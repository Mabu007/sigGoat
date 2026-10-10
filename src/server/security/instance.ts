/**
 * CREDENTIAL VAULT SINGLETON
 * =========================
 * The one `CredentialVault` the application uses.
 *
 * WHY THE PERSISTENCE LAYER IS INJECTED, NOT CREATED HERE
 *   An earlier version called `createPersistence()` from this module. That
 *   produced a SECOND `FilePersistence` pointed at the same `DATA_DIR`: two
 *   objects each holding their own in-memory copy of the whole state document
 *   and each rewriting it wholesale. Whichever wrote last silently discarded
 *   the other's writes — including, potentially, a just-saved credential.
 *
 *   In production this is masked (Firestore is a shared database, not a
 *   file), which is exactly why it is worth fixing rather than working around:
 *   the bug is invisible in the deployed environment and destructive in local
 *   and test runs.
 *
 *   So the vault takes its storage from whatever persistence layer the
 *   application already built. One layer, one writer.
 *
 * WHY A SINGLETON RATHER THAN ONE PER REQUEST
 *   It is not a cache of secrets — the vault holds only the KEYRING (derived
 *   from `CREDENTIAL_ENCRYPTION_KEY`), never a decrypted value. Sharing the
 *   instance saves re-parsing the master key per field access while keeping the
 *   blast radius small: there is nothing user-specific in here.
 */

import { CredentialVault, MemoryCredentialRecordStore } from './CredentialVault';
import { createCredentialVault } from './providers';
import { createPersistence, type PersistenceLayer } from '../repositories';

let vault: CredentialVault | null = null;
let injected = false;

/**
 * Binds the vault to the application's persistence layer.
 *
 * Called once during startup by `apiRouter`. Idempotent: the first caller
 * wins, so a later import cannot swap the storage out from under a request in
 * flight.
 */
export function configureCredentialVault(persistence: PersistenceLayer): CredentialVault {
  if (!vault) {
    vault = createCredentialVault(persistence);
    injected = true;
  }
  return vault;
}

/**
 * Returns the process-wide vault.
 *
 * If startup did not configure one (a test, or a tool that uses the vault
 * without the API layer), an isolated in-memory vault is created. It is
 * deliberately in-memory: a caller that reaches this path is not serving
 * traffic, and silently opening a second file-backed store is the clobbering
 * bug described above.
 */
export function getCredentialVault(): CredentialVault {
  if (!vault) {
    // No application layer to bind to. Use memory rather than creating a
    // second FilePersistence over the same directory.
    vault = new CredentialVault({ store: new MemoryCredentialRecordStore() });
  }
  return vault;
}

/** True once an application persistence layer has been bound. */
export function isVaultConfigured(): boolean {
  return injected && vault !== null;
}

/**
 * The eagerly-usable instance.
 *
 * A Proxy rather than a resolved value so importing this module never forces
 * persistence construction as a side effect of an import — that ordering is
 * exactly what produced the two-writer bug.
 */
export const credentialVault: CredentialVault = new Proxy({} as CredentialVault, {
  get(_target, property) {
    const resolved = getCredentialVault() as unknown as Record<string | symbol, unknown>;
    const value = resolved[property];
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(getCredentialVault())
      : value;
  },
});

/** Test seam. Only permitted before the real vault is configured. */
export function setCredentialVaultForTests(replacement: CredentialVault | null): void {
  if (injected && replacement === null) {
    throw new Error(
      'Refusing to clear the shared credential vault after the application has configured it. ' +
        'Construct an isolated vault for the test instead.',
    );
  }
  vault = replacement;
  injected = replacement !== null;
}

export { createPersistence };