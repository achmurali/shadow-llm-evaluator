import { describe, it, expect } from 'vitest';
import { textSimilarityRule } from '../../src/shared/heuristics/rules/text-similarity.js';
import { Comparable } from '../../src/shared/types.js';
const cmp = (content: any): Comparable => ({ content, parseError: false, toolCalls: [] });

describe('textSimilarityRule', () => {
  it('1 for identical strings', () => {
    expect(textSimilarityRule.evaluate(cmp({ s: 'hello world' }), cmp({ s: 'hello world' }), { options: {} }).score).toBe(1);
  });
  it('partial for near strings', () => {
    const r = textSimilarityRule.evaluate(cmp({ s: 'hello world' }), cmp({ s: 'hello there' }), { options: {} });
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(1);
  });
  it('1 when there are no string fields (nothing to compare)', () => {
    expect(textSimilarityRule.evaluate(cmp({ a: 1 }), cmp({ a: 1 }), { options: {} }).score).toBe(1);
  });
});
