import { ModelProvider, ProviderChatRequest, ProviderChatResponse } from './types.js';

/** Deterministic provider for tests/demo. Maps modelName -> canned JSON content. */
export class MockProvider implements ModelProvider {
  constructor(private responses: Record<string, unknown>, private latencyMs = 1) {}
  async chat(modelName: string, _req: ProviderChatRequest): Promise<ProviderChatResponse> {
    const payload = this.responses[modelName] ?? { echo: modelName };
    return { choices: [{ message: { role: 'assistant', content: JSON.stringify(payload) } }] };
  }
}
