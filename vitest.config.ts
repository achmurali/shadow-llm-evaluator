import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // Integration tests share a local Postgres/Redis; run files sequentially
    // so per-file isolated databases and Redis flushes don't race.
    poolOptions: { forks: { singleFork: true } }
  }
});
