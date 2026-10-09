/**
 * TELEGRAM BOT API CLIENT
 * =======================
 * The small, honest slice of the Bot API this product needs:
 *
 *   getMe              verify a token is real and learn the bot's identity
 *   setWebhook / getWebhookInfo  register and audit the delivery endpoint
 *   deleteWebhook      disconnect
 *   sendMessage        deliver a notification
 *   getUpdates         the polling alternative to a webhook
 *
 * WHAT THIS DOES NOT DO
 *
 * It never logs a token, never returns one, and never puts one in a URL that
 * could be recorded by an intermediary's access log beyond what the Bot API
 * itself requires (the token is part of the documented path).
 *
 * ERRORS ARE REPORTED, NOT THROWN, EXCEPT WHERE THE CALLER MUST KNOW
 *
 * A Telegram 4xx is a normal response carrying a description, not an
 * exception. `sendMessage` returns `{ ok, description }`. Methods that a user
 * explicitly invoked (connect, disconnect) throw a typed error so the router
 * can answer with the real reason instead of a generic failure.
 */

import type { TelegramSendMessageResponse } from './TelegramService';

const TELEGRAM_API = 'https://api.telegram.org';

/** Default per-request timeout. */
const REQUEST_TIMEOUT_MS = 8_000;

/** Webhook registration timeout: Telegram's ack can be slower. */
const WEBHOOK_TIMEOUT_MS = 12_000;

export interface TelegramBotIdentity {
  id: number;
  username: string;
  firstName?: string;
  canJoinGroups?: boolean;
  supportsInlineQueries?: boolean;
}

export interface TelegramWebhookInfo {
  url: string;
  hasCustomCertificate: boolean;
  pendingUpdateCount: number;
  lastErrorMessage?: string;
  lastErrorDate?: number;
  /** Present when the webhook was registered with a secret_token. */
  hasSecretToken?: boolean;
}

/**
 * A Telegram API failure with the description Telegram gave.
 *
 * Carries the HTTP status so the router can distinguish "your token is wrong"
 * (401/404) from "Telegram is unhappy" (429) from "that chat id does not
 * exist" (400).
 */
export class TelegramApiError extends Error {
  readonly status: number;
  readonly method: string;

  constructor(method: string, status: number, description: string) {
    super(`${method} failed (${status}): ${description}`);
    this.name = 'TelegramApiError';
    this.status = status;
    this.method = method;
  }
}

/**
 * Validates the SHAPE of a bot token before any network call.
 *
 * `<botId>:<35 chars>`. Checking the shape locally means an obvious paste
 * mistake is reported as a bad token rather than as a Telegram outage, and it
 * costs nothing.
 */
export function isPlausibleBotToken(token: string): boolean {
  const trimmed = token.trim();
  if (trimmed.length > 256) return false;
  return /^\d{5,20}:[A-Za-z0-9_-]{30,}$/.test(trimmed);
}

export class TelegramBotClient {
  constructor(private readonly token: string) {}

  private async call<T>(
    method: string,
    init: { body?: Record<string, unknown>; timeoutMs?: number } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      init.timeoutMs ?? REQUEST_TIMEOUT_MS,
    );

    try {
      const response = await fetch(`${TELEGRAM_API}/bot${this.token}/${method}`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(init.body ?? {}),
      });

      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        result?: T;
        description?: string;
      } | null;

      if (!response.ok || payload?.ok === false) {
        throw new TelegramApiError(
          method,
          response.status,
          payload?.description ?? `HTTP ${response.status}`,
        );
      }

      return payload?.result as T;
    } catch (err) {
      if (err instanceof TelegramApiError) throw err;

      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new TelegramApiError(
        method,
        0,
        aborted ? 'request timed out' : describeError(err),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Verifies the token and returns the bot's identity.
   *
   * THIS IS THE "IS IT REALLY CONNECTED" CHECK. Nothing about a bot is assumed
   * connected until this has succeeded — a stored token proves only that some
   * token was stored.
   */
  async getMe(): Promise<TelegramBotIdentity> {
    return this.call<TelegramBotIdentity>('getMe');
  }

  /**
   * Registers the webhook.
   *
   * `secretToken` becomes the `X-Telegram-Bot-Api-Secret-Token` header on every
   * delivery, and it is how the receiving endpoint proves the request really
   * came from Telegram for THIS bot. Telegram requires 1-256 characters from
   * [A-Za-z0-9_-].
   *
   * `allowedUpdates` is narrowed deliberately: only messages are needed, and
   * subscribing to everything means more traffic for no benefit.
   */
  async setWebhook(
    url: string,
    secretToken: string,
    allowedUpdates: string[] = ['message'],
  ): Promise<boolean> {
    return this.call<boolean>('setWebhook', {
      body: {
        url,
        secret_token: secretToken,
        allowed_updates: allowedUpdates,
        // A dropped update must be retried rather than silently discarded.
        drop_pending_updates: false,
      },
      timeoutMs: WEBHOOK_TIMEOUT_MS,
    });
  }

  /** Current webhook registration, for the connection-status endpoint. */
  async getWebhookInfo(): Promise<TelegramWebhookInfo> {
    return this.call<TelegramWebhookInfo>('getWebhookInfo');
  }

  /** Removes the webhook, so this app stops receiving updates for the bot. */
  async deleteWebhook(): Promise<boolean> {
    return this.call<boolean>('deleteWebhook', {
      body: { drop_pending_updates: false },
    });
  }

  /** Replaces any webhook with long polling. */
  async deleteWebhookAndPoll(): Promise<boolean> {
    return this.call<boolean>('deleteWebhook', {
      body: { drop_pending_updates: true },
    });
  }

  async sendMessage(
    chatId: string,
    text: string,
    options: { parseMode?: string } = {},
  ): Promise<TelegramSendMessageResponse> {
    return this.call<TelegramSendMessageResponse>('sendMessage', {
      body: {
        chat_id: chatId,
        text,
        parse_mode: options.parseMode ?? 'Markdown',
        disable_web_page_preview: true,
      },
    });
  }

  /**
   * Confirms a chat id is one the bot can actually message.
   *
   * A user typing their chat id by hand is the single most common setup error,
   * and this turns a silent no-op into a definitive answer at connect time.
   */
  async verifyChat(chatId: string): Promise<{ ok: boolean; username?: string }> {
    const chat = await this.call<{ id: number; username?: string }>('getChat', {
      body: { chat_id: chatId },
    });
    return { ok: true, username: chat?.username };
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}