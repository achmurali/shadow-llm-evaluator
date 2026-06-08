import { Comparable, Verdict } from '../types.js';

export interface RuleContext { options: Record<string, unknown>; }

export interface RuleResult { score: number; details: Record<string, unknown>; }

export interface HeuristicRule {
  name: string;
  evaluate(primary: Comparable, candidate: Comparable, ctx: RuleContext): RuleResult;
}

export interface EvaluationResult {
  ruleScores: Record<string, { score: number; weight: number; details: Record<string, unknown> }>;
  composite: number;     // 0..1
  verdict: Verdict;
}
