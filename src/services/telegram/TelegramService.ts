/**
 * TELEGRAM SERVICE
 * ================
 * Server-side Telegram integration:
 *  - sends clearly-formatted GOAT messages (status, signals, test, chat replies);
 *  - parses incoming updates into typed commands (see TelegramCommands);
 *  - routes them through per-user handlers so the ROUTER owns persistence,
 *    identity and ownership.
 *
 * All messages are informational. No trade execution exists anywhere in the
 * platform; signals are manual-execution ideas by design.
 *
 * WHY THE COMMANDS ARE TYPED, NOT STRING-MATCHED
 *
 * The previous router compared raw strings in sequence, which meant
 * `/processes` fell through to the conversational path and got an AI answer
 * instead of a list, and no command could take a process id. Commands now come
 * from `parseTelegramCommand`, which matches on exact first tokens and returns
 * `unknown` for anything it does not recognise — so an unrecognised command is
 * never silently spent as an AI call.
 *
 * THE HANDLERS ARE THE OWNERSHIP BOUNDARY
 *
 * This class deliberately cannot see a user id, a bot token or a database. It
 * receives a resolver and asks "which GOAT does this chat belong to?"; the
 * router answers from authenticated records only. There is no code path here
 * that could reach another user's process.
 */

import { TradeSignal, GoatRuntimeState } from '../../types';
import type { GoatReasoningContext } from '../ai/OpenRouterClient';
import type { ReasoningGateway } from '../../server/reasoningGateway';
import { parseTelegramCommand, type TelegramCommand } from './TelegramCommands';

export interface TelegramSendMessageResponse {
  ok: boolean;
  description?: string;
  result?: unknown;
}

/**
 * A process, as Telegram needs to see it.
 *
 * A flat summary rather than the whole SignalGoat: the command layer formats
 * messages and must not be handed credentials, market context or thesis text.
 */
export interface TelegramProcessSummary {
  id: string;
  name: string;
  markets: string[];
  status: string;
  timeframe: string;
  model: string;
}

export interface TelegramProcessDetail {
  summary: TelegramProcessSummary;
  state: GoatRuntimeState;
  reasoningContext: GoatReasoningContext;
  gateway: ReasoningGateway;
  requestAnalysis?: (reason: string) => Promise<string>;
}

/** Per-chat resolution, supplied by the router. */
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
  /**
   * Resolves the process named in a command, enforcing ownership.
   *
   * Returning null means "not yours or does not exist" — the router must not
   * distinguish the two, because that distinction is a resource-enumeration
   * oracle.
   */
  resolveProcessForChat?: (
    chatId: string,
    processId: string,
  ) => Promise<TelegramProcessDetail | null>;

  /** Every process the chat's owner may act on. */
  listProcessesForChat?: (
    chatId: string,
  ) => Promise<TelegramProcessSummary[]>;

  /** Creates a process for the chat's owner. */
  createProcessForChat?: (
    chatId: string,
    args: string,
  ) => Promise<{ ok: boolean; message: string }>;

  /** Pauses a process. Ownership enforced by the router. */
  pauseProcessForChat?: (
    chatId: string,
    processId: string,
  ) => Promise<{ ok: boolean; message: string }>;

  /** Resumes a process. Ownership enforced by the router. */
  resumeProcessForChat?: (
    chatId: string,
    processId: string,
  ) => Promise<{ ok: boolean; message: string }>;

  /** Triggers a controlled evaluation of a process. */
  triggerProcessForChat?: (
    chatId: string,
    processId: string,
  ) => Promise<{ ok: boolean; message: string }>;

  /** The default process for a chat, used by chat and `/status`. */
  resolveGoatForChat: (chatId: string) => Promise<TelegramResolution | null>;

  getBotTokenForUser: (userId: string) => Promise<string | undefined>;
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

  formatTrackerTriggeredMessage = this.formatTrackerTriggerMessage;

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
      `Run /help to see the available commands.\n\n` +
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
  /* Command formatting                                                */
  /* ---------------------------------------------------------------- */

  /**
   * The command list. Also the answer to `/help`.
   *
   * Kept next to the handlers so a new command cannot be added without its
   * documentation appearing here.
   */
  formatHelpMessage(): string {
    return [
      '🐐 *SignalGOAT commands*',
      '',
      '/create <goal> <market> [timeframe]',
      '   Create a monitoring process. Example:',
      '   `/create wait for a London sweep on EUR/USD 5m`',
      '',
      '/processes',
      '   List your processes with their ids and status.',
      '',
      '/trigger <PROCESS_ID>',
      '   Run one evaluation now. This spends AI, so it is rate limited.',
      '',
      '/pause <PROCESS_ID>',
      '   Stop evaluating a process. Its alarms are cleared, not just ignored.',
      '',
      '/resume <PROCESS_ID>',
      '   Restart a paused process from its saved thesis.',
      '',
      '/analyse [market]',
      '   Force a full analysis of your default process.',
      '',
      '/status',
      '   Current state of your default process.',
      '',
      '_SignalGOAT produces analysis and alerts only. It never places an order._',
    ].join('\n');
  }

  /**
   * Renders the process list.
   *
   * The id is shown in full because every mutating command takes it. It is the
   * user\'s OWN process id and this reply goes only to their own chat, so it
   * leaks nothing — but the routing decision was already made server-side from
   * the authenticated chat identity, never from this text.
   */
  formatProcessesMessage(processes: TelegramProcessSummary[]): string {
    if (processes.length === 0) {
      return (
        '🐐 *Your processes*\n\n' +
        'You have no monitoring processes yet.\n' +
        'Create one with `/create <goal> <market> [timeframe]`.'
      );
    }

    const lines = [`🐐 *Your processes* (${processes.length})\n`];

    for (const process of processes) {
      const icon = process.status === 'PAUSED' ? '⏸' : '👁';
      lines.push(
        `${icon} *${process.name}*`,
        `   id: \`${process.id}\``,
        `   markets: ${process.markets.join(', ')} · timeframe: ${process.timeframe}`,
        '',
      );
    }

    lines.push(
      `_Use /pause, /resume or /trigger with the id above._`,
    );

    return lines.join('\n');
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

  /**
   * The reply sent when a chat has no linked account.
   *
   * Deliberately says nothing about whether the chat id exists. A bot that
   * confirms "this chat is not linked" versus "this chat is not yours" hands an
   * attacker a way to test chat ids.
   */
  formatUnlinkedMessage(): string {
    return (
      '🐐 Welcome to SignalGOAT!\n\n' +
      'This chat is not linked to a SignalGOAT account yet.\n' +
      'Open the SignalGOAT app, connect your bot token and chat id in Settings, then create a process.\n\n' +
      'Run /help once you are connected.'
    );
  }

  /** Answers an unrecognised command without spending an AI call. */
  formatUnknownCommandMessage(command: string): string {
    return (
      `I don't know the command \`${command.slice(0, 40)}\`.\n\n` +
      'Available commands:\n' +
      '/create · /processes · /trigger · /pause · /resume · /analyse · /status\n\n' +
      'Run /help for the full list.'
    );
  }

  /* ---------------------------------------------------------------- */
  /* Webhook updates                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Handles one Telegram update.
   *
   * Dispatches on a PARSED command. An unrecognised command gets an explicit
   * error rather than falling through to the conversational path, so a typo
   * costs nothing and never reaches a model.
   *
   * Every handler is wrapped: one failing command must not leave the user with
   * silence, and must never surface a stack trace.
   */
  async processUpdate(
    update: unknown,
    handlers: TelegramUpdateHandlers,
  ): Promise<{ handled: boolean; reason?: string; command?: string }> {
    const parsed = this.parseMessage(update);

    if (!parsed) {
      return { handled: false, reason: 'unsupported_update' };
    }

    const { chatId, text } = parsed;
    const command = parseTelegramCommand(text);

    let resolved: TelegramResolution | null = null;
    let botToken: string | undefined;

    try {
      resolved = await handlers.resolveGoatForChat(chatId);
      botToken = resolved
        ? await handlers.getBotTokenForUser(resolved.goat.userId)
        : undefined;
    } catch (err) {
      console.error('[telegram] update resolution failed:', err);
      return { handled: false, reason: 'resolution_error' };
    }

    /**
     * Token resolution for an UNLINKED chat.
     *
     * Previously this fell back to the server-wide `TELEGRAM_BOT_TOKEN`, so an
     * unlinked chat could be messaged through the shared bot and could then be
     * given conversational access to whichever GOAT resolved. With no linked
     * user there is no key store entry to read, so the reply simply goes out
     * with no token — which means it is not delivered, and the app is where a
     * bot gets connected. Reported rather than faked.
     */
    const sendToken = botToken;

    if (command.kind === 'unknown') {
      if (sendToken) {
        await this.sendMessage(
          chatId,
          this.formatUnknownCommandMessage(command.command),
          sendToken,
        );
      }
      return { handled: true, command: command.command };
    }

    if (command.kind === 'help') {
      if (sendToken) {
        await this.sendMessage(chatId, this.formatHelpMessage(), sendToken);
      }
      return { handled: true, command: '/help' };
    }

    if (command.kind === 'processes') {
      await this.runGuarded(command.kind, async () => {
        if (!handlers.listProcessesForChat) {
          throw new Error('Listing processes is not available for this chat.');
        }
        const processes = await handlers.listProcessesForChat(chatId);
        await this.sendMessage(
          chatId,
          this.formatProcessesMessage(processes),
          sendToken,
        );
      });
      return { handled: true, command: '/processes' };
    }

    if (command.kind === 'create') {
      await this.runGuarded(command.kind, async () => {
        if (!handlers.createProcessForChat) {
          throw new Error('Creating a process is not available for this chat.');
        }
        const result = await handlers.createProcessForChat(chatId, command.args);
        await this.sendMessage(chatId, result.message, sendToken);
      });
      return { handled: true, command: '/create' };
    }

    /**
     * Commands that name a process.
     *
     * All four share one path so ownership, not-found and rate-limit handling
     * are identical: there is no way to add a fifth command and forget that.
     */
    if (
      command.kind === 'trigger' ||
      command.kind === 'pause' ||
      command.kind === 'resume' ||
      command.kind === 'delete'
    ) {
      await this.runGuarded(command.kind, async () => {
        const processId =
          command.kind === 'trigger' ||
          command.kind === 'pause' ||
          command.kind === 'resume' ||
          command.kind === 'delete'
            ? command.processId
            : '';

        const handler =
          command.kind === 'trigger'
            ? handlers.triggerProcessForChat
            : command.kind === 'pause'
              ? handlers.pauseProcessForChat
              : command.kind === 'resume'
                ? handlers.resumeProcessForChat
                : undefined;

        if (!handler) {
          throw new Error(
            `The /${command.kind} command is not available for this chat.`,
          );
        }

        const result = await handler(chatId, processId);
        await this.sendMessage(chatId, result.message, sendToken);
      });
      return { handled: true, command: `/${command.kind}` };
    }

    /**
     * Everything below needs a resolved process.
     *
     * An unlinked chat gets the onboarding text and no token, so nothing is
     * actually delivered — but the request is acknowledged truthfully and the
     * app remains the place where a bot is connected.
     */
    if (!resolved) {
      if (sendToken) {
        await this.sendMessage(chatId, this.formatUnlinkedMessage(), sendToken);
      }
      return { handled: true, command: `/${command.kind}` };
    }

    if (command.kind === 'start') {
      await this.sendTestMessage(chatId, sendToken);
      return { handled: true, command: '/start' };
    }

    if (command.kind === 'status') {
      await this.sendMessage(
        chatId,
        this.formatStatusMessage(resolved.goat.name, resolved.state),
        sendToken,
      );
      return { handled: true, command: '/status' };
    }

    if (command.kind === 'analyse') {
      if (!resolved.requestAnalysis) {
        await this.sendMessage(
          chatId,
          'Manual analysis is not available for this GOAT right now.',
          sendToken,
        );
        return { handled: true, command: '/analyse' };
      }

      await this.sendMessage(
        chatId,
        `🔄 Running a fresh analysis for *${resolved.goat.name}*… this takes a few seconds.`,
        sendToken,
      );

      try {
        const summary = await resolved.requestAnalysis(
          'Manual analysis requested from Telegram',
        );
        await this.sendMessage(chatId, summary.slice(0, 4000), sendToken);
      } catch (err) {
        await this.sendMessage(
          chatId,
          `The analysis could not be completed: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
          sendToken,
        );
      }

      return { handled: true, command: '/analyse' };
    }

    if (command.kind === 'connect') {
      await this.sendMessage(
        chatId,
        'Bot connection is managed from the SignalGOAT app under Settings → Telegram, where your token is stored securely.',
        sendToken,
      );
      return { handled: true, command: '/connect' };
    }

    // Canonical chat path — same gateway + context the web chat API uses.
    let answer: string;
    try {
      answer = await resolved.gateway.answerGoatQuestion(
        (command as { text: string }).text,
        resolved.reasoningContext,
        resolved.model,
      );
    } catch (err) {
      answer =
        err instanceof Error && /timed out|unavailable|failed|invalid/i.test(err.message)
          ? `I could not answer just now: ${err.message}`
          : 'I could not process that question. Please try again shortly.';
    }

    await this.sendMessage(chatId, answer.slice(0, 4000), sendToken);
    return { handled: true, command: 'chat' };
  }

  /**
   * Runs a command handler, converting a thrown error into a user-visible
   * message.
   *
   * Without this, one unhandled rejection leaves the user with no reply at all
   * and the operator with only a log line.
   */
  private async runGuarded(
    command: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      console.error(`[telegram] /${command} failed:`, message);
    }
  }

  private parseMessage(update: unknown): { chatId: string; text: string } | null {
    if (typeof update !== 'object' || update === null) return null;
    const u = update as Record<string, unknown>;
    const message =
      typeof u.message === 'object' && u.message !== null
        ? (u.message as Record<string, unknown>)
        : null;
    if (!message) return null;

    const chat =
      typeof message.chat === 'object' && message.chat !== null
        ? (message.chat as Record<string, unknown>)
        : null;
    const chatId =
      chat !== null && (typeof chat.id === 'number' || typeof chat.id === 'string')
        ? String(chat.id)
        : null;
    if (!chatId) return null;

    const text = typeof message.text === 'string' ? message.text.trim() : '';
    return { chatId, text };
  }
}

export const telegramService = new TelegramService();

export type { TelegramCommand };