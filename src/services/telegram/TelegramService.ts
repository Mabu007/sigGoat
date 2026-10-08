/**
 * TELEGRAM SERVICE
 * ================
 * Server-side Telegram integration:
 *  - sends clearly-formatted GOAT messages (status, signals, test, chat replies);
 *  - validates webhook updates and routes them through per-user handlers so
 *    the router — not this service — owns persistence and identity.
 *
 * All messages are informational. No trade execution exists anywhere in the
 * platform; signals are manual-execution ideas by design.
 */

import { TradeSignal, GoatRuntimeState } from '../../types';
import type { GoatReasoningContext } from '../ai/OpenRouterClient';
import type { ReasoningGateway } from '../../server/reasoningGateway';

export interface TelegramSendMessageResponse {
  ok: boolean;
  description?: string;
  result?: unknown;
}

/** Per-chat resolution of the GOAT and credentials, supplied by the router. */
export interface TelegramResolution {
  goat: { id: string; userId: string; name: string; model: string };
  state: GoatRuntimeState;
  reasoningContext: GoatReasoningContext;
  model: string;
  /** The reasoning gateway to answer chat questions (web chat parity). */
  gateway: ReasoningGateway;
  /**
   * Forces a full reasoning run (manual "analyse now"). Optional so existing
   * callers/tests that only need chat keep working.
   */
  requestAnalysis?: (reason: string) => Promise<string>;
}

export interface TelegramUpdateHandlers {
  resolveGoatForChat: (chatId: string) => Promise<TelegramResolution | null>;
  getBotTokenForUser: (userId: string) => Promise<string | undefined>;
}

interface ParsedMessage {
  chatId: string;
  text: string;
}

export class TelegramService {
  private fallbackBotToken?: string;

  constructor(fallbackBotToken?: string) {
    this.fallbackBotToken = fallbackBotToken || process.env.TELEGRAM_BOT_TOKEN;
  }

  setBotToken(token: string): void {
    this.fallbackBotToken = token;
  }

  getBotToken(): string | undefined {
    return this.fallbackBotToken;
  }

  /* ---------------------------------------------------------------- */
  /* Message formatting (canonical TradeSignal only)                    */
  /* ---------------------------------------------------------------- */

  formatSignalMessage(signal: TradeSignal, goatName: string): string {
    if (signal.direction === 'NO_TRADE' || signal.status !== 'ACTIONABLE') {
      return (
        `🐐 *${goatName.toUpperCase()} · MARKET UPDATE*\n\n` +
        `Market: \`${signal.market}\`\n` +
        `Decision: *NO TRADE*\n\n` +
        `*Reason:* ${signal.rationale.slice(0, 800)}\n\n` +
        `_SignalGOAT: manual analysis only — no order has been placed._`
      );
    }

    const emoji = signal.direction === 'LONG' ? '🟢' : '🔴';
    const orderLabel =
      signal.orderType === 'LIMIT'
        ? 'Buy/Sell Limit'
        : signal.orderType === 'STOP'
          ? 'Stop Order'
          : 'Market Reference';

    return (
      `🐐 *${signal.market} · CONDITIONAL SETUP*\n\n` +
      `${emoji} *${signal.direction} · ${orderLabel}*\n\n` +
      (signal.entryZone
        ? `*Entry Zone:* \`${signal.entryZone.low} - ${signal.entryZone.high}\`\n`
        : signal.entry !== undefined
          ? `*Entry:* \`${signal.entry}\`\n`
          : '') +
      (signal.stopLoss !== undefined ? `*Invalidation (Stop):* \`${signal.stopLoss}\`\n` : '') +
      (signal.takeProfit !== undefined ? `*Target:* \`${signal.takeProfit}\`\n` : '') +
      (signal.riskReward ? `\n*R:R:* ${signal.riskReward} · *Confidence:* ${signal.confidence}%\n` : `\n*Confidence:* ${signal.confidence}%\n`) +
      `\n*Thesis:*\n${signal.thesis.slice(0, 600)}\n\n` +
      `*Confirmation Required:*\n${signal.confirmationRequired.slice(0, 300)}\n\n` +
      `*Why this setup exists:*\n${signal.rationale.slice(0, 600)}\n\n` +
      `_Analyst: ${goatName}_\n` +
      `_Manual execution only on your own broker — SignalGOAT never places orders._`
    );
  }

  /* ---------------------------------------------------------------- */
  /* Outbound sends                                                     */
  /* ---------------------------------------------------------------- */

  async sendSignalNotification(
    chatId: string,
    signal: TradeSignal,
    goatName: string,
    botToken?: string,
  ): Promise<TelegramSendMessageResponse> {
    const token = botToken || this.fallbackBotToken;
    if (!token || !chatId) {
      return { ok: false, description: 'Telegram credentials missing.' };
    }
    return this.sendMessage(chatId, this.formatSignalMessage(signal, goatName), token);
  }

  /**
   * A tracked condition was satisfied.
   *
   * This is NOT a signal and NOT an instruction to trade — it is one of the
   * wait-for conditions in the GOAT's plan coming true, which the user
   * explicitly asked to be alerted on.
   */
  formatTrackerTriggerMessage(
    goatName: string,
    trigger: {
      description: string;
      market: string;
      formula?: string;
      calculatedValue?: number;
      currentValue?: number;
    },
  ): string {
    return (
      `🎯 *${goatName.toUpperCase()} · CONDITION MET*\n\n` +
      `Market: \`${trigger.market}\`\n` +
      `Waiting for: ${trigger.description}\n` +
      (trigger.formula
        ? `Condition: \`${trigger.formula}\`\n`
        : '') +
      (trigger.calculatedValue !== undefined
        ? `Current value: \`${trigger.calculatedValue}\`\n`
        : '') +
      `\n_One of your GOAT's wait-for conditions is now satisfied. ` +
      `Re-analysing now — this is not an instruction to trade._`
    );
  }

  async sendTrackerTriggered(
    chatId: string,
    goatName: string,
    trigger: {
      description: string;
      market: string;
      formula?: string;
      calculatedValue?: number;
      currentValue?: number;
    },
    botToken?: string,
  ): Promise<TelegramSendMessageResponse> {
    const token = botToken || this.fallbackBotToken;
    if (!token || !chatId) {
      return { ok: false, description: 'Telegram credentials missing.' };
    }

    return this.sendMessage(
      chatId,
      this.formatTrackerTriggerMessage(goatName, trigger),
      token,
    );
  }

  async sendTestMessage(chatId: string, botToken?: string): Promise<TelegramSendMessageResponse> {
    const token = botToken || this.fallbackBotToken;
    if (!token || !chatId) {
      return { ok: false, description: 'Missing Bot Token or Chat ID.' };
    }

    const text =
      `🐐 *SignalGOAT Connected!*\n\n` +
      `Your Telegram is now linked to your AI Signal GOAT.\n\n` +
      `You'll receive clearly-labelled conditional trade ideas and market review summaries.\n` +
      `Signals are informational — execution is always manual, on your own broker.\n\n` +
      `While a GOAT is watching, you can chat with it directly.\n\n` +
      `_Note: if the GOAT is in DEMO mode (no AI model connected), replies will say so instead of pretending to analyze the market._`;

    return this.sendMessage(chatId, text, token);
  }

  async sendMessage(
    chatId: string,
    text: string,
    botToken?: string,
  ): Promise<TelegramSendMessageResponse> {
    const token = botToken || this.fallbackBotToken;
    if (!token || !chatId) {
      return { ok: false, description: 'No bot token configured.' };
    }

    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }),
      });
      return (await res.json()) as TelegramSendMessageResponse;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'unknown error';
      console.error('[telegram] sendMessage error:', message);
      return { ok: false, description: message };
    }
  }

  /* ---------------------------------------------------------------- */
  /* Webhook updates                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Validates a Telegram update and dispatches it. The router supplies
   * the per-user resolution callbacks. Returns a small ack for the webhook.
   */
  async processUpdate(
    update: unknown,
    handlers: TelegramUpdateHandlers,
  ): Promise<{ handled: boolean; reason?: string }> {
    const parsed = this.parseMessage(update);

    if (!parsed) {
      return { handled: false, reason: 'unsupported_update' };
    }

    const { chatId, text } = parsed;

    let resolved: TelegramResolution | null;
    let botToken: string | undefined;
    try {
      resolved = await handlers.resolveGoatForChat(chatId);
      botToken = resolved ? await handlers.getBotTokenForUser(resolved.goat.userId) : undefined;
    } catch (err) {
      console.error('[telegram] update resolution failed:', err);
      return { handled: false, reason: 'resolution_error' };
    }

    if (!resolved) {
      const welcome =
        '🐐 Welcome to SignalGOAT!\n\nNo GOAT is linked to this chat yet. Open the SignalGOAT app, connect your bot token and chat id in Settings, then create a GOAT.';
      await this.sendMessage(chatId, welcome, botToken || this.fallbackBotToken);
      return { handled: true };
    }

    if (!botToken) {
      botToken = this.fallbackBotToken;
    }

    if (text.startsWith('/start') || text.startsWith('/status')) {
      if (text.startsWith('/status')) {
        await this.sendMessage(
          chatId,
          this.formatStatusMessage(resolved.goat.name, resolved.state),
          botToken,
        );
        return { handled: true };
      }
      await this.sendTestMessage(chatId, botToken);
      return { handled: true };
    }

    /**
     * /analyse [market] — force a full reasoning run on demand. This is the
     * Telegram equivalent of the in-app chat trigger, so the user never has
     * to wait for the next scheduled interval.
     */
    if (text.startsWith('/analyse') || text.startsWith('/analyze')) {
      if (!resolved.requestAnalysis) {
        await this.sendMessage(
          chatId,
          'Manual analysis is not available for this GOAT right now.',
          botToken,
        );
        return { handled: true };
      }

      await this.sendMessage(
        chatId,
        `🔄 Running a fresh analysis for *${resolved.goat.name}*… this takes a few seconds.`,
        botToken,
      );

      try {
        const summary = await resolved.requestAnalysis(
          'Manual analysis requested from Telegram',
        );
        await this.sendMessage(chatId, summary.slice(0, 4000), botToken);
      } catch (err) {
        await this.sendMessage(
          chatId,
          `The analysis could not be completed: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
          botToken,
        );
      }

      return { handled: true };
    }

    // Canonical chat path — same gateway + context the web chat API uses.
    let answer: string;
    try {
      answer = await resolved.gateway.answerGoatQuestion(text, resolved.reasoningContext, resolved.model);
    } catch (err) {
      answer =
        err instanceof Error && /timed out|unavailable|failed|invalid/i.test(err.message)
          ? `I could not answer just now: ${err.message}`
          : 'I could not process that question. Please try again shortly.';
    }

    await this.sendMessage(chatId, answer.slice(0, 4000), botToken);
    return { handled: true };
  }

  /** Small truthful status summary drawn from the runtime state (not fabricated). */
  formatStatusMessage(goatName: string, state: GoatRuntimeState): string {
    const lines = [`🐐 *${goatName.toUpperCase()} · STATUS*\n`];
    lines.push(`State: ${state.status}${state.isEvaluating ? ' (evaluating…)' : ''}`);
    lines.push(`Data source: ${state.dataSource}`);
    lines.push(`Reasoning mode: ${state.reasoningMode}`);
    if (state.currentThesis) {
      lines.push(`\n*Current thesis* (${state.currentThesis.directionalHypothesis}): ${state.currentThesis.confidence}% confidence`);
    } else {
      lines.push('\nNo active thesis yet.');
    }
    if (state.latestSignal) {
      lines.push(`\n${this.formatSignalMessage(state.latestSignal, goatName)}`);
    }
    return lines.join('\n').slice(0, 4000);
  }

  private parseMessage(update: unknown): ParsedMessage | null {
    if (typeof update !== 'object' || update === null) return null;
    const u = update as Record<string, unknown>;
    const message = typeof u.message === 'object' && u.message !== null ? (u.message as Record<string, unknown>) : null;
    if (!message) return null;

    const chat = typeof message.chat === 'object' && message.chat !== null ? (message.chat as Record<string, unknown>) : null;
    const chatId = chat !== null && (typeof chat.id === 'number' || typeof chat.id === 'string') ? String(chat.id) : null;
    if (!chatId) return null;

    const text = typeof message.text === 'string' ? message.text.trim() : '';
    return { chatId, text };
  }
}
export const telegramService = new TelegramService();
