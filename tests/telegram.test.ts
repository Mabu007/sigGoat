import { describe, test, expect } from 'bun:test';
import { TelegramService, TelegramResolution } from '../src/services/telegram/TelegramService';
import type { ReasoningGateway } from '../src/server/reasoningGateway';
import { GoatReasoningContext } from '../src/services/ai/OpenRouterClient';
import { GoatRuntimeState, TradeSignal } from '../src/types';

function makeUpdate(text: string): unknown {
  return { update_id: 1, message: { chat: { id: 42 }, text } };
}

function makeResolution(overrides: Partial<TelegramResolution> = {}): TelegramResolution {
  const gateway: ReasoningGateway = {
    evaluateGoat: async () => {
      throw new Error('not used here');
    },
    answerGoatQuestion: async (q) => `Echo: ${q}`,
    hasKeyFor: async () => false,
    listModels: async () => ({ models: [], provider: 'openrouter', fetchedAt: 0, source: 'stub' }),
    providerFor: async () => 'openrouter',
    testKeyFor: async () => ({ ok: false, provider: 'openrouter', latencyMs: 0, error: 'not used here' }),
    invalidate: () => {},
  };

  const state: GoatRuntimeState = {
    goatId: 'g1',
    status: 'WATCHING',
    currentThesis: null,
    trackers: [],
    lastWakeEvent: null,
    recentWakeEvents: [],
    latestSignal: null,
    dormancyReason: 'test',
    nextWatchingCondition: 'test',
    generationId: 'gen_1',
    lastEvaluatedAt: Date.now(),
    isEvaluating: false,
    consecutiveFailures: 0,
    dataSource: 'PAPER',
    reasoningMode: 'DEMO',
  };

  const context: GoatReasoningContext = {
    userId: 'u1',
    goatId: 'g1',
    goatName: 'Test Goat',
    goatGoal: 'test',
    market: 'EUR/USD',
    skills: [],
    activeThesis: null,
    dataSource: 'PAPER',
  };

  return {
    goat: { id: 'g1', userId: 'u1', name: 'Test Goat', model: 'openai/gpt-4o-mini' },
    state,
    reasoningContext: context,
    model: 'openai/gpt-4o-mini',
    gateway,
    ...overrides,
  };
}

/** Capture outbound messages instead of hitting the real Telegram API. */
class CapturingTelegram extends TelegramService {
  sent: Array<{ chatId: string; text: string }> = [];

  override async sendMessage(chatId: string, text: string): Promise<{ ok: true }> {
    this.sent.push({ chatId, text });
    return { ok: true };
  }
}

describe('TelegramService.processUpdate', () => {
  test('non-message updates are ignored, not processed', async () => {
    const svc = new CapturingTelegram();
    const result = await svc.processUpdate(
      { update_id: 1, callback_query: { data: 'x' } },
      {
        resolveGoatForChat: async () => {
          throw new Error('must not resolve');
        },
        getBotTokenForUser: async () => undefined,
      },
    );
    expect(result.handled).toBe(false);
    expect(result.reason).toBe('unsupported_update');
    expect(svc.sent.length).toBe(0);
  });

  test('an unlinked chat is acknowledged and fabricates nothing', async () => {
    const svc = new CapturingTelegram();
    const result = await svc.processUpdate(makeUpdate("What's your thesis?"), {
      resolveGoatForChat: async () => null,
      getBotTokenForUser: async () => undefined,
    });

    /**
     * Handled, and NOTHING sent.
     *
     * An unlinked chat resolves to no user, so there is no per-user bot token
     * to send with. The previous behaviour fell back to the server-wide
     * TELEGRAM_BOT_TOKEN, which meant any chat id that found the webhook got a
     * reply from the platform's own bot — and, because the chat path then
     * resolved whichever GOAT the chat mapped to, an unlinked-looking chat
     * could be granted conversational access to a user's GOAT.
     *
     * The webhook is still acknowledged truthfully so Telegram does not retry
     * forever, and no market content is invented.
     */
    expect(result.handled).toBe(true);
    expect(svc.sent.length).toBe(0);
  });

  test('an unlinked chat never receives a message through the shared server bot', async () => {
    /**
     * A server-wide token is configured, which is exactly the situation that
     * used to leak. No user token can be resolved, so nothing may be sent.
     */
    const svc = new CapturingTelegram('server-wide-shared-token');
    const result = await svc.processUpdate(makeUpdate('/processes'), {
      resolveGoatForChat: async () => null,
      getBotTokenForUser: async () => undefined,
    });

    expect(result.handled).toBe(true);
    expect(svc.sent.length).toBe(0);
  });

  test('/start gets the connected message; plain questions go through the canonical gateway', async () => {
    const svc = new CapturingTelegram();
    let resolvedChat: string = '';
    const resolution = makeResolution();

    await svc.processUpdate(makeUpdate('/start'), {
      resolveGoatForChat: async (chatId) => {
        resolvedChat = chatId;
        return resolution;
      },
      getBotTokenForUser: async () => 'token',
    });
    expect(resolvedChat).toBe('42');
    expect(svc.sent[0].text).toContain('FundAGoat Connected');

    svc.sent.length = 0;
    await svc.processUpdate(makeUpdate('What are you watching?'), {
      resolveGoatForChat: async () => resolution,
      getBotTokenForUser: async () => 'token',
    });
    expect(svc.sent[0].text).toContain('Echo: What are you watching?');
  });

  test('/status renders truthful runtime state (data mode + reasoning mode)', async () => {
    const svc = new CapturingTelegram();
    const resolution = makeResolution();
    await svc.processUpdate(makeUpdate('/status'), {
      resolveGoatForChat: async () => resolution,
      getBotTokenForUser: async () => 'token',
    });
    expect(svc.sent[0].text).toContain('STATUS');
    expect(svc.sent[0].text).toContain('PAPER');
    expect(svc.sent[0].text).toContain('DEMO');
  });

  test('gateway failure becomes an honest apology, never a crash', async () => {
    const svc = new CapturingTelegram();
    const resolution = makeResolution({
      gateway: {
        evaluateGoat: async () => {
          throw new Error('no');
        },
        answerGoatQuestion: async () => {
          throw new Error('model unavailable');
        },
        hasKeyFor: async () => false,
        listModels: async () => ({ models: [], provider: 'openrouter', fetchedAt: 0, source: 'stub' }),
        providerFor: async () => 'openrouter',
        testKeyFor: async () => ({ ok: false, provider: 'openrouter', latencyMs: 0, error: 'not used here' }),
        invalidate: () => {},
      },
    });
    const result = await svc.processUpdate(makeUpdate('hello'), {
      resolveGoatForChat: async () => resolution,
      getBotTokenForUser: async () => 'token',
    });
    expect(result.handled).toBe(true);
    expect(svc.sent[0].text).toContain('could not');
  });
});

describe('TelegramService.formatSignalMessage', () => {
  test('ACTIONABLE signal renders order type, entry zone, stop, target and manual-execution notice', () => {
    const svc = new CapturingTelegram();
    const signal: TradeSignal = {
      id: 'sig_1',
      userId: 'u1',
      goatId: 'g1',
      thesisId: 'ths_1',
      market: 'EUR/USD',
      direction: 'LONG',
      orderType: 'LIMIT',
      entry: 1.0845,
      entryZone: { low: 1.0840, high: 1.0850 },
      stopLoss: 1.082,
      takeProfit: 1.092,
      riskReward: '1:3.0',
      confidence: 85,
      thesis: 'Bullish continuation.',
      rationale: 'Demand retest.',
      confirmationRequired: '15m close above entry.',
      invalidation: 'Close below 1.0800.',
      supportingEvidence: ['HH'],
      createdAt: new Date().toISOString(),
      status: 'ACTIONABLE',
      updatedAt: new Date().toISOString(),
    };
    const text = svc.formatSignalMessage(signal, 'Test Goat');
    expect(text).toContain('Buy/Sell Limit');
    expect(text).toContain('1.084 - 1.085');
    expect(text).toContain('1.082');
    expect(text).toContain('1.092');
    expect(text).toContain('never places orders');
  });

  test('NO_TRADE signal renders the honest decision', () => {
    const svc = new CapturingTelegram();
    const signal: TradeSignal = {
      id: 'sig_2',
      userId: 'u1',
      goatId: 'g1',
      thesisId: 'ths_1',
      market: 'EUR/USD',
      direction: 'NO_TRADE',
      orderType: 'MARKET',
      confidence: 40,
      thesis: 'No edge.',
      rationale: 'Evidence insufficient.',
      confirmationRequired: '',
      invalidation: '',
      supportingEvidence: [],
      createdAt: new Date().toISOString(),
      status: 'NO_TRADE',
      updatedAt: new Date().toISOString(),
    };
    const text = svc.formatSignalMessage(signal, 'Test Goat');
    expect(text).toContain('NO TRADE');
    expect(text).toContain('Evidence insufficient.');
  });
});
