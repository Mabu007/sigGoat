/**
 * VAULT-BACKED KEY STORE ADAPTER
 * ==============================
 * Makes the encrypted `CredentialVault` look like the legacy plaintext
 * `KeyStore` that the reasoning gateway, the Telegram service and the chatbot
 * all read through — without writing a single plaintext secret.
 *
 * WHY THIS EXISTS
 *
 * The migration to the vault was completed on the WRITE side only:
 * `POST /api/settings/keys` encrypts and stores through `saveCredential`, and
 * nothing ever called the legacy `setOpenRouterKey`. Every READ still went
 * through `persistence.keys`, which is a different store. So a user who saved
 * a valid OpenRouter key in Settings saw "configured", and then every GOAT
 * wake silently fell back to the server-wide `OPENROUTER_API_KEY` — or to DEMO
 * mode when there was none. The key was accepted, stored, and never used.
 *
 * The two obvious fixes are both wrong:
 *
 *   - dual-write the plaintext alongside the envelope so the readers work:
 *     that re-introduces exactly the plaintext-at-rest the vault exists to
 *     remove, and on Vercel it would not even survive the next cold start;
 *   - rewrite every reader to know about the vault: large, and it leaves the
 *     same trap waiting for the next component that reaches for
 *     `persistence.keys`.
 *
 * Adapting the store makes the vault the single source of truth for every
 * existing and future reader, with no plaintext and no call-site churn. The
 * legacy store is consulted only as a FALLBACK, so a credential saved before
 * the vault existed keeps working instead of silently disappearing.
 */

import type { KeyStore } from '../repositories';
import type { CredentialVault, CredentialProviderId } from './CredentialVault';
import { isPlausibleOpenRouterKey, isPlausibleSpaceBunnyKey } from '../credentialValidation';

/** The slice of `CredentialVault` this adapter needs. */
export type VaultStore = Pick<CredentialVault, 'getCredential' | 'saveCredential'>;

/**
 * Wraps a legacy key store so vault reads take precedence and vault writes go
 * to the vault.
 *
 * `getCredential` decrypts on every call, which is why the reasoning gateway
 * caches the resulting client per user — see `UserScopedReasoningGateway`.
 */
export function createVaultBackedKeyStore(
  legacy: KeyStore,
  vault: VaultStore,
): KeyStore {
  /**
   * Vault first, legacy second.
   *
   * The legacy fallback is deliberate rather than legacy-should-die: a
   * credential saved before the vault existed is still a credential the user
   * believes is configured, and ignoring it would look like silent data loss.
   *
   * A vault read that THROWS (no master key configured, unreadable envelope)
   * degrades to "no credential here" rather than propagating — a read path
   * must not become the place a 503 is raised.
   */
  const read = async (
    userId: string,
    provider: CredentialProviderId,
    fallback: (() => Promise<string | undefined>) | undefined,
  ): Promise<string | undefined> => {
    try {
      const fromVault = await vault.getCredential(userId, provider);
      if (fromVault && fromVault.trim()) return fromVault.trim();
    } catch (err) {
      console.warn(
        `[keys] Vault read for "${provider}" failed, falling back to the legacy store:`,
        err instanceof Error ? err.message : err,
      );
    }
    return fallback ? fallback() : undefined;
  };

  return {
    getOpenRouterKey: async (userId) => {
      const key = await read(userId, 'openrouter', () =>
        legacy.getOpenRouterKey(userId),
      );
      /**
       * Shape-check on the way OUT as well as in. The gateway does this too,
       * but a malformed legacy value must not reach any other reader that
       * calls this adapter directly.
       */
      if (key && !isPlausibleOpenRouterKey(key)) {
        console.warn(
          `[keys] Ignoring malformed stored OpenRouter key for user ${userId}. ` +
            'Re-save the key in Settings.',
        );
        return undefined;
      }
      return key;
    },

    /**
     * Writes go to the VAULT only.
     *
     * `persistence.keys` is never written with a secret. That is the whole
     * point of the adapter — see the header.
     */
    setOpenRouterKey: async (userId, key) => {
      await vault.saveCredential(userId, 'openrouter', key);
    },

    getGroqKey: async (userId) =>
      read(userId, 'groq', () => legacy.getGroqKey?.(userId)),

    setGroqKey: async (userId, key) => {
      await vault.saveCredential(userId, 'groq', key);
    },

    getSpaceBunnyKey: async (userId) => {
      const key = await read(userId, 'spacebunny', () => legacy.getSpaceBunnyKey?.(userId));
      return key && isPlausibleSpaceBunnyKey(key) ? key : undefined;
    },
    setSpaceBunnyKey: async (userId, key) => { await vault.saveCredential(userId, 'spacebunny', key); },

    getTelegramToken: async (userId) =>
      read(userId, 'telegram', () => legacy.getTelegramToken(userId)),

    setTelegramToken: async (userId, token) => {
      await vault.saveCredential(userId, 'telegram', token);
    },

    /**
     * Non-secret metadata stays in the legacy store.
     *
     * Provider choice, Telegram bot identity and chat ids are not credentials:
     * they are already stored as plain fields and are read for display, so
     * moving them through the vault would add cost without adding safety.
     */
    getProvider: (userId) => legacy.getProvider?.(userId),
    setProvider: async (userId, provider) => {
      await legacy.setProvider?.(userId, provider);
    },

    getTelegramBot: (userId) => legacy.getTelegramBot?.(userId),
    setTelegramBot: async (userId, bot) => {
      await legacy.setTelegramBot?.(userId, bot);
    },
  };
}
