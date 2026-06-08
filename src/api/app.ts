import Fastify, { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import { Env } from '../shared/config/env.js';
import { Catalog } from '../shared/config/catalog.js';
import { ConfigService } from '../shared/config/service.js';
import { ModelProvider } from '../shared/providers/types.js';
import { EvalJob } from '../shared/queue/queue.js';
import { registerChatRoute } from './routes/chat.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerLookupRoutes } from './routes/lookup.js';
import { registerStatsRoutes } from './routes/stats.js';

export interface AppDeps {
  env: Env;
  pool: Pool;
  queue: Queue<EvalJob>;
  catalog: Catalog;
  configService: ConfigService;
  provider: ModelProvider;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true });
  app.get('/healthz', async () => ({ ok: true }));
  registerChatRoute(app, deps);
  registerConfigRoutes(app, deps);
  registerLookupRoutes(app, deps);
  registerStatsRoutes(app, deps);
  return app;
}
