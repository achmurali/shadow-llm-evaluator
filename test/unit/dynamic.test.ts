import { describe, it, expect } from 'vitest';
import { DynamicConfigSchema, DEFAULT_CONFIG } from '../../src/shared/config/dynamic.js';

describe('dynamic config', () => {
  it('default validates', () => {
    expect(() => DynamicConfigSchema.parse(DEFAULT_CONFIG)).not.toThrow();
  });
  it('rejects rate > 1', () => {
    expect(() => DynamicConfigSchema.parse({ ...DEFAULT_CONFIG, sampling: { ...DEFAULT_CONFIG.sampling, rate: 2 } })).toThrow();
  });
});
