import { Worker } from 'bullmq';
import { loadEnv } from '../shared/config/env.js';
import { loadCatalogFromFile } from '../shared/config/catalog.js';
import { createPool, applySchema } from '../shared/db/pool.js';
import { ConfigRepo } from '../shared/db/config.repo.js';
import { ConfigService } from '../shared/config/service.js';
import { DOInferenceProvider } from '../shared/providers/do-inference.js';
import { RequestsRepo } from '../shared/db/requests.repo.js';
import { EvaluationsRepo } from '../shared/db/evaluations.repo.js';
import { QUEUE_NAME, EvalJob, createConnection } from '../shared/queue/queue.js';
import { processJob, ProcessorDeps } from './processor.js';

async function main() {
  const env = loadEnv();
  const pool = createPool(env.DATABASE_URL);
  await applySchema(pool);
  const deps: ProcessorDeps = {
    pool,
    provider: new DOInferenceProvider(env.DO_INFERENCE_BASE_URL, env.DO_INFERENCE_KEY, env.MODEL_TIMEOUT_MS),
    catalog: loadCatalogFromFile(env.CATALOG_PATH),
    configService: new ConfigService(new ConfigRepo(pool), env.CONFIG_CACHE_TTL_MS),
    requestsRepo: new RequestsRepo(pool),
    evalsRepo: new EvaluationsRepo(pool)
  };

  const worker = new Worker<EvalJob>(
    QUEUE_NAME,
    async (job) => { await processJob(job.data.evalId, deps); },
    { connection: createConnection(env.REDIS_URL), concurrency: env.WORKER_CONCURRENCY }
  );

  worker.on('failed', (job, err) => console.error(`job ${job?.id} failed:`, err.message));
  console.log(`worker up, concurrency=${env.WORKER_CONCURRENCY}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
