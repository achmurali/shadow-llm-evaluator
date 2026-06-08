import { describe, it, expect } from 'vitest';
import { structuralRule } from '../../src/shared/heuristics/rules/structural.js';
import { Comparable } from '../../src/shared/types.js';

const cmp = (content: any, parseError = false): Comparable => ({ content, parseError, toolCalls: [] });

describe('structuralRule', () => {
  it('scores 1 for same shape and types', () => {
    const r = structuralRule.evaluate(cmp({ a: 1, b: 's' }), cmp({ a: 9, b: 't' }), { options: {} });
    expect(r.score).toBe(1);
  });
  it('penalizes missing/extra keys', () => {
    const r = structuralRule.evaluate(cmp({ a: 1, b: 2 }), cmp({ a: 1 }), { options: {} });
    expect(r.score).toBeLessThan(1);
  });
  it('scores 0 when candidate failed to parse', () => {
    const r = structuralRule.evaluate(cmp({ a: 1 }), cmp(null, true), { options: {} });
    expect(r.score).toBe(0);
  });
});
