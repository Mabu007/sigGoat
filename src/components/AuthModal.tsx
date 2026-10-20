/**
 * SIGN IN / REGISTER DIALOG
 * =========================
 * The one place a person becomes a member.
 *
 * TradingVibes is browsable: the room directory and any room's market, chat
 * history and leader are open to anyone. An account is needed only for the
 * things that need an identity — joining a room, posting in it, and talking
 * to its leader.
 *
 * So this is a MODAL rather than a gate. It is opened from wherever a
 * visitor hits that wall (the locked chat composer, the join button, the
 * header), which means one sign-in surface in the whole product.
 */

import React, { useEffect, useState } from 'react';
import { AlertCircle, LogIn, ShieldCheck, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { isFirebaseConfigured } from '../lib/firebaseConfig';

export const AuthModal: React.FC = () => {
  const {
    authModalOpen,
    authModalMode,
    openAuthModal,
    closeAuthModal,
    loginWithGoogle,
    signupWithEmail,
    loginWithEmail,
    authError,
    authMode,
  } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'google' | 'email' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authModalOpen) {
      setError(null);
      setPassword('');
    }
  }, [authModalOpen]);

  useEffect(() => {
    if (!authModalOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeAuthModal(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [authModalOpen, closeAuthModal]);

  if (!authModalOpen) return null;

  const run = async (kind: 'google' | 'email', fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      closeAuthModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Enter a valid email address.'); return; }
    if (password.length < 8) { setError('Your password must be at least 8 characters.'); return; }
    await run('email', () => (authModalMode === 'signin' ? loginWithEmail(email.trim(), password) : signupWithEmail(email.trim(), password)));
  };

  const authDisabled = busy !== null || authMode !== 'firebase' || !isFirebaseConfigured;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) closeAuthModal(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
        className="w-full max-w-md rounded-2xl border border-line bg-surface p-5 text-fg shadow-2xl sm:p-6"
      >
        <header className="mb-5 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-accent/30 bg-accent-soft text-accent-text">
              <ShieldCheck size={19} aria-hidden="true" />
            </span>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent-text">TradingVibes</p>
              <h2 id="auth-modal-title" className="text-base font-bold text-fg">
                {authModalMode === 'signin' ? 'Welcome back' : 'Create your account'}
              </h2>
              <p className="mt-0.5 text-[11px] text-fg-muted">
                {authModalMode === 'signin'
                  ? 'Sign in to join rooms and talk to their leaders.'
                  : 'An account lets you join rooms, post and talk to leaders.'}
              </p>
            </div>
          </div>
          <button type="button" onClick={closeAuthModal} aria-label="Close" className="rounded-lg p-2 text-fg-subtle hover:bg-raised hover:text-fg">
            <X size={17} />
          </button>
        </header>

        {!isFirebaseConfigured && (
          <p className="mb-4 rounded-xl border border-negative/40 bg-negative-soft p-3 text-[11px] leading-5 text-negative">
            Sign-in is not configured on this deployment, so accounts cannot be created right now.
          </p>
        )}
        {authMode === 'none' && (
          <p className="mb-4 rounded-xl border border-negative/40 bg-negative-soft p-3 text-[11px] leading-5 text-negative">
            The server cannot verify sessions, so sign-in is unavailable.
          </p>
        )}
        {(error || authError) && (
          <p role="alert" className="mb-4 whitespace-pre-wrap break-words rounded-xl border border-negative/40 bg-negative-soft p-3 text-[11px] leading-5 text-negative">
            {error || authError}
          </p>
        )}

        <form onSubmit={submit} className="space-y-3">
          <label className="block text-[11px] font-medium text-fg-muted">
            Email
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              className="input mt-1.5 w-full"
            />
          </label>
          <label className="block text-[11px] font-medium text-fg-muted">
            Password
            <input
              type="password"
              autoComplete={authModalMode === 'signin' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="At least 8 characters"
              className="input mt-1.5 w-full"
            />
          </label>
          <button type="submit" disabled={authDisabled} className="btn btn-primary w-full justify-center">
            <LogIn size={15} aria-hidden="true" />
            {busy === 'email' ? 'Working…' : authModalMode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <div className="my-4 flex items-center gap-3 text-[10px] text-fg-subtle">
          <span className="h-px flex-1 bg-line" />OR<span className="h-px flex-1 bg-line" />
        </div>

        <button type="button" disabled={authDisabled} onClick={() => void run('google', loginWithGoogle)} className="btn btn-secondary w-full justify-center">
          {busy === 'google' ? 'Connecting…' : 'Continue with Google'}
        </button>

        <p className="mt-5 text-center text-[11px] text-fg-muted">
          {authModalMode === 'signin' ? 'New here?' : 'Already have an account?'}{' '}
          <button
            type="button"
            onClick={() => { openAuthModal(authModalMode === 'signin' ? 'signup' : 'signin'); setError(null); }}
            className="font-semibold text-accent-text underline underline-offset-4"
          >
            {authModalMode === 'signin' ? 'Create an account' : 'Sign in'}
          </button>
        </p>

        <p className="mt-4 flex items-start gap-1.5 text-center text-[10px] leading-4 text-fg-subtle">
          <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>You stay signed in on this device until you sign out. Analysis shared in a room is opinion, not advice.</span>
        </p>
      </section>
    </div>
  );
};
