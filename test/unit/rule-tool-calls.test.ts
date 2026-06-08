import { describe, it, expect } from 'vitest';
import { toolCallsRule } from '../../src/shared/heuristics/rules/tool-calls.js';
import { Comparable, ToolCall } from '../../src/shared/types.js';
const tc = (name: string, args: object): ToolCall => ({ type: 'function', function: { name, arguments: JSON.stringify(args) } });
const cmp = (toolCalls: ToolCall[]): Comparable => ({ content: null, parseError: false, toolCalls });

describe('toolCallsRule', () => {
  it('1 when same tools + args', () => {
    const r = toolCallsRule.evaluate(cmp([tc('search', { q: 'x' })]), cmp([tc('search', { q: 'x' })]), { options: {} });
    expect(r.score).toBe(1);
  });
  it('partial when args differ', () => {
    const r = toolCallsRule.evaluate(cmp([tc('search', { q: 'x' })]), cmp([tc('search', { q: 'y' })]), { options: {} });
    expect(r.score).toBe(0.5); // name matches, args do not
  });
  it('1 when neither side calls tools', () => {
    expect(toolCallsRule.evaluate(cmp([]), cmp([]), { options: {} }).score).toBe(1);
  });
  it('0 when primary calls a tool candidate omits', () => {
    expect(toolCallsRule.evaluate(cmp([tc('a', {})]), cmp([]), { options: {} }).score).toBe(0);
  });
});
