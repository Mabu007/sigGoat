/**
 * AUTHENTICATION MIDDLEWARE
 * ===========================
 * Authorization: Bearer <Firebase ID token>
 *   -> verify token (firebase-admin)
 *   -> req.user = verified Firebase identity (uid, email)
 *   -> route handler; ownership derived ONLY from req.user.uid
 *
 * Identity is NEVER taken from the request body.
 *
 * Modes:
 *  - 'firebase' : firebase-admin configured (production).
 *  - 'dev'      : explicit opt-in via SIGNALGOAT_ALLOW_DEV_AUTH=1 — accepts a
 *                 plain x-dev-user-id header so self-hosted/local runs and
 *                 smoke tests work without Firebase credentials. Clearly
 *                 reported in /api/settings/status so it can never be
 *                 mistaken for real auth.
 *  - 'none'     : no admin + no opt-in -> protected routes return 503.
 */

import { Request, Response, NextFunction } from 'express';
import { getFirebaseAdmin, getFirebaseAdminFailureReason } from './firebaseAdmin';

export interface AuthenticatedUser {
  uid: string;
  email?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export type AuthMode = 'firebase' | 'dev' | 'none';

type TokenVerifier = (token: string) => Promise<{ uid: string; email?: string }>;

let cachedVerifier: TokenVerifier | null | undefined;

function getFirebaseVerifier(): TokenVerifier | null {
  if (cachedVerifier !== undefined) return cachedVerifier;
  cachedVerifier = null;

  try {
    const admin = getFirebaseAdmin();
    if (!admin) {
      return null;
    }

    cachedVerifier = async (token: string) => {
      const decoded = await admin.auth.verifyIdToken(token, true);
      return { uid: decoded.uid, email: decoded.email };
    };
    return cachedVerifier;
  } catch (err) {
    console.warn('[auth] firebase-admin unavailable for token verification.', err);
    return null;
  }
}

/**
 * Dev auth is opt-in AND must never be reachable in production.
 *
 * Previously this was a bare `=== '1'` check, so a stray value in a production
 * environment would silently replace Firebase token verification with a plain
 * `x-dev-user-id` header — anyone could then act as any user by choosing a
 * header value.
 *
 * `FUNDAGOAT_ALLOW_DEV_AUTH` is the canonical name. `SIGNALGOAT_ALLOW_DEV_AUTH`
 * is still accepted because it is already set in existing developer
 * environments and deployments; removing it would silently disable dev auth
 * for anyone who has it configured, which looks like a broken app rather than
 * a renamed variable.
 */
/**
 * Production detection.
 *
 * `VERCEL` is injected by the platform and is the authoritative signal.
 * `NODE_ENV === 'production'` alone is not enough, because `npm start` runs a
 * long-lived production build locally and must keep working.
 */
export function isProductionRuntime(): boolean {
  // Production builds on Docker/Fly/Render/Railway are production too.
  // Never permit caller-supplied x-dev-user-id identity in those hosts.
  return process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
}

/**
 * Has the operator EXPLICITLY asked for dev auth?
 *
 * This is the raw, unguarded question. It is deliberately separate from
 * `devAuthAllowed()`, because the two answer different questions:
 *
 *   - "did somebody ask for this?"  -> this function
 *   - "may this run right now?"      -> `devAuthAllowed()`
 *
 * The distinction matters because an operator who set the variable is
 * entitled to know that it is being honoured, and to be told plainly when
 * it is being ignored.
 */
export function devAuthExplicitlyEnabled(): boolean {
  const flag =
    process.env.FUNDAGOAT_ALLOW_DEV_AUTH ?? process.env.SIGNALGOAT_ALLOW_DEV_AUTH;
  return flag === "1";
}

/**
 * Dev auth is opt-in AND must never take priority over real authentication.
 *
 * The previous behaviour REFUSED dev auth in any production runtime, which
 * made the variable a trap: an operator who set it to keep the app running
 * without Firebase credentials was told it was refused, and then the server
 * failed to boot for an unrelated reason (persistence could not degrade), so
 * every endpoint answered with an opaque 500. Setting the variable did
 * nothing except produce a log line.
 *
 * THE RULE NOW
 * -------------
 * Dev auth is used ONLY when there is no real authentication to use. If
 * Firebase Admin is configured, `resolveAuthMode()` returns 'firebase' and
 * this function is never consulted for the mode. So dev auth can never
 * DOWNGRADE a correctly configured production deployment — it can only make
 * a deployment that would otherwise not start at all start in an explicitly
 * labelled, loudly warned mode.
 *
 * It remains dangerous in production: it accepts a caller-supplied identity.
 * That is why it is refused whenever real auth exists, why it is logged as a
 * warning at boot, and why it is reported on /api/settings/status.
 */
function devAuthAllowed(): boolean {
  if (!devAuthExplicitlyEnabled()) return false;

  if (getFirebaseVerifier()) {
    // Real authentication is available. Dev auth is not needed and would be a
    // downgrade, so it is ignored entirely.
    return false;
  }

  if (isProductionRuntime()) {
    console.warn(
      '[auth] DEV AUTH IS ENABLED in a production runtime (VERCEL is set). ' +
        'Callers are identified by a caller-supplied x-dev-user-id header, so ' +
        'anyone who can reach this server can act as anyone. It is used ONLY ' +
        'because no Firebase Admin credential is configured. Configure ' +
        'FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 and unset ' +
        'FUNDAGOAT_ALLOW_DEV_AUTH to remove it.',
    );
  }

  return true;
}

export function resolveAuthMode(): AuthMode {
  if (getFirebaseVerifier()) return 'firebase';
  if (devAuthAllowed()) return 'dev';
  return 'none';
}

/** Test seam: force a verifier (used by authorization unit tests). */
export function setFirebaseVerifierForTests(verifier: TokenVerifier | null): void {
  cachedVerifier = verifier;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const mode = resolveAuthMode();

  if (mode === 'dev') {
    const devUid = req.header('x-dev-user-id');
    if (devUid && /^[a-zA-Z0-9_\-:.]{1,128}$/.test(devUid)) {
      req.user = { uid: devUid, email: `${devUid}@dev.local` };
      return next();
    }
    res.status(401).json({
      error: { code: 'UNAUTHENTICATED', message: 'Missing x-dev-user-id header (dev auth mode).' },
    });
    return;
  }

  if (mode === 'none') {
    /**
     * FAIL CLOSED.
     *
     * 503 rather than 401: the request was not rejected on its merits, it was
     * never evaluated, because this server cannot verify a token at all. The
     * body says which of the two causes applies so an operator can act without
     * reading logs, and deliberately contains no credential detail.
     */
    res.status(503).json({
      error: {
        code: 'AUTH_NOT_CONFIGURED',
        message:
          'This server cannot verify Firebase tokens, so protected routes are disabled. ' +
          (getFirebaseAdminFailureReason() ??
            'Firebase Admin credentials are missing or could not be loaded.'),
      },
    });
    return;
  }

  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!token) {
    res.status(401).json({
      error: { code: 'UNAUTHENTICATED', message: 'Missing Authorization: Bearer token.' },
    });
    return;
  }

  const verifier = getFirebaseVerifier();
  if (!verifier) {
    res.status(503).json({
      error: { code: 'AUTH_NOT_CONFIGURED', message: 'Token verification unavailable.' },
    });
    return;
  }

  verifier(token)
    .then((user) => {
      req.user = { uid: user.uid, email: user.email };
      next();
    })
    .catch(() => {
      res.status(401).json({
        error: { code: 'INVALID_TOKEN', message: 'Invalid or expired authentication token.' },
      });
    });
}

/** Wraps a handler so identity is guaranteed present after authMiddleware. */
export function requireUser(req: Request): AuthenticatedUser {
  if (!req.user) {
    throw new Error('requireUser called on an unauthenticated request');
  }
  return req.user;
}

/**
 * Attaches `req.user` when valid credentials are present, and otherwise does
 * nothing at all.
 *
 * For PUBLIC routes whose response legitimately differs by viewer — a share
 * link that shows its owner a Run button but shows a visitor none. Running
 * `authMiddleware` instead would 401 every anonymous visitor of a public link,
 * and duplicating the token dance inline would let the two paths drift.
 *
 * Failures are deliberately silent here: an invalid token is treated as "not
 * signed in", which is exactly what it means for a route that never required
 * a session. No response is written and `next()` is always called.
 */
export function optionalAuthMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const mode = resolveAuthMode();
  if (mode === 'none') return next();

  if (mode === 'dev') {
    const devUid = req.header('x-dev-user-id');
    if (devUid && /^[a-zA-Z0-9_\-:.]{1,128}$/.test(devUid)) {
      req.user = { uid: devUid, email: `${devUid}@dev.local` };
    }
    return next();
  }

  const header = req.header('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return next();
  const token = header.slice(7).trim();
  if (!token) return next();

  const verifier = getFirebaseVerifier();
  if (!verifier) return next();

  verifier(token)
    .then((user) => {
      req.user = { uid: user.uid, email: user.email };
    })
    .catch(() => {
      // Treated as signed out. The route did not require a session.
    })
    .finally(() => next());
}
