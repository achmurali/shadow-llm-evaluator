import { HeuristicRule, RuleResult } from '../types.js';
import { flatten } from '../json-utils.js';

export const exactMatchRule: HeuristicRule = {
  name: 'exact-match',
  evaluate(primary, candidate): RuleResult {
    if (candidate.parseError || candidate.content === null) return { score: 0, details: { reason: 'parse error' } };
    const p = flatten(primary.content ?? {});
    const c = flatten(candidate.content ?? {});
    const keys = Object.keys(p);
    if (keys.length === 0) return { score: 1, details: { fields: 0 } };
    let equal = 0;
    for (const k of keys) if (k in c && JSON.stringify(p[k]) === JSON.stringify(c[k])) equal++;
    return { score: equal / keys.length, details: { equal, total: keys.length } };
  }
};
