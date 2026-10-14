import { describe, test, expect } from 'bun:test';
import { normaliseSpaceBunnyKey, isPlausibleSpaceBunnyKey } from '../src/server/credentialValidation';

describe('Space Bunny credential validation', () => {
  const valid = `sb_live_${'a1b2c3d4'.repeat(4)}`;

  test('accepts and trims a Space Bunny hosted API key', () => {
    expect(normaliseSpaceBunnyKey(`  ${valid}  `).key).toBe(valid);
    expect(isPlausibleSpaceBunnyKey(valid)).toBe(true);
  });

  test('blank input leaves the stored key unchanged', () => {
    expect(normaliseSpaceBunnyKey('').key).toBeUndefined();
    expect(normaliseSpaceBunnyKey(undefined).key).toBeUndefined();
    expect(normaliseSpaceBunnyKey(null).key).toBeUndefined();
  });

  test('rejects keys for another provider and arbitrary prose', () => {
    for (const bad of ['sk-or-v1-' + 'a'.repeat(40), 'gsk_' + 'a'.repeat(24), 'not an API key', 'sb_live_short']) {
      expect(() => normaliseSpaceBunnyKey(bad)).toThrow();
      expect(isPlausibleSpaceBunnyKey(bad)).toBe(false);
    }
  });
});
