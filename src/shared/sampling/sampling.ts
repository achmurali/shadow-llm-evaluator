import { DynamicConfig } from '../config/dynamic.js';

type Sampling = DynamicConfig['sampling'];
export interface SampleInput { model: string; route: string; forced: boolean; }

export function shouldSample(
  sampling: Sampling,
  input: SampleInput,
  rng: () => number = Math.random
): boolean {
  if (input.forced) return true;
  const rate =
    sampling.overrides.model[input.model] ??
    sampling.overrides.route[input.route] ??
    sampling.rate;
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return rng() < rate;
}
