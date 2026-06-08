import { loadEnv } from '../shared/config/env.js';
import { loadCatalogFromFile } from '../shared/config/catalog.js';
import { createPool, applySchema } from '../shared/db/pool.js';
import { ConfigRepo } from '../shared/db/config.repo.js';
import { ConfigService } from '../shared/config/service.js';
import { DOInferenceProvider } from '../shared/providers/do-inference.js';
import { createQueue } from '../shared/queue/queue.js';
import { buildApp } from './app.js';

async function main() {
  const env = loadEnv();
  const pool = createPool(env.DATABASE_URL);
  await applySchema(pool);
  const catalog = loadCatalogFromFile(env.CATALOG_PATH);
  const configService = new ConfigService(new ConfigRepo(pool), env.CONFIG_CACHE_TTL_MS);
  await configService.get(); // seed defaults if empty
  const provider = new DOInferenceProvider(env.DO_INFERENCE_BASE_URL, env.DO_INFERENCE_KEY, env.MODEL_TIMEOUT_MS);
  const queue = createQueue(env.REDIS_URL);

  const app = buildApp({ env, pool, queue, catalog, configService, provider });
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

main().catch((err) => { console.error(err); process.exit(1); });
