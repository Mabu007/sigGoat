import { describe, test, expect } from 'bun:test';
import { SpaceBunnyClient, SPACE_BUNNY_MODEL } from '../src/services/ai/SpaceBunnyClient';
import type { GoatReasoningContext } from '../src/services/ai/OpenRouterClient';

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

  test('uses JSON-constrained output for GOAT reasoning, not for ordinary chat', async () => {
    let reasoningBody: Record<string, unknown> | undefined;
    const context = { userId: 'user-1', goatId: 'goat-1', wakeReason: 'MANUAL_REEVALUATE' } as unknown as GoatReasoningContext;
    const client = new SpaceBunnyClient({
      apiKey: `sb_live_${'a1b2c3d4'.repeat(4)}`,
      fetchImpl: async (_url, init) => {
        reasoningBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
          usage: { completion_tokens: 12 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    await expect(client.evaluateGoat(context)).rejects.toThrow(/Reasoning result failed validation/i);
    expect(reasoningBody?.model).toBe(SPACE_BUNNY_MODEL);
    expect(reasoningBody?.response_format).toEqual({ type: 'json_object' });
    expect(reasoningBody?.reasoning).toEqual({ effort: 'medium' });
    expect(reasoningBody?.max_tokens).toBe(4096);

    let chatBody: Record<string, unknown> | undefined;
    const chatClient = new SpaceBunnyClient({
      apiKey: `sb_live_${'a1b2c3d4'.repeat(4)}`,
      fetchImpl: async (_url, init) => {
        chatBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'Hello from Space Bunny.' }, finish_reason: 'stop' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });
    const chat = await chatClient.answerQuestion('Say hello', context);
    expect(chat.answer).toBe('Hello from Space Bunny.');
    expect(chatBody?.response_format).toBeUndefined();
  });

  test('retries one empty structured completion and exposes finish diagnostics', async () => {
    let calls = 0;
    const context = { userId: 'user-1', goatId: 'goat-1', wakeReason: 'MANUAL_REEVALUATE' } as unknown as GoatReasoningContext;
    const client = new SpaceBunnyClient({
      apiKey: `sb_live_${'a1b2c3d4'.repeat(4)}`,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify(calls === 1
          ? { choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { completion_tokens: 4096 } }
          : { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    await expect(client.evaluateGoat(context)).rejects.toThrow(/Reasoning result failed validation/i);
    expect(calls).toBe(2);
  });

  test('does not spend a second provider request retrying an empty backtest completion', async () => {
    let calls = 0;
    const context = { userId: 'user-1', goatId: 'goat-1', wakeReason: 'BACKTEST_REPLAY' } as unknown as GoatReasoningContext;
    const client = new SpaceBunnyClient({
      apiKey: `sb_live_${'a1b2c3d4'.repeat(4)}`,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          choices: [{ message: { content: '' }, finish_reason: 'length' }],
          usage: { completion_tokens: 4096 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    await expect(client.evaluateGoat(context)).rejects.toThrow(/no message content.*finish_reason=length.*completion_tokens=4096/i);
    expect(calls).toBe(1);
  });

});