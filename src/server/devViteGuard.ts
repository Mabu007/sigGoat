/**
 * VITE MIDDLEWARE GUARD
 * =====================
 * The second line of defence that keeps `/api` responses out of Vite's
 * middleware entirely.
 *
 * THE BUG THIS EXISTS TO PREVENT
 *   `Error [ERR_HTTP_HEADERS_SENT]: Cannot set headers after they are sent
 *   to the client`, surfacing as the Vite CORS overlay.
 *
 *   Root cause: an API route that has ALREADY sent a JSON response continued
 *   to fall through (or its response was observed) by Vite's `corsMiddleware`
 *   / `applyHeaders`, which then tried to write response headers a second
 *   time. Every response write after the first commit throws — the overlay
 *   merely reports WHERE it threw, not what actually went wrong.
 *
 * WHY A GUARD, NOT A CORS CONFIG CHANGE
 *   The fix is ordering, not policy: `createApp()` mounts the API router
 *   first, and this guard ensures Vite never *sees* an `/api` request at all,
 *   so its CORS/SPA-fallback middleware has nothing to write headers onto.
 *   Weakening CORS or disabling the overlay would hide the symptom while
 *   leaving any other double-response path intact.
 *
 * INVARIANTS (regression-tested in tests/devViteGuard.test.ts):
 *   - an `/api/*` request never reaches the Vite middleware;
 *   - a non-API request reaches the Vite middleware exactly once;
 *   - `next()` is called at most once per request.
 */

type NextFunction = (err?: unknown) => void;
type Middleware = (req: unknown, res: unknown, next: NextFunction) => unknown;

/**
 * Returns express middleware that routes `/api` requests past Vite and
 * everything else into Vite's middleware chain.
 *
 * `viteMiddlewares` is injected as a plain function so tests can supply a
 * spy without constructing a real Vite dev server.
 */
export function createViteGuard(viteMiddlewares: Middleware) {
  return function viteGuard(
    req: { url?: string },
    res: unknown,
    next: NextFunction,
  ): unknown {
    if ((req.url ?? '').startsWith('/api')) {
      return next();
    }
    return viteMiddlewares(req, res, next);
  };
}
