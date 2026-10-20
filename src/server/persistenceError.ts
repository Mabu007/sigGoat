/**
 * PERSISTENCE UNAVAILABLE
 * =======================
 * The datastore is not available and the deployment refuses to pretend
 * otherwise.
 *
 * It lives in its own module so that both the primary datastore and the
 * per-feature stores can raise it without importing each other.
 *
 * Every protected route maps this to 503 with the real reason. It exists
 * because the alternative — throwing while the module is still loading —
 * takes down EVERY endpoint with an opaque platform error, including the
 * status endpoint whose whole job is to explain what is wrong.
 */

export class PersistenceUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "PersistenceUnavailableError";
  }
}
