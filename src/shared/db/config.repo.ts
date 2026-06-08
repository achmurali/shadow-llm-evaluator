import { Pool } from 'pg';
import { DynamicConfig } from '../config/dynamic.js';

export interface ConfigRow { version: number; data: DynamicConfig; }

export class ConfigRepo {
  constructor(private pool: Pool) {}

  async latest(): Promise<ConfigRow | null> {
    const { rows } = await this.pool.query('SELECT version, data FROM config ORDER BY version DESC LIMIT 1');
    return rows[0] ?? null;
  }

  /** Insert next version only if expectedVersion matches current (optimistic concurrency).
   * Returns the new version, or null on conflict. */
  async putNext(data: DynamicConfig, expectedVersion: number): Promise<number | null> {
    const next = expectedVersion + 1;
    const res = await this.pool.query(
      `INSERT INTO config (version, data) VALUES ($1, $2)
       ON CONFLICT (version) DO NOTHING RETURNING version`,
      [next, JSON.stringify(data)]
    );
    return res.rows[0]?.version ?? null;
  }
}
