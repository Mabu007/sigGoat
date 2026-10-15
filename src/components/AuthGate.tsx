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
 *                 vanish when `user` resolves to null. So this state renders
 *                 a loader and nothing else.
 *
 *   authenticated — a user exists; the shell renders.
 *
 *   signed-out — no user, and we are certain of it; the gate renders login and
 *                 registration.
 *
 * THE DEV-MODE ESCAPE HATCH
 *
 * When the server reports `authMode: 'dev'` (local development with
 * `SIGNALGOAT_ALLOW_DEV_AUTH=1`), there is no Firebase user and the app is
 * still usable. The gate passes through in that case only. It is driven by the
 * SERVER's reported mode, so a production deployment cannot be talked into it
 * by anything a client sends.
 *
 * SIGN-OUT
 *
 * Logout navigates to `window.location.assign('/login')` after Firebase signs
 * out. A full document navigation — not a router push — because every provider
 * above this component holds fetched user data in memory, and because browser
 * back-navigation would otherwise be able to re-enter the app from history with
 * stale state still mounted. The cost is one reload on sign-out, which is the
 * correct trade for a guarantee rather than a nicety.
 */

import React, { useState } from 'react';
import { AlertCircle, LogIn, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { LandingAuth } from './LandingAuth';
import { isFirebaseConfigured } from '../lib/firebaseConfig';

export interface AuthGateProps {
  children: React.ReactNode;
}

export const AuthGate: React.FC<AuthGateProps> = ({ children }) => {
  const { currentUser, loading, authMode, authError } = useAuth();

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

  // Server-authorised development mode: no Firebase user is expected.
  if (authMode === 'dev') {
    return <>{children}</>;
  }

  if (!currentUser) {
    const robotLink = typeof window !== 'undefined' && /^\/robot\/[^/]+\/?$/.test(window.location.pathname);
    return robotLink ? <>{children}</> : <LandingAuth authError={authError} authMode={authMode} />;
  }

  return <>{children}</>;
};

const RobotAccessScreen: React.FC<{ authError: string | null; authMode: string | null }> = ({ authError, authMode }) => {
  const { loginWithGoogle, signupWithEmail, loginWithEmail } = useAuth();
  const [mode, setMode] = useState<'signin' | 'signup'>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) { setError('Enter a valid email and a password of at least 8 characters.'); return; }
    setBusy(true); setError('');
    try { await (mode === 'signup' ? signupWithEmail(email.trim(), password) : loginWithEmail(email.trim(), password)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Sign-in failed.'); }
    finally { setBusy(false); }
  };
  const google = async () => { setBusy(true); setError(''); try { await loginWithGoogle(); } catch (e) { setError(e instanceof Error ? e.message : 'Google sign-in failed.'); } finally { setBusy(false); } };
  return <main className="min-h-screen bg-[#080a0f] px-5 py-12 text-white flex items-center justify-center"><div className="w-full max-w-md">
    <p className="text-[10px] uppercase tracking-[.25em] text-violet-200">Private robot access</p><h1 className="mt-3 text-3xl font-black tracking-tight">{mode === 'signup' ? 'Create your account' : 'Welcome back'}</h1><p className="mt-2 text-sm leading-6 text-white/55">Sign in to use this trading robot. Your account and connected trading credentials stay yours.</p>
    {authMode === 'none' && <p className="mt-4 rounded-xl border border-red-300/20 bg-red-300/[.06] p-3 text-xs text-red-100">Authentication is not configured on this deployment.</p>}
    {!isFirebaseConfigured && <p className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/[.06] p-3 text-xs text-amber-100">Firebase web configuration is missing.</p>}
    <form onSubmit={submit} className="mt-5 space-y-3 rounded-2xl border border-white/10 bg-white/[.025] p-5">
      <label className="block text-xs text-white/60">Email<input value={email} onChange={e => setEmail(e.target.value)} type="email" autoComplete="email" required className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-sm text-white outline-none focus:border-violet-300/50" /></label>
      <label className="block text-xs text-white/60">Password<input value={password} onChange={e => setPassword(e.target.value)} type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} minLength={8} required className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-sm text-white outline-none focus:border-violet-300/50" /></label>
      <button disabled={busy || authMode === 'none' || !isFirebaseConfigured} className="w-full rounded-xl bg-violet-300 px-4 py-3 text-sm font-bold text-[#100c1b] disabled:opacity-50">{busy ? 'Working…' : mode === 'signup' ? 'Create account and continue' : 'Sign in and continue'}</button>
      <button type="button" disabled={busy || authMode === 'none' || !isFirebaseConfigured} onClick={() => void google()} className="w-full rounded-xl border border-white/15 px-4 py-3 text-sm font-semibold text-white/85 disabled:opacity-50">{busy ? 'Connecting…' : 'Continue with Google'}</button>
      {(error || authError) && <p role="alert" className="whitespace-pre-wrap text-xs leading-5 text-red-200">{error || authError}</p>}
    </form>
    <p className="mt-4 text-center text-xs text-white/45">{mode === 'signup' ? 'Already have an account?' : 'New here?'} <button onClick={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setError(''); }} className="font-semibold text-violet-200 underline underline-offset-4">{mode === 'signup' ? 'Sign in' : 'Create account'}</button></p>
  </div></main>;
};

const AuthLoadingScreen: React.FC = () => (
  <div
    className="min-h-screen bg-canvas text-fg flex items-center justify-center px-4"
    role="status"
    aria-live="polite"
  >
    <div className="flex flex-col items-center gap-3 text-center">
      <ShieldCheck className="w-8 h-8 text-accent-text animate-pulse" />
      <p className="text-sm text-fg-muted">Checking your session…</p>
      <p className="text-xs text-fg-subtle max-w-xs">
        Verifying your sign-in status with Firebase.
      </p>
    </div>
  </div>
);

const SignInScreen: React.FC<{ authError: string | null; authMode: string | null }> = ({
  authError,
  authMode,
}) => {
  const { loginWithGoogle, signupWithEmail, loginWithEmail, isFirebaseConnected } = useAuth();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'google' | 'email' | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const validate = () => {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return 'Enter a valid email address.';
    }
    if (password.length < 8) {
      return 'Password must be at least 8 characters.';
    }
    return null;
  };

  const run = async (kind: 'google' | 'email', fn: () => Promise<void>): Promise<void> => {
    setBusy(kind);
    setLocalError(null);
    try {
      await fn();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const validationError = validate();
    if (validationError) {
      setLocalError(validationError);
      return;
    }
    if (mode === 'signup') {
      await run('email', () => signupWithEmail(email, password));
    } else {
      await run('email', () => loginWithEmail(email, password));
    }
  };

  return (
    <div className="min-h-screen bg-canvas text-fg flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-accent/10 border border-accent/40">
            <ShieldCheck className="w-6 h-6 text-accent-text" />
          </div>
          <h1 className="text-lg font-bold text-fg">SIRGOAT</h1>
          <p className="text-xs text-fg-muted">
            {mode === 'signin'
              ? 'Sign in to access your workspace'
              : 'Create an account to start building your GOAT'}
          </p>
        </div>

        {/**
         * The server could not verify tokens at all. Sign-in cannot possibly
         * succeed, so saying so is more useful than showing a button that fails.
         */}
        {authMode === 'none' && (
          <div className="rounded-xl border border-negative/40 bg-negative-soft p-3 text-[11px] leading-relaxed text-negative">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                <strong>Sign-in is unavailable.</strong> This server cannot verify
                Firebase tokens, so protected routes are disabled. Check that the
                Firebase Admin credential is configured on the server.
              </span>
            </div>
          </div>
        )}

        {authError && (
          <div className="rounded-xl border border-accent/40 bg-accent/10 p-3">
            <div className="flex items-start gap-2 text-[11px] font-bold text-accent-text">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Sign-in failed</span>
            </div>
            <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed text-accent-text/90">
              {authError}
            </pre>
          </div>
        )}

        <div className="rounded-2xl border border-line bg-surface p-5 space-y-4">
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label htmlFor="email" className="block text-[11px] font-medium text-fg-muted">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@example.com"
                autoComplete="email"
                className="input w-full !pr-9"
              />
            </div>
            <div>
              <label htmlFor="password" className="block text-[11px] font-medium text-fg-muted">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="At least 8 characters"
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                className="input w-full !pr-9"
              />
            </div>
            <button
              type="submit"
              disabled={busy !== null}
              className="w-full flex items-center justify-center gap-2 bg-accent hover:bg-accent-hover text-accent-fg font-bold text-sm py-2.5 px-4 rounded-xl transition-colors cursor-pointer disabled:opacity-50"
            >
              <LogIn className="w-4 h-4" />
              <span>{busy === 'email' ? 'Processing…' : mode === 'signin' ? 'Sign in' : 'Create account'}</span>
            </button>
          </form>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-line"></div>
            </div>
            <div className="relative flex justify-center text-[11px] text-fg-muted">
              <span>or continue with</span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void run('google', loginWithGoogle)}
            disabled={busy !== null}
            className="w-full flex items-center justify-center gap-2 bg-sunken hover:bg-raised text-fg border border-line font-bold text-xs py-2.5 px-4 rounded-xl transition-colors cursor-pointer disabled:opacity-50"
          >
            <LogIn className="w-4 h-4" />
            <span>{busy === 'google' ? 'Signing in…' : 'Continue with Google'}</span>
          </button>

          {!isFirebaseConnected && (
            <p className="text-[10px] text-accent-text text-center pt-1">
              Firebase is not configured on this deployment, so sign-in cannot complete.
            </p>
          )}

          {localError && (
            <div className="rounded-xl border border-negative/40 bg-negative-soft p-2.5">
              <div className="flex items-start gap-2 text-[11px] text-negative">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{localError}</span>
              </div>
            </div>
          )}
        </div>

        <p className="text-[10px] text-center text-fg-subtle leading-relaxed">
          {mode === 'signin' ? (
            <>
              Don't have an account?{' '}
              <button
                type="button"
                onClick={() => {
                  setMode('signup');
                  setLocalError(null);
                }}
                className="text-fg font-medium underline decoration-accent underline-offset-2 hover:text-accent-text"
              >
                Create one
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button
                type="button"
                onClick={() => {
                  setMode('signin');
                  setLocalError(null);
                }}
                className="text-fg font-medium underline decoration-accent underline-offset-2 hover:text-accent-text"
              >
                Sign in
              </button>
            </>
          )}
        </p>

        <p className="text-[10px] text-fg-subtle text-center leading-relaxed">
          SIRGOAT produces analysis and alerts only. It never places an order.
        </p>
      </div>
    </div>
  );
};