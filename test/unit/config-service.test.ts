import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '../../src/shared/config/service.js';
import { DEFAULT_CONFIG } from '../../src/shared/config/dynamic.js';

function fakeRepo(initial = { version: 1, data: DEFAULT_CONFIG }) {
  let row: any = initial;
  return {
    latest: vi.fn(async () => row),
    putNext: vi.fn(async (data: any, expected: number) => {
      if (expected !== row.version) return null;
      row = { version: row.version + 1, data };
      return row.version;
    }),
    _set: (r: any) => { row = r; }
  };
}

describe('ConfigService', () => {
  it('caches within TTL then refetches after expiry', async () => {
    const repo = fakeRepo();
    let now = 1000;
    const svc = new ConfigService(repo as any, 5000, () => now);

    expect((await svc.get()).version).toBe(1);
    repo._set({ version: 2, data: DEFAULT_CONFIG });
    expect((await svc.get()).version).toBe(1);   // cached
    now += 6000;
    expect((await svc.get()).version).toBe(2);   // TTL expired -> refetch
  });

  it('seeds defaults when empty', async () => {
    const repo = { latest: vi.fn(async () => null), putNext: vi.fn(async () => 1) };
    const svc = new ConfigService(repo as any, 5000, () => 0);
    const cfg = await svc.get();
    expect(cfg.version).toBe(1);
    expect(repo.putNext).toHaveBeenCalled();
  });

  it('update rejects stale version', async () => {
    const repo = fakeRepo({ version: 3, data: DEFAULT_CONFIG });
    const svc = new ConfigService(repo as any, 5000, () => 0);
    await svc.get();
    const ok = await svc.update(DEFAULT_CONFIG, 3);
    expect(ok).toBe(4);
    const stale = await svc.update(DEFAULT_CONFIG, 3);  // now current is 4
    expect(stale).toBeNull();
  });
});
