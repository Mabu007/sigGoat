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
import { getFirebaseAdmin } from './firebaseAdmin';

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

export function resolveAuthMode(): AuthMode {
  if (getFirebaseVerifier()) return 'firebase';
  if (process.env.SIGNALGOAT_ALLOW_DEV_AUTH === '1') return 'dev';
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
    res.status(503).json({
      error: {
        code: 'AUTH_NOT_CONFIGURED',
        message: 'Authentication is not configured on this server. Set Firebase credentials or SIGNALGOAT_ALLOW_DEV_AUTH=1 for local mode.',
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
