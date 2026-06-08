import { describe, it, expect } from 'vitest';
import { shouldSample } from '../../src/shared/sampling/sampling.js';
import { DEFAULT_CONFIG } from '../../src/shared/config/dynamic.js';

const cfg = (over: any = {}) => ({ ...DEFAULT_CONFIG.sampling, ...over });

describe('shouldSample', () => {
  it('force header always samples', () => {
    expect(shouldSample(cfg({ rate: 0 }), { model: 'm', route: '/v1/chat', forced: true }, () => 0.99)).toBe(true);
  });
  it('rate=0 never samples', () => {
    expect(shouldSample(cfg({ rate: 0 }), { model: 'm', route: '/v1/chat', forced: false }, () => 0)).toBe(false);
  });
  it('rate=1 always samples', () => {
    expect(shouldSample(cfg({ rate: 1 }), { model: 'm', route: '/v1/chat', forced: false }, () => 0.999)).toBe(true);
  });
  it('model override beats global', () => {
    const c = cfg({ rate: 0, overrides: { model: { m: 1 }, route: {} } });
    expect(shouldSample(c, { model: 'm', route: '/v1/chat', forced: false }, () => 0.5)).toBe(true);
  });
  it('draw below rate samples', () => {
    expect(shouldSample(cfg({ rate: 0.3 }), { model: 'm', route: '/x', forced: false }, () => 0.29)).toBe(true);
    expect(shouldSample(cfg({ rate: 0.3 }), { model: 'm', route: '/x', forced: false }, () => 0.31)).toBe(false);
  });
});
