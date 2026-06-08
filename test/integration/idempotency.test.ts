import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import { startPg, startRedis } from '../helpers/testcontainers.js';
import { createQueue, enqueueEval, defaultJobOpts, QUEUE_NAME, createConnection } from '../../src/shared/queue/queue.js';
import { RequestsRepo } from '../../src/shared/db/requests.repo.js';
import { EvaluationsRepo } from '../../src/shared/db/evaluations.repo.js';
import { ConfigRepo } from '../../src/shared/db/config.repo.js';
import { ConfigService } from '../../src/shared/config/service.js';
import { loadCatalog } from '../../src/shared/config/catalog.js';
import { MockProvider } from '../../src/shared/providers/mock.js';
import { processJob } from '../../src/worker/processor.js';
import { Worker } from 'bullmq';

let pool: Pool; let queue: Queue; let stop: () => Promise<void>; let redisUrl: string;
// UUID literals: request_id and eval_id are UUID columns (see db/schema.sql).
const RID = 'a1111111-1111-1111-1111-111111111111';
const EID = 'b2222222-2222-2222-2222-222222222222';
const EID_DUP = 'c3333333-3333-3333-3333-333333333333';

beforeAll(async () => {
  const pg = await startPg(); const redis = await startRedis();
  pool = pg.pool; redisUrl = redis.url; queue = createQueue(redisUrl);
  stop = async () => { await queue.close(); await pool.end(); await pg.container.stop(); await redis.container.stop(); };
});
afterAll(() => stop());

describe('queue + worker e2e', () => {
  it('processes an enqueued eval to completed, and double-enqueue stays single', async () => {
    const rr = new RequestsRepo(pool), er = new EvaluationsRepo(pool);
    await rr.insert({ requestId: RID, primaryModel: 'p', messages: [], primaryLatencyMs: 5, sampled: true,
      primaryResponse: { choices: [{ message: { role: 'assistant', content: '{"x":1}' } }] } });
    await er.enqueue({ evalId: EID, requestId: RID, candidateModel: 'cand' });
    // duplicate enqueue (same request/candidate) is ignored by DB unique constraint
    await er.enqueue({ evalId: EID_DUP, requestId: RID, candidateModel: 'cand' });
    expect((await er.byRequest(RID)).length).toBe(1);

    const deps = {
      pool, provider: new MockProvider({ CAND: { x: 1 } }),
      catalog: loadCatalog({ models: { cand: { inferenceName: 'CAND' } } }),
      configService: new ConfigService(new ConfigRepo(pool), 5000),
      requestsRepo: rr, evalsRepo: er
    } as any;

    const worker = new Worker(QUEUE_NAME, async (job) => processJob(job.data.evalId, deps),
      { connection: createConnection(redisUrl), concurrency: 2 });

    await enqueueEval(queue, EID, defaultJobOpts(1, 10));
    await enqueueEval(queue, EID, defaultJobOpts(1, 10)); // same jobId -> dedup

    // wait for completion
    await new Promise<void>((resolve) => {
      const t = setInterval(async () => {
        const row = await er.get(EID);
        if (row?.status === 'completed') { clearInterval(t); resolve(); }
      }, 100);
    });

    const row = await er.get(EID);
    expect(row?.status).toBe('completed');
    expect(row?.attempts).toBe(1); // processed once despite duplicate enqueue
    await worker.close();
  });
});
