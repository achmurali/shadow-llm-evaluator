import { Pool } from 'pg';
import { readFileSync } from 'node:fs';

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}

export async function applySchema(pool: Pool, schemaPath = 'db/schema.sql'): Promise<void> {
  const sql = readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
}
