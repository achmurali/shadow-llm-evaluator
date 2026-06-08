import { describe, it, expect } from 'vitest';
import { numericToleranceRule } from '../../src/shared/heuristics/rules/numeric-tolerance.js';
import { Comparable } from '../../src/shared/types.js';
const cmp = (content: any): Comparable => ({ content, parseError: false, toolCalls: [] });

describe('numericToleranceRule', () => {
  it('within relative tolerance counts as match', () => {
    const r = numericToleranceRule.evaluate(cmp({ x: 100 }), cmp({ x: 100.5 }), { options: { absTol: 0, relTol: 0.01 } });
    expect(r.score).toBe(1);
  });
  it('outside tolerance fails', () => {
    const r = numericToleranceRule.evaluate(cmp({ x: 100 }), cmp({ x: 130 }), { options: { absTol: 0, relTol: 0.01 } });
    expect(r.score).toBe(0);
  });
  it('1 when no numeric fields', () => {
    expect(numericToleranceRule.evaluate(cmp({ s: 'a' }), cmp({ s: 'b' }), { options: {} }).score).toBe(1);
  });
});
