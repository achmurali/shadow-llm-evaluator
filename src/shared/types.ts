export type Json =
  | string | number | boolean | null
  | Json[] | { [key: string]: Json };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id?: string;
  type: 'function';
  function: { name: string; arguments: string }; // arguments is a JSON string
}

export interface ChatRequest {
  model: string;                 // primary
  messages: ChatMessage[];
  candidates?: string[];         // extension: shadow candidates
  tools?: Json;
  response_format?: Json;
  temperature?: number;
}

/** What the heuristic engine actually compares. */
export interface Comparable {
  content: Json | null;          // parsed assistant JSON content (null if unparseable)
  parseError: boolean;
  toolCalls: ToolCall[];
}

export const EVAL_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
export type EvalStatus = (typeof EVAL_STATUSES)[number];
export function isEvalStatus(v: unknown): v is EvalStatus {
  return typeof v === 'string' && (EVAL_STATUSES as readonly string[]).includes(v);
}

export type Verdict = 'pass' | 'fail';
