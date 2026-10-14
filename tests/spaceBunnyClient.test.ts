import { describe, test, expect } from 'bun:test';
import { SpaceBunnyClient, SPACE_BUNNY_MODEL } from '../src/services/ai/SpaceBunnyClient';

describe('Space Bunny hosted API adapter', () => {
  test('probes the documented OpenAI-compatible endpoint with the Space Bunny key', async () => {
    let requestedUrl = '';
    let requestInit: RequestInit | undefined;
    const client = new SpaceBunnyClient({
      apiKey: `sb_live_${'a1b2c3d4'.repeat(4)}`,
      fetchImpl: async (url, init) => {
        requestedUrl = url;
        requestInit = init;
        return new Response(JSON.stringify({
          model: SPACE_BUNNY_MODEL,
          choices: [{ message: { content: 'SIRGOAT_SPACE_BUNNY_CONNECTION_OK' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    const result = await client.testConnection();
    expect(result.ok).toBe(true);
    expect(result.model).toBe('space-bunny-alpha');
    expect(requestedUrl).toBe('https://spacebunnymodel.com/api/v1/chat/completions');
    expect(new Headers(requestInit?.headers).get('Authorization')).toBe(`Bearer sb_live_${'a1b2c3d4'.repeat(4)}`);
    expect(JSON.parse(String(requestInit?.body)).model).toBe('space-bunny-alpha');
  });

  test('reports prepaid-credit errors instead of treating them as model output', async () => {
    const client = new SpaceBunnyClient({
      apiKey: `sb_live_${'a1b2c3d4'.repeat(4)}`,
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), { status: 402 }),
    });
    const result = await client.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/credits are insufficient/i);
  });
});
