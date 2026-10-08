import { describe, test, expect } from 'bun:test';
import {
  normaliseOpenRouterKey,
  normaliseTelegramToken,
  isPlausibleOpenRouterKey,
} from '../src/server/credentialValidation';

/**
 * Regression cover for a real incident: a fragment of prose was accepted as
 * an OpenRouter key, which silently poisoned every reasoning run with
 * OpenRouter's misleading "Missing Authentication header".
 */

/**
 * SYNTHETIC key. Real credentials must never appear in a repository, even in
 * a test fixture — a test asserting "this looks like a key" needs only the
 * correct SHAPE.
 */
const VALID_OPENROUTER = `sk-or-v1-${'a1b2c3d4'.repeat(8)}`;

describe('OpenRouter credential validation', () => {
  test('accepts and trims a real key', () => {
    expect(
      normaliseOpenRouterKey(`  ${VALID_OPENROUTER}  `).key,
    ).toBe(VALID_OPENROUTER);
  });

  test('accepts the legacy sk- shape', () => {
    const legacy = `sk-${'a'.repeat(48)}`;
    expect(normaliseOpenRouterKey(legacy).key).toBe(legacy);
  });

  test('blank input means "leave unchanged", not "clear"', () => {
    expect(normaliseOpenRouterKey('').key).toBeUndefined();
    expect(normaliseOpenRouterKey(undefined).key).toBeUndefined();
    expect(normaliseOpenRouterKey(null).key).toBeUndefined();
  });

  test('rejects prose pasted into the field', () => {
    // The exact string that poisoned the key store in production.
    const prose =
      'ther than trying to bill them just for the cidb registration.';

    expect(() => normaliseOpenRouterKey(prose)).toThrow();
    expect(() => normaliseOpenRouterKey(prose)).toThrow(
      /does not look like an OpenRouter API key/i,
    );
  });

  test('rejects a JSON blob, a sentence and a bare word', () => {
    for (const bad of [
      '{"type":"message","content":"hi"}',
      'Buy now at market',
      'sk-',
      'your-api-key-here',
      'sk-or-v1-short',
    ]) {
      expect(() => normaliseOpenRouterKey(bad)).toThrow();
    }
  });

  test('rejects non-strings', () => {
    expect(() => normaliseOpenRouterKey(12345)).toThrow();
    expect(() => normaliseOpenRouterKey({ key: VALID_OPENROUTER })).toThrow();
  });

  test('rejects an absurdly long value with paste-specific guidance', () => {
    expect(() => normaliseOpenRouterKey('x'.repeat(400))).toThrow(
      /wrong text was pasted/i,
    );
  });
});

describe('isPlausibleOpenRouterKey', () => {
  test('true only for real key shapes', () => {
    expect(isPlausibleOpenRouterKey(VALID_OPENROUTER)).toBe(true);
    expect(isPlausibleOpenRouterKey(` ${VALID_OPENROUTER} `)).toBe(true);
  });

  test('false for prose, empty and undefined — so the UI never claims "saved"', () => {
    expect(
      isPlausibleOpenRouterKey(
        'ther than trying to bill them just for the cidb registration.',
      ),
    ).toBe(false);
    expect(isPlausibleOpenRouterKey('')).toBe(false);
    expect(isPlausibleOpenRouterKey(undefined)).toBe(false);
  });
});

describe('Telegram credential validation', () => {
  test('accepts a @BotFather shaped token', () => {
    const token = `123456789:${'A'.repeat(35)}`;
    expect(normaliseTelegramToken(` ${token} `)).toBe(token);
  });

  test('rejects prose and a bare chat id', () => {
    expect(() => normaliseTelegramToken('my bot token')).toThrow();
    expect(() => normaliseTelegramToken('987654321')).toThrow();
    expect(() => normaliseTelegramToken('123:abc')).toThrow();
  });

  test('blank input means "leave unchanged"', () => {
    expect(normaliseTelegramToken('')).toBeUndefined();
    expect(normaliseTelegramToken(undefined)).toBeUndefined();
  });
});

describe('OpenRouter credit-budget adaptation', () => {
  test('shrinks to the affordable ceiling reported by OpenRouter', async () => {
    const { fitBudgetToCredits } = await import(
      '../src/services/ai/OpenRouterClient'
    );

    const message =
      'This request requires more credits, or fewer max_tokens. ' +
      'You requested up to 8192 tokens, but can only afford 4794.';

    const fitted = fitBudgetToCredits(8192, message);

    // 85% of 4794, never above the request.
    expect(fitted).toBeLessThanOrEqual(4794);
    expect(fitted).toBeGreaterThan(3000);
    expect(fitted).toBeLessThan(8192);
  });

  test('handles thousands separators', async () => {
    const { fitBudgetToCredits } = await import(
      '../src/services/ai/OpenRouterClient'
    );

    expect(
      fitBudgetToCredits(
        8192,
        'You requested up to 8192 tokens, but can only afford 12,288.',
      ),
    ).toBe(8192);
  });

  test('leaves the budget alone for unrelated errors', async () => {
    const { fitBudgetToCredits } = await import(
      '../src/services/ai/OpenRouterClient'
    );

    expect(fitBudgetToCredits(4096, 'Model not found')).toBe(4096);
    expect(fitBudgetToCredits(4096, '')).toBe(4096);
  });

  test('never drops below a usable floor', async () => {
    const { fitBudgetToCredits } = await import(
      '../src/services/ai/OpenRouterClient'
    );

    expect(
      fitBudgetToCredits(
        4096,
        'You requested up to 4096 tokens, but can only afford 100.',
      ),
    ).toBeGreaterThanOrEqual(1536);
  });
});
