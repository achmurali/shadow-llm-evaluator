import { Comparable } from '../types.js';
import { ProviderChatResponse } from './types.js';

/** Strip a leading/trailing Markdown code fence (```json ... ```), which some
 *  models emit around JSON even when asked for a raw JSON object. */
export function stripCodeFence(s: string): string {
  const t = s.trim();
  if (!t.startsWith('```')) return t;
  return t
    .replace(/^```[a-zA-Z0-9_-]*\s*\n?/, '') // opening fence + optional lang tag
    .replace(/\n?```\s*$/, '')               // closing fence
    .trim();
}

export function extractComparable(resp: ProviderChatResponse): Comparable {
  const msg = resp.choices?.[0]?.message;
  const toolCalls = msg?.tool_calls ?? [];
  const raw = msg?.content;
  if (raw == null || raw === '') return { content: null, parseError: toolCalls.length === 0, toolCalls };
  try {
    return { content: JSON.parse(stripCodeFence(raw)), parseError: false, toolCalls };
  } catch {
    return { content: null, parseError: true, toolCalls };
  }
}
