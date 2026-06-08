import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { startPg } from '../helpers/testcontainers.js';
import { ConfigRepo } from '../../src/shared/db/config.repo.js';
import { ConfigService } from '../../src/shared/config/service.js';

let pool: Pool; let stop: () => Promise<void>;
beforeAll(async () => { const pg = await startPg(); pool = pg.pool; stop = async () => { await pool.end(); await pg.container.stop(); }; });
afterAll(() => stop());

describe('config propagation across instances', () => {
  it('writer updates; second reader sees it after TTL', async () => {
    let now = 0;
    const writer = new ConfigService(new ConfigRepo(pool), 1000, () => now);
    const reader = new ConfigService(new ConfigRepo(pool), 1000, () => now);

    const initial = await reader.get();           // version 1, cached in reader
    const cfg = structuredClone(initial.config); cfg.sampling.rate = 0.99;
    const v = await writer.update(cfg, initial.version);
    expect(v).toBe(initial.version + 1);

    expect((await reader.get()).config.sampling.rate).not.toBe(0.99); // still cached
    now += 2000;                                   // expire TTL
    expect((await reader.get()).config.sampling.rate).toBe(0.99);     // re-read from PG
  });
});
