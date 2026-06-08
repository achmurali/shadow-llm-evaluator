import { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import { AppDeps } from '../app.js';
import { ChatRequest } from '../../shared/types.js';
import { checkRequestAuth } from '../auth.js';
import { shouldSample } from '../../shared/sampling/sampling.js';
import { RequestsRepo } from '../../shared/db/requests.repo.js';
import { EvaluationsRepo } from '../../shared/db/evaluations.repo.js';
import { enqueueEval, defaultJobOpts } from '../../shared/queue/queue.js';

export function registerChatRoute(app: FastifyInstance, deps: AppDeps): void {
  const requestsRepo = new RequestsRepo(deps.pool);
  const evalsRepo = new EvaluationsRepo(deps.pool);

  app.post('/v1/chat', async (req, reply) => {
    if (!checkRequestAuth(deps.env.AUTH_KEY, req.headers as any)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = req.body as ChatRequest;
    if (!body?.model || !Array.isArray(body.messages)) {
      return reply.code(400).send({ error: 'model and messages are required' });
    }
    if (!deps.catalog.has(body.model)) {
      return reply.code(400).send({ error: `unknown model: ${body.model}` });
    }
    const { config } = await deps.configService.get();
    const candidates = (body.candidates ?? config.defaultCandidates).filter((c) => c !== body.model);
    for (const c of candidates) {
      if (!deps.catalog.has(c)) return reply.code(400).send({ error: `unknown candidate: ${c}` });
    }

    // Call primary synchronously.
    const start = Date.now();
    let primaryResponse;
    try {
      primaryResponse = await deps.provider.chat(deps.catalog.resolve(body.model), {
        messages: body.messages, tools: body.tools, response_format: body.response_format, temperature: body.temperature
      });
    } catch (err) {
      req.log.error({ err }, 'primary model call failed');
      return reply.code(502).send({ error: 'primary model call failed' });
    }
    const primaryLatencyMs = Date.now() - start;

    const requestId = uuid();
    // Force a shadow evaluation regardless of sample rate, via any of:
    //   header  <forceHeader>: force   |  query  ?force=true   |  body  {"force": true}
    const forced =
      String(req.headers[config.sampling.forceHeader] ?? '') === 'force' ||
      String((req.query as Record<string, unknown> | undefined)?.force ?? '') === 'true' ||
      (body as { force?: unknown }).force === true;
    const sampled = candidates.length > 0 &&
      shouldSample(config.sampling, { model: body.model, route: '/v1/chat', forced });

    await requestsRepo.insert({
      requestId, primaryModel: body.model, messages: body.messages,
      primaryResponse: primaryResponse as any, primaryLatencyMs, sampled
    });

    if (sampled) {
      const opts = defaultJobOpts(deps.env.JOB_ATTEMPTS, deps.env.JOB_BACKOFF_MS);
      for (const candidate of candidates) {
        const evalId = uuid();
        await evalsRepo.enqueue({ evalId, requestId, candidateModel: candidate });
        try {
          await enqueueEval(deps.queue, evalId, opts);
        } catch (err) {
          req.log.error({ err }, 'failed to enqueue eval job (best-effort)');
        }
      }
    }

    reply.header('x-request-id', requestId);
    return reply.send(primaryResponse);
  });
}
