import { describe, it, expect } from 'vitest';
import { exactMatchRule } from '../../src/shared/heuristics/rules/exact-match.js';
import { Comparable } from '../../src/shared/types.js';
const cmp = (content: any, parseError = false): Comparable => ({ content, parseError, toolCalls: [] });

describe('exactMatchRule', () => {
  it('1 when all scalar fields equal', () => {
    expect(exactMatchRule.evaluate(cmp({ a: 1, b: 'x' }), cmp({ a: 1, b: 'x' }), { options: {} }).score).toBe(1);
  });
  it('ratio of equal fields', () => {
    const r = exactMatchRule.evaluate(cmp({ a: 1, b: 'x' }), cmp({ a: 1, b: 'y' }), { options: {} });
    expect(r.score).toBe(0.5);
  });
  it('0 on parse error', () => {
    expect(exactMatchRule.evaluate(cmp({ a: 1 }), cmp(null, true), { options: {} }).score).toBe(0);
  });
});
