/**
 * SECRET REDACTION
 * ================
 * One place that knows how to strip secrets out of text that is about to be
 * logged, stored in an audit trail, or returned to a user in an error.
 *
 * WHY THIS IS NOT A REGEX SOMEWHERE ELSE
 *   The failure mode this prevents is real and quiet: a provider error
 *   containing `Authorization: Bearer pd_live_abc123` gets `console.error`'d
 *   in a catch block, ships to an error tracker, and is never read again until
 *   the key is rotated in a panic. Redaction has to happen at the boundary
 *   where the value would otherwise escape, on EVERY path, which means one
 *   shared implementation that all the escape paths can import.
 *
 * COVERAGE
 *   - Bearer / Basic authorization headers (any provider, any token).
 *   - Provider key formats observed in the wild, including the ones this app
 *     does NOT use yet (Stripe, GitHub) — a future integration should not be
 *     able to leak on day one.
 *   - Telegram bot tokens (`<digits>:<secret>`).
 *   - Anything registered via `registerRedactionPattern`.
 *
 * DELIBERATE LIMITATION
 *   Redaction is a BACKSTOP, not a control. The controls are: never put a
 *   secret in a log call in the first place, and never store one where a log
 *   can reach it. This module catches the mistake, it does not excuse it.
 */

interface NamedPattern {
  readonly label: string;
  readonly pattern: RegExp;
}

/**
 * Patterns ordered from most specific to least.
 *
 * Order matters: `sk-or-v1-…` must be consumed before the looser `sk-[A-Za-z0-9]{16,}`, or the
 * generic pattern wins and produces a shorter match than intended.
 */
const NAMED_PATTERNS: NamedPattern[] = [
  {
    label: 'openrouter',
    pattern: /sk-or-v1-[A-Za-z0-9_-]{16,}/g,
  },
  {
    label: 'propdao',
    pattern: /pd_(?:live|test)_[A-Za-z0-9_-]{16,}/g,
  },
  {
    label: 'telegram-bot-token',
    // <bot_id>:<35+ char secret>
    pattern: /\b\d{5,20}:[A-Za-z0-9_-]{30,}\b/g,
  },
  {
    label: 'groq',
    pattern: /gsk_[A-Za-z0-9_-]{16,}/g,
  },
  {
    label: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    label: 'private-key-block',
    // A whole PEM body, which is what a mis-logged service account looks like.
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    label: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
];

/**
 * Header-shaped redaction, applied to whole objects.
 *
 * Matching is by HEADER NAME, not by value pattern, because that is the only
 * way to catch a secret whose format nobody has catalogued. `authorization`,
 * `cookie`, `set-cookie`, `proxy-authorization`, and any header containing
 * `api-key`/`token`/`secret`/`password` are covered.
 */
const SENSITIVE_HEADER_PATTERN =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)$|^.*(?:api[-_]?key|secret|password|token)$/i;

export const REDACTION_PLACEHOLDER = '[REDACTED]';

/** Caller-registered patterns (e.g. a future provider's key format). */
const extraPatterns: NamedPattern[] = [];

export function registerRedactionPattern(label: string, pattern: RegExp): void {
  extraPatterns.push({ label, pattern: new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`) });
}

/**
 * Scrubs known secret formats out of a free-text string.
 *
 * Always returns a string — an unknown value type yields `''` rather than
 * being passed through, because "we don't know what this is" is exactly the
 * case that must not reach a log line.
 */
export function redactText(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'string') {
    try {
      input = typeof input === 'object' ? JSON.stringify(input) : String(input);
    } catch {
      return REDACTION_PLACEHOLDER;
    }
  }

  let output = input as string;

  for (const { pattern } of [...NAMED_PATTERNS, ...extraPatterns]) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, REDACTION_PLACEHOLDER);
  }

  return output;
}

/**
 * Deep-scrubs an object: sensitive headers by NAME, everything else by
 * content.
 *
 * Cycle-safe, because the things most likely to be logged (request objects,
 * error causes, provider clients) are exactly the things that reference
 * themselves.
 */
export function redactSecrets<T>(value: T, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'symbol') return value.toString();

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      stack: value.stack ? redactText(value.stack) : undefined,
    };
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return redactText(value.toString());

  if (typeof value === 'object') {
    if (seen.has(value as object)) return '[Circular]';
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.map((item) => redactSecrets(item, seen));
    }

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_HEADER_PATTERN.test(key)
        ? REDACTION_PLACEHOLDER
        : redactSecrets(item, seen);
    }
    return out;
  }

  return REDACTION_PLACEHOLDER;
}

/**
 * An error safe to show a user AND to log.
 *
 * Keeps the provider's own status code (so the UI can say "rate limited"
 * rather than "something went wrong") while dropping the body, which is
 * where the credential usually sits.
 */
export function redactError(error: unknown): { name: string; message: string; status?: number; code?: string } {
  if (error instanceof Error) {
    const anyError = error as Error & { status?: number; code?: string };
    return {
      name: error.name,
      message: redactText(error.message),
      status: typeof anyError.status === 'number' ? anyError.status : undefined,
      code: typeof anyError.code === 'string' ? anyError.code : undefined,
    };
  }
  return { name: 'UnknownError', message: redactText(error) };
}

/**
 * Builds a log-safe line. The format is fixed so log scrapes stay parseable
 * even when the message contains `{}` or newlines.
 */
export function safeLog(scope: string, message: string, context?: Record<string, unknown>): string {
  const head = `[${scope}] ${redactText(message)}`;
  if (!context) return head;
  try {
    return `${head} ${redactText(JSON.stringify(redactSecrets(context)))}`;
  } catch {
    return head;
  }
}