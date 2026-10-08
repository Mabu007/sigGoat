/**
 * CREDENTIAL FORMAT VALIDATION
 * ============================
 * Rejecting malformed credentials at the boundary is what keeps a paste
 * mistake from silently poisoning every future reasoning run.
 *
 * Without this, saving a sentence into the OpenRouter key field produces a
 * GOAT that looks configured but fails every wake with OpenRouter's
 * "Missing Authentication header" — which reads like a network or auth bug
 * rather than "that is not a key".
 *
 * These are SHAPE checks only (prefix + charset + length). They never
 * contact the provider; `POST /api/ai/test` performs the real check.
 */

/**
 * A bad value the CALLER supplied.
 *
 * Deliberately not an ApiRequestError: an ApiRequestError means "an upstream
 * provider failed" and is reported as 502. Input problems must surface as
 * 400 so the client can tell "you pasted nonsense" from "OpenRouter is down".
 */
export class CredentialValidationError extends Error {
  readonly code = 'INVALID_KEY';

  constructor(message: string) {
    super(message);
    this.name = 'CredentialValidationError';
  }
}

/** OpenRouter issues `sk-or-v1-…`; `sk-…` is the legacy/other shape. */
const OPENROUTER_KEY_PATTERN = /^sk-(?:or-v\d+-)?[A-Za-z0-9_-]{32,}$/;

/** Telegram bot tokens are `<botId>:<35 char secret>`. */
const TELEGRAM_TOKEN_PATTERN = /^\d{5,20}:[A-Za-z0-9_-]{30,}$/;

const MAX_OPENROUTER_KEY_LENGTH = 256;
const MAX_TELEGRAM_TOKEN_LENGTH = 256;

export interface NormalisedOpenRouterKey {
  key: string | undefined;
}

/**
 * Validates and normalises a user-supplied OpenRouter key.
 *
 * @param value raw input; blank/undefined means "do not change"
 * @returns the trimmed key, or undefined when the field should be ignored
 * @throws CredentialValidationError with a message safe to show the user
 */
export function normaliseOpenRouterKey(
  value: unknown,
): NormalisedOpenRouterKey {
  if (value === undefined || value === null) {
    return { key: undefined };
  }

  if (typeof value !== 'string') {
    throw new CredentialValidationError(
      'The OpenRouter API key must be text.',
    );
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return { key: undefined };
  }

  if (trimmed.length > MAX_OPENROUTER_KEY_LENGTH) {
    throw new CredentialValidationError(
      `That is not an OpenRouter API key (${trimmed.length} characters). ` +
        'Keys look like sk-or-v1-… and are far shorter than this — it looks like ' +
        'the wrong text was pasted into the field.',
    );
  }

  if (!OPENROUTER_KEY_PATTERN.test(trimmed)) {
    throw new CredentialValidationError(
      'That does not look like an OpenRouter API key. Expected something like ' +
        'sk-or-v1-… (openrouter.ai/keys → API keys → Create new key).',
    );
  }

  return { key: trimmed };
}

export function normaliseTelegramToken(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new CredentialValidationError(
      'The Telegram bot token must be text.',
    );
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return undefined;
  }

  if (
    trimmed.length > MAX_TELEGRAM_TOKEN_LENGTH ||
    !TELEGRAM_TOKEN_PATTERN.test(trimmed)
  ) {
    throw new CredentialValidationError(
      'That does not look like a Telegram bot token. Expected the value from ' +
        '@BotFather, in the form 123456789:AA… (a bot id, a colon, then the secret).',
    );
  }

  return trimmed;
}

/**
 * A stored credential that fails the shape check is almost certainly a past
 * paste mistake. `hasKeyFor` must NOT report such a value as configured,
 * otherwise the UI claims "your key is saved" while every wake fails.
 */
export function isPlausibleOpenRouterKey(value: string | undefined): boolean {
  return typeof value === 'string' && OPENROUTER_KEY_PATTERN.test(value.trim());
}
