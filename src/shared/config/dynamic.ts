import { z } from 'zod';

const RuleConfig = z.object({
  enabled: z.boolean(),
  weight: z.number().min(0),
  options: z.record(z.unknown()).default({})
});

export const DynamicConfigSchema = z.object({
  sampling: z.object({
    rate: z.number().min(0).max(1),
    overrides: z.object({
      model: z.record(z.number().min(0).max(1)).default({}),
      route: z.record(z.number().min(0).max(1)).default({})
    }).default({ model: {}, route: {} }),
    forceHeader: z.string().default('x-shadow-eval')
  }),
  defaultCandidates: z.array(z.string()).default([]),
  heuristics: z.object({
    rules: z.record(RuleConfig),
    verdictThreshold: z.number().min(0).max(1)
  })
});

export type DynamicConfig = z.infer<typeof DynamicConfigSchema>;

export const DEFAULT_CONFIG: DynamicConfig = {
  sampling: { rate: 0.2, overrides: { model: {}, route: {} }, forceHeader: 'x-shadow-eval' },
  defaultCandidates: ['candidate-mistral'],
  heuristics: {
    verdictThreshold: 0.8,
    rules: {
      structural:       { enabled: true, weight: 2, options: {} },
      'exact-match':    { enabled: true, weight: 2, options: {} },
      'text-similarity':{ enabled: true, weight: 1, options: {} },
      'numeric-tolerance':{ enabled: true, weight: 1, options: { absTol: 0, relTol: 0.01 } },
      'tool-calls':     { enabled: true, weight: 2, options: {} }
    }
  }
};
