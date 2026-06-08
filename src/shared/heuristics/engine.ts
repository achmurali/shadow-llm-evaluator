import { HeuristicRule, EvaluationResult } from './types.js';
import { Comparable } from '../types.js';
import { DynamicConfig } from '../config/dynamic.js';
import { structuralRule } from './rules/structural.js';
import { exactMatchRule } from './rules/exact-match.js';
import { textSimilarityRule } from './rules/text-similarity.js';
import { numericToleranceRule } from './rules/numeric-tolerance.js';
import { toolCallsRule } from './rules/tool-calls.js';

export const ALL_RULES: Record<string, HeuristicRule> = {
  [structuralRule.name]: structuralRule,
  [exactMatchRule.name]: exactMatchRule,
  [textSimilarityRule.name]: textSimilarityRule,
  [numericToleranceRule.name]: numericToleranceRule,
  [toolCallsRule.name]: toolCallsRule
};

export function runEngine(
  primary: Comparable,
  candidate: Comparable,
  cfg: DynamicConfig['heuristics']
): EvaluationResult {
  const ruleScores: EvaluationResult['ruleScores'] = {};
  let weighted = 0, totalWeight = 0;

  for (const [name, rc] of Object.entries(cfg.rules)) {
    if (!rc.enabled) continue;
    const rule = ALL_RULES[name];
    if (!rule) continue;
    const res = rule.evaluate(primary, candidate, { options: rc.options });
    ruleScores[name] = { score: res.score, weight: rc.weight, details: res.details };
    weighted += res.score * rc.weight;
    totalWeight += rc.weight;
  }

  const composite = totalWeight > 0 ? weighted / totalWeight : 0;
  return { ruleScores, composite, verdict: composite >= cfg.verdictThreshold ? 'pass' : 'fail' };
}
