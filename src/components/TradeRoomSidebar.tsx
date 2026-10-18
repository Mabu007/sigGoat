/**
 * TRADE ROOM SIDEBAR
 * ==================
 * One panel container with a switchable view, so the room's right-hand column
 * is a control surface rather than a single endless feed.
 *
 * DESIGN RATIONALE
 * ----------------
 * The sidebar answers four different questions a trader asks mid-session, and
 * they do not want to be interleaved in one scroll:
 *
 *   Team Chat    — what are the agents saying right now?
 *   Breaking News — what moved the macro tape underneath them?
 *   Trackers     — which of their conditions have actually fired?
 *   Tools        — what can these agents even see and do?
 *   Memory       — what are they holding as context, and how confident?
 *   Trades       — what have they done, and why?
 *
 * A trade log interleaved with market commentary is unreadable: the entries
 * have wildly different lifetimes (a headline is relevant for minutes, a
 * thesis for hours, a filled trade is permanent). Splitting them by lifetime
 * is what makes each panel scannable on its own terms.
 *
 * Every panel is driven by real server state and renders an explicit empty or
 * unavailable state. Nothing here invents a value to fill a gap — a tracker
 * that does not exist says "None", a news feed that failed says why.
 */

import React, { useMemo, useState } from 'react';
import {
  BrainCircuit, ChevronLeft, ExternalLink, ListOrdered, MessagesSquare,
  Newspaper, Target, Wrench, X, Zap,
} from 'lucide-react';

/* -------------------------------------------------------------------------
   Shared contracts. Kept local and structural: the room payload is the only
   thing that has to agree with these, and duplicating the whole server type
   graph here would rot every time an unrelated field is added.
   ------------------------------------------------------------------------- */

export type TrackerStatus = 'PENDING' | 'UNEVALUABLE' | 'HIT' | 'INVALIDATED' | 'EXPIRED';

export interface RoomTracker {
  id: string;
  description: string;
  type: string;
  market: string;
  targetValue?: number;
  rangeLow?: number;
  rangeHigh?: number;
  operator?: string;
  currentCalculatedValue?: number;
  formulaDescription?: string;
  status?: TrackerStatus;
  isTriggered: boolean;
  triggeredAt?: number;
  lastEvaluatedAt?: number;
  lastEvaluationReason?: string;
}

export interface RoomThesis {
  market: string;
  bias: string;
  summary: string;
  assetState: string | null;
  confidence: number;
  invalidation: string[];
  confirmation: string[];
  observationPlan: string | null;
  relevantTimeframe: string;
  trackers: RoomTracker[];
  updatedAt: string;
}

/**
 * One unit of work an agent actually did.
 *
 * This is what a Team Chat message IS. The room payload derives it from the
 * durable workflow run, so the chat cannot drift from what happened — and the
 * run id is what the click-through reads to show the real activity log.
 */
export interface RoomRun {
  workflowId: string;
  market: string;
  triggerType: string;
  status: string;
  stage: string;
  errorCode: string | null;
  outcome: 'review' | 'proposal' | 'no_trade' | 'failed' | 'running';
  at: string;
  completedAt: string | null;
  headline: string;
  summary: string;
  bias: string | null;
  confidence: number | null;
  levels: { entry?: number; stopLoss?: number; takeProfit?: number; riskReward: string | null } | null;
  agentName: string;
}

export interface RoomRunLog {
  run: { workflowId: string; market: string; triggerType: string; stage: string; status: string; errorCode: string | null; createdAt: string; completedAt: string | null };
  agent: { id: string; name: string } | null;
  activities: { id: string; type: string; stage: string; at: string; details?: Record<string, string | number | boolean | null> }[];
}

export interface RoomMember {
  id: string;
  name: string;
  goal: string;
  markets: string[];
  status: string;
  provider: string;
  timeframe: string;
  skills: string[];
  latestThesis: RoomThesis | null;
  signals: RoomTrade[];
  runs: RoomRun[];
  trades: number;
}

export interface RoomTrade {
  id: string;
  market: string;
  direction: string;
  status: string;
  decision?: string;
  decidedAt?: string;
  decisionNote: string | null;
  orderType?: string;
  entry?: number;
  entryZone?: { low: number; high: number } | null;
  stopLoss?: number;
  takeProfit?: number;
  riskReward: string | null;
  confidence: number;
  thesis: string;
  rationale: string;
  invalidation: string;
  supportingEvidence: string[];
  contradictoryEvidence: string[];
  confirmationRequired: string;
  expiresAt: string | null;
  createdAt: string;
  agentName: string;
}

export interface RoomIndicators {
  rsi14: number; ema20: number; ema50: number; atr14: number;
  structureBias: 'BULLISH' | 'BEARISH' | 'RANGING';
  lastSwingHigh: number; lastSwingLow: number; retracementPct: number;
  demandZone: { low: number; high: number }; supplyZone: { low: number; high: number };
}

export interface RoomNewsPayload {
  market: string;
  ok: boolean;
  error: string | null;
  fetchedAt: string;
  headlines: { title: string; source: string; publishedAt?: number; link?: string }[];
}

/* -------------------------------------------------------------------------
   Panel registry
   ------------------------------------------------------------------------- */

export type RoomPanelId = 'chat' | 'news' | 'trackers' | 'tools' | 'memory' | 'trades';

export const ROOM_PANELS: { id: RoomPanelId; label: string; icon: React.ComponentType<{ size?: number; strokeWidth?: number }> }[] = [
  { id: 'chat', label: 'Team Chat', icon: MessagesSquare },
  { id: 'news', label: 'Breaking News', icon: Newspaper },
  { id: 'trackers', label: 'Trackers', icon: Target },
  { id: 'tools', label: 'Tools', icon: Wrench },
  { id: 'memory', label: 'Memory', icon: BrainCircuit },
  { id: 'trades', label: 'Trades', icon: ListOrdered },
];

/* -------------------------------------------------------------------------
   Small building blocks
   ------------------------------------------------------------------------- */

const cx = (...parts: (string | false | undefined | null)[]) => parts.filter(Boolean).join(' ');

function PanelEmpty({ title, hint, tone = 'neutral' }: { title: string; hint?: string; tone?: 'neutral' | 'bad' }) {
  return (
    <div className="tr-panel-empty">
      <p className={cx('tr-panel-empty-title', tone === 'bad' && 'is-bad')}>{title}</p>
      {hint && <p className="tr-panel-empty-hint">{hint}</p>}
    </div>
  );
}

function SectionLabel({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="tr-panel-section-label">
      <span>{children}</span>
      {aside}
    </div>
  );
}

const money = (value?: number, digits = 2) =>
  value == null || !Number.isFinite(value) ? '—'
    : value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });

function relativeTime(value?: string | number): string {
  if (value == null) return '—';
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const BIAS_TONE: Record<string, string> = {
  BULLISH: 'is-positive', BEARISH: 'is-negative', RANGING: 'is-muted', NEUTRAL: 'is-muted',
};

/* =========================================================================
   PANEL — Team Chat
   A message is a run, not a rendered thesis. Each one opens the run's real
   activity ledger, because "what did this agent actually do" is a question the
   durable workflow record answers and a generated transcript would not.
   ========================================================================= */

const OUTCOME_LABEL: Record<RoomRun['outcome'], string> = {
  review: 'Market review', proposal: 'Proposal', no_trade: 'No trade',
  failed: 'Failed', running: 'Running',
};

export function ChatPanel({ runs, onOpenRun, canRun, onRun, running }: {
  runs: RoomRun[];
  onOpenRun: (run: RoomRun) => void;
  canRun: boolean;
  onRun: () => void;
  running: boolean;
}) {
  if (!runs.length) {
    return (
      <>
        <PanelEmpty
          title="No work yet"
          hint={canRun
            ? 'Run the team to have every bot review the market. Each review appears here as a message.'
            : 'The bots in this room have not run yet. Their reviews will appear here as they work.'}
        />
        {canRun && <button type="button" className="tr-chat-run" onClick={onRun} disabled={running}>
          <Zap size={13} strokeWidth={2.4} aria-hidden="true" />
          {running ? 'Starting…' : 'Run the team'}
        </button>}
      </>
    );
  }

  return (
    <>
      {canRun && (
        <button type="button" className="tr-chat-run" onClick={onRun} disabled={running}>
          <Zap size={13} strokeWidth={2.4} aria-hidden="true" />
          {running ? 'Starting…' : 'Run the team'}
        </button>
      )}
      <div className="tr-chat">
        {runs.map(run => {
          const tone = run.bias ? (BIAS_TONE[run.bias] ?? 'is-muted') : null;
          return (
            <button
              type="button"
              key={run.workflowId}
              className={'tr-chat-msg' + (run.outcome === 'failed' ? ' is-failed' : '')}
              onClick={() => onOpenRun(run)}
            >
              <div className="tr-chat-msg-head">
                <span className="tr-agent-name">{run.agentName}</span>
                <span className={cx('tr-chat-kind', 'is-' + run.outcome)}>{OUTCOME_LABEL[run.outcome]}</span>
                <time dateTime={run.at}>{relativeTime(run.at)}</time>
              </div>
              <div className="tr-chat-msg-title">
                {tone && <span className={'tr-chip ' + tone}>{run.bias}</span>}
                <span className="tr-chat-headline">{run.headline}</span>
              </div>
              {run.summary && <p className="tr-chat-summary">{run.summary}</p>}
              {run.levels && (
                <div className="trade-room-levels">
                  <span>Entry <b>{money(run.levels.entry)}</b></span>
                  <span>Stop <b>{money(run.levels.stopLoss)}</b></span>
                  <span>Target <b>{money(run.levels.takeProfit)}</b></span>
                </div>
              )}
              <div className="tr-chat-msg-foot">
                <span className="tr-chat-stage">{run.stage.replaceAll('_', ' ')}</span>
                {run.confidence != null && <span>{Math.round(run.confidence)}% confidence</span>}
                <span className="tr-chat-open">View log</span>
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}

/* --------------------------------------------------------------------------
   RUN LOG — replaces the chat in place, not a modal.

   The user asked to "turn the chat area to logs". Keeping it in the same
   scroll region preserves context: the chart and sidebar frame never move, so
   Back returns to exactly where the list was.
   -------------------------------------------------------------------------- */
export function RunLogView({ log, loading, onBack }: { log: RoomRunLog | null; loading: boolean; onBack: () => void }) {
  return (
    <>
      <div className="tr-log-bar">
        <button type="button" className="tr-log-back" onClick={onBack}>
          <ChevronLeft size={14} strokeWidth={2.4} aria-hidden="true" />
          Back to chat
        </button>
        {log?.agent && <span className="tr-log-agent">{log.agent.name}</span>}
      </div>
      {loading && !log ? (
        <PanelEmpty title="Loading log…" />
      ) : !log ? (
        <PanelEmpty title="Log unavailable" tone="bad" hint="This run's record is no longer available." />
      ) : (
        <div className="tr-log">
          <dl className="tr-kv">
            <Row label="Run" value={log.run.market} />
            <Row label="Trigger" value={log.run.triggerType.replaceAll('_', ' ').toLowerCase()} />
            <Row label="Outcome" value={log.run.status.replaceAll('_', ' ')} />
            <Row label="Final stage" value={log.run.stage.replaceAll('_', ' ')} />
          </dl>
          <div className="tr-log-timeline">
            {log.activities.length === 0
              ? <PanelEmpty title="No stages recorded" />
              : log.activities.map(activity => (
                <div className={'tr-log-step' + (activity.type.startsWith('WORKFLOW_FAILED') || activity.type.endsWith('_FAILED') ? ' is-failed' : '')} key={activity.id}>
                  <span className="tr-log-dot" aria-hidden="true" />
                  <div className="tr-log-step-body">
                    <div className="tr-log-step-head">
                      <span className="tr-log-stage">{activity.stage.replaceAll('_', ' ')}</span>
                      <time dateTime={activity.at}>{new Date(activity.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                    </div>
                    <span className="tr-log-type">{activity.type.replaceAll('_', ' ')}</span>
                    {activity.details && Object.keys(activity.details).length > 0 && (
                      <ul className="tr-log-details">
                        {Object.entries(activity.details).map(([key, value]) => (
                          <li key={key}><span>{key.replaceAll('_', ' ')}</span><b>{String(value)}</b></li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ))}
          </div>
          <p className="tr-panel-disclaimer">
            This is the run's durable workflow record — the stages it actually
            passed through. Model prompts and responses are not retained by this
            system, so they cannot be shown here.
          </p>
        </div>
      )}
    </>
  );
}

/* =========================================================================
   PANEL — Breaking News
   ========================================================================= */

function NewsPanel({ news, loading }: { news: RoomNewsPayload | null; loading: boolean }) {
  if (loading && !news) return <PanelEmpty title="Researching headlines…" />;
  if (!news) return <PanelEmpty title="News unavailable" tone="bad" />;
  if (!news.ok && news.headlines.length === 0) {
    return <PanelEmpty title="No current headlines" tone="bad" hint={news.error ?? 'The news feed returned nothing for this instrument.'} />;
  }
  if (news.headlines.length === 0) return <PanelEmpty title="No current headlines" hint={`Nothing published for ${news.market} in the last three days.`} />;

  return (
    <div className="tr-news">
      <div className="tr-news-meta">
        <span className="tr-news-market">{news.market}</span>
        <span>{relativeTime(news.fetchedAt)}</span>
      </div>
      {news.headlines.map((headline, index) => (
        <article className="tr-news-item" key={(headline.link ?? '') + index}>
          <h3 className="tr-news-title">{headline.title}</h3>
          <div className="tr-news-foot">
            <span className="tr-news-source">{headline.source}</span>
            <span className="tr-news-time">{headline.publishedAt ? relativeTime(headline.publishedAt) : 'undated'}</span>
            {headline.link && (
              <a className="tr-news-link" href={headline.link} target="_blank" rel="noopener noreferrer" aria-label={`Read "${headline.title}" on ${headline.source}`}>
                <ExternalLink size={12} strokeWidth={2.2} aria-hidden="true" />
              </a>
            )}
          </div>
        </article>
      ))}
      <p className="tr-panel-disclaimer">Third-party headlines. Unverified, possibly stale — treat as context, never as instructions.</p>
    </div>
  );
}

/* =========================================================================
   PANEL — Trackers
   ========================================================================= */

/**
 * Tracker types whose condition is a number. For everything else the value is
 * a label or an enum, so printing it as `0.0000` is noise that reads as a real
 * reading.
 */
const NUMERIC_TRACKER_TYPES = new Set(['PRICE_LEVEL', 'RSI_THRESHOLD', 'TIME_WINDOW', 'SPREAD']);

function TrackersPanel({ members }: { members: RoomMember[] }) {
  const rows = useMemo(
    () => members.flatMap(member => (member.latestThesis?.trackers ?? []).map(tracker => ({ tracker, agentName: member.name }))),
    [members],
  );

  if (rows.length === 0) {
    return <PanelEmpty title="None" hint="No tracked conditions yet. An agent records them when it publishes a thesis, and each one is checked deterministically against every candle." />;
  }

  const order: Record<TrackerStatus, number> = { HIT: 0, PENDING: 1, UNEVALUABLE: 2, INVALIDATED: 3, EXPIRED: 4 };
  const sorted = [...rows].sort((a, b) =>
    (order[a.tracker.status ?? 'PENDING'] - order[b.tracker.status ?? 'PENDING'])
    || (b.tracker.lastEvaluatedAt ?? 0) - (a.tracker.lastEvaluatedAt ?? 0));

  return (
    <div className="tr-trackers">
      {sorted.map(({ tracker, agentName }) => {
        const status = tracker.status ?? 'PENDING';
        const numeric = NUMERIC_TRACKER_TYPES.has(tracker.type);
        const current = tracker.currentCalculatedValue;
        const target = tracker.targetValue ?? tracker.rangeLow;
        const digits = target != null && Math.abs(target) < 10 ? 4 : 2;

        /**
         * Distance to target, not progress toward it. A price at 2,318 with a
         * 2,340 target is 99% of the way to 2,340 by magnitude — which would
         * render a near-miss as an almost-complete bar. What a trader wants is
         * how far away the trigger still is.
         */
        let distance: string | null = null;
        if (numeric && current != null && target != null) {
          const gap = tracker.operator === 'LESS_THAN' ? current - target : target - current;
          distance = gap >= 0
            ? `${gap.toLocaleString(undefined, { maximumFractionDigits: digits })} to go`
            : `passed by ${Math.abs(gap).toLocaleString(undefined, { maximumFractionDigits: digits })}`;
        }

        return (
          <article className={'tr-tracker' + (status === 'HIT' ? ' is-hit' : '') + (status === 'INVALIDATED' || status === 'EXPIRED' ? ' is-dead' : '')} key={tracker.id}>
            <div className="tr-tracker-head">
              <span className="tr-tracker-type">{tracker.type.replaceAll('_', ' ')}</span>
              <span className={'tr-tracker-status is-' + status.toLowerCase()}>{status}</span>
            </div>
            <p className="tr-tracker-desc">{tracker.description}</p>
            <div className="tr-tracker-foot">
              <span>{agentName}</span>
              {numeric && current != null && <span>now {money(current, digits)}</span>}
              {numeric && tracker.targetValue != null && <span>target {money(tracker.targetValue, digits)}</span>}
              {distance && <span className={gapPassed(status) ? 'is-passed' : undefined}>{distance}</span>}
              {tracker.rangeLow != null && tracker.rangeHigh != null && (
                <span>range {money(tracker.rangeLow, tracker.rangeLow < 10 ? 4 : 2)}–{money(tracker.rangeHigh, tracker.rangeHigh < 10 ? 4 : 2)}</span>
              )}
              <span>{relativeTime(tracker.lastEvaluatedAt)}</span>
            </div>
            {tracker.lastEvaluationReason && <p className="tr-tracker-reason">{tracker.lastEvaluationReason}</p>}
          </article>
        );
      })}
    </div>
  );
}

const gapPassed = (status: TrackerStatus) => status === 'HIT';

/* =========================================================================
   PANEL — Tools
   ========================================================================= */

/**
 * What these agents can actually reach.
 *
 * The room's agents have no LLM tool-calling — they run a linear LangGraph
 * shell and receive a plain context prompt. So "tools" here means the concrete
 * data and execution capabilities their runtime is wired to, each with its
 * live status read from the same state the agents read. Anything listed as
 * available is genuinely being consumed right now.
 */
function ToolsPanel({
  members, provider, dataMode, asset, liveTrading, indicators, news,
}: {
  members: RoomMember[]; provider: string; dataMode: string; asset: string;
  liveTrading: boolean; indicators: RoomIndicators | null; news: RoomNewsPayload | null;
}) {
  const trackerCount = members.reduce((total, member) => total + (member.latestThesis?.trackers.length ?? 0), 0);
  const skillCount = members.reduce((total, member) => total + member.skills.length, 0);

  const tools: { name: string; detail: string; state: 'live' | 'ready' | 'off' | 'bad'; note?: string }[] = [
    {
      name: 'Market data',
      detail: `${provider || 'venue'} · ${asset || 'no asset'}`,
      state: dataMode ? (dataMode.toUpperCase() === 'PAPER' ? 'ready' : 'live') : 'bad',
      note: dataMode ? undefined : 'No market data is arriving.',
    },
    {
      name: 'Breaking news',
      detail: news?.ok ? `${news.headlines.length} headlines · ${news.market}` : news ? news.error ?? 'Unavailable' : 'Loading…',
      state: news ? (news.ok ? 'live' : 'bad') : 'off',
      note: news ? undefined : 'Fetching headlines for this instrument.',
    },
    {
      name: 'Market structure',
      detail: indicators ? `${indicators.structureBias} · swings ${money(indicators.lastSwingLow)}–${money(indicators.lastSwingHigh)}` : 'Waiting for candles',
      state: indicators ? 'live' : 'off',
      note: 'Deterministic swing, level and regime detection — not model output.',
    },
    {
      name: 'Technical indicators',
      detail: indicators ? `RSI ${indicators.rsi14.toFixed(1)} · ATR ${money(indicators.atr14, indicators.atr14 < 10 ? 4 : 2)}` : 'Waiting for candles',
      state: indicators ? 'live' : 'off',
    },
    {
      name: 'Tracker evaluation',
      detail: trackerCount ? `${trackerCount} condition${trackerCount === 1 ? '' : 's'} evaluated per candle` : 'No conditions recorded',
      state: trackerCount ? 'live' : 'ready',
    },
    {
      name: 'Agent skills',
      detail: skillCount ? `${skillCount} attached across ${members.length} agent${members.length === 1 ? '' : 's'}` : 'No skills attached',
      state: skillCount ? 'live' : 'ready',
    },
    {
      name: 'Order execution',
      detail: liveTrading ? `Live · ${provider === 'ctrader' ? 'cTrader' : 'PropDAO'} via Hyperliquid` : 'Off · this room is paper',
      state: liveTrading ? 'live' : 'off',
      note: liveTrading ? 'Real orders can be submitted. Every order is re-checked against live risk before it is sent.' : 'Enable live trading when creating the room to submit real orders.',
    },
  ];

  const labels = { live: 'Live', ready: 'Ready', off: 'Off', bad: 'Unavailable' };

  return (
    <div className="tr-tools">
      {tools.map(tool => (
        <div className="tr-tool" key={tool.name}>
          <span className={cx('tr-tool-dot', 'is-' + tool.state)} aria-hidden="true" />
          <div className="tr-tool-body">
            <div className="tr-tool-head">
              <span className="tr-tool-name">{tool.name}</span>
              <span className={cx('tr-tool-state', 'is-' + tool.state)}>{labels[tool.state]}</span>
            </div>
            <p className="tr-tool-detail">{tool.detail}</p>
            {tool.note && <p className="tr-tool-note">{tool.note}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

/* =========================================================================
   PANEL — Memory
   ========================================================================= */

/**
 * The agents' working context.
 *
 * Two layers, because the room has two: the deterministic indicators every
 * agent in the room is woken with (identical for all of them), and each
 * agent's own thesis — which is per-agent and diverges over time.
 */
function MemoryPanel({ members, indicators, asset }: { members: RoomMember[]; indicators: RoomIndicators | null; asset: string }) {
  return (
    <div className="tr-memory">
      <SectionLabel aside={<span className="tr-metrics-timeframe">{indicators ? 'Live' : 'Waiting'}</span>}>Working context</SectionLabel>
      {indicators ? (
        <>
          <div className="tr-metrics">
            <Metric label="RSI 14" value={indicators.rsi14.toFixed(1)} />
            <Metric label="EMA 20" value={money(indicators.ema20, indicators.ema20 < 10 ? 4 : 2)} />
            <Metric label="EMA 50" value={money(indicators.ema50, indicators.ema50 < 10 ? 4 : 2)} />
            <Metric label="ATR 14" value={money(indicators.atr14, indicators.atr14 < 10 ? 4 : 2)} />
          </div>
          <div className="tr-structure">
            <div className="tr-structure-head">
              <span>Structure</span>
              <span className={cx('tr-chip', BIAS_TONE[indicators.structureBias] ?? 'is-muted')}>{indicators.structureBias}</span>
            </div>
            <dl className="tr-kv">
              <Row label="Last higher high" value={money(indicators.lastSwingHigh)} />
              <Row label="Last lower low" value={money(indicators.lastSwingLow)} />
              <Row label="Retracement" value={indicators.retracementPct.toFixed(1) + '%'} />
              <Row label="Demand zone" value={`${money(indicators.demandZone.low)} – ${money(indicators.demandZone.high)}`} />
              <Row label="Supply zone" value={`${money(indicators.supplyZone.low)} – ${money(indicators.supplyZone.high)}`} />
            </dl>
          </div>
        </>
      ) : <PanelEmpty title="No market context yet" hint="Deterministic indicators appear as soon as candle history arrives." />}

      <SectionLabel>{members.length + ' agents'}</SectionLabel>
      {members.length === 0
        ? <PanelEmpty title="None" />
        : members.map(member => {
          const thesis = member.latestThesis;
          return (
            <article className="tr-memory-agent" key={member.id}>
              <header className="tr-memory-agent-head">
                <span className="tr-agent-name">{member.name}</span>
                {thesis && <span className={cx('tr-chip', BIAS_TONE[thesis.bias] ?? 'is-muted')}>{thesis.bias}</span>}
              </header>
              {thesis ? (
                <>
                  <p className="tr-memory-summary">{thesis.summary}</p>
                  <div className="tr-confidence" aria-label={`Confidence ${thesis.confidence} percent`}>
                    <span className="tr-confidence-bar"><i style={{ width: Math.max(0, Math.min(100, thesis.confidence)) + '%' }} /></span>
                    <span className="tr-confidence-value">{Math.round(thesis.confidence)}%</span>
                  </div>
                  {thesis.observationPlan && (
                    <div className="tr-memory-block">
                      <span className="tr-memory-block-label">Observation plan</span>
                      <p>{thesis.observationPlan}</p>
                    </div>
                  )}
                  {thesis.invalidation.length > 0 && (
                    <div className="tr-memory-block">
                      <span className="tr-memory-block-label">Invalidation</span>
                      <ul>{thesis.invalidation.map(item => <li key={item}>{item}</li>)}</ul>
                    </div>
                  )}
                  <div className="tr-memory-foot">
                    <span>{asset || thesis.market} · {thesis.relevantTimeframe}</span>
                    <span>{relativeTime(thesis.updatedAt)}</span>
                  </div>
                </>
              ) : <p className="tr-memory-summary is-empty">No thesis recorded yet.</p>}
            </article>
          );
        })}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="tr-metric"><span className="tr-metric-label">{label}</span><span className="tr-metric-value">{value}</span></div>;
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="tr-kv-row"><dt>{label}</dt><dd>{value}</dd></div>;
}

/* =========================================================================
   PANEL — Trades
   ========================================================================= */

function TradeRow({ trade, onOpen }: { trade: RoomTrade; onOpen: (trade: RoomTrade) => void }) {
  const long = /long|buy/i.test(trade.direction);
  const digits = trade.entry != null && trade.entry < 10 ? 4 : 2;
  return (
    <button type="button" className="tr-trade" onClick={() => onOpen(trade)}>
      <span className={cx('tr-trade-dir', long ? 'is-long' : 'is-short')}>{trade.direction}</span>
      <span className="tr-trade-market">{trade.market}</span>
      <span className="tr-trade-price">{money(trade.entry, digits)}</span>
      <span className={cx('tr-chip', 'is-muted')}>{trade.status}</span>
      <span className="tr-trade-agent">{trade.agentName}</span>
      <span className="tr-trade-time">{relativeTime(trade.createdAt)}</span>
    </button>
  );
}

function TradesPanel({ trades, onOpen }: { trades: RoomTrade[]; onOpen: (trade: RoomTrade) => void }) {
  if (trades.length === 0) {
    return <PanelEmpty title="None" hint="No trades have been proposed yet. Every signal an agent raises appears here with its full reasoning." />;
  }
  return (
    <div className="tr-trades">
      <div className="tr-trades-head" aria-hidden="true">
        <span>Side</span><span>Market</span><span>Entry</span><span>Status</span>
      </div>
      {trades.map(trade => <TradeRow key={trade.id} trade={trade} onOpen={onOpen} />)}
    </div>
  );
}

/* =========================================================================
   Trade detail modal
   ========================================================================= */

export function TradeModal({ trade, onClose }: { trade: RoomTrade; onClose: () => void }) {
  const [digits, setDigits] = useState(4);
  React.useEffect(() => { setDigits(trade.entry != null && trade.entry < 10 ? 4 : 2); }, [trade]);
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const long = /long|buy/i.test(trade.direction);

  return (
    <div className="tr-modal-backdrop" onClick={onClose} role="presentation">
      <div className="tr-modal" role="dialog" aria-modal="true" aria-label={`Trade detail · ${trade.market}`} onClick={event => event.stopPropagation()}>
        <header className="tr-modal-head">
          <div className="tr-modal-title">
            <span className={cx('tr-trade-dir', long ? 'is-long' : 'is-short')}>{trade.direction}</span>
            <span className="tr-modal-market">{trade.market}</span>
            <span className={cx('tr-chip', 'is-muted')}>{trade.status}</span>
            {trade.decision && <span className={cx('tr-chip', trade.decision === 'ACCEPTED' ? 'is-positive' : 'is-negative')}>{trade.decision}</span>}
          </div>
          <button type="button" className="tr-modal-close" onClick={onClose} aria-label="Close trade detail"><X size={15} strokeWidth={2.4} aria-hidden="true" /></button>
        </header>

        <div className="tr-modal-body">
          <dl className="tr-kv tr-kv-grid">
            <Row label="Entry" value={money(trade.entry, digits)} />
            <Row label="Stop loss" value={money(trade.stopLoss, digits)} />
            <Row label="Target" value={money(trade.takeProfit, digits)} />
            <Row label="Risk : reward" value={trade.riskReward ?? '—'} />
            <Row label="Confidence" value={Math.round(trade.confidence) + '%'} />
            <Row label="Order type" value={trade.orderType ?? '—'} />
          </dl>

          <ModalBlock label="Thesis"><p>{trade.thesis}</p></ModalBlock>
          <ModalBlock label="Rationale"><p>{trade.rationale}</p></ModalBlock>
          {trade.invalidation && <ModalBlock label="Invalidation"><p>{trade.invalidation}</p></ModalBlock>}
          {trade.confirmationRequired && <ModalBlock label="Confirmation required"><p>{trade.confirmationRequired}</p></ModalBlock>}
          {trade.contradictoryEvidence.length > 0 && (
            <ModalBlock label="Counter-evidence"><ul>{trade.contradictoryEvidence.map(item => <li key={item}>{item}</li>)}</ul></ModalBlock>
          )}
          {trade.supportingEvidence.length > 0 && (
            <ModalBlock label="Supporting evidence"><ul>{trade.supportingEvidence.map(item => <li key={item}>{item}</li>)}</ul></ModalBlock>
          )}
        </div>

        <footer className="tr-modal-foot">
          <span>{trade.agentName}</span>
          <span>Raised {relativeTime(trade.createdAt)}</span>
          {trade.decidedAt && <span>Decided {relativeTime(trade.decidedAt)}</span>}
          {trade.expiresAt && <span>Expires {relativeTime(trade.expiresAt)}</span>}
        </footer>
      </div>
    </div>
  );
}

function ModalBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="tr-modal-block"><span className="tr-modal-block-label">{label}</span><div className="tr-modal-block-body">{children}</div></div>;
}

/* =========================================================================
   Shell
   ========================================================================= */

export interface SidebarTabBadge { news?: number; trades?: number; trackers?: number }

export const TradeRoomSidebar: React.FC<{
  panel: RoomPanelId;
  onPanelChange: (panel: RoomPanelId) => void;
  /** Quote freshness — describes the panel content, so it lives in its header. */
  status: 'live' | 'stale' | 'unavailable';
  statusTitle: string;
  badges: SidebarTabBadge;
}> = ({ panel, onPanelChange, status, statusTitle, badges }) => {
  const active = ROOM_PANELS.find(entry => entry.id === panel) ?? ROOM_PANELS[0];
  const badgeFor = (id: RoomPanelId) => (id === 'news' ? badges.news : id === 'trades' ? badges.trades : id === 'trackers' ? badges.trackers : 0);

  return (
    <div className="trade-room-stream-header">
      <div className="tr-panel-titlebar">
        <h2 className="tr-panel-title">{active.label}</h2>
        <span className={'trade-room-identity-status is-' + status} title={statusTitle}>
          {status === 'live' ? 'Live' : status === 'stale' ? 'Stale' : 'No feed'}
        </span>
      </div>
      <div className="tr-panel-tabs" role="tablist" aria-label="Room panel">
        {ROOM_PANELS.map(entry => {
          const Icon = entry.icon;
          const badge = badgeFor(entry.id);
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              className="tr-panel-tab"
              aria-selected={entry.id === panel}
              aria-label={entry.label}
              title={entry.label}
              onClick={() => onPanelChange(entry.id)}
            >
              <Icon size={15} strokeWidth={2} />
              {badge > 0 && <span className="tr-panel-tab-badge" aria-hidden="true">{badge > 99 ? '99+' : badge}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export { NewsPanel, TrackersPanel, ToolsPanel, MemoryPanel, TradesPanel, cx, relativeTime, BIAS_TONE, money };