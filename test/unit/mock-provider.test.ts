import { describe, it, expect } from 'vitest';
import { MockProvider } from '../../src/shared/providers/mock.js';

describe('MockProvider', () => {
  it('returns canned JSON content per model', async () => {
    const p = new MockProvider({ A: { a: 1 }, B: { a: 2 } });
    const r = await p.chat('A', { messages: [] });
    expect(JSON.parse(r.choices[0].message.content!)).toEqual({ a: 1 });
  });
});
