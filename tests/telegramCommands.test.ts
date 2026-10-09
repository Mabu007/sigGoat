import { describe, test, expect } from 'bun:test';
import {
  parseTelegramCommand,
  normaliseProcessId,
  TelegramRateLimiter,
} from '../src/services/telegram/TelegramCommands';

/**
 * TELEGRAM COMMAND PARSING
 * ========================
 * The previous router matched raw strings in sequence, which is how `/processes`
 * fell through to the conversational path and returned an AI answer instead of
 * a list. These tests pin the properties that matter:
 *
 *   - exact first-token matching, so no command shadows another
 *   - `@botname` suffix stripping, so commands work in group chats
 *   - process ids are validated before they can reach a lookup
 *   - unrecognised input is NEVER classified as chat, so a typo costs no AI
 */

describe('parseTelegramCommand', () => {
  test('recognises the MVP command set', () => {
    expect(parseTelegramCommand('/start')).toEqual({ kind: 'start' });
    expect(parseTelegramCommand('/help')).toEqual({ kind: 'help' });
    expect(parseTelegramCommand('/status')).toEqual({ kind: 'status' });
    expect(parseTelegramCommand('/processes')).toEqual({ kind: 'processes' });
    expect(parseTelegramCommand('/create wait for a sweep on EUR/USD')).toEqual({
      kind: 'create',
      args: 'wait for a sweep on EUR/USD',
    });
  });

  test('takes a process id for trigger, pause and resume', () => {
    expect(parseTelegramCommand('/trigger goat_1_abc')).toEqual({
      kind: 'trigger',
      processId: 'goat_1_abc',
    });
    expect(parseTelegramCommand('/pause goat_1_abc')).toEqual({
      kind: 'pause',
      processId: 'goat_1_abc',
    });
    expect(parseTelegramCommand('/resume goat_1_abc')).toEqual({
      kind: 'resume',
      processId: 'goat_1_abc',
    });
  });

  test('a process command without an id is unknown, never a chat message', () => {
    /**
     * The important part is `kind: 'unknown'`. Treating a malformed command as
     * free text would route it to the AI and spend the user\'s credits on what
     * they believed was a control command.
     */
    for (const input of ['/trigger', '/pause', '/resume', '/trigger   ']) {
      const parsed = parseTelegramCommand(input);
      expect(parsed.kind).toBe('unknown');
    }
  });

  test('an unknown command never becomes a chat message', () => {
    expect(parseTelegramCommand('/nonsense').kind).toBe('unknown');
    expect(parseTelegramCommand('/process').kind).toBe('unknown');
    // A near-miss must not be silently accepted as the real command.
    expect(parseTelegramCommand('/processess').kind).toBe('unknown');
  });

  test('strips the @botname suffix Telegram adds in group chats', () => {
    expect(parseTelegramCommand('/processes@my_signalgoat_bot')).toEqual({
      kind: 'processes',
    });
    expect(parseTelegramCommand('/trigger@my_signalgoat_bot goat_1_abc')).toEqual({
      kind: 'trigger',
      processId: 'goat_1_abc',
    });
  });

  test('analyse accepts an optional market and both spellings', () => {
    expect(parseTelegramCommand('/analyse')).toEqual({ kind: 'analyse' });
    expect(parseTelegramCommand('/analyze')).toEqual({ kind: 'analyse' });
    expect(parseTelegramCommand('/analyse EURUSD')).toEqual({
      kind: 'analyse',
      market: 'EURUSD',
    });
  });

  test('non-command text stays conversational', () => {
    const parsed = parseTelegramCommand('what is my bias?');
    expect(parsed.kind).toBe('chat');
  });

  test('a leading @ on a chat message is not treated as a command', () => {
    expect(parseTelegramCommand('ping @somebody').kind).toBe('chat');
  });

  test('a slash mid-sentence is not a command', () => {
    expect(parseTelegramCommand('long/short bias?').kind).toBe('chat');
  });

  test('command matching is case-insensitive', () => {
    expect(parseTelegramCommand('/Processes')).toEqual({ kind: 'processes' });
    expect(parseTelegramCommand('/STATUS')).toEqual({ kind: 'status' });
  });
});

describe('normaliseProcessId', () => {
  test('accepts the ids this system generates', () => {
    expect(normaliseProcessId('goat_1791545716353_zyl9')).toBe(
      'goat_1791545716353_zyl9',
    );
  });

  test('strips a leading @ and surrounding whitespace', () => {
    expect(normaliseProcessId('  @goat_1_abc  ')).toBe('goat_1_abc');
  });

  test('refuses empty, oversized and injection-shaped input', () => {
    expect(normaliseProcessId('')).toBeNull();
    expect(normaliseProcessId('   ')).toBeNull();
    expect(normaliseProcessId('a'.repeat(65))).toBeNull();
    // A quote or backtick must never reach a formatted message or a lookup.
    expect(normaliseProcessId("goat_1'; DROP TABLE--")).toBeNull();
    expect(normaliseProcessId('goat/../other')).toBeNull();
  });
});

describe('TelegramRateLimiter', () => {
  test('allows a burst up to the limit, then refuses', () => {
    const limiter = new TelegramRateLimiter({ maxPerWindow: 3, windowMs: 60_000 });

    expect(limiter.allow('chat1')).toBe(true);
    expect(limiter.allow('chat1')).toBe(true);
    expect(limiter.allow('chat1')).toBe(true);
    expect(limiter.allow('chat1')).toBe(false);
  });

  test('is per chat, so one user cannot exhaust another', () => {
    const limiter = new TelegramRateLimiter({ maxPerWindow: 1, windowMs: 60_000 });

    expect(limiter.allow('chat1')).toBe(true);
    expect(limiter.allow('chat1')).toBe(false);
    expect(limiter.allow('chat2')).toBe(true);
  });

  test('the window slides, so a blocked chat recovers', () => {
    let now = 1_000_000;
    const limiter = new TelegramRateLimiter({
      maxPerWindow: 1,
      windowMs: 60_000,
      now: () => now,
    });

    expect(limiter.allow('chat1')).toBe(true);
    expect(limiter.allow('chat1')).toBe(false);

    now += 61_000;
    expect(limiter.allow('chat1')).toBe(true);
  });

  test('reports a useful retry-after rather than just false', () => {
    let now = 1_000_000;
    const limiter = new TelegramRateLimiter({
      maxPerWindow: 1,
      windowMs: 60_000,
      now: () => now,
    });

    limiter.allow('chat1');
    limiter.allow('chat1');

    expect(limiter.retryAfterSeconds('chat1')).toBeGreaterThan(0);

    now += 61_000;
    expect(limiter.retryAfterSeconds('chat1')).toBe(0);
  });

  test('the chat map is bounded so a hostile caller cannot grow memory', () => {
    const limiter = new TelegramRateLimiter({ maxChats: 10 });

    for (let i = 0; i < 100; i += 1) {
      expect(limiter.allow(`chat-${i}`)).toBe(true);
    }

    // Still functional after eviction — the bound costs history, not correctness.
    expect(limiter.allow('chat-99')).toBe(true);
  });
});