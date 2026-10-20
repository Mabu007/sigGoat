/**
 * SETTINGS
 * ========
 * Your account, how TradingVibes looks, and the trading accounts you connect.
 *
 * WHAT THIS SCREEN IS NOT
 *   There is no model picker, no reasoning provider, no autonomy switch and
 *   no agent keys. TradingVibes is a social trading product: it connects people to
 *   rooms, rooms to charts and brokers, and traders to each other. Nothing
 *   here decides what a machine thinks — that is what the people in a room
 *   are for.
 *
 * The broker connections below are the ones that matter: they are the
 * account a member trades their own ideas with.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Check, ImagePlus, LogOut, Moon, Palette as PaletteIcon, Sun, UserRound } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { UserAvatar } from '../UserAvatar';
import { useImageUpload } from '../../hooks/useImageUpload';
import { PropDaoSettings } from './PropDaoSettings';
import { CTraderSettings } from './CTraderSettings';

interface UserPreferences {
  tradingProvider: 'ctrader' | 'hyperliquid';
  tradingProviderAvailable?: boolean;
  tradingProviderUnavailableReason?: string | null;
}

export const SettingsView: React.FC<{ section?: string }> = ({ section }) => {
  const { theme, setTheme } = useTheme();
  const {
    currentUser,
    profile,
    logout,
    isFirebaseConnected,
    getApiAuthHeaders,
    updateProfileData,
  } = useAuth();

  const [preferences, setPreferences] = useState<UserPreferences>({ tradingProvider: 'ctrader' });
  const [isSavingPreferences, setIsSavingPreferences] = useState(false);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [nameSaving, setNameSaving] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  /**
   * The profile picture upload.
   *
   * The picture belongs to the ACCOUNT, so it lives here and is used
   * everywhere the member appears. The upload itself goes through the
   * server-signed R2 flow: this browser never holds a bucket credential.
   */
  const avatarUpload = useImageUpload({
    purpose: 'avatar',
    onUploaded: url => setAvatarUrl(url),
  });
  const avatarStatus = avatarUpload.status;

  /**
   * Load the stored picture so it is visible before the member changes it.
   *
   * The server returns a signed delivery url; the stored value is only an
   * object key, so the url is regenerated on every read.
   */
  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    void (async () => {
      try {
        const headers = new Headers({ Accept: 'application/json' });
        for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);
        const response = await fetch('/api/profile', { headers, cache: 'no-store' });
        const body = await response.json().catch(() => ({}));
        if (!cancelled && response.ok) setAvatarUrl(body.avatarUrl ?? null);
      } catch {
        // No picture is a fine outcome.
      }
    })();
    return () => { cancelled = true; };
  }, [currentUser, getApiAuthHeaders]);
  const [nameNotice, setNameNotice] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(profile?.displayName ?? '');
  }, [profile?.displayName]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const headers = { Accept: 'application/json', ...(await getApiAuthHeaders()) };
        const response = await fetch('/api/settings/preferences', { headers, cache: 'no-store' });
        const body = await response.json().catch(() => null);
        if (!cancelled && response.ok && body) {
          setPreferences({
            tradingProvider: body.tradingProvider === 'hyperliquid' ? 'hyperliquid' : 'ctrader',
            tradingProviderAvailable: body.tradingProviderAvailable,
            tradingProviderUnavailableReason: body.tradingProviderUnavailableReason ?? null,
          });
        }
      } catch {
        // The default is the only thing this screen needs when the request
        // fails: the account connections below work either way.
      }
    })();
    return () => { cancelled = true; };
  }, [getApiAuthHeaders]);

  const savePreferences = useCallback(
    async (patch: Partial<Pick<UserPreferences, 'tradingProvider'>>) => {
      setPreferencesError(null);
      const previous = preferences;
      setPreferences((prev) => ({ ...prev, ...patch }));
      try {
        const res = await fetch('/api/settings/preferences', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(await getApiAuthHeaders()) },
          body: JSON.stringify(patch),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error?.message ?? 'Could not save that preference.');
        if (body?.tradingProvider) {
          setPreferences((prev) => ({ ...prev, tradingProvider: body.tradingProvider === 'hyperliquid' ? 'hyperliquid' : 'ctrader' }));
        }
      } catch (err) {
        setPreferences(previous);
        setPreferencesError(err instanceof Error ? err.message : 'Could not save that preference.');
      }
    },
    [getApiAuthHeaders, preferences],
  );

  const saveDisplayName = useCallback(async () => {
    if (!currentUser) return;
    setNameSaving(true); setNameNotice(null);
    try {
      await updateProfileData({ displayName: displayName.trim() });
      setNameNotice('Saved.');
    } catch (err) {
      setNameNotice(err instanceof Error ? err.message : 'Could not save your name.');
    } finally { setNameSaving(false); }
  }, [currentUser, displayName, updateProfileData]);

  /**
   * Bring the requested section into view.
   *
   * A room's "Connect Broker" panel links straight to the connection screen
   * the member needs, so the section is scrolled into place once it is on
   * the page. The delay lets the section mount before it is measured.
   */
  useEffect(() => {
    if (!section) return;
    const target = document.getElementById(section);
    if (!target) return;
    const timer = window.setTimeout(() => {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [section]);

  return (
    <div className="space-y-6 pb-20 max-w-3xl mx-auto">
      {/* Title */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-fg flex items-center gap-2">
            <UserRound className="w-5 h-5 text-accent-text" />
            <span>Settings</span>
          </h1>
          <p className="text-xs text-fg-muted mt-0.5">
            Your account, how TradingVibes looks, and the trading accounts you connect.
          </p>
        </div>
        <button type="button" onClick={() => { window.location.hash = '/rooms'; window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }); }} className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-xs font-bold text-fg hover:bg-raised">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Rooms
        </button>
      </div>

      {/* ---- ACCOUNT ---- */}
      <div className="bg-surface border border-line rounded-2xl p-4 sm:p-5 space-y-3">
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-accent-soft border border-accent/30 flex items-center justify-center text-accent-text">
              <UserRound className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-[13px] font-semibold text-fg">Your account</h2>
              <p className="text-[11px] text-fg-muted">
                {currentUser?.email ?? 'You are browsing without an account'}
              </p>
            </div>
          </div>
          <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
            isFirebaseConnected
              ? 'bg-positive-soft border-positive/40 text-positive'
              : 'bg-accent/10 border-accent/40 text-accent-text'
          }`}>
            {isFirebaseConnected ? 'Synced' : 'Offline / Local'}
          </span>
        </div>

        {currentUser ? (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="block flex-1">
                <span className="mb-1 block text-[11px] font-medium text-fg-muted">Display name</span>
                <input
                  value={displayName}
                  onChange={event => setDisplayName(event.target.value)}
                  maxLength={80}
                  placeholder="How you appear in rooms"
                  className="input w-full"
                />
              </label>
              <button type="button" onClick={() => void saveDisplayName()} disabled={nameSaving} className="btn btn-secondary shrink-0">
                {nameSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
            {nameNotice && <p className="text-[11px] text-fg-muted">{nameNotice}</p>}

            {/**
             * THE PROFILE PICTURE.
             *
             * It belongs to the ACCOUNT, not to a room: one picture, used
             * everywhere the member appears. The upload goes through the
             * server-signed R2 flow, so the browser never holds a bucket
             * credential and the object key is chosen by the server.
             */}
            <div className="flex flex-col gap-2 border-t border-line pt-3 sm:flex-row sm:items-center">
              <div className="flex items-center gap-3">
                <UserAvatar name={displayName || currentUser?.email} url={avatarUrl} size={56} />
                <div>
                  <p className="text-[11px] font-medium text-fg">Profile picture</p>
                  <p className="text-[11px] text-fg-muted">
                    Shown next to your name in rooms, chat and member lists.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 sm:ml-auto">
                <label className="btn btn-secondary inline-flex cursor-pointer items-center gap-2">
                  <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
                  {avatarStatus === 'uploading' || avatarStatus === 'committing'
                    ? 'Uploading…'
                    : avatarUrl ? 'Change picture' : 'Upload picture'}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="sr-only"
                    onChange={event => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) void avatarUpload.upload(file);
                    }}
                  />
                </label>
                {avatarUrl && (
                  <button type="button" className="btn btn-ghost" onClick={() => void avatarUpload.remove()}>
                    Remove
                  </button>
                )}
              </div>
              {avatarUpload.error && <p className="text-[11px] text-negative" role="alert">{avatarUpload.error}</p>}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
              <p className="text-[11px] text-fg-muted">You stay signed in on this device until you sign out.</p>
              <button type="button" onClick={() => void logout()} className="btn btn-secondary inline-flex items-center gap-2">
                <LogOut className="h-3.5 w-3.5" /> Log out
              </button>
            </div>
          </>
        ) : (
          <p className="text-[11px] leading-5 text-fg-muted">
            You can browse every room without an account. Sign in to join rooms, post in them and talk to their leaders.
          </p>
        )}
      </div>

      {/* ---- APPEARANCE ---- */}
      <div className="bg-surface border border-line rounded-2xl p-4 sm:p-5">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-accent-soft border border-accent/30 flex items-center justify-center text-accent-text">
            <PaletteIcon className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-[13px] font-semibold text-fg">Appearance</h2>
            <p className="text-[11px] text-fg-muted">
              Both themes are designed individually, not one inverted into the other.
            </p>
          </div>
        </div>

        <div className="mt-3 flex gap-2">
          {(['light', 'dark'] as const).map((option) => {
            const active = theme === option;
            return (
              <button
                key={option}
                type="button"
                onClick={() => setTheme(option)}
                aria-pressed={active}
                className={`flex flex-1 items-center gap-2 rounded-xl border px-3 py-2 text-[12px] font-medium transition-colors ${
                  active ? 'border-accent bg-accent-soft text-accent-text' : 'border-line bg-sunken text-fg-muted hover:border-line-strong hover:text-fg'
                }`}
              >
                {option === 'light' ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}
                {option === 'light' ? 'Light' : 'Dark'}
                {active && <Check className="ml-auto" size={13} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </div>

      {/* ---- TRADING PROVIDER ---- */}
      <div className="bg-surface border border-line rounded-2xl p-4 sm:p-5 space-y-3">
        <div>
          <h2 className="text-[13px] font-semibold text-fg">Your default venue</h2>
          <p className="text-[11px] text-fg-muted mt-0.5">Which market you look at first when you open a room. You can change it at any time.</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Default trading venue">
          {([
            { id: 'ctrader' as const, label: 'cTrader', detail: 'Broker symbols, quotes, candles and orders.' },
            { id: 'hyperliquid' as const, label: 'PropDAO', detail: 'Perpetual markets with your prop-firm account.' },
          ]).map((option) => {
            const selected = preferences.tradingProvider === option.id;
            return (
              <button key={option.id} type="button" role="radio" aria-checked={selected}
                disabled={isSavingPreferences}
                onClick={() => void savePreferences({ tradingProvider: option.id })}
                className={`flex items-start gap-2 rounded-xl border px-3 py-3 text-left transition-colors disabled:opacity-60 ${selected ? 'border-accent bg-accent-soft' : 'border-line bg-sunken hover:border-line-strong'}`}>
                <span className={`mt-0.5 h-3.5 w-3.5 rounded-full border ${selected ? 'border-accent bg-accent' : 'border-line-strong'}`} />
                <span className="min-w-0">
                  <span className="block text-xs font-semibold text-fg">{option.label}</span>
                  <span className="mt-1 block text-[10px] leading-relaxed text-fg-muted">{option.detail}</span>
                </span>
              </button>
            );
          })}
        </div>
        {preferencesError && <p role="alert" className="text-xs text-red-500">{preferencesError}</p>}
      </div>

      <CTraderSettings />

      {/* ---- PROPDAO ---- */}
      <PropDaoSettings />
    </div>
  );
};
