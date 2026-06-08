import { Comparable } from '../types.js';
import { ProviderChatResponse } from './types.js';

export function extractComparable(resp: ProviderChatResponse): Comparable {
  const msg = resp.choices?.[0]?.message;
  const toolCalls = msg?.tool_calls ?? [];
  const raw = msg?.content;
  if (raw == null || raw === '') return { content: null, parseError: toolCalls.length === 0, toolCalls };
  try {
    return { content: JSON.parse(raw), parseError: false, toolCalls };
  } catch {
    return { content: null, parseError: true, toolCalls };
  }
}
