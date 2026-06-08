import { ChatMessage, Json } from '../types.js';

export interface ProviderChatRequest {
  messages: ChatMessage[];
  tools?: Json;
  response_format?: Json;
  temperature?: number;
}

/** OpenAI-compatible chat completion (the parts we use). */
export interface ProviderChatResponse {
  choices: Array<{ message: ChatMessage }>;
  [k: string]: Json | undefined;
}

export interface ModelProvider {
  /** modelName is the resolved DO inference model name. */
  chat(modelName: string, req: ProviderChatRequest): Promise<ProviderChatResponse>;
}
