import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { startPg } from '../helpers/testcontainers.js';
import { RequestsRepo } from '../../src/shared/db/requests.repo.js';

let pool: Pool; let stop: () => Promise<void>; let repo: RequestsRepo;

beforeAll(async () => {
  const pg = await startPg();
  pool = pg.pool; repo = new RequestsRepo(pool);
  stop = async () => { await pool.end(); await pg.container.stop(); };
});
afterAll(() => stop());

describe('RequestsRepo', () => {
  it('inserts and reads a request', async () => {
    const id = await repo.insert({
      requestId: 'a1111111-1111-1111-1111-111111111111',
      primaryModel: 'primary-llama',
      messages: [{ role: 'user', content: 'hi' }],
      primaryResponse: { choices: [] },
      primaryLatencyMs: 42,
      sampled: true
    });
    const row = await repo.get(id);
    expect(row?.primary_model).toBe('primary-llama');
    expect(row?.sampled).toBe(true);
  });
});
