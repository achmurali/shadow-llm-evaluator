import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { startPg } from '../helpers/testcontainers.js';
import { RequestsRepo } from '../../src/shared/db/requests.repo.js';
import { EvaluationsRepo } from '../../src/shared/db/evaluations.repo.js';
import { ConfigRepo } from '../../src/shared/db/config.repo.js';
import { ConfigService } from '../../src/shared/config/service.js';
import { loadCatalog } from '../../src/shared/config/catalog.js';
import { MockProvider } from '../../src/shared/providers/mock.js';
import { processJob } from '../../src/worker/processor.js';

let pool: Pool; let stop: () => Promise<void>;

beforeAll(async () => {
  const pg = await startPg();
  pool = pg.pool;
  stop = async () => { await pool.end(); await pg.container.stop(); };
});
afterAll(() => stop());

describe('processJob', () => {
  it('runs heuristics and completes the eval', async () => {
    const rr = new RequestsRepo(pool), er = new EvaluationsRepo(pool);
    await rr.insert({
      requestId: 'a1111111-1111-1111-1111-111111111111', primaryModel: 'primary', messages: [], primaryLatencyMs: 10, sampled: true,
      primaryResponse: { choices: [{ message: { role: 'assistant', content: '{"answer":42}' } }] }
    });
    await er.enqueue({ evalId: 'b1111111-1111-1111-1111-111111111111', requestId: 'a1111111-1111-1111-1111-111111111111', candidateModel: 'cand' });

    const provider = new MockProvider({ CAND: { answer: 42 } }); // identical -> pass
    const catalog = loadCatalog({ models: { cand: { inferenceName: 'CAND' } } });
    const cfgService = new ConfigService(new ConfigRepo(pool), 5000);

    const deps = { pool, provider, catalog, configService: cfgService, requestsRepo: rr, evalsRepo: er, timeoutMs: 30000 };
    await processJob('b1111111-1111-1111-1111-111111111111', deps as any);

    const row = await er.get('b1111111-1111-1111-1111-111111111111');
    expect(row?.status).toBe('completed');
    expect(row?.verdict).toBe('pass');
    expect(Number(row?.composite_score)).toBeGreaterThan(0.8);
  });

  it('marks failed when candidate call throws', async () => {
    const rr = new RequestsRepo(pool), er = new EvaluationsRepo(pool);
    await rr.insert({ requestId: 'a2222222-2222-2222-2222-222222222222', primaryModel: 'primary', messages: [], primaryLatencyMs: 10, sampled: true,
      primaryResponse: { choices: [{ message: { role: 'assistant', content: '{"a":1}' } }] } });
    await er.enqueue({ evalId: 'b2222222-2222-2222-2222-222222222222', requestId: 'a2222222-2222-2222-2222-222222222222', candidateModel: 'cand' });

    const provider = { chat: async () => { throw new Error('boom'); } };
    const catalog = loadCatalog({ models: { cand: { inferenceName: 'CAND' } } });
    const cfgService = new ConfigService(new ConfigRepo(pool), 5000);
    const deps = { pool, provider, catalog, configService: cfgService, requestsRepo: rr, evalsRepo: er, timeoutMs: 30000 };

    await expect(processJob('b2222222-2222-2222-2222-222222222222', deps as any, true)).rejects.toThrow('boom'); // rethrow so BullMQ retries
    const row = await er.get('b2222222-2222-2222-2222-222222222222');
    expect(row?.status).toBe('failed');
  });

  it('stays running (not failed) when a non-final attempt throws', async () => {
    const rr = new RequestsRepo(pool), er = new EvaluationsRepo(pool);
    await rr.insert({ requestId: 'a3333333-3333-3333-3333-333333333333', primaryModel: 'primary', messages: [], primaryLatencyMs: 10, sampled: true,
      primaryResponse: { choices: [{ message: { role: 'assistant', content: '{"a":1}' } }] } });
    await er.enqueue({ evalId: 'b3333333-3333-3333-3333-333333333333', requestId: 'a3333333-3333-3333-3333-333333333333', candidateModel: 'cand' });

    const provider = { chat: async () => { throw new Error('boom'); } };
    const catalog = loadCatalog({ models: { cand: { inferenceName: 'CAND' } } });
    const cfgService = new ConfigService(new ConfigRepo(pool), 5000);
    const deps = { pool, provider, catalog, configService: cfgService, requestsRepo: rr, evalsRepo: er, timeoutMs: 30000 };

    await expect(processJob('b3333333-3333-3333-3333-333333333333', deps as any, false)).rejects.toThrow('boom');
    const row = await er.get('b3333333-3333-3333-3333-333333333333');
    expect(row?.status).toBe('running'); // not failed: retries remain
    expect(row?.error).toBeNull();
  });
});
