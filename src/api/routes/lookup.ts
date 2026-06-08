import { FastifyInstance } from 'fastify';
import { AppDeps } from '../app.js';
import { RequestsRepo } from '../../shared/db/requests.repo.js';
import { EvaluationsRepo } from '../../shared/db/evaluations.repo.js';

export function registerLookupRoutes(app: FastifyInstance, deps: AppDeps): void {
  const requestsRepo = new RequestsRepo(deps.pool);
  const evalsRepo = new EvaluationsRepo(deps.pool);

  app.get('/v1/requests/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const request = await requestsRepo.get(id);
    if (!request) return reply.code(404).send({ error: 'request not found' });
    const evaluations = await evalsRepo.byRequest(id);
    return { request, evaluations };
  });

  app.get('/v1/evaluations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await evalsRepo.get(id);
    if (!row) return reply.code(404).send({ error: 'evaluation not found' });
    return row;
  });
}
