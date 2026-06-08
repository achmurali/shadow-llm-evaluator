import { describe, it, expect } from 'vitest';
import { checkAdmin, checkRequestAuth } from '../../src/api/auth.js';

describe('auth', () => {
  it('admin requires matching key', () => {
    expect(checkAdmin('secret', { authorization: 'Bearer secret' })).toBe(true);
    expect(checkAdmin('secret', { authorization: 'Bearer nope' })).toBe(false);
    expect(checkAdmin('secret', {})).toBe(false);
  });
  it('request auth is open when AUTH_KEY unset', () => {
    expect(checkRequestAuth(undefined, {})).toBe(true);
  });
  it('request auth enforced when AUTH_KEY set', () => {
    expect(checkRequestAuth('k', { authorization: 'Bearer k' })).toBe(true);
    expect(checkRequestAuth('k', {})).toBe(false);
  });
});
