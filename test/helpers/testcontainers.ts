import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import { applySchema } from '../../src/shared/db/pool.js';

const ADMIN_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://shadow:shadow@localhost:5432/shadow';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

function uniqueDbName(): string {
  return 'test_' + randomBytes(6).toString('hex');
}

/** Creates an isolated database, applies the schema, and returns a pool to it.
 *  `container.stop()` drops that database (call AFTER `pool.end()`). */
export async function startPg(): Promise<{ container: { stop: () => Promise<void> }; pool: Pool; url: string }> {
  const admin = new Pool({ connectionString: ADMIN_DB_URL });
  const db = uniqueDbName();
  await admin.query(`CREATE DATABASE ${db}`);
  const url = ADMIN_DB_URL.replace(/\/[^/]+$/, `/${db}`);
  const pool = new Pool({ connectionString: url });
  await applySchema(pool, 'db/schema.sql');
  const container = {
    stop: async () => {
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.end();
    }
  };
  return { container, pool, url };
}

/** Flushes the local Redis so each file starts clean. `container.stop()` is a no-op. */
export async function startRedis(): Promise<{ container: { stop: () => Promise<void> }; url: string }> {
  const client = new Redis(REDIS_URL);
  await client.flushall();
  await client.quit();
  return { container: { stop: async () => {} }, url: REDIS_URL };
}
