import { describe, it, expect } from 'vitest';
import { flatten, levenshteinRatio, jaccard } from '../../src/shared/heuristics/json-utils.js';

describe('json-utils', () => {
  it('flattens nested objects to dot paths', () => {
    expect(flatten({ a: 1, b: { c: 'x' }, d: [1, 2] }))
      .toEqual({ a: 1, 'b.c': 'x', 'd.0': 1, 'd.1': 2 });
  });
  it('levenshtein ratio: identical = 1, disjoint < 1', () => {
    expect(levenshteinRatio('abc', 'abc')).toBe(1);
    expect(levenshteinRatio('abc', 'abd')).toBeCloseTo(2 / 3);
    expect(levenshteinRatio('', '')).toBe(1);
  });
  it('jaccard token overlap', () => {
    expect(jaccard('the cat', 'the cat')).toBe(1);
    expect(jaccard('the cat', 'the dog')).toBeCloseTo(1 / 3);
  });
});
