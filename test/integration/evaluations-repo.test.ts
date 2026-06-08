import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { startPg } from '../helpers/testcontainers.js';
import { RequestsRepo } from '../../src/shared/db/requests.repo.js';
import { EvaluationsRepo } from '../../src/shared/db/evaluations.repo.js';

let pool: Pool; let stop: () => Promise<void>;
let reqRepo: RequestsRepo; let evalRepo: EvaluationsRepo;
const RID = 'b2222222-2222-2222-2222-222222222222';
const EID = 'c3333333-3333-3333-3333-333333333333';

beforeAll(async () => {
  const pg = await startPg();
  pool = pg.pool; reqRepo = new RequestsRepo(pool); evalRepo = new EvaluationsRepo(pool);
  stop = async () => { await pool.end(); await pg.container.stop(); };
  await reqRepo.insert({ requestId: RID, primaryModel: 'p', messages: [], primaryResponse: {}, primaryLatencyMs: 1, sampled: true });
});
afterAll(() => stop());

describe('EvaluationsRepo', () => {
  it('queues then completes an eval', async () => {
    await evalRepo.enqueue({ evalId: EID, requestId: RID, candidateModel: 'candidate-claude' });
    let row = await evalRepo.get(EID);
    expect(row?.status).toBe('queued');

    await evalRepo.markRunning(EID);
    row = await evalRepo.get(EID);
    expect(row?.status).toBe('running');

    await evalRepo.complete(EID, {
      candidateResponse: { ok: true },
      ruleScores: { structural: { score: 1, weight: 2 } },
      compositeScore: 0.9, verdict: 'pass', candidateLatencyMs: 50
    });
    row = await evalRepo.get(EID);
    expect(row?.status).toBe('completed');
    expect(Number(row?.composite_score)).toBeCloseTo(0.9);
    expect(row?.verdict).toBe('pass');
  });

  it('lists evals by request', async () => {
    const list = await evalRepo.byRequest(RID);
    expect(list.length).toBe(1);
  });

  it('enqueue is idempotent on (request, candidate)', async () => {
    await evalRepo.enqueue({ evalId: 'd4444444-4444-4444-4444-444444444444', requestId: RID, candidateModel: 'candidate-claude' });
    const list = await evalRepo.byRequest(RID);
    expect(list.length).toBe(1); // unchanged: conflict ignored
  });
});
