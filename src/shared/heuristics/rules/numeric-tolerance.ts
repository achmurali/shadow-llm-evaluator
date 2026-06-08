import { HeuristicRule, RuleResult, RuleContext } from '../types.js';
import { flatten } from '../json-utils.js';

export const numericToleranceRule: HeuristicRule = {
  name: 'numeric-tolerance',
  evaluate(primary, candidate, ctx: RuleContext): RuleResult {
    if (candidate.parseError || candidate.content === null) return { score: 0, details: { reason: 'parse error' } };
    const absTol = Number(ctx.options.absTol ?? 0);
    const relTol = Number(ctx.options.relTol ?? 0.01);
    const p = flatten(primary.content ?? {});
    const c = flatten(candidate.content ?? {});
    const numKeys = Object.keys(p).filter((k) => typeof p[k] === 'number');
    if (numKeys.length === 0) return { score: 1, details: { numericFields: 0 } };
    let ok = 0;
    for (const k of numKeys) {
      const pv = p[k] as number;
      const cv = typeof c[k] === 'number' ? (c[k] as number) : NaN;
      const tol = Math.max(absTol, Math.abs(pv) * relTol);
      if (Math.abs(pv - cv) <= tol) ok++;
    }
    return { score: ok / numKeys.length, details: { ok, total: numKeys.length, absTol, relTol } };
  }
};
