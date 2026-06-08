import { HeuristicRule, RuleResult } from '../types.js';
import { flatten } from '../json-utils.js';
import { Json } from '../../types.js';

function typeOf(v: Json): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export const structuralRule: HeuristicRule = {
  name: 'structural',
  evaluate(primary, candidate): RuleResult {
    if (candidate.parseError || candidate.content === null) {
      return { score: 0, details: { reason: 'candidate parse error' } };
    }
    const p = flatten(primary.content ?? {});
    const c = flatten(candidate.content ?? {});
    const keys = new Set([...Object.keys(p), ...Object.keys(c)]);
    if (keys.size === 0) return { score: 1, details: { keys: 0 } };
    let matches = 0;
    for (const k of keys) {
      if (k in p && k in c && typeOf(p[k]) === typeOf(c[k])) matches++;
    }
    return { score: matches / keys.size, details: { matches, total: keys.size } };
  }
};
