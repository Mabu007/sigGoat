/**
 * PROPOSALS
 * =========
 * The approval surface. Every trade the agent has proposed, with the
 * deterministic risk verdict attached.
 *
 * INTERACTION MODEL
 *   A card is a SUMMARY; clicking it opens the proposal DETAIL, which carries
 *   the full persisted record — levels, evidence, source GOAT, skills,
 *   execution eligibility — plus the three actions: Check risk, Accept /
 *   Reject, and the contextual AI assistant.
 *
 * WHY APPROVAL IS BOUND TO AN EXACT VERSION
 *   A user approves a specific trade — an instrument, a size, a stop. If the
 *   proposal is edited or re-derived afterwards, the earlier approval no
 *   longer refers to what would actually be placed. So the detail view shows
 *   the proposal's `expiresAt`, and the server refuses decisions on expired
 *   proposals and any second decision on a finalised one.
 *
 * WHY EVERY REFUSAL IS SHOWN VERBATIM
 *   "Trade rejected: reward:risk 1.2:1 is below the required 1.50:1" tells a
 *   user what to change. "Trade rejected" does not. The server returns every
 *   violation, not just the first, so they can be fixed together.
 *
 * ACCEPT NEVER IMPLIES AN ORDER
 *   Accept posts to the server's decision endpoint, which runs the SAME
 *   execution policy the executor uses. When execution is disabled (the only
 *   state this deployment may run in) the server refuses with
 *   EXECUTION_DISABLED, records nothing, and the reason is shown verbatim.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  Loader2,
  MessageSquare,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useGoat } from '../../context/GoatContext';

interface RiskReport {
  ok: boolean;
  violations: string[];
  measured: {
    notionalUsd: number | null;
    riskUsd: number | null;
    feeUsd: number | null;
    riskReward: number | null;
    riskPctOfRoom: number | null;
  };
  execution: { enabled: boolean; summary: string };
}

interface ExecutionStatus {
  enabled: boolean;
  authorised: boolean;
  summary: string;
  termsSummary?: string;
}

interface Proposal {
  id: string;
  createdAt: string;
  updatedAt?: string;
  status: string;
  direction?: 'LONG' | 'SHORT' | 'NO_TRADE';
  orderType?: string;
  market?: string;
  entry?: number;
  entryZone?: { low: number; high: number };
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: string;
  confidence?: number;
  thesis?: string;
  rationale?: string;
  confirmationRequired?: string;
  invalidation?: string;
  supportingEvidence?: string[];
  contradictoryEvidence?: string[];
  goatId?: string;
  goatName?: string;
  expired?: boolean;
  expiresAt?: string;
  /** User decision, once recorded server-side (write-once). */
  decision?: 'ACCEPTED' | 'REJECTED';
  decidedAt?: string;
  decisionNote?: string;
  /** Present when the server has evaluated this proposal against risk. */
  risk?: RiskReport | null;
  error?: string;
}

interface AssistantMessage {
  sender: 'user' | 'assistant';
  text: string;
}

const SUGGESTED_QUESTIONS = [
  'Why is this trade being proposed?',
  'What evidence supports the entry?',
  'What would invalidate the thesis?',
  'What is the risk/reward ratio?',
  'What important information is missing?',
  'How does this proposal compare with its stated strategy?',
];

export function ProposalsView() {
  const { getApiAuthHeaders } = useAuth();
  const { goats, skills, activeGoat } = useGoat();

  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [evaluating, setEvaluating] = useState<string | null>(null);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [executionStatus, setExecutionStatus] = useState<ExecutionStatus | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const headers = await getApiAuthHeaders();
      // Signals are per-GOAT, so proposals are collected across all of them.
      const responses = await Promise.all(
        goats.map((goat) =>
          fetch(`/api/goats/${goat.id}/signals`, { headers: { Accept: 'application/json', ...headers } }).then(
            (res) => (res.ok ? res.json() : { signals: [] }),
          ),
        ),
      );

      const collected: Proposal[] = [];
      responses.forEach((body, index) => {
        const list = Array.isArray(body.signals) ? body.signals : [];
        for (const signal of list) {
          collected.push({
            ...signal,
            goatId: signal.goatId ?? goats[index]?.id,
            goatName: goats[index]?.name,
            expired: signal.expiresAt ? Date.parse(signal.expiresAt) < Date.now() : false,
          } as Proposal);
        }
      });

      collected.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      setProposals(collected.slice(0, 100));
    } catch {
      setError('Could not reach the FundAGoat API.');
    } finally {
      setLoading(false);
    }
  }, [getApiAuthHeaders, goats]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Execution eligibility, fetched once per detail open so it is LIVE data. */
  useEffect(() => {
    if (!detailId || executionStatus) return;
    void (async () => {
      try {
        const headers = await getApiAuthHeaders();
        const res = await fetch('/api/propdao/status', {
          headers: { Accept: 'application/json', ...headers },
        });
        if (res.ok) {
          const body = await res.json();
          if (body?.execution) setExecutionStatus(body.execution as ExecutionStatus);
        }
      } catch {
        // Eligibility panel falls back to "not yet checked" rather than guessing.
      }
    })();
  }, [detailId, executionStatus, getApiAuthHeaders]);

  /**
   * Ask the server to evaluate a proposal against LIVE account risk.
   *
   * This never executes anything: it calls the pure validator and returns the
   * verdict, so the user sees the result before approving rather than after.
   *
   * NOTE THE SYMBOL MISMATCH, which the server — not this view — resolves.
   *   A proposal is researched against a HYPERLIQUID market (`BTC`,
   *   `xyz:GOLD`), while orders are placed on a PROPDAO instrument
   *   (`BTCUSDC`). They are not the same identifier and this view does not
   *   invent a mapping between them. When the proposal's market is not an
   *   instrument PropDAO offers, the server returns a clear refusal and that
   *   is what the user sees.
   */
  const evaluate = useCallback(
    async (proposal: Proposal) => {
      if (!proposal.market || !proposal.entry || !proposal.stopLoss || !proposal.takeProfit) {
        setProposals((current) =>
          (current ?? []).map((p) =>
            p.id === proposal.id
              ? {
                  ...p,
                  error:
                    'This proposal does not carry the complete price levels a risk check needs (entry, stop and target).',
                }
              : p,
          ),
        );
        return;
      }

      setEvaluating(proposal.id);
      try {
        const headers = await getApiAuthHeaders();
        const accountsResponse = await fetch('/api/propdao/accounts', {
          headers: { Accept: 'application/json', ...headers },
        });
        const accountsBody = accountsResponse.ok ? await accountsResponse.json() : null;
        const accountId: string | null = accountsBody?.accounts?.[0]?.accountId ?? null;

        if (!accountId) {
          setProposals((current) =>
            (current ?? []).map((p) =>
              p.id === proposal.id
                ? { ...p, error: 'Connect a PropDAO account in Settings to check this trade against live risk.' }
                : p,
            ),
          );
          return;
        }

        const response = await fetch('/api/propdao/risk-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({
            accountId,
            symbol: proposal.market,
            side: proposal.direction === 'SHORT' ? 'SELL' : 'BUY',
            qty: 0,
            entry: proposal.entry,
            stopLoss: proposal.stopLoss,
            takeProfit: proposal.takeProfit,
          }),
        });

        if (response.ok) {
          const body = (await response.json()) as RiskReport;
          setProposals((current) =>
            (current ?? []).map((p) => (p.id === proposal.id ? { ...p, risk: body } : p)),
          );
        } else {
          const body = await response.json().catch(() => null);
          setProposals((current) =>
            (current ?? []).map((p) =>
              p.id === proposal.id
                ? { ...p, error: body?.error?.message ?? 'Risk check failed.' }
                : p,
            ),
          );
        }
      } catch {
        setProposals((current) =>
          (current ?? []).map((p) =>
            p.id === proposal.id ? { ...p, error: 'Could not reach the FundAGoat API.' } : p,
          ),
        );
      } finally {
        setEvaluating(null);
      }
    },
    [getApiAuthHeaders],
  );

  /* ------------------------------------------------------------------ */
  /* Decision (accept / reject)                                          */
  /* ------------------------------------------------------------------ */

  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  /** Confirmation state for ACCEPT — an action that could submit an order. */
  const [confirmAccept, setConfirmAccept] = useState<Proposal | null>(null);
  const [decisionNote, setDecisionNote] = useState('');

  const submitDecision = useCallback(
    async (proposal: Proposal, decision: 'ACCEPTED' | 'REJECTED') => {
      if (proposal.decision || decisionBusy) return;
      setDecisionBusy(true);
      setDecisionError(null);

      try {
        const headers = await getApiAuthHeaders();
        const response = await fetch(
          `/api/goats/${proposal.goatId}/signals/${proposal.id}/decision`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({
              decision,
              note: decisionNote.trim() || undefined,
            }),
          },
        );

        const body = await response.json().catch(() => null);

        if (!response.ok) {
          // EXECUTION_DISABLED / ALREADY_FINALIZED / PROPOSAL_EXPIRED arrive
          // as verbatim server messages — the reason is the product here.
          const message =
            body?.error?.message ?? `Could not record the decision (${response.status}).`;
          setDecisionError(message);
          return;
        }

        const saved = body?.signal as Proposal | undefined;
        setProposals((current) =>
          (current ?? []).map((p) => (p.id === proposal.id ? { ...p, ...saved, error: undefined } : p)),
        );
        setConfirmAccept(null);
        setDecisionNote('');
        if (body?.execution) setExecutionStatus(body.execution as ExecutionStatus);
      } catch {
        setDecisionError('Could not reach the FundAGoat API. Nothing was recorded.');
      } finally {
        setDecisionBusy(false);
      }
    },
    [decisionBusy, decisionNote, getApiAuthHeaders],
  );

  /* ------------------------------------------------------------------ */
  /* AI assistant (contextual, per proposal)                             */
  /* ------------------------------------------------------------------ */

  const [assistantFor, setAssistantFor] = useState<string | null>(null);
  const [assistantMessages, setAssistantMessages] = useState<AssistantMessage[]>([]);
  const [assistantInput, setAssistantInput] = useState('');
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantError, setAssistantError] = useState<string | null>(null);

  const openAssistant = useCallback((proposal: Proposal) => {
    setAssistantFor(proposal.id);
    setAssistantMessages([
      {
        sender: 'assistant',
        text:
          `I can answer questions about this ${proposal.market ?? 'market'} proposal using its actual stored record — ` +
          'the levels, evidence, source GOAT, skills and execution restrictions. Ask me why it was proposed, what ' +
          'would invalidate it, or what is missing. I cannot modify the proposal or place an order.',
      },
    ]);
    setAssistantError(null);
    setAssistantInput('');
  }, []);

  const askAssistant = useCallback(
    async (question: string) => {
      const proposal = proposals?.find((p) => p.id === assistantFor);
      if (!proposal || !question.trim() || assistantBusy) return;

      const asked = question.trim();
      setAssistantMessages((prev) => [...prev, { sender: 'user', text: asked }]);
      setAssistantInput('');
      setAssistantBusy(true);
      setAssistantError(null);

      try {
        const headers = await getApiAuthHeaders();
        const response = await fetch(
          `/api/goats/${proposal.goatId}/signals/${proposal.id}/ask`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ question: asked }),
          },
        );

        const body = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(body?.error?.message ?? `Assistant request failed (${response.status}).`);
        }

        setAssistantMessages((prev) => [...prev, { sender: 'assistant', text: body.answer }]);
      } catch (err) {
        setAssistantError(err instanceof Error ? err.message : 'The assistant could not answer.');
      } finally {
        setAssistantBusy(false);
      }
    },
    [assistantBusy, assistantFor, getApiAuthHeaders, proposals],
  );

  const detailProposal = proposals?.find((p) => p.id === detailId) ?? null;

  if (loading && proposals === null) {
    return (
      <div className="panel flex items-center gap-2 p-6 text-[13px] text-fg-muted">
        <Loader2 size={15} className="animate-spin" aria-hidden="true" /> Loading proposals…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-fg">Proposals</h1>
          <p className="mt-0.5 text-[13px] text-fg-muted">
            Trade ideas from your agents, checked against deterministic risk rules.
          </p>
        </div>
        <button type="button" onClick={() => void load()} className="btn btn-secondary">
          <RefreshCw size={13} aria-hidden="true" /> Refresh
        </button>
      </header>

      {error && (
        <div className="panel flex items-start gap-2.5 border-negative/40 p-3.5">
          <ShieldAlert size={15} className="mt-0.5 shrink-0 text-negative" aria-hidden="true" />
          <p className="text-[12px] text-fg-muted">{error}</p>
        </div>
      )}

      {proposals?.length === 0 ? (
        <div className="panel p-8 text-center">
          <Clock size={20} className="mx-auto text-fg-subtle" aria-hidden="true" />
          <p className="mt-2 text-[13px] font-medium text-fg">No proposals yet</p>
          <p className="mx-auto mt-1 max-w-sm text-[12px] text-fg-muted">
            Agents produce proposals after their next evaluation. Create an agent and give it a market to
            watch.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {proposals?.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              onEvaluate={() => void evaluate(proposal)}
              evaluating={evaluating === proposal.id}
              onOpenDetail={() => {
                setDecisionError(null);
                setDetailId(proposal.id);
              }}
              onOpenAssistant={() => openAssistant(proposal)}
            />
          ))}
        </div>
      )}

      {/* ============================================================= */}
      {/* PROPOSAL DETAIL                                                */}
      {/* ============================================================= */}
      {detailProposal && (
        <ProposalDetail
          proposal={detailProposal}
          goat={goats.find((g) => g.id === detailProposal.goatId) ?? activeGoat ?? null}
          skills={skills}
          execution={executionStatus}
          evaluating={evaluating === detailProposal.id}
          decisionBusy={decisionBusy}
          decisionError={decisionError}
          onEvaluate={() => void evaluate(detailProposal)}
          onAskAccept={() => setConfirmAccept(detailProposal)}
          onReject={() => void submitDecision(detailProposal, 'REJECTED')}
          onClose={() => setDetailId(null)}
          onOpenAssistant={() => openAssistant(detailProposal)}
        />
      )}

      {/* ACCEPT CONFIRMATION — required before any action that could submit an order. */}
      {confirmAccept && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm proposal acceptance"
        >
          <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-5 space-y-4">
            <div className="flex items-center gap-2">
              <ShieldCheck size={17} className="text-accent-text" aria-hidden="true" />
              <h3 className="text-sm font-bold text-fg">Accept this proposal?</h3>
            </div>

            <p className="text-[12px] leading-relaxed text-fg-muted">
              You are recording <strong>ACCEPTED</strong> for{' '}
              <span className="font-mono">{confirmAccept.market}</span>{' '}
              {confirmAccept.direction ?? ''} created{' '}
              {new Date(confirmAccept.createdAt).toLocaleString()}.
              {executionStatus && !executionStatus.enabled ? (
                <>
                  {' '}
                  <strong className="text-fg">No order will be placed:</strong>{' '}
                  {executionStatus.summary}
                </>
              ) : (
                ' The server applies the deployment execution policy before any acceptance is recorded.'
              )}
            </p>

            <label className="block">
              <span className="label">Note (optional)</span>
              <input
                className="input"
                value={decisionNote}
                maxLength={500}
                onChange={(e) => setDecisionNote(e.target.value)}
                placeholder="e.g. sized down to 0.5% risk"
              />
            </label>

            {decisionError && (
              <div className="rounded-xl border border-negative/40 bg-negative-soft/50 p-2.5 text-[11px] leading-relaxed text-negative">
                {decisionError}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setConfirmAccept(null);
                  setDecisionError(null);
                }}
                disabled={decisionBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={decisionBusy}
                onClick={() => void submitDecision(confirmAccept, 'ACCEPTED')}
              >
                {decisionBusy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : null}
                Confirm acceptance
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================= */}
      {/* AI ASSISTANT                                                   */}
      {/* ============================================================= */}
      {assistantFor && (
        <div
          className="fixed inset-0 z-[70] flex items-end justify-center bg-black/75 p-3 backdrop-blur-sm sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Proposal AI assistant"
        >
          <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-surface">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div className="flex items-center gap-2">
                <Sparkles size={15} className="text-accent-text" aria-hidden="true" />
                <div>
                  <h3 className="text-[13px] font-bold text-fg">Proposal assistant</h3>
                  <p className="text-[10px] text-fg-subtle">
                    Grounded in this proposal&apos;s stored record. Read-only.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setAssistantFor(null)}
                className="rounded-lg p-1.5 text-fg-subtle hover:bg-raised hover:text-fg"
                aria-label="Close assistant"
              >
                <X size={15} />
              </button>
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {assistantMessages.map((message, index) => (
                <div
                  key={index}
                  className={`max-w-[90%] whitespace-pre-wrap rounded-xl px-3 py-2 text-[12px] leading-relaxed ${
                    message.sender === 'user'
                      ? 'ml-auto bg-accent-soft text-fg'
                      : 'bg-raised text-fg-muted'
                  }`}
                >
                  {message.text}
                </div>
              ))}

              {assistantBusy && (
                <div className="flex items-center gap-2 text-[11px] text-fg-subtle">
                  <Loader2 size={12} className="animate-spin" aria-hidden="true" /> Consulting the
                  proposal record…
                </div>
              )}

              {assistantError && (
                <div className="rounded-xl border border-negative/40 bg-negative-soft/50 p-2.5 text-[11px] leading-relaxed text-negative">
                  {assistantError}
                  <p className="mt-1">
                    If no AI key is configured, add your OpenRouter key in{' '}
                    <strong>Settings → AI Reasoning Engine</strong> and try again.
                  </p>
                </div>
              )}
            </div>

            {assistantMessages.length <= 1 && (
              <div className="flex flex-wrap gap-1.5 border-t border-line px-4 py-2.5">
                {SUGGESTED_QUESTIONS.map((question) => (
                  <button
                    key={question}
                    type="button"
                    onClick={() => void askAssistant(question)}
                    disabled={assistantBusy}
                    className="rounded-lg border border-line bg-sunken px-2 py-1 text-[10px] text-fg-muted transition-colors hover:border-accent/40 hover:text-fg disabled:opacity-50"
                  >
                    {question}
                  </button>
                ))}
              </div>
            )}

            <form
              className="flex items-center gap-2 border-t border-line p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void askAssistant(assistantInput);
              }}
            >
              <input
                className="input"
                value={assistantInput}
                maxLength={2000}
                onChange={(e) => setAssistantInput(e.target.value)}
                placeholder="Ask about this proposal…"
                aria-label="Question for the proposal assistant"
              />
              <button
                type="submit"
                className="btn btn-primary !px-3"
                disabled={assistantBusy || !assistantInput.trim()}
                aria-label="Send question"
              >
                <Send size={14} aria-hidden="true" />
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Proposal card (summary — clickable)                                        */
/* -------------------------------------------------------------------------- */

function ProposalCard({
  proposal,
  onEvaluate,
  evaluating,
  onOpenDetail,
  onOpenAssistant,
}: {
  proposal: Proposal;
  onEvaluate: () => void;
  evaluating: boolean;
  onOpenDetail: () => void;
  onOpenAssistant: () => void;
}) {
  const actionable = proposal.status === 'ACTIONABLE' && !proposal.expired && !proposal.decision;

  return (
    <article className="panel relative overflow-hidden">
      {actionable && <span className="edge-top" aria-hidden="true" />}

      <div
        role="button"
        tabIndex={0}
        onClick={onOpenDetail}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpenDetail();
          }
        }}
        className="flex w-full cursor-pointer flex-wrap items-start gap-3 p-4 text-left transition-colors hover:bg-raised"
      >
        {/* Direction */}
        <span
          className={`badge ${
            proposal.direction === 'LONG'
              ? 'badge-positive'
              : proposal.direction === 'SHORT'
                ? 'badge-negative'
                : 'badge-neutral'
          }`}
        >
          {proposal.direction ?? proposal.status}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="font-mono text-[14px] font-semibold text-fg">
              {proposal.market ?? '—'}
            </h3>
            {proposal.goatName && (
              <span className="text-[11px] text-fg-subtle">from {proposal.goatName}</span>
            )}
            <span className="text-[11px] text-fg-subtle">
              {new Date(proposal.createdAt).toLocaleString()}
            </span>
          </div>

          {proposal.rationale && (
            <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-fg-muted">
              {proposal.rationale}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {proposal.decision && (
            <span
              className={`badge ${proposal.decision === 'ACCEPTED' ? 'badge-info' : 'badge-neutral'}`}
              title={proposal.decidedAt ? `Decided ${new Date(proposal.decidedAt).toLocaleString()}` : undefined}
            >
              {proposal.decision}
            </span>
          )}
          {proposal.expired && !proposal.decision && (
            <span className="badge badge-warning">
              <Clock size={10} aria-hidden="true" /> Expired
            </span>
          )}
        </div>
      </div>

      {/* Levels */}
      {proposal.direction && proposal.direction !== 'NO_TRADE' && (
        <div className="grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-4">
          <Level label="Entry" value={proposal.entry} />
          <Level label="Stop" value={proposal.stopLoss} tone="negative" />
          <Level label="Target" value={proposal.takeProfit} tone="positive" />
          <Level
            label="R:R"
            value={
              proposal.riskReward !== undefined && Number.isFinite(Number(proposal.riskReward))
                ? `${Number(proposal.riskReward).toFixed(2)}:1`
                : null
            }
          />
        </div>
      )}

      {/* Risk verdict */}
      {proposal.error && (
        <div className="flex items-start gap-2 border-t border-line bg-negative-soft/40 px-4 py-2.5">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-negative" aria-hidden="true" />
          <p className="text-[12px] text-fg-muted">{proposal.error}</p>
        </div>
      )}

      {proposal.risk && (
        <div
          className={`border-t border-line px-4 py-3 ${
            proposal.risk.ok ? 'bg-positive-soft/30' : 'bg-warning-soft/30'
          }`}
        >
          <div className="flex items-start gap-2">
            {proposal.risk.ok ? (
              <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-positive" aria-hidden="true" />
            ) : (
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold text-fg">
                {proposal.risk.ok ? 'Passes risk checks' : 'Blocked by risk checks'}
              </p>
              {!proposal.risk.ok && proposal.risk.violations.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {proposal.risk.violations.map((violation, index) => (
                    <li key={index} className="text-[12px] leading-relaxed text-fg-muted">
                      · {violation}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5">
        <p className="text-[11px] text-fg-subtle">
          {proposal.risk
            ? proposal.risk.execution.enabled
              ? 'Execution is enabled for this deployment.'
              : proposal.risk.execution.summary
            : 'Not yet evaluated against live account risk.'}
        </p>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenAssistant();
            }}
            className="btn btn-ghost"
            aria-label={`Ask the AI assistant about the ${proposal.market ?? 'selected'} proposal`}
            title="Ask the AI assistant about this proposal"
          >
            <Bot size={13} aria-hidden="true" /> Ask AI
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEvaluate();
            }}
            disabled={evaluating}
            className="btn btn-secondary"
          >
            {evaluating ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : null}
            Check risk
          </button>
        </div>
      </div>
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/* Proposal detail                                                            */
/* -------------------------------------------------------------------------- */

function ProposalDetail({
  proposal,
  goat,
  skills,
  execution,
  evaluating,
  decisionBusy,
  decisionError,
  onEvaluate,
  onAskAccept,
  onReject,
  onClose,
  onOpenAssistant,
}: {
  proposal: Proposal;
  goat: { id: string; name: string; skillIds: string[]; model: string; timeframe?: string } | null;
  skills: { id: string; name: string }[];
  execution: ExecutionStatus | null;
  evaluating: boolean;
  decisionBusy: boolean;
  decisionError: string | null;
  onEvaluate: () => void;
  onAskAccept: () => void;
  onReject: () => void;
  onClose: () => void;
  onOpenAssistant: () => void;
}) {
  const attachedSkills = (goat?.skillIds ?? [])
    .map((id) => skills.find((s) => s.id === id)?.name ?? id);

  const evidence = proposal.supportingEvidence ?? [];
  const contra = proposal.contradictoryEvidence ?? [];

  return (
    <div
      className="fixed inset-0 z-[65] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`Proposal detail for ${proposal.market ?? 'trade'}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-line bg-surface">
        <div className="sticky top-0 flex items-start justify-between gap-3 border-b border-line bg-surface px-5 py-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`badge ${
                  proposal.direction === 'LONG'
                    ? 'badge-positive'
                    : proposal.direction === 'SHORT'
                      ? 'badge-negative'
                      : 'badge-neutral'
                }`}
              >
                {proposal.direction ?? proposal.status}
              </span>
              <h2 className="font-mono text-[15px] font-bold text-fg">{proposal.market ?? '—'}</h2>
              {proposal.decision && (
                <span className={`badge ${proposal.decision === 'ACCEPTED' ? 'badge-info' : 'badge-neutral'}`}>
                  {proposal.decision}
                </span>
              )}
            </div>
            <p className="mt-1 text-[11px] text-fg-subtle">
              Created {new Date(proposal.createdAt).toLocaleString()}
              {proposal.expiresAt && (
                <>
                  {' · '}
                  {proposal.expired ? 'Expired' : 'Expires'}{' '}
                  {new Date(proposal.expiresAt).toLocaleString()}
                </>
              )}
              {proposal.decidedAt && (
                <> · Decided {new Date(proposal.decidedAt).toLocaleString()}</>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-fg-subtle hover:bg-raised hover:text-fg"
            aria-label="Close proposal detail"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-5 px-5 py-4">
          {decisionError && (
            <div className="flex items-start gap-2 rounded-xl border border-negative/40 bg-negative-soft/50 p-3">
              <ShieldAlert size={14} className="mt-0.5 shrink-0 text-negative" aria-hidden="true" />
              <p className="text-[12px] leading-relaxed text-negative">{decisionError}</p>
            </div>
          )}

          {/* ---- Thesis ---- */}
          <section>
            <DetailHeading label="Trade thesis" />
            <p className="mt-1 text-[13px] leading-relaxed text-fg">
              {proposal.thesis ?? proposal.rationale ?? (
                <span className="text-fg-subtle">Not available — the GOAT did not record a thesis.</span>
              )}
            </p>
            {proposal.thesis && proposal.rationale && proposal.rationale !== proposal.thesis && (
              <p className="mt-2 text-[12px] leading-relaxed text-fg-muted">{proposal.rationale}</p>
            )}
          </section>

          {/* ---- Levels ---- */}
          <section>
            <DetailHeading label="Price plan" />
            <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <DetailValue
                label="Entry"
                value={
                  proposal.entryZone
                    ? `${proposal.entryZone.low} – ${proposal.entryZone.high}`
                    : proposal.entry
                }
              />
              <DetailValue label="Stop-loss" value={proposal.stopLoss} tone="negative" />
              <DetailValue label="Take-profit" value={proposal.takeProfit} tone="positive" />
              <DetailValue
                label="Risk / reward"
                value={
                  proposal.riskReward !== undefined && Number.isFinite(Number(proposal.riskReward))
                    ? `1:${Number(proposal.riskReward).toFixed(2)}`
                    : null
                }
              />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <DetailValue label="Order type" value={proposal.orderType} />
              <DetailValue
                label="Confidence"
                value={proposal.confidence !== undefined ? `${proposal.confidence}%` : null}
              />
            </div>
          </section>

          {/* ---- Position size / risk (only if actually calculated) ---- */}
          <section>
            <DetailHeading label="Position size & risk" />
            {proposal.risk?.measured ? (
              <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-3">
                <DetailValue label="Notional" value={proposal.risk.measured.notionalUsd ?? null} money />
                <DetailValue label="Risk (USD)" value={proposal.risk.measured.riskUsd ?? null} money />
                <DetailValue
                  label="% of room"
                  value={
                    proposal.risk.measured.riskPctOfRoom !== null
                      ? `${proposal.risk.measured.riskPctOfRoom.toFixed(2)}%`
                      : null
                  }
                />
              </div>
            ) : (
              <p className="mt-1 text-[12px] text-fg-subtle">
                Not calculated yet — run <strong>Check risk</strong> below to measure this against your
                live PropDAO account.
              </p>
            )}
          </section>

          {/* ---- Evidence ---- */}
          <section>
            <DetailHeading label="Supporting evidence" />
            {evidence.length > 0 ? (
              <ul className="mt-1.5 space-y-1">
                {evidence.map((item, index) => (
                  <li key={index} className="flex gap-2 text-[12px] leading-relaxed text-fg-muted">
                    <span className="text-positive">✓</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[12px] text-fg-subtle">
                No supporting evidence was recorded with this proposal.
              </p>
            )}

            {contra.length > 0 && (
              <>
                <p className="mt-3 text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
                  Contradictory evidence
                </p>
                <ul className="mt-1 space-y-1">
                  {contra.map((item, index) => (
                    <li key={index} className="flex gap-2 text-[12px] leading-relaxed text-fg-muted">
                      <span className="text-warning">!</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          {/* ---- Source ---- */}
          <section>
            <DetailHeading label="Source" />
            <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <DetailValue label="GOAT" value={proposal.goatName ?? goat?.name ?? null} />
              <DetailValue label="Model" value={goat ? shortModel(goat.model) : null} />
              <DetailValue label="Tracking timeframe" value={goat?.timeframe ?? null} />
              <DetailValue
                label="Skills"
                value={attachedSkills.length > 0 ? attachedSkills.join(', ') : null}
              />
            </div>
            {goat && (
              <p className="mt-2 text-[11px] leading-relaxed text-fg-subtle">{goat.name} goal: see the GOATs tab.</p>
            )}
          </section>

          {/* ---- Confirmation / invalidation ---- */}
          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <DetailHeading label="Confirmation required" />
              <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">
                {proposal.confirmationRequired || (
                  <span className="text-fg-subtle">Not recorded.</span>
                )}
              </p>
            </div>
            <div>
              <DetailHeading label="Invalidation" />
              <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">
                {proposal.invalidation || <span className="text-fg-subtle">Not recorded.</span>}
              </p>
            </div>
          </section>

          {/* ---- Execution eligibility ---- */}
          <section className="rounded-xl border border-line bg-sunken/60 p-3.5">
            <div className="flex items-center gap-2">
              <ShieldCheck size={14} className="text-fg-subtle" aria-hidden="true" />
              <p className="text-[12px] font-semibold text-fg">Execution eligibility</p>
            </div>
            <p className="mt-1.5 text-[12px] leading-relaxed text-fg-muted">
              {execution ? (
                <>
                  <strong className={execution.enabled ? 'text-positive' : 'text-warning'}>
                    {execution.enabled ? 'Execution enabled' : 'Execution disabled'}
                  </strong>{' '}
                  — {execution.summary}
                </>
              ) : (
                <>
                  <span className="text-fg-subtle">
                    Not yet checked — loading the deployment&apos;s execution policy.
                  </span>
                </>
              )}
            </p>
            <p className="mt-1.5 text-[11px] text-fg-subtle">
              Market data comes from Hyperliquid; execution eligibility is decided by the PropDAO
              integration and this deployment&apos;s execution policy. A quote alone never implies an
              instrument is executable.
            </p>
          </section>

          {/* ---- Risk verdict, if checked ---- */}
          {proposal.risk && (
            <section
              className={`rounded-xl border p-3.5 ${
                proposal.risk.ok
                  ? 'border-positive/40 bg-positive-soft/30'
                  : 'border-warning/40 bg-warning-soft/30'
              }`}
            >
              <p className="text-[12px] font-semibold text-fg">
                {proposal.risk.ok ? 'Passes risk checks' : 'Blocked by risk checks'}
              </p>
              {!proposal.risk.ok && proposal.risk.violations.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {proposal.risk.violations.map((violation, index) => (
                    <li key={index} className="text-[12px] leading-relaxed text-fg-muted">
                      · {violation}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>

        {/* ---- Actions ---- */}
        <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-2 border-t border-line bg-surface px-5 py-3.5">
          <button type="button" onClick={onEvaluate} disabled={evaluating} className="btn btn-secondary">
            {evaluating ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : null}
            Check risk
          </button>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onOpenAssistant}
              className="btn btn-secondary"
              title="Ask the AI assistant about this proposal"
            >
              <MessageSquare size={13} aria-hidden="true" /> Ask AI
            </button>

            {proposal.decision ? (
              <span className="text-[11px] text-fg-subtle">
                Decision recorded: <strong className="text-fg">{proposal.decision}</strong>
                {proposal.decisionNote ? ` — “${proposal.decisionNote}”` : ''}
              </span>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onReject}
                  disabled={decisionBusy}
                  className="btn btn-danger"
                  title="Reject this proposal (no order is involved)"
                >
                  <ThumbsDown size={13} aria-hidden="true" /> Reject
                </button>
                <button
                  type="button"
                  onClick={onAskAccept}
                  disabled={decisionBusy}
                  className="btn btn-primary"
                  title="Accept this proposal (the server applies the execution policy)"
                >
                  <ThumbsUp size={13} aria-hidden="true" /> Accept
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Presentational helpers                                                     */
/* -------------------------------------------------------------------------- */

function DetailHeading({ label }: { label: string }) {
  return (
    <p className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">{label}</p>
  );
}

function DetailValue({
  label,
  value,
  tone = 'default',
  money = false,
}: {
  label: string;
  value: number | string | null | undefined;
  tone?: 'default' | 'positive' | 'negative';
  money?: boolean;
}) {
  const unavailable = value === null || value === undefined || value === '';
  const text = unavailable
    ? '—'
    : money && typeof value === 'number'
      ? `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
      : String(value);

  return (
    <div className="bg-sunken/60 p-3 rounded-xl border border-line">
      <p className="text-[10px] uppercase font-bold text-fg-subtle">{label}</p>
      <p
        className={`mt-0.5 font-mono text-sm font-medium ${
          unavailable
            ? 'text-fg-subtle'
            : tone === 'positive'
              ? 'text-positive'
              : tone === 'negative'
                ? 'text-negative'
                : 'text-fg'
        }`}
        title={unavailable ? 'Not available for this proposal' : undefined}
      >
        {text}
        {unavailable && <span className="sr-only"> (not available)</span>}
      </p>
    </div>
  );
}

function Level({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number | string | null | undefined;
  tone?: 'default' | 'positive' | 'negative';
}) {
  const numeric = typeof value === 'number' && Number.isFinite(value);
  const text = numeric
    ? (value as number).toLocaleString()
    : typeof value === 'string' && value.trim().length > 0
      ? value
      : '—';
  return (
    <div className="bg-surface px-4 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">{label}</p>
      <p
        className={`mt-0.5 font-mono text-[13px] font-medium ${
          tone === 'positive' ? 'text-positive' : tone === 'negative' ? 'text-negative' : 'text-fg'
        }`}
      >
        {text}
      </p>
    </div>
  );
}

function shortModel(id: string): string {
  const parts = id.split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : id;
}
