import { ModelProvider, ProviderChatRequest, ProviderChatResponse } from './types.js';

type FetchFn = typeof fetch;

export class DOInferenceProvider implements ModelProvider {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private timeoutMs: number,
    private fetchFn: FetchFn = fetch
  ) {}

  async chat(modelName: string, req: ProviderChatRequest): Promise<ProviderChatResponse> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: modelName, ...req }),
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error(`DO inference error ${res.status}: ${await res.text()}`);
      return (await res.json()) as ProviderChatResponse;
    } finally {
      clearTimeout(t);
    }
  }
}
