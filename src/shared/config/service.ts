import { ConfigRepo } from '../db/config.repo.js';
import { DynamicConfig, DEFAULT_CONFIG } from './dynamic.js';

export interface VersionedConfig { version: number; config: DynamicConfig; }

export class ConfigService {
  private cache: { version: number; data: DynamicConfig } | null = null;
  private fetchedAt = -Infinity;

  constructor(
    private repo: ConfigRepo,
    private ttlMs: number,
    private now: () => number = () => Date.now()
  ) {}

  async get(): Promise<VersionedConfig> {
    if (this.cache && this.now() - this.fetchedAt < this.ttlMs) {
      return { version: this.cache.version, config: this.cache.data };
    }
    let row = await this.repo.latest();
    if (!row) {
      await this.repo.putNext(DEFAULT_CONFIG, 0); // -> version 1
      row = { version: 1, data: DEFAULT_CONFIG };
    }
    this.cache = row; this.fetchedAt = this.now();
    return { version: row.version, config: row.data };
  }

  /** Returns the new version, or null on stale-version conflict. */
  async update(next: DynamicConfig, expectedVersion: number): Promise<number | null> {
    const v = await this.repo.putNext(next, expectedVersion);
    if (v !== null) { this.cache = { version: v, data: next }; this.fetchedAt = this.now(); }
    return v;
  }
}
