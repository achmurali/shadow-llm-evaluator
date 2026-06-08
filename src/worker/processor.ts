import { Pool } from 'pg';
import { Catalog } from '../shared/config/catalog.js';
import { ConfigService } from '../shared/config/service.js';
import { ModelProvider, ProviderChatResponse } from '../shared/providers/types.js';
import { extractComparable } from '../shared/providers/comparable.js';
import { runEngine } from '../shared/heuristics/engine.js';
import { RequestsRepo } from '../shared/db/requests.repo.js';
import { EvaluationsRepo } from '../shared/db/evaluations.repo.js';

export interface ProcessorDeps {
  pool: Pool;
  provider: ModelProvider;
  catalog: Catalog;
  configService: ConfigService;
  requestsRepo: RequestsRepo;
  evalsRepo: EvaluationsRepo;
}

export async function processJob(evalId: string, deps: ProcessorDeps): Promise<void> {
  const evalRow = await deps.evalsRepo.get(evalId);
  if (!evalRow) return;                       // nothing to do
  if (evalRow.status === 'completed') return; // idempotent: already done

  await deps.evalsRepo.markRunning(evalId);
  const request = await deps.requestsRepo.get(evalRow.request_id);
  if (!request) { await deps.evalsRepo.fail(evalId, 'request not found'); return; }

  try {
    const start = Date.now();
    const candidateResp = await deps.provider.chat(
      deps.catalog.resolve(evalRow.candidate_model),
      { messages: request.messages, response_format: undefined }
    );
    const candidateLatencyMs = Date.now() - start;

    const { config } = await deps.configService.get();
    const primary = extractComparable(request.primary_response as unknown as ProviderChatResponse);
    const candidate = extractComparable(candidateResp);
    const result = runEngine(primary, candidate, config.heuristics);

    await deps.evalsRepo.complete(evalId, {
      candidateResponse: candidateResp as any,
      ruleScores: result.ruleScores as any,
      compositeScore: result.composite,
      verdict: result.verdict,
      candidateLatencyMs
    });
  } catch (err) {
    await deps.evalsRepo.fail(evalId, String(err));
    throw err; // rethrow so BullMQ records the attempt and retries
  }
}
