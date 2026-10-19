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
 *   Room Chat     — what is the room talking about right now?
 *   Breaking News — what moved the macro tape underneath them?
 *   Chat to Mentor — a private word with the room's leader
 *   Group Details — who runs this room, and what is it about?
 *   Connect Broker — which account am I trading this room with?
 *   Tools        — what can these agents even see and do?
 *
 * A trade log interleaved with market commentary is unreadable: the entries
 * have wildly different lifetimes (a headline is relevant for minutes, a
 * question in the room chat for an afternoon, a filled trade is permanent).
 * Splitting them by lifetime is what makes each panel scannable on its own
 * terms.
 *
 * Every panel is driven by real server state and renders an explicit empty or
 * unavailable state. Nothing here invents a value to fill a gap — a room
 * that has no messages says so, a news feed that failed says why.
 */

import React, { useMemo, useState } from 'react';
import {
  BrainCircuit, ChevronLeft, ExternalLink, Link2, ListOrdered, MessageCircle,
  MessagesSquare, Newspaper, Target, Users, Wrench, X, Zap, RefreshCw, Send,
  ShieldCheck, CheckCircle2, AlertCircle,
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
  sma20?: number; macd?: { macd: number; signal: number; histogram: number };
  bollingerBands20?: { middle: number; upper: number; lower: number; bandwidthPct: number };
  stochastic14?: { k: number; d: number }; vwap?: number | null;
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

export type RoomPanelId = 'chat' | 'news' | 'mentor' | 'details' | 'broker' | 'tools';

export const ROOM_PANELS: { id: RoomPanelId; label: string; icon: React.ComponentType<{ size?: number; strokeWidth?: number }> }[] = [
  { id: 'chat', label: 'Room Chat', icon: MessagesSquare },
  { id: 'news', label: 'Breaking News', icon: Newspaper },
  { id: 'mentor', label: 'Chat to Mentor', icon: MessageCircle },
  { id: 'details', label: 'Group Details', icon: Users },
  { id: 'broker', label: 'Connect Broker', icon: Link2 },
  { id: 'tools', label: 'Tools', icon: Wrench },
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

/** One label/value line, used by the run log and the room details. */
function Row({ label, value }: { label: string; value: string }) {
  return <div className="tr-kv-row"><dt>{label}</dt><dd>{value}</dd></div>;
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

function compactChatLine(value: string, maxLength = 170): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  const sentenceEnd = clean.slice(0, maxLength).lastIndexOf('. ');
  const cutoff = sentenceEnd >= Math.floor(maxLength * 0.55) ? sentenceEnd + 1 : maxLength - 1;
  return clean.slice(0, cutoff).trimEnd() + '…';
}

const AGENT_NAME_COLORS = ['#7c9cff', '#52d6a2', '#f0b35a', '#e58bc4', '#63c7e8', '#b7a0ff', '#f28f75'];
function agentNameColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return AGENT_NAME_COLORS[Math.abs(hash) % AGENT_NAME_COLORS.length];
}

function localMessageTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '—';
}

/* =========================================================================
   PANEL — Room Chat
   The shared conversation of the room.

   A room is a human-led community, so the feed has two kinds of entry:
   what the PEOPLE in the room said, and what the room's agents did. Both are
   attributed and timestamped the same way, because both are part of the same
   conversation.

   A message written by a person is not a drill-down, so it is rendered as a
   static card; an agent's run still opens that run's real activity ledger.
   ========================================================================= */

/** One message written by a member of the room. */
export interface RoomChatMessage {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
}

const OUTCOME_LABEL: Record<RoomRun['outcome'], string> = {
  review: 'Market review', proposal: 'Proposal', no_trade: 'No trade',
  failed: 'Failed', running: 'Running',
};

/** Human label for what an agent's run ended up doing. */
export function runOutcomeLabel(outcome: RoomRun['outcome']): string {
  return OUTCOME_LABEL[outcome] ?? outcome;
}

export function RoomChatPanel({
  messages, runs, onOpenRun, canRun, onRun, running,
  canPost, onSend, sending, onJoin, joining, joinError, viewerId, participantCount, signedIn,
}: {
  messages: RoomChatMessage[];
  runs: RoomRun[];
  onOpenRun: (run: RoomRun) => void;
  canRun: boolean;
  onRun: () => void;
  running: boolean;
  canPost: boolean;
  onSend: (content: string) => void;
  sending: boolean;
  onJoin: () => void;
  joining: boolean;
  joinError: string;
  viewerId: string | null;
  participantCount: number;
  signedIn: boolean;
}) {
  const [draft, setDraft] = useState('');

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    onSend(content);
    setDraft('');
  };

  /**
   * One feed, newest first. The agent's run keeps its own card because it
   * opens a real record; a person's message is a statement, not a run.
   */
  const feed = useMemo(() => {
    const entries: ({ kind: 'message'; at: number; message: RoomChatMessage } | { kind: 'run'; at: number; run: RoomRun })[] = [];
    for (const message of messages) entries.push({ kind: 'message', at: Date.parse(message.createdAt), message });
    for (const run of runs) entries.push({ kind: 'run', at: Date.parse(run.at), run });
    return entries.sort((left, right) => right.at - left.at);
  }, [messages, runs]);

  return (
    <>
      <div className="tr-chat-status" aria-live="polite">
        <span className="tr-chat-status-left"><span className={'tr-chat-live-dot' + (running ? ' is-working' : '')} /><span>ROOM CHAT</span></span>
        <span className="tr-chat-status-right">
          {participantCount > 0 ? `${participantCount} in the room` : 'No members yet'}
        </span>
      </div>

      {canPost ? (
        <form className="tr-composer" onSubmit={submit}>
          <textarea
            className="tr-composer-input"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            maxLength={2000}
            rows={2}
            placeholder="Share what the market is doing, or ask the room…"
            aria-label="Message the room"
          />
          <div className="tr-composer-foot">
            <span className="tr-composer-count">{draft.trim().length}/2000</span>
            <button type="submit" className="tr-composer-send" disabled={sending || !draft.trim()}>
              <Send size={12} strokeWidth={2.4} aria-hidden="true" />
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      ) : (
        <div className="tr-composer is-locked">
          <p className="tr-composer-locked-text">
            {joinError || (signedIn
              ? 'Join this room to post in its conversation.'
              : 'Sign in to join this room and post in its conversation.')}
          </p>
          <button type="button" className="tr-composer-send" onClick={onJoin} disabled={joining}>
            {joining ? 'Joining…' : signedIn ? 'Join room' : 'Sign in'}
          </button>
        </div>
      )}

      {canRun && (
        <button type="button" className="tr-chat-run" onClick={onRun} disabled={running}>
          <Zap size={13} strokeWidth={2.4} aria-hidden="true" />
          {running ? 'Agents working…' : 'Run the team'}
        </button>
      )}

      {feed.length === 0 ? (
        <PanelEmpty
          title="No messages yet"
          hint="Start the conversation — share an idea, ask a question, or post what you are watching."
        />
      ) : (
        <div className="tr-chat">
          {feed.map(entry => {
            if (entry.kind === 'message') {
              const { message } = entry;
              const own = viewerId != null && message.authorId === viewerId;
              return (
                <article
                  key={message.id}
                  className={'tr-chat-msg is-static' + (own ? ' is-self' : '')}
                >
                  <div className="tr-chat-msg-head">
                    <span className="tr-agent-avatar" aria-hidden="true">
                      {message.authorName.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="tr-agent-name">{message.authorName}</span>
                    <span className="tr-chat-kind">Member</span>
                    <time dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>
                      <span className="tr-chat-clock">{localMessageTime(message.createdAt)}</span>
                      <span className="tr-chat-relative">{relativeTime(message.createdAt)}</span>
                    </time>
                  </div>
                  <p className="tr-chat-summary is-body">{message.content}</p>
                </article>
              );
            }

            const run = entry.run;
            const tone = run.bias ? (BIAS_TONE[run.bias] ?? 'is-muted') : null;
            return (
              <button
                type="button"
                key={run.workflowId}
                className={'tr-chat-msg' + (run.outcome === 'failed' ? ' is-failed' : '') + ' is-agent'}
                onClick={() => onOpenRun(run)}
              >
                <div className="tr-chat-msg-head">
                  <span className={'tr-agent-pulse' + (run.outcome === 'running' ? ' is-working' : '')} aria-hidden="true" />
                  <span className="tr-agent-name" style={{ color: agentNameColor(run.agentName) }}>{run.agentName}</span>
                  <span className="tr-chat-kind is-agent">Agent</span>
                  <time dateTime={run.at} title={new Date(run.at).toLocaleString()}><span className="tr-chat-clock">{localMessageTime(run.at)}</span><span className="tr-chat-relative">{relativeTime(run.at)}</span></time>
                </div>
                <div className="tr-chat-msg-title">
                  {tone && <span className={'tr-chip ' + tone}>{run.bias}</span>}
                  <span className="tr-chat-headline">{run.headline}</span>
                </div>
                {run.summary && <p className="tr-chat-summary">{compactChatLine(run.summary)}</p>}
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
      )}
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

function NewsPanel({ news, loading, onRefresh }: { news: RoomNewsPayload | null; loading: boolean; onRefresh: () => void }) {
  const refreshButton = <button type="button" className="tr-news-refresh" onClick={onRefresh} disabled={loading} aria-label="Refresh news" title="Refresh news"><RefreshCw size={12} className={loading ? 'is-spinning' : ''} /><span>{loading ? 'Updating…' : 'Refresh'}</span></button>;
  const meta = <div className="tr-news-meta"><span className="tr-news-market">{news?.market ?? 'BREAKING NEWS'}</span>{news && <span>{relativeTime(news.fetchedAt)}</span>}{refreshButton}</div>;
  if (loading && !news) return <><div className="tr-news">{meta}<PanelEmpty title="Researching headlines…" /></div></>;
  if (!news) return <div className="tr-news">{meta}<PanelEmpty title="News unavailable" tone="bad" /></div>;
  if (!news.ok && news.headlines.length === 0) return <div className="tr-news">{meta}<PanelEmpty title="No current headlines" tone="bad" hint={news.error ?? 'The news feed returned nothing for this instrument.'} /></div>;
  if (news.headlines.length === 0) return <div className="tr-news">{meta}<PanelEmpty title="No current headlines" hint={`Nothing published for ${news.market} in the last three days.`} /></div>;

  return (
    <div className="tr-news">
      <div className="tr-news-meta">
        <span className="tr-news-market">{news.market}</span>
        <span>{relativeTime(news.fetchedAt)}</span>
        {refreshButton}
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
      detail: indicators ? [
        `RSI(14) ${indicators.rsi14.toFixed(1)}`,
        `EMA(20/50) ${money(indicators.ema20)} / ${money(indicators.ema50)}`,
        `ATR(14) ${money(indicators.atr14, indicators.atr14 < 10 ? 4 : 2)}`,
        indicators.macd ? `MACD ${indicators.macd.macd.toFixed(4)}` : '',
        indicators.stochastic14 ? `Stoch ${indicators.stochastic14.k.toFixed(1)}/${indicators.stochastic14.d.toFixed(1)}` : '',
        indicators.bollingerBands20 ? `BB ${money(indicators.bollingerBands20.lower)}–${money(indicators.bollingerBands20.upper)}` : '',
        indicators.vwap != null && indicators.vwap > 0 ? `VWAP ${money(indicators.vwap)}` : '',
      ].filter(Boolean).join(' · ') : 'Waiting for candles',
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
   PANEL — Chat to Mentor
   A private line between one member and the room's leader.

   The leader sees a list of the conversations their members have started; a
   member sees their own conversation with the leader. These messages are
   never mixed into the room conversation.
   ========================================================================= */

export interface MentorThreadSummary {
  memberId: string;
  memberName: string;
  lastMessageAt: string | null;
  lastMessage: string | null;
}

export function MentorChatPanel({
  threads, activeMemberId, onSelectThread, messages, counterpartName, isLeader,
  onSend, sending, canPost, onJoin, joining, joinError, viewerId, loading, signedIn,
}: {
  threads: MentorThreadSummary[];
  activeMemberId: string | null;
  onSelectThread: (memberId: string) => void;
  messages: RoomChatMessage[];
  counterpartName: string;
  isLeader: boolean;
  onSend: (content: string) => void;
  sending: boolean;
  canPost: boolean;
  onJoin: () => void;
  joining: boolean;
  joinError: string;
  viewerId: string | null;
  loading: boolean;
  signedIn: boolean;
}) {
  const [draft, setDraft] = useState('');

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    onSend(content);
    setDraft('');
  };

  return (
    <>
      <div className="tr-chat-status" aria-live="polite">
        <span className="tr-chat-status-left"><MessageCircle size={12} strokeWidth={2.2} aria-hidden="true" /><span>PRIVATE</span></span>
        <span className="tr-chat-status-right">
          {isLeader ? 'Only you and the member can read this' : `You and ${counterpartName}`}
        </span>
      </div>

      {isLeader && threads.length > 0 && (
        <div className="tr-mentor-threads" role="list" aria-label="Member conversations">
          {threads.map(thread => (
            <button
              type="button"
              role="listitem"
              key={thread.memberId}
              className={'tr-mentor-thread' + (thread.memberId === activeMemberId ? ' is-active' : '')}
              onClick={() => onSelectThread(thread.memberId)}
            >
              <span className="tr-mentor-thread-name">{thread.memberName}</span>
              <span className="tr-mentor-thread-last">
                {thread.lastMessage ? thread.lastMessage.slice(0, 60) : 'No messages yet'}
              </span>
              <span className="tr-mentor-thread-time">
                {thread.lastMessageAt ? relativeTime(thread.lastMessageAt) : ''}
              </span>
            </button>
          ))}
        </div>
      )}

      {canPost && !(isLeader && !activeMemberId) ? (
        <form className="tr-composer" onSubmit={submit}>
          <textarea
            className="tr-composer-input"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            maxLength={2000}
            rows={2}
            placeholder={isLeader ? 'Write to this member…' : `Ask ${counterpartName} a question…`}
            aria-label="Private message"
          />
          <div className="tr-composer-foot">
            <span className="tr-composer-count">{draft.trim().length}/2000</span>
            <button type="submit" className="tr-composer-send" disabled={sending || !draft.trim()}>
              <Send size={12} strokeWidth={2.4} aria-hidden="true" />
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      ) : canPost ? (
        <div className="tr-composer is-locked">
          <p className="tr-composer-locked-text">
            {joinError || 'Choose the conversation you want to reply to.'}
          </p>
        </div>
      ) : (
        <div className="tr-composer is-locked">
          <p className="tr-composer-locked-text">
            {joinError || (signedIn
              ? 'Join this room to write to its leader privately.'
              : 'Sign in and join this room to write to its leader privately.')}
          </p>
          <button type="button" className="tr-composer-send" onClick={onJoin} disabled={joining}>
            {joining ? 'Joining…' : signedIn ? 'Join room' : 'Sign in'}
          </button>
        </div>
      )}

      {loading ? (
        <PanelEmpty title="Loading conversation…" />
      ) : messages.length === 0 ? (
        <PanelEmpty
          title="No private messages yet"
          hint={isLeader
            ? 'When a member writes to you, the conversation appears here.'
            : `Start a private conversation with ${counterpartName}.`}
        />
      ) : (
        <div className="tr-chat">
          {messages.map(message => {
            const own = viewerId != null && message.authorId === viewerId;
            return (
              <article key={message.id} className={'tr-chat-msg is-static' + (own ? ' is-self' : '')}>
                <div className="tr-chat-msg-head">
                  <span className="tr-agent-avatar" aria-hidden="true">
                    {message.authorName.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="tr-agent-name">{message.authorName}</span>
                  <span className="tr-chat-kind is-private">Private</span>
                  <time dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>
                    <span className="tr-chat-clock">{localMessageTime(message.createdAt)}</span>
                    <span className="tr-chat-relative">{relativeTime(message.createdAt)}</span>
                  </time>
                </div>
                <p className="tr-chat-summary is-body">{message.content}</p>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}

/* =========================================================================
   PANEL — Group Details
   What this room actually is, said by the room's own records.

   Nothing here is estimated: the name, the leader, the visibility and the
   roster all come from the server's records about this room.
   ========================================================================= */

export interface RoomGroupDetails {
  id: string;
  name: string;
  description: string | null;
  visibility: 'PUBLIC' | 'PRIVATE';
  status: string;
  market: string | null;
  provider: string | null;
  environment: string;
  agentCount: number;
  createdAt: string;
  leader: { id: string; displayName: string };
}

export interface RoomGroupMember {
  id: string;
  displayName: string;
  role: 'LEADER' | 'MEMBER';
  joinedAt: string;
}

export function GroupDetailsPanel({
  room, members, memberCount, isMember, onJoin, joining, joinError,
}: {
  room: RoomGroupDetails | null;
  members: RoomGroupMember[];
  memberCount: number;
  isMember: boolean;
  onJoin: () => void;
  joining: boolean;
  joinError: string;
}) {
  if (!room) return <PanelEmpty title="Loading room details…" />;

  const marketLabel = room.market
    ? `${room.market}${room.provider ? ' · ' + room.provider.toUpperCase() : ''}`
    : room.agentCount > 0 ? 'Market not set' : 'No market configured';

  return (
    <div className="tr-details">
      <SectionLabel>Room</SectionLabel>
      <div className="tr-details-card">
        <h3 className="tr-details-name">{room.name}</h3>
        <div className="tr-details-tags">
          <span className="tr-chip is-muted">{room.visibility === 'PUBLIC' ? 'Public room' : 'Private room'}</span>
          <span className="tr-chip is-muted">{room.status}</span>
          <span className="tr-chip is-muted">{room.environment}</span>
        </div>
        {room.description
          ? <p className="tr-details-description">{room.description}</p>
          : <p className="tr-details-description is-empty">
              {isMember
                ? 'The leader has not written a description for this room yet.'
                : 'Join this room to read its description.'}
            </p>}
      </div>

      <SectionLabel>Leader</SectionLabel>
      <div className="tr-details-card">
        <div className="tr-details-row">
          <span className="tr-details-row-label">Mentor</span>
          <span className="tr-details-row-value">{room.leader.displayName}</span>
        </div>
        <div className="tr-details-row">
          <span className="tr-details-row-label">Members</span>
          <span className="tr-details-row-value">{memberCount}</span>
        </div>
        <div className="tr-details-row">
          <span className="tr-details-row-label">Market</span>
          <span className="tr-details-row-value">{marketLabel}</span>
        </div>
        <div className="tr-details-row">
          <span className="tr-details-row-label">Trading agents</span>
          <span className="tr-details-row-value">{room.agentCount}</span>
        </div>
        <div className="tr-details-row">
          <span className="tr-details-row-label">Created</span>
          <span className="tr-details-row-value">{new Date(room.createdAt).toLocaleDateString()}</span>
        </div>
      </div>

      {members.length > 0 && (
        <>
          <SectionLabel>Who is here</SectionLabel>
          <div className="tr-details-roster">
            {members.map(member => (
              <div className="tr-details-member" key={member.id}>
                <span className="tr-agent-avatar" aria-hidden="true">{member.displayName.slice(0, 2).toUpperCase()}</span>
                <span className="tr-details-member-name">{member.displayName}</span>
                <span className="tr-chat-kind">{member.role === 'LEADER' ? 'Leader' : 'Member'}</span>
                <span className="tr-details-member-since">{relativeTime(member.joinedAt)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {!isMember && (
        <button type="button" className="tr-chat-run" onClick={onJoin} disabled={joining}>
          <Users size={13} strokeWidth={2.4} aria-hidden="true" />
          {joining ? 'Joining…' : 'Join this room'}
        </button>
      )}
      {joinError && <p className="tr-panel-error" role="alert">{joinError}</p>}
    </div>
  );
}

/* =========================================================================
   PANEL — Connect Broker
   The member's OWN trading account, connected in Settings.

   This panel never shows a credential and never claims an account is
   connected unless the server verified it. The connection itself happens in
   the existing Settings screen, which owns the OAuth flow and the vault.
   ========================================================================= */

export interface BrokerConnectionState {
  cTrader: { configured: boolean; connected: boolean; selectedAccountId: string | null; selectedAccountIsLive: boolean } | null;
  propDao: { configured: boolean; connected: boolean } | null;
}

export function ConnectBrokerPanel({
  state, loading, error, onOpenSettings,
}: {
  state: BrokerConnectionState;
  loading: boolean;
  error: string;
  onOpenSettings: (section: 'ctrader' | 'propdao') => void;
}) {
  if (loading) return <PanelEmpty title="Checking your connections…" />;

  const cTrader = state.cTrader;
  const propDao = state.propDao;

  return (
    <div className="tr-broker">
      <p className="tr-panel-disclaimer">
        Connect the account you want to trade this room with. Your connection
        belongs to you — it is never shared with the room leader, and no
        credential is ever shown in the room.
      </p>

      <article className={'tr-broker-card' + (cTrader?.connected ? ' is-connected' : '')}>
        <div className="tr-broker-head">
          <span className="tr-broker-name">cTrader</span>
          {cTrader?.connected
            ? <span className="tr-broker-state is-connected"><CheckCircle2 size={12} /> Connected</span>
            : <span className="tr-broker-state"><AlertCircle size={12} /> Not connected</span>}
        </div>
        <p className="tr-broker-detail">
          {cTrader?.connected
            ? cTrader.selectedAccountId
              ? `Account ${cTrader.selectedAccountId}${cTrader.selectedAccountIsLive ? ' · LIVE' : ' · DEMO'}`
              : 'Authorized, but no trading account is selected yet.'
            : cTrader?.configured
              ? 'Not authorized on this account yet. Connect it to use cTrader prices and orders.'
              : 'cTrader is not configured on this deployment. Ask the operator to add the cTrader Open API credentials.'}
        </p>
        <button type="button" className="tr-broker-action" onClick={() => onOpenSettings('ctrader')}>
          {cTrader?.connected ? 'Manage cTrader account' : 'Connect cTrader'}
        </button>
      </article>

      <article className={'tr-broker-card' + (propDao?.connected ? ' is-connected' : '')}>
        <div className="tr-broker-head">
          <span className="tr-broker-name">PropDAO</span>
          {propDao?.connected
            ? <span className="tr-broker-state is-connected"><CheckCircle2 size={12} /> Connected</span>
            : <span className="tr-broker-state"><AlertCircle size={12} /> Not connected</span>}
        </div>
        <p className="tr-broker-detail">
          {propDao?.connected
            ? 'Your PropDAO key is stored and verified.'
            : propDao?.configured
              ? 'A key is saved but could not be verified. Open the settings to re-check it.'
              : 'No PropDAO key is saved on this account yet. Add one to connect a prop-firm account.'}
        </p>
        <button type="button" className="tr-broker-action" onClick={() => onOpenSettings('propdao')}>
          {propDao?.connected ? 'Manage PropDAO connection' : 'Connect PropDAO'}
        </button>
      </article>

      {error && <p className="tr-panel-error" role="alert">{error}</p>}
    </div>
  );
}

/* =========================================================================
   Shell
   ========================================================================= */

export interface SidebarTabBadge { news?: number; messages?: number }

export const TradeRoomSidebar: React.FC<{
  panel: RoomPanelId;
  onPanelChange: (panel: RoomPanelId) => void;
  /** Quote freshness — describes the panel content, so it lives in its header. */
  status: 'live' | 'stale' | 'unavailable';
  statusTitle: string;
  badges: SidebarTabBadge;
}> = ({ panel, onPanelChange, status, statusTitle, badges }) => {
  const active = ROOM_PANELS.find(entry => entry.id === panel) ?? ROOM_PANELS[0];
  const badgeFor = (id: RoomPanelId) => (id === 'news' ? badges.news : id === 'chat' ? badges.messages : 0);

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

export { NewsPanel, ToolsPanel, cx, relativeTime, BIAS_TONE, money };