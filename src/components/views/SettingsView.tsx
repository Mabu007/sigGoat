import React, { useState, useEffect, useCallback } from 'react';
import { Check, Moon, Palette as PaletteIcon, Sun } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { PropDaoSettings } from './PropDaoSettings';
import {
  Settings,
  Send,
  Key,
  Shield,
  LogOut,
  LogIn,
  CheckCircle,
  AlertCircle,
  Save,
  Zap,
  Activity,
} from 'lucide-react';

interface KeyStatus {
  openRouterKeyConfigured: boolean;
  openRouterKeyInvalid?: boolean;
  groqKeyConfigured?: boolean;
  provider?: 'openrouter' | 'groq';
  telegramTokenConfigured: boolean;
  serverKeyFallback: boolean;
}

type AiProvider = 'openrouter' | 'groq';

interface TelegramStatusResponse {
  tokenConfigured: boolean;
  bot: { id: number; username: string; verifiedAt: string } | null;
  chatId: string | null;
  webhookSecretConfigured: boolean;
  webhook: { ok: boolean; pendingUpdates?: number; lastErrorMessage?: string; detail?: string } | null;
  connected: boolean;
}

/**
 * Client-side shape check, mirroring the server. Catches a bad paste before
 * a round trip so the user sees the problem immediately. The server still
 * revalidates — this is convenience, not security.
 */
const OPENROUTER_KEY_SHAPE = /^sk-(?:or-v\d+-)?[A-Za-z0-9_-]{32,}$/;
const GROQ_KEY_SHAPE = /^gsk_[A-Za-z0-9_-]{20,}$/;
const TELEGRAM_TOKEN_SHAPE = /^\d{5,20}:[A-Za-z0-9_-]{30,}$/;

/**
 * Client-side shape check, mirroring the server. Catches a bad paste before a
 * round trip so the user sees the problem immediately. The server still
 * revalidates — this is convenience, not security.
 *
 * The provider matters: an OpenRouter key pasted into the Groq field is a
 * different mistake from a typo, and gets a message that says so.
 */
function validateProviderKey(raw: string, provider: AiProvider): string | null {
  const value = raw.trim();
  if (!value) return null;

  if (provider === 'groq') {
    if (!GROQ_KEY_SHAPE.test(value)) {
      return 'That does not look like a Groq API key. Expected something like gsk_… (console.groq.com/keys). Choose the OpenRouter provider if you have an OpenRouter key.';
    }
    return null;
  }

  if (!OPENROUTER_KEY_SHAPE.test(value)) {
    return 'That does not look like an OpenRouter API key. Expected something like sk-or-v1-… (openrouter.ai/keys → Create new key).';
  }
  return null;
}

export const SettingsView: React.FC = () => {
  const { theme, setTheme } = useTheme();
  const {
    currentUser,
    profile,
    loginWithGoogle,
    logout,
    isFirebaseConnected,
    getApiAuthHeaders,
    authMode,
    authError,
  } = useAuth();

  // Keys State. Market data needs no user key; the provider does.
  const [provider, setProvider] = useState<AiProvider>('openrouter');
  const [openRouterKey, setOpenRouterKey] = useState('');
  const [groqKey, setGroqKey] = useState('');
  const [telegramToken, setTelegramToken] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatusResponse | null>(null);
  const [isConnectingTelegram, setIsConnectingTelegram] = useState(false);
  const [isDisconnectingTelegram, setIsDisconnectingTelegram] = useState(false);

  // Status & Feedback State
  const [isSaving, setIsSaving] = useState(false);
  const [isTestingAi, setIsTestingAi] = useState(false);
  const [isTestingTelegram, setIsTestingTelegram] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [serverStatus, setServerStatus] = useState<any>(null);

  const loadKeyStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/keys', {
        headers: { Accept: 'application/json', ...(await getApiAuthHeaders()) },
      });
      if (!res.ok) return;
      setKeyStatus((await res.json()) as KeyStatus);
    } catch (err) {
      console.warn('Unable to read key status:', err);
    }
  }, [getApiAuthHeaders]);

  useEffect(() => {
    fetch('/api/settings/status')
      .then(res => res.json())
      .then(data => setServerStatus(data))
      .catch(console.warn);
  }, []);

  const loadTelegramStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/telegram/status', {
        headers: { Accept: 'application/json', ...(await getApiAuthHeaders()) },
      });
      if (!res.ok) return;
      setTelegramStatus((await res.json()) as TelegramStatusResponse);
    } catch (err) {
      console.warn('Unable to read Telegram status:', err);
    }
  }, [getApiAuthHeaders]);

  useEffect(() => {
    void loadKeyStatus();
    void loadTelegramStatus();
  }, [loadKeyStatus, loadTelegramStatus]);

  const platform = serverStatus?.platform;
  const marketData = serverStatus?.marketData;
  const reasoningStatus = serverStatus?.reasoning;
  // Deployment-level Telegram facts (server token, secret required).
  const telegramPlatform = serverStatus?.telegram;

  /**
   * "Saved" tracks the SELECTED provider only.
   *
   * Reporting a stored OpenRouter key as satisfying a Groq configuration would
   * tell the user they are set up when every wake is about to fail.
   */
  const hasSavedKey =
    provider === 'groq'
      ? (keyStatus?.groqKeyConfigured ?? false)
      : (keyStatus?.openRouterKeyConfigured ?? false);

  const handleSaveKeys = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setSaveError(null);
    setTestResult(null);

    // Catch bad pastes before spending a round trip.
    const shapeError =
      validateProviderKey(openRouterKey, 'openrouter') ??
      validateProviderKey(groqKey, 'groq') ??
      (telegramToken.trim() && !TELEGRAM_TOKEN_SHAPE.test(telegramToken.trim())
        ? 'That does not look like a Telegram bot token. Expected the value from @BotFather, like 123456789:AA…'
        : null);

    if (shapeError) {
      setSaveError(shapeError);
      setIsSaving(false);
      return;
    }

    try {
      const res = await fetch('/api/settings/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await getApiAuthHeaders()) },
        body: JSON.stringify({
          provider,
          // Only send fields the user actually filled in; an empty box must
          // never wipe an existing stored secret.
          ...(openRouterKey.trim() ? { openRouterKey: openRouterKey.trim() } : {}),
          ...(groqKey.trim() ? { groqKey: groqKey.trim() } : {}),
          ...(telegramToken.trim() ? { telegramToken: telegramToken.trim() } : {}),
          ...(telegramChatId.trim() ? { telegramChatId: telegramChatId.trim() } : {}),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setSaveError(body?.error?.message || `Failed to save settings (HTTP ${res.status}).`);
        return;
      }

      const body = await res.json().catch(() => null);
      setKeyStatus((prev) => ({
        openRouterKeyConfigured: body?.openRouterKeyConfigured ?? prev?.openRouterKeyConfigured ?? false,
        groqKeyConfigured: body?.groqKeyConfigured ?? prev?.groqKeyConfigured ?? false,
        provider: body?.provider ?? provider,
        telegramTokenConfigured: Boolean(telegramToken.trim()) || (prev?.telegramTokenConfigured ?? false),
        serverKeyFallback: prev?.serverKeyFallback ?? false,
      }));

      // Secrets are never read back; clear the inputs so they cannot leak
      // into a screenshot or a later shoulder-surf.
      setOpenRouterKey('');
      setGroqKey('');
      setTelegramToken('');
      setTestResult({ ok: true, message: 'Saved. Your GOATs will use these credentials on the next reasoning run.' });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save settings.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestAi = async () => {
    setIsTestingAi(true);
    setTestResult(null);
    setSaveError(null);
    try {
      const headers = await getApiAuthHeaders();

      // Persist first when a key is typed but unsaved, so the test exercises
      // exactly what will be stored.
      const pendingKey =
        provider === 'groq' ? groqKey.trim() : openRouterKey.trim();

      if (pendingKey) {
        const saveRes = await fetch('/api/settings/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({
            provider,
            ...(provider === 'groq' ? { groqKey: pendingKey } : { openRouterKey: pendingKey }),
          }),
        });
        if (!saveRes.ok) {
          const body = await saveRes.json().catch(() => null);
          setTestResult({ ok: false, message: body?.error?.message || 'Could not save the key before testing.' });
          return;
        }
        setOpenRouterKey('');
        setGroqKey('');
        await loadKeyStatus();
      }

      const res = await fetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
      });
      const data = await res.json();

      if (data.ok) {
        setTestResult({
          ok: true,
          message: `${data.provider ?? provider} connected — model ${data.model} responded in ${data.latencyMs}ms.`,
        });
      } else {
        setTestResult({ ok: false, message: data.error || `${provider} rejected the key.` });
      }
    } catch (err: any) {
      setTestResult({ ok: false, message: err.message || `Network error reaching ${provider}.` });
    } finally {
      setIsTestingAi(false);
    }
  };

  /**
   * CONNECTS THE BOT, rather than merely storing a token.
   *
   * Storing a token proves nothing: it has not been checked with Telegram, and
   * no webhook is registered, so no command and no alert would arrive. This
   * calls `getMe`, registers the webhook, and optionally verifies the chat, and
   * only reports success if Telegram itself agreed.
   */
  const handleConnectTelegram = async () => {
    const token = telegramToken.trim();

    if (!token) {
      setSaveError('Paste the bot token from @BotFather first.');
      return;
    }
    if (!TELEGRAM_TOKEN_SHAPE.test(token)) {
      setSaveError('That does not look like a Telegram bot token. Expected the value from @BotFather, like 123456789:AA…');
      return;
    }
    if (telegramChatId.trim() && !/^-?\d{1,20}$/.test(telegramChatId.trim())) {
      setSaveError('Your Telegram Chat ID must be numeric. Message @userinfobot to find it.');
      return;
    }

    setIsConnectingTelegram(true);
    setSaveError(null);
    setTestResult(null);

    try {
      const res = await fetch('/api/telegram/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await getApiAuthHeaders()) },
        body: JSON.stringify({
          telegramToken: token,
          ...(telegramChatId.trim() ? { chatId: telegramChatId.trim() } : {}),
        }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setSaveError(data?.error?.message || `Could not connect the bot (HTTP ${res.status}).`);
        return;
      }

      // The token is never read back, so clear the field immediately.
      setTelegramToken('');
      setTelegramChatId('');
      await Promise.all([loadTelegramStatus(), loadKeyStatus()]);

      setTestResult({
        ok: true,
        message: data.chatVerified
          ? `@${data.bot?.username} is connected and verified. Try /processes in Telegram.`
          : `@${data.bot?.username} is connected and the webhook is registered. Send /start to your bot to finish.`,
      });
    } catch (err: any) {
      setSaveError(err?.message || 'Network error reaching Telegram.');
    } finally {
      setIsConnectingTelegram(false);
    }
  };

  const handleDisconnectTelegram = async () => {
    setIsDisconnectingTelegram(true);
    setSaveError(null);
    setTestResult(null);

    try {
      const res = await fetch('/api/telegram/connect', {
        method: 'DELETE',
        headers: { Accept: 'application/json', ...(await getApiAuthHeaders()) },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setSaveError(body?.error?.message || `Could not disconnect (HTTP ${res.status}).`);
        return;
      }
      await Promise.all([loadTelegramStatus(), loadKeyStatus()]);
      setTestResult({ ok: true, message: 'Telegram disconnected. The webhook has been removed.' });
    } catch (err: any) {
      setSaveError(err?.message || 'Network error reaching Telegram.');
    } finally {
      setIsDisconnectingTelegram(false);
    }
  };

  const handleTestTelegram = async () => {
    if (!telegramChatId) {
      setTestResult({ ok: false, message: 'Please enter your Telegram Chat ID first.' });
      return;
    }
    setIsTestingTelegram(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/telegram/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await getApiAuthHeaders()) },
        body: JSON.stringify({
          chatId: telegramChatId.trim(),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setTestResult({ ok: true, message: 'Telegram test alert delivered successfully! Check your phone.' });
      } else {
        setTestResult({ ok: false, message: data.description || 'Telegram failed. Check your Bot Token and Chat ID.' });
      }
    } catch (err: any) {
      setTestResult({ ok: false, message: err.message || 'Network error reaching Telegram API.' });
    } finally {
      setIsTestingTelegram(false);
    }
  };

  return (
    <div className="space-y-6 pb-20 max-w-3xl mx-auto">
      {/* Title */}
      <div>
        <h1 className="text-lg font-bold text-fg flex items-center gap-2">
          <Settings className="w-5 h-5 text-accent-text" />
          <span>Settings</span>
        </h1>
        <p className="text-xs text-fg-muted mt-0.5">
          Account, appearance, model provider, PropDAO connection and Telegram notifications.
        </p>
      </div>

      {/* ---- APPEARANCE ---- */}
      <div className="bg-surface border border-line rounded-2xl p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-accent-soft border border-accent/30 flex items-center justify-center text-accent-text">
              <PaletteIcon />
            </div>
            <div>
              <h2 className="text-[13px] font-semibold text-fg">Appearance</h2>
              <p className="text-[11px] text-fg-muted">
                Both themes are designed individually, not one inverted into the other.
              </p>
            </div>
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
                  active
                    ? 'border-accent bg-accent-soft text-accent-text'
                    : 'border-line bg-sunken text-fg-muted hover:border-line-strong hover:text-fg'
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

      {/* ---- PROPDAO ---- */}
      <PropDaoSettings />

      {/* 1. SOLE MARKET DATA STATUS (AUTOMATIC - NO USER KEY NEEDED) */}
      <div className="bg-surface border border-line rounded-2xl p-4 sm:p-5 space-y-3">
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-positive-soft border border-positive/40 flex items-center justify-center text-positive">
              <Activity className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-fg">Market Data Engine</h2>
              <p className="text-xs text-fg-muted">
                {marketData?.dataMode === 'PAPER'
                  ? 'Deterministic simulated feed — prices are generated locally and are NOT live market prices.'
                  : marketData?.dataMode === 'LIVE'
                    ? 'Live market data feed for Forex, Commodities, and Indices.'
                    : 'Integrated market data service for Forex, Commodities, and Indices.'}
              </p>
            </div>
          </div>
          {marketData?.dataMode === 'PAPER' ? (
            <span className="text-[10px] font-mono px-2 py-0.5 bg-accent/10 text-accent-text border border-accent/40 rounded flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-accent" />
              PAPER · simulated
            </span>
          ) : (
            <span className="text-[10px] font-mono px-2 py-0.5 bg-positive-soft text-positive border border-positive/30 rounded flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-positive animate-pulse" />
              Connected
            </span>
          )}
        </div>

        <div className="text-xs text-fg-muted space-y-1.5 bg-sunken/60 p-3.5 rounded-xl border border-line">
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">Data Mode:</span>
            <span className={`font-semibold ${marketData?.dataMode === 'PAPER' ? 'text-accent-text' : 'text-positive'}`}>
              {marketData?.dataMode ?? 'PAPER'}
              {marketData?.dataMode === 'PAPER' && ' (not live prices)'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">Provider:</span>
            <span className="text-fg font-mono">{marketData?.provider ?? '—'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">Supported Asset Classes:</span>
            <span className="text-fg">Forex Majors &amp; Crosses, Gold, Silver, Crude Oil, Major Indices</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">Symbols Available:</span>
            <span className="font-mono text-accent-text">{marketData?.symbolsCount ?? '—'}</span>
          </div>
        </div>
      </div>

      {/* 2. TELEGRAM NOTIFICATIONS & TWO-WAY INTERFACE */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleTestTelegram();
        }}
        autoComplete="off"
        className="bg-surface border border-line rounded-2xl p-4 sm:p-5 space-y-4"
      >
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-info-soft border border-info/30 flex items-center justify-center text-info">
              <Send className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-fg">Telegram Real-Time Alerts &amp; Chat</h2>
              <p className="text-xs text-fg-muted">Receive human-readable signal alerts and chat with your GOAT on Telegram.</p>
            </div>
          </div>
          <span
            className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
              telegramStatus?.connected
                ? 'bg-positive-soft border-positive/40 text-positive'
                : telegramStatus?.tokenConfigured
                  ? 'bg-accent/10 border-accent/40 text-accent-text'
                  : 'bg-sunken border-line-strong text-fg-muted'
            }`}
          >
            {telegramStatus?.connected
              ? `Connected @${telegramStatus.bot?.username}`
              : telegramStatus?.tokenConfigured
                ? 'Token saved, not verified'
                : 'Not connected'}
          </span>
        </div>

        <div className="space-y-3 text-xs">
          {/**
           * A stored token is NOT a connected bot.
           *
           * The old flow saved the token and reported nothing else, so a user
           * could believe alerts were arriving when no webhook was ever
           * registered. This states which of the three states is actually true.
           */}
          {telegramStatus && (
            <div className="rounded-xl border border-line bg-sunken/60 p-3 space-y-1 text-[11px]">
              {telegramStatus.connected && telegramStatus.webhook?.ok && (
                <div className="text-positive flex items-center gap-1.5">
                  <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    Verified with Telegram as <strong>@{telegramStatus.bot?.username}</strong>. Webhook registered.
                  </span>
                </div>
              )}

              {!telegramStatus.connected && telegramStatus.tokenConfigured && (
                <div className="text-accent-text flex items-start gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>
                    A token is stored but the bot is <strong>not</strong> connected, so commands and alerts will not
                    arrive. Reconnect to verify it with Telegram.
                    {telegramStatus.webhook && !telegramStatus.webhook.ok && (
                      <>
                        {' '}
                        Telegram reported: {telegramStatus.webhook.detail ?? telegramStatus.webhook.lastErrorMessage}
                      </>
                    )}
                  </span>
                </div>
              )}

              {!telegramStatus.webhookSecretConfigured && (
                <div className="text-negative flex items-start gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>
                    This deployment has no Telegram webhook secret configured, so no bot can be connected securely. An
                    operator must set TELEGRAM_WEBHOOK_SECRET.
                  </span>
                </div>
              )}
            </div>
          )}

          <div>
            <label htmlFor="telegram-token" className="block font-semibold text-fg-muted mb-1">
              Telegram Bot Token
            </label>
            <input
              id="telegram-token"
              name="telegram-bot-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={telegramToken}
              onChange={e => setTelegramToken(e.target.value)}
              placeholder={keyStatus?.telegramTokenConfigured ? 'Saved — type a new token to replace it' : 'e.g. 123456789:ABCdefGHIjklmnoPQRstuvWXYZ (from @BotFather)'}
              className="w-full bg-sunken border border-line rounded-xl px-3 py-2 text-fg placeholder-fg-subtle font-mono focus:outline-none focus:border-focus"
            />
          </div>

          <div>
            <label htmlFor="telegram-chat-id" className="block font-semibold text-fg-muted mb-1">
              Your Telegram Chat ID
            </label>
            <input
              id="telegram-chat-id"
              name="telegram-chat-id"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={telegramChatId}
              onChange={e => setTelegramChatId(e.target.value)}
              placeholder="e.g. 987654321 (message @userinfobot to see your ID)"
              className="w-full bg-sunken border border-line rounded-xl px-3 py-2 text-fg placeholder-fg-subtle font-mono focus:outline-none focus:border-focus"
            />
          </div>

          {testResult && (
            <div
              className={`p-3 rounded-xl border text-xs flex items-start gap-2 ${
                testResult.ok
                  ? 'bg-positive-soft border-positive/40 text-positive'
                  : 'bg-negative-soft border-negative/40 text-negative'
              }`}
            >
              {testResult.ok ? (
                <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              )}
              <span>{testResult.message}</span>
            </div>
          )}

          {saveError && (
            <div className="p-3 bg-negative-soft border border-negative/40 text-negative rounded-xl flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{saveError}</span>
            </div>
          )}

          {testResult && (
            <div
              className={`p-3 rounded-xl border text-xs flex items-start gap-2 ${
                testResult.ok
                  ? 'bg-positive-soft border-positive/40 text-positive'
                  : 'bg-negative-soft border-negative/40 text-negative'
              }`}
            >
              {testResult.ok ? (
                <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              )}
              <span>{testResult.message}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {/**
             * Connect is the action that MAKES it work: it verifies the token
             * with Telegram and registers the webhook. Send Test only proves the
             * bot can message one chat, so it is secondary and disabled until
             * the bot is actually connected.
             */}
            <button
              type="button"
              onClick={() => void handleConnectTelegram()}
              disabled={isConnectingTelegram || isDisconnectingTelegram}
              className="flex items-center gap-1.5 bg-info hover:bg-info text-accent-fg font-bold text-xs py-2 px-3.5 rounded-xl transition-colors cursor-pointer disabled:opacity-50"
            >
              <Shield className="w-3.5 h-3.5" />
              <span>
                {isConnectingTelegram
                  ? 'Connecting…'
                  : telegramStatus?.tokenConfigured
                    ? 'Reconnect Bot'
                    : 'Connect Bot'}
              </span>
            </button>

            <button
              type="submit"
              disabled={isTestingTelegram || !telegramStatus?.connected}
              title={
                telegramStatus?.connected
                  ? undefined
                  : 'Connect the bot first — the webhook must be registered before a test means anything.'
              }
              className="flex items-center gap-1.5 bg-sunken hover:bg-raised text-fg border border-line font-bold text-xs py-2 px-3.5 rounded-xl transition-colors cursor-pointer disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{isTestingTelegram ? 'Sending Test...' : 'Send Test Alert'}</span>
            </button>

            {telegramStatus?.tokenConfigured && (
              <button
                type="button"
                onClick={() => void handleDisconnectTelegram()}
                disabled={isConnectingTelegram || isDisconnectingTelegram}
                className="flex items-center gap-1.5 bg-sunken hover:bg-raised text-negative border border-negative/40 font-bold text-xs py-2 px-3.5 rounded-xl transition-colors cursor-pointer disabled:opacity-50"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>{isDisconnectingTelegram ? 'Disconnecting…' : 'Disconnect'}</span>
              </button>
            )}
          </div>

          {/* Setup Guide */}
          <div className="bg-sunken/60 border border-line rounded-xl p-3 text-[11px] text-fg-muted space-y-1">
            <strong className="text-fg-muted block mb-1">Quick Telegram Setup:</strong>
            <div>1. Open Telegram, message <strong>@BotFather</strong>, send <code>/newbot</code> to get your Bot Token.</div>
            <div>2. Message <strong>@userinfobot</strong> to get your numerical Chat ID.</div>
            <div>3. Press &quot;Start&quot; on your new bot, paste both above, then click &quot;Connect Bot&quot;.</div>
            <div>4. In Telegram send <code>/help</code> to see every command.</div>
          </div>
        </div>
      </form>

      {/* 3. AI MODEL CONFIGURATION */}
      <form onSubmit={handleSaveKeys} className="bg-surface border border-line rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="border-b border-line pb-3">
          <h2 className="text-sm font-bold text-fg flex items-center gap-2">
            <Key className="w-4 h-4 text-accent-text" />
            <span>AI Reasoning Engine</span>
          </h2>
          <p className="text-xs text-fg-muted mt-0.5">
            Configure optional model credentials allowing your FundAGoat to reason via Claude 3.5 Sonnet, DeepSeek, or Llama.
          </p>
        </div>

        <div className="space-y-3.5 text-xs">
          {/**
           * Provider choice comes FIRST, because the key field below means
           * different things depending on it. Choosing Groq and pasting an
           * OpenRouter key is the single most likely mistake here, so the two
           * are separated before either key is typed.
           */}
          <div>
            <span className="block font-semibold text-fg-muted mb-1.5">
              Reasoning provider
            </span>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  {
                    id: 'openrouter' as const,
                    label: 'OpenRouter',
                    hint: 'Any model in the live catalogue',
                  },
                  {
                    id: 'groq' as const,
                    label: 'Groq',
                    hint: 'Fast Llama/Qwen models, own key',
                  },
                ]
              ).map((option) => {
                const selected = provider === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setProvider(option.id)}
                    aria-pressed={selected}
                    className={`text-left rounded-xl border px-3 py-2 transition-colors cursor-pointer ${
                      selected
                        ? 'border-accent/60 bg-accent-soft text-accent-text'
                        : 'border-line bg-sunken text-fg-muted hover:border-line-strong'
                    }`}
                  >
                    <span className="block text-xs font-bold">{option.label}</span>
                    <span className="block text-[10px] opacity-80">{option.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {provider === 'openrouter' ? (
          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="openrouter-key" className="font-semibold text-fg-muted">
                AI Model API Key (OpenRouter)
              </label>
              {keyStatus?.openRouterKeyInvalid ? (
                <span className="text-[10px] text-negative flex items-center gap-1 font-mono">
                  <AlertCircle className="w-3 h-3" /> Stored key is invalid
                </span>
              ) : hasSavedKey ? (
                <span className="text-[10px] text-positive flex items-center gap-1 font-mono">
                  <CheckCircle className="w-3 h-3" /> Your key is saved
                </span>
              ) : reasoningStatus?.serverKeyConfigured ? (
                <span className="text-[10px] text-info flex items-center gap-1 font-mono">
                  <Zap className="w-3 h-3" /> Using platform key
                </span>
              ) : (
                <span className="text-[10px] text-accent-text flex items-center gap-1 font-mono">
                  <AlertCircle className="w-3 h-3" /> Not configured
                </span>
              )}
            </div>
            <input
              id="openrouter-key"
              name="openrouter-api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={openRouterKey}
              onChange={e => setOpenRouterKey(e.target.value)}
              placeholder={hasSavedKey ? 'Saved — type a new key to replace it' : 'sk-or-v1-...'}
              className="w-full bg-sunken border border-line rounded-xl px-3 py-2 text-fg placeholder-fg-subtle font-mono focus:outline-none focus:border-focus"
            />
            <p className="text-[10px] text-fg-muted mt-1">
              Stored per-account on the server and used only for your GOATs. Get one at openrouter.ai/keys.
            </p>

            {keyStatus?.openRouterKeyInvalid && (
              <p className="mt-2 rounded-lg border border-negative/40 bg-negative-soft p-2 text-[10px] leading-relaxed text-negative">
                A saved value for this account is not a valid OpenRouter key, so
                every analysis is failing. Enter a valid key below and save to
                replace it.
              </p>
            )}
          </div>
          ) : (
          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="groq-key" className="font-semibold text-fg-muted">
                AI Model API Key (Groq)
              </label>
              {hasSavedKey ? (
                <span className="text-[10px] text-positive flex items-center gap-1 font-mono">
                  <CheckCircle className="w-3 h-3" /> Your key is saved
                </span>
              ) : (
                <span className="text-[10px] text-accent-text flex items-center gap-1 font-mono">
                  <AlertCircle className="w-3 h-3" /> Not configured
                </span>
              )}
            </div>
            <input
              id="groq-key"
              name="groq-api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={groqKey}
              onChange={e => setGroqKey(e.target.value)}
              placeholder={hasSavedKey ? 'Saved — type a new key to replace it' : 'gsk_...'}
              className="w-full bg-sunken border border-line rounded-xl px-3 py-2 text-fg placeholder-fg-subtle font-mono focus:outline-none focus:border-focus"
            />
            <p className="text-[10px] text-fg-muted mt-1">
              Stored per-account on the server and used only for your GOATs. Get one at console.groq.com/keys.
              Groq is a separate service from OpenRouter: its model names are not interchangeable, and it is not
              unlimited or always free.
            </p>
          </div>
          )}

          {saveError && (
            <div className="p-3 bg-negative-soft border border-negative/40 text-negative rounded-xl flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{saveError}</span>
            </div>
          )}

          {testResult && (
            <div
              className={`p-3 rounded-xl border text-xs flex items-start gap-2 ${
                testResult.ok
                  ? 'bg-positive-soft border-positive/40 text-positive'
                  : 'bg-negative-soft border-negative/40 text-negative'
              }`}
            >
              {testResult.ok ? (
                <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              )}
              <span>{testResult.message}</span>
            </div>
          )}

          <div className="pt-2 flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleTestAi}
              disabled={isTestingAi || isSaving}
              className="flex items-center gap-1.5 bg-sunken hover:bg-raised text-fg border border-line font-bold text-xs py-2 px-3.5 rounded-xl transition-colors cursor-pointer disabled:opacity-50"
            >
              <Zap className="w-3.5 h-3.5" />
              <span>{isTestingAi ? 'Testing...' : `Test ${provider} Key`}</span>
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="flex items-center gap-1.5 bg-accent hover:bg-accent text-accent-fg font-bold text-xs py-2 px-4 rounded-xl transition-colors cursor-pointer disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{isSaving ? 'Saving...' : 'Save Configuration'}</span>
            </button>
          </div>
        </div>
      </form>

      {/* 4. USER PROFILE & PERSISTENCE */}
      <div className="bg-surface border border-line rounded-2xl p-4 sm:p-5 space-y-4">
        {(platform?.authMode === 'dev' || platform?.persistenceMode) && (
          <div className="text-[10px] font-mono text-fg-subtle flex flex-wrap gap-3">
            <span>Auth mode: {platform?.authMode ?? '—'}</span>
            <span>·</span>
            <span>Persistence: {platform?.persistenceMode ?? '—'}</span>
            <span>·</span>
            <span>Active GOAT actors: {platform?.activeActors ?? 0}</span>
          </div>
        )}
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-positive-soft border border-positive/40 flex items-center justify-center text-positive">
              <Shield className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-fg">Your Account</h2>
              <p className="text-xs text-fg-muted">Cloud synchronization and preferences for your GOAT definitions, skills, and signals.</p>
            </div>
          </div>
          <span
            className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
              isFirebaseConnected
                ? 'bg-positive-soft border-positive/40 text-positive'
                : 'bg-accent/10 border-accent/40 text-accent-text'
            }`}
          >
            {isFirebaseConnected ? 'Cloud Synced' : 'Offline / Local'}
          </span>
        </div>

        <div className="text-xs space-y-3">
          {currentUser ? (
            <div className="space-y-3">
              <div className="p-3 bg-sunken rounded-xl border border-line space-y-1">
                <div className="text-fg-muted">
                  Signed in as: <strong className="text-fg">{profile?.email || currentUser.email || 'Trader'}</strong>
                </div>
                <div className="text-fg-muted text-[11px] font-mono truncate">
                  Account Reference: {currentUser.uid ? currentUser.uid.slice(0, 8) + '...' : 'Local'}
                </div>
              </div>

              <button
                onClick={logout}
                className="flex items-center gap-1.5 text-xs text-negative hover:text-negative bg-negative-soft border border-negative/40 px-3.5 py-2 rounded-xl transition-colors cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Sign Out</span>
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-fg-muted">
                You are currently browsing as a local session. Sign in with Google to sync your GOATs across devices.
              </p>
              <button
                onClick={() => {
                  void loginWithGoogle().catch(() => {
                    /* Message is surfaced from authError below. */
                  });
                }}
                className="flex items-center gap-2 bg-sunken hover:bg-raised text-fg border border-line font-bold text-xs py-2.5 px-4 rounded-xl transition-colors cursor-pointer"
              >
                <LogIn className="w-4 h-4 text-accent-text" />
                <span>Sign in with Google</span>
              </button>
            </div>
          )}

          {/* Sign-in failures are configuration problems: show the exact fix. */}
          {authError && (
            <div className="rounded-xl border border-accent/40 bg-accent/10 p-3">
              <div className="flex items-start gap-2 text-xs font-bold text-accent-text">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Sign-in failed</span>
              </div>

              <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed text-accent-text/90">
                {authError}
              </pre>
            </div>
          )}

          {/* Honest labelling of which auth mode is actually running. */}
          {authMode === 'dev' && (
            <div className="rounded-xl border border-accent/30 bg-sunken/60 p-3 text-[11px] text-fg-muted">
              <strong className="text-accent-text">
                Local mode (FUNDAGOAT_ALLOW_DEV_AUTH=1).
              </strong>{' '}
              Identity is a browser-generated local id, not a real account.
              Set the Firebase service-account variable and remove the dev flag
              to enable Google sign-in and cloud sync.
            </div>
          )}

          {authMode === 'none' && (
            <div className="rounded-xl border border-negative/40 bg-negative-soft p-3 text-[11px] text-negative">
              <strong className="text-negative">
                No authentication configured.
              </strong>{' '}
              {platform?.authNotConfiguredReason ??
                'The server has no Firebase credentials.'}{' '}
              Every signed-in request will fail until this is set.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
