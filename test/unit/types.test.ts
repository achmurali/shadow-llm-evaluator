import { describe, it, expect } from 'vitest';
import { EVAL_STATUSES, isEvalStatus } from '../../src/shared/types.js';

describe('eval status', () => {
  it('lists the four statuses', () => {
    expect(EVAL_STATUSES).toEqual(['queued', 'running', 'completed', 'failed']);
  });
  it('guards unknown values', () => {
    expect(isEvalStatus('running')).toBe(true);
    expect(isEvalStatus('nope')).toBe(false);
  });
});
