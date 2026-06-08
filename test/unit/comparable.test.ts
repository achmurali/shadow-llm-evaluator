import { describe, it, expect } from 'vitest';
import { extractComparable } from '../../src/shared/providers/comparable.js';

describe('extractComparable', () => {
  it('parses JSON content', () => {
    const c = extractComparable({ choices: [{ message: { role: 'assistant', content: '{"a":1}' } }] });
    expect(c.content).toEqual({ a: 1 });
    expect(c.parseError).toBe(false);
    expect(c.toolCalls).toEqual([]);
  });
  it('flags unparseable content', () => {
    const c = extractComparable({ choices: [{ message: { role: 'assistant', content: 'not json' } }] });
    expect(c.parseError).toBe(true);
    expect(c.content).toBeNull();
  });
  it('parses JSON wrapped in a markdown code fence', () => {
    const c = extractComparable({ choices: [{ message: { role: 'assistant',
      content: '```json\n{"a":1,"b":"x"}\n```' } }] });
    expect(c.content).toEqual({ a: 1, b: 'x' });
    expect(c.parseError).toBe(false);
  });
  it('captures tool calls', () => {
    const c = extractComparable({ choices: [{ message: { role: 'assistant', content: null,
      tool_calls: [{ type: 'function', function: { name: 'f', arguments: '{"x":1}' } }] } }] });
    expect(c.toolCalls.length).toBe(1);
  });
});
