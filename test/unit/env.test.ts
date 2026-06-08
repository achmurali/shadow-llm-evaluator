import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../src/shared/config/env.js';

const base = {
  DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x',
  DO_INFERENCE_BASE_URL: 'https://x/v1', DO_INFERENCE_KEY: 'k', ADMIN_KEY: 'a'
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(8080);
    expect(env.WORKER_CONCURRENCY).toBe(5);
    expect(env.AUTH_KEY).toBeUndefined();
  });
  it('throws when a required var is missing', () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: undefined } as any)).toThrow();
  });
});
