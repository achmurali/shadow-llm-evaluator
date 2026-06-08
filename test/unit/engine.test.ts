import { describe, it, expect } from 'vitest';
import { runEngine, ALL_RULES } from '../../src/shared/heuristics/engine.js';
import { DEFAULT_CONFIG } from '../../src/shared/config/dynamic.js';
import { Comparable } from '../../src/shared/types.js';
const cmp = (content: any): Comparable => ({ content, parseError: false, toolCalls: [] });

describe('runEngine', () => {
  it('registers all five rules', () => {
    expect(Object.keys(ALL_RULES).sort()).toEqual(
      ['exact-match', 'numeric-tolerance', 'structural', 'text-similarity', 'tool-calls']);
  });
  it('identical content -> composite 1 -> pass', () => {
    const r = runEngine(cmp({ a: 1, b: 'x' }), cmp({ a: 1, b: 'x' }), DEFAULT_CONFIG.heuristics);
    expect(r.composite).toBe(1);
    expect(r.verdict).toBe('pass');
  });
  it('divergent content -> fail', () => {
    const r = runEngine(cmp({ a: 1, b: 'hello world' }), cmp({ a: 999, b: 'totally different' }), DEFAULT_CONFIG.heuristics);
    expect(r.composite).toBeLessThan(DEFAULT_CONFIG.heuristics.verdictThreshold);
    expect(r.verdict).toBe('fail');
  });
  it('skips disabled rules', () => {
    const cfg = structuredClone(DEFAULT_CONFIG.heuristics);
    cfg.rules['text-similarity'].enabled = false;
    const r = runEngine(cmp({ a: 1 }), cmp({ a: 1 }), cfg);
    expect(r.ruleScores['text-similarity']).toBeUndefined();
  });
});
