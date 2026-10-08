import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
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
  telegramTokenConfigured: boolean;
  serverKeyFallback: boolean;
}

/**
 * Client-side shape check, mirroring the server. Catches a bad paste before
 * a round trip so the user sees the problem immediately. The server still
 * revalidates — this is convenience, not security.
 */
const OPENROUTER_KEY_SHAPE = /^sk-(?:or-v\d+-)?[A-Za-z0-9_-]{32,}$/;
const TELEGRAM_TOKEN_SHAPE = /^\d{5,20}:[A-Za-z0-9_-]{30,}$/;

function validateOpenRouterKey(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (!OPENROUTER_KEY_SHAPE.test(value)) {
    return 'That does not look like an OpenRouter API key. Expected something like sk-or-v1-… (openrouter.ai/keys → Create new key).';
  }
  return null;
}

export const SettingsView: React.FC = () => {
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

  // Keys State (OpenRouter and Telegram only - NO BiQuote user key!)
  const [openRouterKey, setOpenRouterKey] = useState('');
  const [telegramToken, setTelegramToken] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');

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

  useEffect(() => {
    void loadKeyStatus();
  }, [loadKeyStatus]);

  const platform = serverStatus?.platform;
  const marketData = serverStatus?.marketData;
  const reasoningStatus = serverStatus?.reasoning;
  const telegramStatus = serverStatus?.telegram;

  const hasSavedKey = keyStatus?.openRouterKeyConfigured ?? false;

  const handleSaveKeys = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setSaveError(null);
    setTestResult(null);

    // Catch bad pastes before spending a round trip.
    const shapeError =
      validateOpenRouterKey(openRouterKey) ??
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
          // Only send fields the user actually filled in; an empty box must
          // never wipe an existing stored secret.
          ...(openRouterKey.trim() ? { openRouterKey: openRouterKey.trim() } : {}),
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
        telegramTokenConfigured: Boolean(telegramToken.trim()) || (prev?.telegramTokenConfigured ?? false),
        serverKeyFallback: prev?.serverKeyFallback ?? false,
      }));

      // Secrets are never read back; clear the inputs so they cannot leak
      // into a screenshot or a later shoulder-surf.
      setOpenRouterKey('');
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
      const pendingKey = openRouterKey.trim();
      if (pendingKey) {
        const saveRes = await fetch('/api/settings/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ openRouterKey: pendingKey }),
        });
        if (!saveRes.ok) {
          const body = await saveRes.json().catch(() => null);
          setTestResult({ ok: false, message: body?.error?.message || 'Could not save the key before testing.' });
          return;
        }
        setOpenRouterKey('');
        await loadKeyStatus();
      }

      const res = await fetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
      });
      const data = await res.json();

      if (data.ok) {
        setTestResult({ ok: true, message: `OpenRouter connected — model ${data.model} responded in ${data.latencyMs}ms.` });
      } else {
        setTestResult({ ok: false, message: data.error || 'OpenRouter rejected the key.' });
      }
    } catch (err: any) {
      setTestResult({ ok: false, message: err.message || 'Network error reaching OpenRouter.' });
    } finally {
      setIsTestingAi(false);
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
        <h1 className="text-lg font-bold text-slate-100 flex items-center gap-2">
          <Settings className="w-5 h-5 text-amber-400" />
          <span>System Settings &amp; Integrations</span>
        </h1>
        <p className="text-xs text-slate-400 mt-0.5">
          Configure real-time Telegram notifications, advanced AI reasoning engines, and view market data status.
        </p>
      </div>

      {/* 1. SOLE MARKET DATA STATUS (AUTOMATIC - NO USER KEY NEEDED) */}
      <div className="bg-[#0c0f17] border border-slate-800 rounded-2xl p-4 sm:p-5 space-y-3">
        <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Activity className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">Market Data Engine</h2>
              <p className="text-xs text-slate-400">
                {marketData?.dataMode === 'PAPER'
                  ? 'Deterministic simulated feed — prices are generated locally and are NOT live market prices.'
                  : marketData?.dataMode === 'LIVE'
                    ? 'Live market data feed for Forex, Commodities, and Indices.'
                    : 'Integrated market data service for Forex, Commodities, and Indices.'}
              </p>
            </div>
          </div>
          {marketData?.dataMode === 'PAPER' ? (
            <span className="text-[10px] font-mono px-2 py-0.5 bg-amber-500/10 text-amber-300 border border-amber-500/30 rounded flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              PAPER · simulated
            </span>
          ) : (
            <span className="text-[10px] font-mono px-2 py-0.5 bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 rounded flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Connected
            </span>
          )}
        </div>

        <div className="text-xs text-slate-300 space-y-1.5 bg-slate-900/60 p-3.5 rounded-xl border border-slate-800/80">
          <div className="flex items-center justify-between">
            <span className="text-slate-400">Data Mode:</span>
            <span className={`font-semibold ${marketData?.dataMode === 'PAPER' ? 'text-amber-300' : 'text-emerald-400'}`}>
              {marketData?.dataMode ?? 'PAPER'}
              {marketData?.dataMode === 'PAPER' && ' (not live prices)'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-400">Provider:</span>
            <span className="text-slate-200 font-mono">{marketData?.provider ?? '—'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-400">Supported Asset Classes:</span>
            <span className="text-slate-200">Forex Majors &amp; Crosses, Gold, Silver, Crude Oil, Major Indices</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-400">Symbols Available:</span>
            <span className="font-mono text-amber-300">{marketData?.symbolsCount ?? '—'}</span>
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
        className="bg-[#0c0f17] border border-slate-800 rounded-2xl p-4 sm:p-5 space-y-4"
      >
        <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400">
              <Send className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">Telegram Real-Time Alerts &amp; Chat</h2>
              <p className="text-xs text-slate-400">Receive human-readable signal alerts and chat with your GOAT on Telegram.</p>
            </div>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 bg-sky-500/10 text-sky-300 border border-sky-500/20 rounded">
            Two-Way
          </span>
        </div>

        <div className="space-y-3 text-xs">
          <div>
            <label htmlFor="telegram-token" className="block font-semibold text-slate-300 mb-1">
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
              className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-slate-100 placeholder-slate-400 font-mono focus:outline-none focus:border-amber-500/50"
            />
          </div>

          <div>
            <label htmlFor="telegram-chat-id" className="block font-semibold text-slate-300 mb-1">
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
              className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-slate-100 placeholder-slate-400 font-mono focus:outline-none focus:border-amber-500/50"
            />
          </div>

          {testResult && (
            <div
              className={`p-3 rounded-xl border text-xs flex items-start gap-2 ${
                testResult.ok
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                  : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
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
            <button
              type="submit"
              disabled={isTestingTelegram}
              className="flex items-center gap-1.5 bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs py-2 px-3.5 rounded-xl transition-colors cursor-pointer disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{isTestingTelegram ? 'Sending Test...' : 'Send Test Alert to Telegram'}</span>
            </button>
          </div>

          {/* Setup Guide */}
          <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-3 text-[11px] text-slate-400 space-y-1">
            <strong className="text-slate-300 block mb-1">Quick Telegram Setup:</strong>
            <div>1. Open Telegram, message <strong>@BotFather</strong>, send <code>/newbot</code> to get your Bot Token.</div>
            <div>2. Message <strong>@userinfobot</strong> to get your numerical Chat ID.</div>
            <div>3. Press &quot;Start&quot; on your new bot, paste credentials above, and click &quot;Send Test Alert&quot;.</div>
          </div>
        </div>
      </form>

      {/* 3. AI MODEL CONFIGURATION */}
      <form onSubmit={handleSaveKeys} className="bg-[#0c0f17] border border-slate-800 rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="border-b border-slate-800/80 pb-3">
          <h2 className="text-sm font-bold text-slate-100 flex items-center gap-2">
            <Key className="w-4 h-4 text-amber-400" />
            <span>AI Reasoning Engine</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Configure optional model credentials allowing your SignalGOAT to reason via Claude 3.5 Sonnet, DeepSeek, or Llama.
          </p>
        </div>

        <div className="space-y-3.5 text-xs">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="openrouter-key" className="font-semibold text-slate-300">
                AI Model API Key (OpenRouter)
              </label>
              {keyStatus?.openRouterKeyInvalid ? (
                <span className="text-[10px] text-rose-400 flex items-center gap-1 font-mono">
                  <AlertCircle className="w-3 h-3" /> Stored key is invalid
                </span>
              ) : hasSavedKey ? (
                <span className="text-[10px] text-emerald-400 flex items-center gap-1 font-mono">
                  <CheckCircle className="w-3 h-3" /> Your key is saved
                </span>
              ) : reasoningStatus?.serverKeyConfigured ? (
                <span className="text-[10px] text-sky-400 flex items-center gap-1 font-mono">
                  <Zap className="w-3 h-3" /> Using platform key
                </span>
              ) : (
                <span className="text-[10px] text-amber-400 flex items-center gap-1 font-mono">
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
              className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-slate-100 placeholder-slate-400 font-mono focus:outline-none focus:border-amber-500/50"
            />
            <p className="text-[10px] text-slate-400 mt-1">
              Stored per-account on the server and used only for your GOATs. Get one at openrouter.ai/keys.
            </p>

            {keyStatus?.openRouterKeyInvalid && (
              <p className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-[10px] leading-relaxed text-rose-300">
                A saved value for this account is not a valid OpenRouter key, so
                every analysis is failing. Enter a valid key below and save to
                replace it.
              </p>
            )}
          </div>

          {saveError && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/30 text-rose-300 rounded-xl flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{saveError}</span>
            </div>
          )}

          {testResult && (
            <div
              className={`p-3 rounded-xl border text-xs flex items-start gap-2 ${
                testResult.ok
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                  : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
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
              className="flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-slate-100 border border-slate-800 font-bold text-xs py-2 px-3.5 rounded-xl transition-colors cursor-pointer disabled:opacity-50"
            >
              <Zap className="w-3.5 h-3.5" />
              <span>{isTestingAi ? 'Testing...' : 'Test OpenRouter Key'}</span>
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs py-2 px-4 rounded-xl transition-colors cursor-pointer disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{isSaving ? 'Saving...' : 'Save Configuration'}</span>
            </button>
          </div>
        </div>
      </form>

      {/* 4. USER PROFILE & PERSISTENCE */}
      <div className="bg-[#0c0f17] border border-slate-800 rounded-2xl p-4 sm:p-5 space-y-4">
        {(platform?.authMode === 'dev' || platform?.persistenceMode) && (
          <div className="text-[10px] font-mono text-slate-500 flex flex-wrap gap-3">
            <span>Auth mode: {platform?.authMode ?? '—'}</span>
            <span>·</span>
            <span>Persistence: {platform?.persistenceMode ?? '—'}</span>
            <span>·</span>
            <span>Active GOAT actors: {platform?.activeActors ?? 0}</span>
          </div>
        )}
        <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Shield className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">Your Account</h2>
              <p className="text-xs text-slate-400">Cloud synchronization and preferences for your GOAT definitions, skills, and signals.</p>
            </div>
          </div>
          <span
            className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
              isFirebaseConnected
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
            }`}
          >
            {isFirebaseConnected ? 'Cloud Synced' : 'Offline / Local'}
          </span>
        </div>

        <div className="text-xs space-y-3">
          {currentUser ? (
            <div className="space-y-3">
              <div className="p-3 bg-slate-900 rounded-xl border border-slate-800 space-y-1">
                <div className="text-slate-300">
                  Signed in as: <strong className="text-slate-100">{profile?.email || currentUser.email || 'Trader'}</strong>
                </div>
                <div className="text-slate-400 text-[11px] font-mono truncate">
                  Account Reference: {currentUser.uid ? currentUser.uid.slice(0, 8) + '...' : 'Local'}
                </div>
              </div>

              <button
                onClick={logout}
                className="flex items-center gap-1.5 text-xs text-rose-400 hover:text-rose-300 bg-rose-500/10 border border-rose-500/30 px-3.5 py-2 rounded-xl transition-colors cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Sign Out</span>
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-slate-400">
                You are currently browsing as a local session. Sign in with Google to sync your GOATs across devices.
              </p>
              <button
                onClick={() => {
                  void loginWithGoogle().catch(() => {
                    /* Message is surfaced from authError below. */
                  });
                }}
                className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-slate-100 border border-slate-800 font-bold text-xs py-2.5 px-4 rounded-xl transition-colors cursor-pointer"
              >
                <LogIn className="w-4 h-4 text-amber-400" />
                <span>Sign in with Google</span>
              </button>
            </div>
          )}

          {/* Sign-in failures are configuration problems: show the exact fix. */}
          {authError && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
              <div className="flex items-start gap-2 text-xs font-bold text-amber-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Sign-in failed</span>
              </div>

              <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed text-amber-200/90">
                {authError}
              </pre>
            </div>
          )}

          {/* Honest labelling of which auth mode is actually running. */}
          {authMode === 'dev' && (
            <div className="rounded-xl border border-amber-500/20 bg-slate-900/60 p-3 text-[11px] text-slate-400">
              <strong className="text-amber-300">
                Local mode (SIGNALGOAT_ALLOW_DEV_AUTH=1).
              </strong>{' '}
              Identity is a browser-generated local id, not a real account.
              Set the Firebase service-account variable and remove the dev flag
              to enable Google sign-in and cloud sync.
            </div>
          )}

          {authMode === 'none' && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-[11px] text-rose-200">
              <strong className="text-rose-300">
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
