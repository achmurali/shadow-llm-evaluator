import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { startPg } from '../helpers/testcontainers.js';
import { RequestsRepo } from '../../src/shared/db/requests.repo.js';
import { EvaluationsRepo } from '../../src/shared/db/evaluations.repo.js';
import { getStats } from '../../src/shared/stats/stats.js';

let pool: Pool; let stop: () => Promise<void>;

beforeAll(async () => {
  const pg = await startPg();
  pool = pg.pool;
  stop = async () => { await pool.end(); await pg.container.stop(); };
  const rr = new RequestsRepo(pool); const er = new EvaluationsRepo(pool);
  const RID = 'a1111111-1111-1111-1111-111111111111';
  const EID1 = 'b1111111-1111-1111-1111-111111111111';
  const EID2 = 'b2222222-2222-2222-2222-222222222222';
  await rr.insert({ requestId: RID, primaryModel: 'p', messages: [], primaryResponse: {}, primaryLatencyMs: 100, sampled: true });
  await er.enqueue({ evalId: EID1, requestId: RID, candidateModel: 'candidate-claude' });
  await er.markRunning(EID1);
  await er.complete(EID1, { candidateResponse: {}, ruleScores: {}, compositeScore: 0.9, verdict: 'pass', candidateLatencyMs: 150 });
  await er.enqueue({ evalId: EID2, requestId: RID, candidateModel: 'candidate-mistral' });
  await er.markRunning(EID2);
  await er.complete(EID2, { candidateResponse: {}, ruleScores: {}, compositeScore: 0.4, verdict: 'fail', candidateLatencyMs: 200 });
});
afterAll(() => stop());

describe('getStats', () => {
  it('aggregates per candidate', async () => {
    const s = await getStats(pool);
    const claude = s.perCandidate.find((c) => c.candidate_model === 'candidate-claude')!;
    expect(claude.completed).toBe(1);
    expect(Number(claude.pass_rate)).toBeCloseTo(1);
    expect(Number(claude.avg_composite)).toBeCloseTo(0.9);
    expect(s.statusBreakdown.completed).toBe(2);
  });
});
