import { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { AppDeps } from '../app.js';
import { getStats } from '../../shared/stats/stats.js';

export function registerStatsRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/stats', async () => getStats(deps.pool));

  app.get('/', async (_req, reply) => {
    reply.header('content-type', 'text/html');
    return readFileSync('public/dashboard.html', 'utf8');
  });
}
