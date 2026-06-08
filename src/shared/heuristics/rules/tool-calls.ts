import { HeuristicRule, RuleResult } from '../types.js';
import { ToolCall } from '../../types.js';

function canonicalArgs(a: string): string {
  try { return JSON.stringify(JSON.parse(a)); } catch { return a; }
}

export const toolCallsRule: HeuristicRule = {
  name: 'tool-calls',
  evaluate(primary, candidate): RuleResult {
    const p = primary.toolCalls, c = candidate.toolCalls;
    if (p.length === 0 && c.length === 0) return { score: 1, details: { calls: 0 } };

    // Score per primary tool call: 0.5 for name match, +0.5 for args match. Average over max(len).
    const used = new Set<number>();
    let total = 0;
    for (const pc of p) {
      let best = 0; let bestIdx = -1;
      c.forEach((cc, i) => {
        if (used.has(i)) return;
        let s = 0;
        if (cc.function.name === pc.function.name) {
          s = 0.5 + (canonicalArgs(cc.function.arguments) === canonicalArgs(pc.function.arguments) ? 0.5 : 0);
        }
        if (s > best) { best = s; bestIdx = i; }
      });
      if (bestIdx >= 0) used.add(bestIdx);
      total += best;
    }
    const denom = Math.max(p.length, c.length);
    return { score: total / denom, details: { primaryCalls: p.length, candidateCalls: c.length } };
  }
};
