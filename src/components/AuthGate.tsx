/**
 * AUTHENTICATION GATE
 * ===================
 * Decides whether the application shell may render at all.
 *
 * THE THREE STATES, AND WHY EACH IS SEPARATE
 *
 *   initializing — Firebase Auth has not yet told us whether a session exists.
 *                 Rendering the shell here is what produces a "flash of
 *                 protected content": the sidebar and quotes appear, then
 *                 vanish once `user` resolves to null. So this state renders
 *                 a loader and nothing else.
 *
 *   ready — the shell renders, for EVERYONE.
 *
 * BROWSE FIRST, REGISTER WHEN IT MATTERS
 *
 * SIRGOAT is a social trading product. A person who has never signed in can
 * open the room directory, walk into any room, read the conversation, watch
 * the chart and see who leads it. An account is only needed for the things
 * that need an identity: joining a room, posting in it, and talking to its
 * leader privately. Those ask for it through the sign-in dialog, not by
 * hiding the whole product behind a wall.
 *
 * So this gate no longer decides WHO sees the app — it only decides whether
 * the app is ready to be shown.
 *
 * THE DEV-MODE ESCAPE HATCH
 *
 * When the server reports `authMode: 'dev'` (local development with
 * `SIGNALGOAT_ALLOW_DEV_AUTH=1`), there is no Firebase user and the app is
 * still usable. The gate passes through in that case only. It is driven by
 * the SERVER's reported mode, so a production deployment cannot be talked
 * into it by anything a client sends.
 */

import React, { useState } from 'react';
import { AlertCircle, LogIn, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { isFirebaseConfigured } from '../lib/firebaseConfig';

export interface AuthGateProps {
  children: React.ReactNode;
}

export const AuthGate: React.FC<AuthGateProps> = ({ children }) => {
  const { loading, authMode } = useAuth();

  /**
   * While Firebase Auth hydrates, render nothing but a loader.
   *
   * The condition is `loading || authMode === null`: `authMode` is null until
   * the server status request resolves, and treating that window as
   * "signed out" would bounce a signed-in user to the login screen on every
   * refresh.
   */
  const initializing = loading || authMode === null;

  if (initializing) {
    return <AuthLoadingScreen />;
  }

  return <>{children}</>;
};

const AuthLoadingScreen: React.FC = () => (
  <div
    className="min-h-screen bg-canvas text-fg flex items-center justify-center px-4"
    role="status"
    aria-live="polite"
  >
    <div className="flex flex-col items-center gap-3 text-center">
      <ShieldCheck className="w-8 h-8 text-accent-text animate-pulse" />
      <p className="text-sm text-fg-muted">Opening SIRGOAT…</p>
      <p className="text-xs text-fg-subtle max-w-xs">
        Restoring your session, if you have one.
      </p>
    </div>
  </div>
);

/** Kept for the sign-in surface used by the dialog. */
export const AuthUnavailableNotice: React.FC = () => {
  const { authMode, authError } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || authMode === 'firebase') return null;
  return (
    <div role="alert" className="mx-auto flex max-w-3xl items-start gap-2 rounded-xl border border-negative/40 bg-negative-soft p-3 text-[11px] leading-5 text-negative">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="flex-1">
        {authMode === 'none'
          ? 'Accounts are unavailable on this deployment: the server cannot verify sessions.'
          : 'Accounts are unavailable on this deployment.'}
        {authError ? ` ${authError}` : ''}
      </span>
      <button type="button" onClick={() => setDismissed(true)} aria-label="Dismiss" className="shrink-0 rounded p-1 hover:bg-raised">
        <LogIn size={13} />
      </button>
    </div>
  );
};
