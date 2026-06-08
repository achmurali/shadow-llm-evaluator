import { HeuristicRule, RuleResult } from '../types.js';
import { flatten, levenshteinRatio } from '../json-utils.js';

export const textSimilarityRule: HeuristicRule = {
  name: 'text-similarity',
  evaluate(primary, candidate): RuleResult {
    if (candidate.parseError || candidate.content === null) return { score: 0, details: { reason: 'parse error' } };
    const p = flatten(primary.content ?? {});
    const c = flatten(candidate.content ?? {});
    const strKeys = Object.keys(p).filter((k) => typeof p[k] === 'string');
    if (strKeys.length === 0) return { score: 1, details: { stringFields: 0 } };
    let sum = 0;
    for (const k of strKeys) {
      const cv = typeof c[k] === 'string' ? (c[k] as string) : '';
      sum += levenshteinRatio(p[k] as string, cv);
    }
    return { score: sum / strKeys.length, details: { stringFields: strKeys.length } };
  }
};
