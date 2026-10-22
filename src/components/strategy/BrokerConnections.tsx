import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Link2, Loader2, ShieldCheck, Unlink } from 'lucide-react';

/**
 * BROKER CONNECTIONS
 * ==================
 *
 * The panel that connects a trading robot to a broker.
 *
 * WHAT IT DOES
 * ------------
 *   - connects a cTrader account through the EXISTING OAuth flow, and lists
 *     the broker accounts that authorization granted;
 *   - stores a PropDAO API key through the EXISTING encrypted vault, and
 *     lists the accounts that key can see;
 *   - binds ONE of the owner's own accounts to the robot.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 *   It does not enable live trading. This build executes in paper mode, and
 *   the panel says so in the first line rather than in a footnote. A bound
 *   account records WHERE the robot is intended to trade; it is not a
 *   licence to trade, and no order can be placed from this screen.
 *
 * NO SECRET EVER REACHES THIS SCREEN
 * ----------------------------------
 *   The key is written straight to the vault and is never read back. The
 *   server answers with a masked hint at most. The component holds the key
 *   in a password field for exactly as long as it takes to submit it, and
 *   clears it the moment the server confirms.
 */

export interface BrokerAccountChoice {
  accountId: string;
  label: string;
  environment: 'demo' | 'live' | 'challenge' | 'funded' | 'unknown';
  isLive: boolean;
}

export interface BrokerState {
  bound: { provider: 'ctrader' | 'propdao'; accountId: string; label: string; environment: string } | null;
  execution: { mode: string; liveTradingSupported: boolean; message: string };
  cTrader: { configured: boolean; connected: boolean; accounts: BrokerAccountChoice[]; error: string | null };
  propDao: { connected: boolean; accounts: BrokerAccountChoice[]; error: string | null };
}

export function BrokerConnections({
  robotSlug,
  headers,
  canManage,
  onChanged,
}: {
  robotSlug: string;
  headers: (json?: boolean) => Promise<Headers>;
  canManage: boolean;
  onChanged?: () => void;
}) {
  const [state, setState] = useState<BrokerState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [propDaoKey, setPropDaoKey] = useState('');
  const [showPropDaoKey, setShowPropDaoKey] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/robot-marketplace/${encodeURIComponent(robotSlug)}/broker`, {
        headers: await headers(),
        cache: 'no-store',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || 'The broker connections could not be read.');
      setState(body as BrokerState);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The broker connections could not be read.');
    } finally {
      setLoading(false);
    }
  }, [robotSlug, headers]);

  useEffect(() => { void load(); }, [load]);

  const run = async (work: () => Promise<void>, success: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      setNotice(success);
      await load();
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That action could not be completed.');
    } finally {
      setBusy(false);
    }
  };

  const connectCTrader = () => run(async () => {
    const response = await fetch('/api/ctrader/connect', { headers: await headers(), cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || 'cTrader is not available right now.');
    if (!body?.authorizationUrl) throw new Error('cTrader did not return an authorization link.');
    // The provider does the authentication in the browser, and the callback
    // returns to the app with the token already in the vault.
    window.location.href = body.authorizationUrl;
  }, '');

  const savePropDaoKey = () => run(async () => {
    const key = propDaoKey.trim();
    if (!key) throw new Error('Enter your PropDAO API key.');
    const response = await fetch(`/api/robot-marketplace/${encodeURIComponent(robotSlug)}/broker/propdao-key`, {
      method: 'POST',
      headers: await headers(true),
      body: JSON.stringify({ apiKey: key }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || 'The PropDAO key could not be saved.');
    // The key is never read back from the server, so it is cleared here.
    setPropDaoKey('');
    setShowPropDaoKey(false);
  }, 'PropDAO key saved in the encrypted vault.');

  const disconnectPropDao = () => run(async () => {
    const response = await fetch(`/api/robot-marketplace/${encodeURIComponent(robotSlug)}/broker/propdao-key`, { method: 'DELETE', headers: await headers() });
    if (!response.ok) throw new Error('PropDAO could not be disconnected.');
  }, 'PropDAO key deleted from the vault.');

  const bind = (provider: 'ctrader' | 'propdao', accountId: string) => run(async () => {
    const response = await fetch(`/api/robot-marketplace/${encodeURIComponent(robotSlug)}/broker`, {
      method: 'POST',
      headers: await headers(true),
      body: JSON.stringify({ provider, accountId }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || 'The account could not be bound.');
  }, 'The account is now bound to this robot.');

  const unbind = () => run(async () => {
    const response = await fetch(`/api/robot-marketplace/${encodeURIComponent(robotSlug)}/broker`, {
      method: 'DELETE',
      headers: await headers(),
    });
    if (!response.ok) throw new Error('The binding could not be removed.');
  }, 'The robot is no longer bound to an account.');

  if (loading) {
    return <div className="flex items-center gap-2 text-xs text-fg-muted"><Loader2 size={14} className="animate-spin" /> Reading the broker connections…</div>;
  }
  if (!state) {
    return <p className="text-xs text-danger">{error || 'The broker connections could not be read.'}</p>;
  }

  return <div className="space-y-3">
    {/* The safety boundary, stated first and plainly. */}
    <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/5 p-3">
      <ShieldCheck size={15} className="mt-0.5 shrink-0 text-[color:var(--color-warning)]" />
      <p className="text-[11px] leading-relaxed text-fg-muted">{state.execution.message}</p>
    </div>

    {error && <p role="alert" className="rounded-lg border border-danger/30 p-2.5 text-[11px] text-danger">{error}</p>}
    {notice && <p className="rounded-lg border border-positive/30 bg-positive/5 p-2.5 text-[11px] text-fg-muted">{notice}</p>}

    {/* The bound account. */}
    <div className="rounded-xl border border-line p-3">
      <p className="text-[11px] font-bold uppercase tracking-wider text-fg-subtle">Account used by this robot</p>
      {state.bound ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-fg">{state.bound.label}</p>
            <p className="text-[11px] text-fg-subtle">
              {state.bound.provider === 'ctrader' ? 'cTrader' : 'PropDAO'} · {state.bound.environment}
            </p>
          </div>
          {canManage && (
            <button type="button" disabled={busy} onClick={() => void unbind()} className="btn btn-secondary text-[11px]">
              <Unlink size={12} /> Unbind
            </button>
          )}
        </div>
      ) : (
        <p className="mt-1.5 text-[11px] text-fg-muted">No account is bound. The robot stays in paper mode either way.</p>
      )}
    </div>

    {!canManage ? (
      <p className="text-[11px] text-fg-subtle">Only the robot creator can change the broker connection.</p>
    ) : (
      <>
        {/* cTrader. */}
        <div className="rounded-xl border border-line p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-fg">cTrader</p>
            {state.cTrader.connected ? (
              <span className="text-[11px] text-positive">Connected</span>
            ) : (
              <button type="button" disabled={busy || !state.cTrader.configured} onClick={() => void connectCTrader()} className="btn btn-secondary text-[11px]">
                <Link2 size={12} /> Connect
              </button>
            )}
          </div>
          {!state.cTrader.configured && (
            <p className="mt-2 text-[11px] text-fg-subtle">This deployment has no cTrader application credentials, so the connection cannot be started.</p>
          )}
          {state.cTrader.error && <p className="mt-2 text-[11px] text-danger">{state.cTrader.error}</p>}
          {state.cTrader.connected && state.cTrader.accounts.length === 0 && (
            <p className="mt-2 text-[11px] text-fg-muted">Your cTrader authorization returned no accounts.</p>
          )}
          {state.cTrader.accounts.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {state.cTrader.accounts.map(account => (
                <li key={account.accountId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-raised/40 px-2.5 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-fg">{account.label}</p>
                    <p className="text-[10px] text-fg-subtle">
                      {account.environment}
                      {account.isLive ? ' · live account' : ' · demo account'}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void bind('ctrader', account.accountId)}
                    className="shrink-0 rounded-lg border border-line-strong px-2.5 py-1.5 text-[11px] font-semibold text-fg hover:bg-raised disabled:opacity-50"
                  >
                    Use this account
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* PropDAO. */}
        <div className="rounded-xl border border-line p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-fg">PropDAO</p>
            {state.propDao.connected ? (
              <button type="button" disabled={busy} onClick={() => void disconnectPropDao()} className="btn btn-secondary text-[11px]">
                <Unlink size={12} /> Disconnect
              </button>
            ) : (
              <button type="button" disabled={busy} onClick={() => setShowPropDaoKey(open => !open)} className="btn btn-secondary text-[11px]">
                <Link2 size={12} /> {state.propDao.connected ? 'Key connected' : 'Add API key'}
              </button>
            )}
          </div>
          {showPropDaoKey && !state.propDao.connected && (
            <form
              className="mt-2 flex flex-col gap-2 sm:flex-row"
              onSubmit={event => { event.preventDefault(); void savePropDaoKey(); }}
            >
              <input
                type="password"
                autoComplete="off"
                value={propDaoKey}
                onChange={event => setPropDaoKey(event.target.value)}
                placeholder="Your PropDAO API key"
                aria-label="PropDAO API key"
                className="input min-w-0 flex-1"
              />
              <button type="submit" disabled={busy || !propDaoKey.trim()} className="btn btn-primary text-[11px]">
                {busy ? 'Saving…' : 'Save securely'}
              </button>
            </form>
          )}
          {state.propDao.error && <p className="mt-2 text-[11px] text-danger">{state.propDao.error}</p>}
          {state.propDao.connected && state.propDao.accounts.length === 0 && (
            <p className="mt-2 text-[11px] text-fg-muted">This key can see no funded or challenge accounts.</p>
          )}
          {state.propDao.accounts.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {state.propDao.accounts.map(account => (
                <li key={account.accountId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-raised/40 px-2.5 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-fg">{account.label}</p>
                    <p className="text-[10px] text-fg-subtle">{account.environment}</p>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void bind('propdao', account.accountId)}
                    className="shrink-0 rounded-lg border border-line-strong px-2.5 py-1.5 text-[11px] font-semibold text-fg hover:bg-raised disabled:opacity-50"
                  >
                    Use this account
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-fg-subtle">
            <AlertTriangle size={11} className="mt-0.5 shrink-0" />
            The key is encrypted in the credential vault and is never shown again. Deleting it here removes it from the vault.
          </p>
        </div>

        <p className="text-[11px] text-fg-subtle">Each robot keeps its own PropDAO key and one broker account binding.</p>
      </>
    )}
  </div>;
}
