import { describe, it, expect, vi, afterEach } from 'vitest';
import { DOInferenceProvider } from '../../src/shared/providers/do-inference.js';

afterEach(() => vi.restoreAllMocks());

describe('DOInferenceProvider', () => {
  it('POSTs to /chat/completions with bearer auth', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    ));
    const p = new DOInferenceProvider('https://x/v1', 'key', 30000, fetchMock as any);
    const r = await p.chat('model-x', { messages: [{ role: 'user', content: 'hi' }] });
    expect(r.choices[0].message.content).toBe('{"ok":true}');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://x/v1/chat/completions');
    expect((init as any).headers.Authorization).toBe('Bearer key');
    expect(JSON.parse((init as any).body).model).toBe('model-x');
  });

  it('throws on non-2xx', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }));
    const p = new DOInferenceProvider('https://x/v1', 'key', 30000, fetchMock as any);
    await expect(p.chat('m', { messages: [] })).rejects.toThrow(/500/);
  });
});
