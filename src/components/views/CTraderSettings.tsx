import React, { useCallback, useEffect, useState } from "react";
import { CheckCircle, ExternalLink, Loader2, Link2, Unplug, AlertCircle } from "lucide-react";
import { useAuth } from "../../context/AuthContext";

interface CTraderAccount {
  ctidTraderAccountId: string;
  isLive: boolean;
  traderLogin?: string;
  brokerTitleShort?: string;
  environment?: "demo" | "live";
}

interface CTraderStatus {
  configured: boolean;
  connected: boolean;
  selectedAccountId: string | null;
  selectedAccountIsLive: boolean;
  credential?: { maskedHint?: string; updatedAt?: string };
}

export const CTraderSettings: React.FC = () => {
  const { getApiAuthHeaders } = useAuth();
  const [status, setStatus] = useState<CTraderStatus | null>(null);
  const [accounts, setAccounts] = useState<CTraderAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const headers = { Accept: "application/json", ...(await getApiAuthHeaders()) };
      const statusRes = await fetch("/api/ctrader/status", { headers });
      const statusBody = await statusRes.json().catch(() => null);
      if (!statusRes.ok) throw new Error(statusBody?.error?.message ?? "Could not load cTrader connection status.");
      const nextStatus = statusBody as CTraderStatus;
      setStatus(nextStatus);
      setSelectedAccountId(nextStatus.selectedAccountId ?? "");
      if (nextStatus.connected) {
        const accountsRes = await fetch("/api/ctrader/accounts", { headers });
        const accountsBody = await accountsRes.json().catch(() => null);
        if (!accountsRes.ok) throw new Error(accountsBody?.error?.message ?? "Could not load cTrader accounts.");
        setAccounts(Array.isArray(accountsBody?.accounts) ? accountsBody.accounts : []);
        setSelectedAccountId(accountsBody?.selectedAccountId ?? "");
      } else {
        setAccounts([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load cTrader settings.");
    } finally {
      setLoading(false);
    }
  }, [getApiAuthHeaders]);

  useEffect(() => { void load(); }, [load]);

  const connect = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await fetch("/api/ctrader/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await getApiAuthHeaders()) },
        body: "{}",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || typeof body?.authorizationUrl !== "string") throw new Error(body?.error?.message ?? "Could not start cTrader authorization.");
      window.location.assign(body.authorizationUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect cTrader.");
      setBusy(false);
    }
  };

  const selectAccount = async (accountId: string) => {
    if (!accountId) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await fetch("/api/ctrader/account", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await getApiAuthHeaders()) },
        body: JSON.stringify({ accountId }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? "Could not select that cTrader account.");
      setSelectedAccountId(accountId);
      setStatus((prev) => prev ? { ...prev, selectedAccountId: accountId, selectedAccountIsLive: body?.selectedAccount?.isLive === true } : prev);
      window.dispatchEvent(new Event("sirgoat:trading-provider-changed"));
      setNotice(body?.warning ?? "cTrader account selected.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not select cTrader account.");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await fetch("/api/ctrader/connect", { method: "DELETE", headers: await getApiAuthHeaders() });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? "Could not disconnect cTrader.");
      setAccounts([]); setSelectedAccountId("");
      window.dispatchEvent(new Event("sirgoat:trading-provider-changed"));
      setNotice("cTrader disconnected. GOATs pinned to cTrader will not run until you reconnect.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect cTrader.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-surface border border-line rounded-2xl p-4 sm:p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <div className="w-8 h-8 shrink-0 rounded-lg bg-accent-soft border border-accent/30 flex items-center justify-center text-accent-text">
            <Link2 size={16} />
          </div>
          <div>
            <h2 className="text-[13px] font-semibold text-fg">cTrader connection</h2>
            <p className="text-[11px] text-fg-muted mt-0.5">Live quotes, candles and orders from your authorized cTrader account. Demo is selected automatically when available.</p>
          </div>
        </div>
        {status?.connected ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-600"><CheckCircle size={13} /> Connected</span>
        ) : null}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-fg-muted"><Loader2 size={14} className="animate-spin" /> Checking cTrader connection…</div>
      ) : !status?.configured ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-fg-muted">
          cTrader is not configured on this deployment. Set <code>CTRADER_CLIENT_ID</code>, <code>CTRADER_SECRET</code> and <code>CTRADER_REDIRECT_URI</code> in server environment variables, and register the redirect URI in the cTrader Open API application.
        </div>
      ) : !status.connected ? (
        <button type="button" onClick={() => void connect()} disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-60">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />} Connect cTrader
        </button>
      ) : (
        <div className="space-y-3">
          <div className="text-[11px] text-fg-muted">Credential: {status.credential?.maskedHint ?? "Encrypted OAuth token stored"}{status.credential?.updatedAt ? ` · Updated ${new Date(status.credential.updatedAt).toLocaleString()}` : ""}</div>
          {accounts.length ? (
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-fg">Trading account</span>
              <select value={selectedAccountId} onChange={(event) => void selectAccount(event.target.value)} disabled={busy} className="w-full rounded-xl border border-line bg-sunken px-3 py-2 text-xs text-fg disabled:opacity-60">
                <option value="">Choose account (required)</option>
                {accounts.map((account) => (
                  <option key={account.ctidTraderAccountId} value={account.ctidTraderAccountId}>
                    {(account.brokerTitleShort ? account.brokerTitleShort + " · " : "")}{account.traderLogin ? "Login " + account.traderLogin + " · " : ""}{account.environment === "live" || account.isLive ? "LIVE" : "DEMO"} · ID {account.ctidTraderAccountId}
                  </option>
                ))}
              </select>
              <span className="block text-[10px] text-fg-muted">Live accounts are never selected automatically. Switching the selected account changes where new cTrader GOATs trade; existing GOATs retain their provider, not a frozen account ID.</span>
            </label>
          ) : (
            <div className="text-xs text-fg-muted">No cTrader accounts were granted. Reconnect and approve account access.</div>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void load()} disabled={busy} className="rounded-xl border border-line px-3 py-2 text-xs font-medium text-fg disabled:opacity-60">Refresh accounts</button>
            <button type="button" onClick={() => void disconnect()} disabled={busy} className="inline-flex items-center gap-1.5 rounded-xl border border-line px-3 py-2 text-xs font-medium text-fg-muted hover:text-fg disabled:opacity-60"><Unplug size={13} /> Disconnect</button>
          </div>
        </div>
      )}
      {error && <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-500"><AlertCircle size={14} className="mt-0.5 shrink-0" />{error}</div>}
      {notice && <div className="text-xs text-fg-muted">{notice}</div>}
    </section>
  );
};
