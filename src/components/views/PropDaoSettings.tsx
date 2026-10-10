/**
 * PROPDAO CONNECTION (Settings)
 * =============================
 * Save, verify, test and disconnect a PropDAO API key.
 *
 * THE KEY IS NEVER RETURNED AFTER SAVING
 *   The save request carries the secret one way. Every subsequent read comes
 *   back as a masked hint plus a status, because there is no endpoint anywhere
 *   in this application that returns a decrypted credential to a browser.
 *   That is a property of the vault, not a UI convention — see
 *   `src/server/security/CredentialVault.ts`.
 *
 * "CONNECTED" AND "VERIFIED" ARE DIFFERENT
 *   A saved key proves only that some text was stored. It is verified when a
 *   live `GET /me` against PropDAO succeeds. The UI shows both, because
 *   "connected" that has never been verified is the most misleading thing this
 *   panel could say.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  Plug,
  PlugZap,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

interface PropDaoCredential {
  configured: boolean;
  maskedHint?: string;
  updatedAt?: string;
  keyId?: string;
  needsRotation?: boolean;
}

interface PropDaoVerification {
  connected: boolean;
  userId?: string;
  accountCount?: number;
  code?: string;
  message?: string;
}

interface PropDaoPolicy {
  enabled: boolean;
  authorised: boolean;
  termsReference: string | null;
  summary: string;
  termsSummary: string;
  capabilities: Record<string, boolean>;
}

export function PropDaoSettings() {
  const { getApiAuthHeaders } = useAuth();

  const [credential, setCredential] = useState<PropDaoCredential | null>(null);
  const [verification, setVerification] = useState<PropDaoVerification | null>(null);
  const [policy, setPolicy] = useState<PropDaoPolicy | null>(null);
  const [encryptionAvailable, setEncryptionAvailable] = useState(true);

  const [apiKey, setApiKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const headers = await getApiAuthHeaders();
      const [statusRes, settingsRes] = await Promise.all([
        fetch('/api/propdao/status', { headers: { Accept: 'application/json', ...headers } }),
        fetch('/api/settings/keys', { headers: { Accept: 'application/json', ...headers } }),
      ]);
      if (statusRes.ok) {
        const body = await statusRes.json();
        setCredential(body.credential ?? null);
        setVerification(body.verification ? { connected: body.connected, ...body.verification } : null);
        setPolicy(body.execution ?? null);
      }
      if (settingsRes.ok) {
        const body = await settingsRes.json();
        setEncryptionAvailable(body.encryptionAvailable !== false);
      }
    } catch {
      setMessage({ tone: 'error', text: 'Could not reach the FundAGoat API.' });
    }
  }, [getApiAuthHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    try {
      const headers = await getApiAuthHeaders();
      const response = await fetch('/api/settings/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ propDaoApiKey: apiKey }),
      });
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        setMessage({
          tone: 'error',
          text: body?.error?.message ?? 'Could not save the PropDAO key.',
        });
        return;
      }
      // Clear the input immediately: the secret now lives encrypted on the
      // server and must not linger in component state or the DOM.
      setApiKey('');
      setReveal(false);
      setMessage({ tone: 'ok', text: 'Key saved. Verifying against PropDAO…' });
      await load();
    } catch {
      setMessage({ tone: 'error', text: 'Could not reach the FundAGoat API.' });
    } finally {
      setSaving(false);
    }
  }, [apiKey, getApiAuthHeaders, load]);

  const test = useCallback(async () => {
    setTesting(true);
    setMessage(null);
    try {
      await load();
      setMessage({
        tone: 'ok',
        text: 'Connection re-tested. See the status below for the provider response.',
      });
    } finally {
      setTesting(false);
    }
  }, [load]);

  const disconnect = useCallback(async () => {
    setDisconnecting(true);
    setMessage(null);
    try {
      const headers = await getApiAuthHeaders();
      const response = await fetch('/api/propdao/connect', {
        method: 'DELETE',
        headers: { Accept: 'application/json', ...headers },
      });
      if (response.ok) {
        setCredential(null);
        setVerification(null);
        setMessage({ tone: 'ok', text: 'PropDAO disconnected. The stored key has been deleted.' });
      }
    } finally {
      setDisconnecting(false);
    }
  }, [getApiAuthHeaders]);

  const saved = credential?.configured === true;

  return (
    <section className="panel overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-line p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
            <KeyRound size={17} aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-[14px] font-semibold text-fg">PropDAO</h2>
            <p className="mt-0.5 text-[12px] text-fg-muted">
              Connect your prop-firm challenge or funded account to see equity, drawdown headroom and open
              positions.
            </p>
          </div>
        </div>
        <StatusPill saved={saved} verified={verification?.connected === true} />
      </div>

      <div className="space-y-4 p-4">
        {/* Encryption warning — surfaced before the user types a key. */}
        {!encryptionAvailable && (
          <div className="flex items-start gap-2.5 rounded-lg border border-negative/40 bg-negative-soft/40 p-3">
            <ShieldAlert size={15} className="mt-0.5 shrink-0 text-negative" aria-hidden="true" />
            <div>
              <p className="text-[12px] font-semibold text-fg">Credential storage is unavailable</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-fg-muted">
                This deployment has no credential encryption key configured, so a PropDAO key cannot be saved
                safely. Set <code className="font-mono">CREDENTIAL_ENCRYPTION_KEY</code> on the server.
              </p>
            </div>
          </div>
        )}

        {/* Current state */}
        {saved && (
          <div className="rounded-lg border border-line bg-raised p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-medium text-fg">Stored key</span>
              <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-fg-muted">
                {credential?.maskedHint ?? '••••'}
              </code>
              {credential?.needsRotation && (
                <span className="badge badge-warning">Pending key rotation</span>
              )}
            </div>
            {credential?.updatedAt && (
              <p className="mt-1 text-[11px] text-fg-subtle">
                Last saved {new Date(credential.updatedAt).toLocaleString()}
              </p>
            )}

            {verification?.connected ? (
              <p className="mt-2 flex items-center gap-1.5 text-[12px] text-positive">
                <CheckCircle2 size={13} aria-hidden="true" />
                Verified — {verification.accountCount ?? 0} account(s) available
              </p>
            ) : (
              <p className="mt-2 flex items-start gap-1.5 text-[12px] text-fg-muted">
                <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
                <span>
                  Saved but not verified
                  {verification?.message ? ` — ${verification.message}` : '.'}
                </span>
              </p>
            )}
          </div>
        )}

        {/* Input */}
        <div>
          <label className="label" htmlFor="propdao-key">
            {saved ? 'Replace API key' : 'API key'}
          </label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                id="propdao-key"
                type={reveal ? 'text' : 'password'}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={saved ? 'Enter a new key to replace the stored one' : 'pd_live_…'}
                autoComplete="off"
                spellCheck={false}
                className="input font-mono !pr-16"
              />
              <button
                type="button"
                onClick={() => setReveal((value) => !value)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-[11px] text-fg-subtle hover:text-fg"
                aria-label={reveal ? 'Hide API key' : 'Show API key'}
              >
                {reveal ? 'Hide' : 'Show'}
              </button>
            </div>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || apiKey.trim().length === 0 || !encryptionAvailable}
              className="btn btn-primary"
            >
              {saving ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : null}
              Save
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-fg-subtle">
            Generate a key at{' '}
            <a
              href="https://app.propdao.finance"
              target="_blank"
              rel="noopener noreferrer"
              className="link inline-flex items-center gap-0.5"
            >
              app.propdao.finance
              <ExternalLink size={10} aria-hidden="true" />
            </a>{' '}
            → Avatar → Settings → Developers. It is shown only once. FundAGoat stores it encrypted with
            AES-256-GCM and never returns it to the browser.
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void test()}
            disabled={!saved || testing}
            className="btn btn-secondary"
          >
            {testing ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <PlugZap size={13} aria-hidden="true" />}
            Test connection
          </button>
          {saved && (
            <button
              type="button"
              onClick={() => void disconnect()}
              disabled={disconnecting}
              className="btn btn-danger"
            >
              {disconnecting ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Trash2 size={13} aria-hidden="true" />}
              Disconnect
            </button>
          )}
        </div>

        {message && (
          <p
            className={`rounded-lg border p-2.5 text-[12px] ${
              message.tone === 'ok'
                ? 'border-positive/40 bg-positive-soft/40 text-fg-muted'
                : 'border-negative/40 bg-negative-soft/40 text-fg-muted'
            }`}
          >
            {message.text}
          </p>
        )}

        {/* Execution policy */}
        {policy && (
          <div className="rounded-lg border border-line bg-raised p-3">
            <div className="flex items-start gap-2">
              <Plug
                size={14}
                className={`mt-0.5 shrink-0 ${policy.enabled ? 'text-positive' : 'text-fg-subtle'}`}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-medium text-fg">Order execution</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-fg-muted">{policy.summary}</p>
                <p className="mt-1.5 text-[11px] leading-relaxed text-fg-subtle">{policy.termsSummary}</p>

                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] font-medium text-fg-subtle hover:text-fg">
                    Provider capabilities
                  </summary>
                  <ul className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                    {Object.entries(policy.capabilities).map(([name, supported]) => (
                      <li key={name} className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="text-fg-muted">{name.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
                        <span className={`badge ${supported ? 'badge-positive' : 'badge-neutral'}`}>
                          {supported ? 'available' : 'not offered'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function StatusPill({ saved, verified }: { saved: boolean; verified: boolean }) {
  if (!saved) return <span className="badge badge-neutral">Not connected</span>;
  if (verified) return <span className="badge badge-positive">Connected</span>;
  return <span className="badge badge-warning">Unverified</span>;
}