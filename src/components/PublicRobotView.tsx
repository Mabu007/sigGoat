import React, { useCallback, useEffect, useState } from 'react';
import { Bot, LoaderCircle, LockKeyhole, MessageCircle, Play, Send } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { TradingViewLightweightChart } from './TradingViewLightweightChart';
import type { Candle, MarketQuote } from '../types';

type Robot = {
  slug: string; name: string; description: string; markets: string[];
  status: string; creatorName: string; mode: 'PAPER';
  latestThesis: null | { market: string; bias: string; summary: string; confidence?: number; updatedAt: string };
  signals: Array<{ market: string; direction: string; status: string; entry?: number; stopLoss?: number; takeProfit?: number; thesis: string; rationale: string; createdAt: string }>;
  activities?: Array<{ id: string; type: string; stage: string; at: string; details?: Record<string, string | number | boolean | null> }>;
};
type Membership = { joinedAt: string; activatedAt: string | null; mode: 'PAPER' } | null;
async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || body?.message || 'Request failed (' + response.status + ').');
  return body as T;
}

export function PublicRobotView({ slug }: { slug: string }) {
  const { currentUser, authMode, getApiAuthHeaders, loginWithGoogle, signupWithEmail, loginWithEmail } = useAuth();
  const [robot, setRobot] = useState<Robot | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [marketQuote, setMarketQuote] = useState<MarketQuote | null>(null);
  const [marketProvider, setMarketProvider] = useState('Unknown');
  const [marketDataMode, setMarketDataMode] = useState('unknown');
  const [marketError, setMarketError] = useState('');
  const [marketUpdatedAt, setMarketUpdatedAt] = useState<number | null>(null);
  const [joined, setJoined] = useState(false);
  const [membership, setMembership] = useState<Membership>(null);
  const [propDaoConnected, setPropDaoConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'robot'; text: string }>>([]);
  const [propDaoKey, setPropDaoKey] = useState('');
  const [showPropDao, setShowPropDao] = useState(false);
  const [error, setError] = useState('');
  const [authChoice, setAuthChoice] = useState<'signin' | 'signup'>('signup');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');

  const api = useCallback(async <T,>(path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (init.body) headers.set('Content-Type', 'application/json');
    for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);
    return responseJson<T>(await fetch(path, { ...init, headers }));
  }, [getApiAuthHeaders]);

  useEffect(() => {
    let cancelled = false;
    let firstLoad = true;
    const refreshRoom = async () => {
      try {
        const data = await responseJson<{ robot: Robot }>(await fetch('/api/robots/' + encodeURIComponent(slug), { headers: { Accept: 'application/json' }, cache: 'no-store' }));
        if (!cancelled) { setRobot(data.robot); setError(''); }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load this room.');
      } finally {
        if (!cancelled && firstLoad) { setLoading(false); firstLoad = false; }
      }
    };
    void refreshRoom();
    const interval = window.setInterval(() => void refreshRoom(), 15000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [slug]);

  const marketSymbol = robot?.latestThesis?.market || robot?.markets?.[0] || '';
  useEffect(() => {
    if (!marketSymbol) return;
    let cancelled = false;
    const refreshMarket = async () => {
      try {
        const response = await fetch('/api/robots/' + encodeURIComponent(slug) + '/market?symbol=' + encodeURIComponent(marketSymbol) + '&timeframe=1h&count=120', {
          headers: { Accept: 'application/json' }, cache: 'no-store',
        });
        const marketBody = await responseJson<{ quotes: MarketQuote[]; candles: Candle[]; provider?: string; dataMode?: string; fetchedAt?: string }>(response);
        if (cancelled) return;
        const quote = marketBody.quotes.find(item => item.symbol === marketSymbol) ?? marketBody.quotes[0] ?? null;
        setMarketQuote(quote);
        setCandles(Array.isArray(marketBody.candles) ? marketBody.candles : []);
        setMarketProvider(marketBody.provider || 'Provider not reported');
        setMarketDataMode(marketBody.dataMode || 'unknown');
        setMarketUpdatedAt(quote?.timestamp ?? null);
        setMarketError(quote || marketBody.candles?.length ? '' : 'The room provider returned no quote or candle data for this market.');
      } catch (err) {
        if (!cancelled) setMarketError(err instanceof Error ? err.message : 'Market data unavailable.');
      }
    };
    void refreshMarket();
    const interval = window.setInterval(() => void refreshMarket(), 15000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [marketSymbol, slug]);

  useEffect(() => {
    if (!robot) return;
    const previousTitle = document.title;
    const icon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    const previousIcon = icon?.href;
    document.title = robot.name;
    if (icon) {
      icon.type = 'image/svg+xml';
      icon.href = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%23080a0f'/%3E%3Cpath d='M18 22h28v20H18z' fill='%23c4b5fd'/%3E%3Ccircle cx='26' cy='30' r='3' fill='%23080a0f'/%3E%3Ccircle cx='38' cy='30' r='3' fill='%23080a0f'/%3E%3Cpath d='M25 37h14' stroke='%23080a0f' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E";
    }
    return () => { document.title = previousTitle; if (icon && previousIcon) icon.href = previousIcon; };
  }, [robot]);

  useEffect(() => {
    if (!currentUser && authMode !== 'dev') return;
    let cancelled = false;
    void api<{ joined: boolean; membership: Membership; propDaoKeyConfigured: boolean }>('/api/robots/' + encodeURIComponent(slug) + '/me')
      .then(data => { if (!cancelled) { setJoined(data.joined); setMembership(data.membership); setPropDaoConnected(data.propDaoKeyConfigured); } })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [api, currentUser, authMode, slug]);

  const authenticate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!authEmail.includes('@') || authPassword.length < 8) {
      setError('Enter a valid email and a password of at least 8 characters.');
      return;
    }
    setBusy(true); setError('');
    try {
      if (authChoice === 'signup') await signupWithEmail(authEmail.trim(), authPassword);
      else await loginWithEmail(authEmail.trim(), authPassword);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally { setBusy(false); }
  };
  const authenticateGoogle = async () => {
    setBusy(true); setError('');
    try { await loginWithGoogle(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Google sign-in failed.'); }
    finally { setBusy(false); }
  };

  const join = async () => {
    setBusy(true); setError('');
    try {
      const data = await api<{ joined: boolean; membership: Membership }>('/api/robots/' + encodeURIComponent(slug) + '/join', { method: 'POST', body: '{}' });
      setJoined(data.joined); setMembership(data.membership);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not join this robot.'); }
    finally { setBusy(false); }
  };
  const activate = async () => {
    setBusy(true); setError('');
    try {
      await api('/api/robots/' + encodeURIComponent(slug) + '/activate', { method: 'POST', body: '{}' });
      setMembership(previous => ({ joinedAt: previous?.joinedAt ?? new Date().toISOString(), activatedAt: previous?.activatedAt ?? new Date().toISOString(), mode: 'PAPER' }));
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not activate this robot.'); }
    finally { setBusy(false); }
  };
  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text || busy) return;
    setQuestion(''); setMessages(previous => [...previous, { role: 'user', text }]); setBusy(true); setError('');
    try {
      const data = await api<{ answer: string }>('/api/robots/' + encodeURIComponent(slug) + '/chat', { method: 'POST', body: JSON.stringify({ question: text }) });
      setMessages(previous => [...previous, { role: 'robot', text: data.answer }]);
    } catch (err) { setError(err instanceof Error ? err.message : 'The robot could not answer.'); }
    finally { setBusy(false); }
  };
  const savePropDaoKey = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!propDaoKey.trim()) return;
    setBusy(true); setError('');
    try {
      const data = await api<{ propDaoKeyConfigured?: boolean }>('/api/settings/keys', { method: 'POST', body: JSON.stringify({ propDaoApiKey: propDaoKey.trim() }) });
      setPropDaoConnected(Boolean(data.propDaoKeyConfigured ?? true)); setPropDaoKey(''); setShowPropDao(false);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save the PropDAO key.'); }
    finally { setBusy(false); }
  };

  const signedIn = Boolean(currentUser) || authMode === 'dev';
  if (loading) return <div className="min-h-screen bg-[#080a0f] text-white flex items-center justify-center"><LoaderCircle className="h-5 w-5 animate-spin" /><span className="ml-3 text-sm text-white/60">Loading robot…</span></div>;
  if (!robot) return <div className="min-h-screen bg-[#080a0f] text-white flex items-center justify-center px-6"><div className="max-w-md text-center"><Bot className="mx-auto h-10 w-10 text-violet-300" /><h1 className="mt-4 text-xl font-bold">Robot unavailable</h1><p className="mt-2 text-sm text-white/60">{error || 'This link may have been unpublished or removed.'}</p></div></div>;

  return <main className="min-h-screen bg-[#080a0f] text-white"><div className="mx-auto max-w-4xl px-5 py-8 sm:px-8 sm:py-12">
    <header className="flex items-start justify-between gap-4 border-b border-white/10 pb-6"><div className="flex min-w-0 items-start gap-3"><div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-violet-300/20 bg-violet-300/10"><Bot className="h-6 w-6 text-violet-200" /></div><div><p className="text-[10px] uppercase tracking-[.22em] text-white/40">AI Trading Room</p><h1 className="mt-1 break-words text-2xl font-black sm:text-3xl">{robot.name}</h1><p className="mt-2 text-sm leading-6 text-white/60">{robot.description}</p><p className="mt-2 text-xs text-white/35">Created by {robot.creatorName}</p></div></div><span className="shrink-0 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1.5 text-[10px] font-bold uppercase text-emerald-200">Paper mode</span></header>
    <section className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(260px,.8fr)]">
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[.025] p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-[10px] font-bold uppercase tracking-wider text-violet-200">Market stage</p><h2 className="mt-1 text-lg font-bold">{marketSymbol || 'No market configured'}</h2></div>
          <div className="text-right"><p className="text-xs font-semibold">{marketQuote ? marketQuote.mid.toLocaleString(undefined, { maximumFractionDigits: 8 }) : 'No current quote'}</p><p className="mt-1 text-[10px] text-white/40">{marketQuote ? 'Bid ' + marketQuote.bid + ' · Ask ' + marketQuote.ask : 'Waiting for provider data'}</p></div>
        </div>
        {candles.length > 0 ? <div className="mt-4 h-[360px]"><TradingViewLightweightChart candles={candles} activeQuote={marketQuote} timeframe="1h" symbol={marketSymbol} digits={marketSymbol.includes('BTC') ? 1 : 5} /></div> : <div className="mt-4 flex h-[240px] items-center justify-center rounded-xl border border-dashed border-white/10 px-5 text-center text-sm text-white/40">{marketError || 'No historical candles are available from the selected provider for this instrument.'}</div>}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-3 text-[10px] text-white/40">
          <span>Market data provider: <strong className="text-white/70">{marketProvider}</strong> · {marketDataMode}</span>
          <span>{marketUpdatedAt ? 'Quote timestamp ' + new Date(marketUpdatedAt).toLocaleTimeString() : 'Quote timestamp unavailable'}</span>
        </div>
        {marketError && candles.length > 0 && <p className="mt-2 text-xs text-amber-200/80">{marketError}</p>}
      </div>
      <aside className="space-y-3">
        <div className="rounded-2xl border border-white/10 bg-white/[.025] p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-violet-200">Live State HUD</p>
          <div className="mt-3 space-y-3 text-xs">
            <div className="flex justify-between gap-3"><span className="text-white/45">Team runtime</span><strong>{robot.status}</strong></div>
            <div className="flex justify-between gap-3"><span className="text-white/45">Trading mode</span><strong>Paper</strong></div>
            <div className="flex justify-between gap-3"><span className="text-white/45">Market freshness</span><strong className={marketQuote && Date.now() - marketQuote.timestamp <= 30000 ? 'text-emerald-200' : 'text-amber-200'}>{marketQuote ? (Date.now() - marketQuote.timestamp <= 30000 ? 'Recent quote' : 'Stale quote') : 'Unavailable'}</strong></div>
            <div className="flex justify-between gap-3"><span className="text-white/45">Candles loaded</span><strong>{candles.length || 'None'}</strong></div>
            <div className="flex justify-between gap-3"><span className="text-white/45">Latest workflow</span><strong>{robot.activities?.[0]?.stage || 'No recorded workflow'}</strong></div>
            <div className="flex justify-between gap-3"><span className="text-white/45">Execution</span><strong>{robot.activities?.some(item => item.type === 'EXECUTION_SUBMITTED') ? 'Submission recorded' : robot.activities?.some(item => item.type === 'EXECUTION_FAILED') ? 'Failure recorded' : 'No submission recorded'}</strong></div>
          </div>
          <p className="mt-3 border-t border-white/10 pt-3 text-[10px] leading-5 text-white/35">The HUD reflects the last persisted room record and provider response. Refreshes poll the server; they are not a guarantee of continuous streaming.</p>
        </div>
        {robot.latestThesis && <div className="rounded-2xl border border-violet-300/15 bg-violet-300/[.04] p-4"><p className="text-[10px] font-bold uppercase tracking-wider text-violet-200">Current recorded thesis</p><p className="mt-2 text-sm font-semibold">{robot.latestThesis.bias} · {robot.latestThesis.market}</p><p className="mt-2 text-xs leading-5 text-white/60">{robot.latestThesis.summary}</p><p className="mt-2 text-[10px] text-white/35">Recorded {new Date(robot.latestThesis.updatedAt).toLocaleString()}</p></div>}
      </aside>
    </section>
    <section className="mt-5 rounded-2xl border border-white/10 bg-white/[.025] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-bold">Recorded team activity</h2><p className="mt-1 text-xs text-white/40">Persisted workflow ledger events · refreshes every 15 seconds</p></div><span className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-white/45">{robot.activities?.length ?? 0} records</span></div>
      {robot.activities?.length ? <div className="mt-4 space-y-2">{robot.activities.map(item => <article key={item.id} className="flex gap-3 rounded-xl border border-white/[.07] bg-black/10 p-3"><span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-violet-200/80" /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold">{item.type.replaceAll('_', ' ')}</p><time className="text-[10px] text-white/35">{new Date(item.at).toLocaleString()}</time></div><p className="mt-1 text-[11px] text-white/45">Stage: {item.stage}{item.details?.provider ? ' · Provider: ' + item.details.provider : ''}{item.details?.decision ? ' · Decision: ' + item.details.decision : ''}{item.details?.orderId ? ' · Order: ' + item.details.orderId : ''}</p></div></article>)}</div> : <p className="mt-4 text-sm text-white/40">No workflow activity has been recorded for this trader yet. Nothing is inferred or simulated.</p>}
    </section>
    <section className="grid gap-3 py-5 sm:grid-cols-3"><div className="rounded-2xl border border-white/10 bg-white/[.025] p-4"><p className="text-[10px] uppercase text-white/40">Markets</p><p className="mt-2 text-sm font-semibold">{robot.markets.join(', ')}</p></div><div className="rounded-2xl border border-white/10 bg-white/[.025] p-4"><p className="text-[10px] uppercase text-white/40">Robot status</p><p className="mt-2 text-sm font-semibold">{robot.status}</p></div><div className="rounded-2xl border border-white/10 bg-white/[.025] p-4"><p className="text-[10px] uppercase text-white/40">Your access</p><p className="mt-2 text-sm font-semibold">{!signedIn ? 'Sign in to join' : !joined ? 'Not joined' : membership?.activatedAt ? 'Active · paper' : 'Joined'}</p></div></section>
    {robot.latestThesis && <section className="rounded-2xl border border-white/10 bg-white/[.025] p-5"><p className="text-[10px] font-bold uppercase text-violet-200">Latest market review · {robot.latestThesis.market}</p><h2 className="mt-2 text-lg font-bold">{robot.latestThesis.bias}</h2><p className="mt-2 text-sm leading-6 text-white/65">{robot.latestThesis.summary}</p><p className="mt-3 text-[10px] text-white/35">Last updated {new Date(robot.latestThesis.updatedAt).toLocaleString()}</p></section>}
    <section className="mt-5 rounded-2xl border border-white/10 bg-white/[.025] p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-bold">Use this robot</h2><p className="mt-1 text-xs text-white/50">Join to chat and activate your own paper-mode access.</p></div>{!signedIn ? <span className="inline-flex items-center gap-2 text-xs text-white/50"><LockKeyhole className="h-4 w-4" /> Sign in required</span> : !joined ? <button disabled={busy} onClick={() => void join()} className="rounded-xl bg-violet-300 px-4 py-2.5 text-xs font-bold text-[#100c1b] disabled:opacity-50">{busy ? 'Working…' : 'Join robot'}</button> : <button disabled={busy || Boolean(membership?.activatedAt)} onClick={() => void activate()} className="inline-flex items-center gap-2 rounded-xl bg-violet-300 px-4 py-2.5 text-xs font-bold text-[#100c1b] disabled:opacity-50"><Play className="h-3.5 w-3.5" />{membership?.activatedAt ? 'Paper mode active' : busy ? 'Activating…' : 'Activate paper mode'}</button>}</div>
      {!signedIn && <form onSubmit={authenticate} className="mt-4 grid gap-2 border-t border-white/10 pt-4 sm:grid-cols-2">
        <div className="sm:col-span-2 flex gap-3 text-xs"><button type="button" onClick={() => setAuthChoice('signup')} className={authChoice === 'signup' ? 'font-bold text-violet-200' : 'text-white/45'}>Create account</button><button type="button" onClick={() => setAuthChoice('signin')} className={authChoice === 'signin' ? 'font-bold text-violet-200' : 'text-white/45'}>Sign in</button></div>
        <input type="email" autoComplete="email" required value={authEmail} onChange={e => setAuthEmail(e.target.value)} placeholder="Email address" className="rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm outline-none focus:border-violet-300/50" />
        <input type="password" minLength={8} autoComplete={authChoice === 'signup' ? 'new-password' : 'current-password'} required value={authPassword} onChange={e => setAuthPassword(e.target.value)} placeholder="Password (8+ characters)" className="rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm outline-none focus:border-violet-300/50" />
        <button disabled={busy || authMode === 'none'} className="rounded-xl bg-violet-300 px-4 py-2.5 text-xs font-bold text-[#100c1b] disabled:opacity-50 sm:col-span-2">{busy ? 'Working…' : authChoice === 'signup' ? 'Create account and continue' : 'Sign in and continue'}</button>
        <button type="button" disabled={busy || authMode === 'none'} onClick={() => void authenticateGoogle()} className="rounded-xl border border-white/15 px-4 py-2.5 text-xs font-semibold text-white/80 disabled:opacity-50 sm:col-span-2">{busy ? 'Connecting…' : 'Continue with Google'}</button>
      </form>}
      {joined && <div className="mt-4 border-t border-white/10 pt-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-semibold">Connect PropDAO (optional)</h3><p className="mt-1 text-xs leading-5 text-white/45">Your API key is saved to your account, not the creator's. Connecting it does not enable live orders; execution remains subject to server authorization and risk checks.</p></div><button onClick={() => setShowPropDao(v => !v)} className="rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold">{propDaoConnected ? 'Key connected' : 'Connect key'}</button></div>{showPropDao && <form onSubmit={savePropDaoKey} className="mt-3 flex flex-col gap-2 sm:flex-row"><input type="password" autoComplete="off" value={propDaoKey} onChange={e => setPropDaoKey(e.target.value)} placeholder="Your PropDAO API key" className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm outline-none focus:border-violet-300/50" /><button disabled={busy || !propDaoKey.trim()} className="rounded-xl bg-white px-4 py-2.5 text-xs font-bold text-black disabled:opacity-50">{busy ? 'Saving…' : 'Save key securely'}</button></form>}</div>}
    </section>
    <section className="mt-5 rounded-2xl border border-white/10 bg-white/[.025] p-5"><div className="flex items-center gap-2"><MessageCircle className="h-4 w-4 text-violet-200" /><h2 className="text-base font-bold">AI discussion · {robot.name}</h2></div><p className="mt-1 text-[10px] text-white/35">Chat messages are currently session-only. Recorded thesis and workflow events appear in the persisted activity feed above.</p>{!joined ? <p className="mt-3 text-sm text-white/45">Join this robot to start a conversation.</p> : <><div className="mt-4 max-h-80 space-y-3 overflow-y-auto">{messages.map((message, index) => <div key={index} className={message.role === 'user' ? 'ml-8 rounded-xl bg-violet-300/10 p-3 text-sm' : 'mr-8 rounded-xl bg-white/[.04] p-3 text-sm leading-6 text-white/80'}><p className="mb-1 text-[9px] font-bold uppercase text-white/35">{message.role === 'user' ? 'You' : robot.name}</p>{message.text}</div>)}</div><form onSubmit={send} className="mt-4 flex gap-2"><input value={question} onChange={e => setQuestion(e.target.value)} maxLength={2000} placeholder={'Ask ' + robot.name + ' a question…'} className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-sm outline-none focus:border-violet-300/50" /><button disabled={busy || !question.trim()} className="rounded-xl bg-violet-300 px-4 text-[#100c1b] disabled:opacity-50" aria-label="Send message"><Send className="h-4 w-4" /></button></form></>}</section>
    <section className="mt-5"><h2 className="text-base font-bold">Recent trade ideas</h2>{robot.signals.length ? <div className="mt-3 space-y-2">{robot.signals.map((signal, index) => <article key={index} className="rounded-xl border border-white/10 bg-white/[.02] p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold">{signal.market} · {signal.direction}</p><span className="rounded-full border border-white/10 px-2 py-1 text-[9px] uppercase text-white/45">{signal.status}</span></div><p className="mt-2 text-sm text-white/65">{signal.thesis}</p><p className="mt-1 text-xs leading-5 text-white/40">{signal.rationale}</p></article>)}</div> : <p className="mt-3 text-sm text-white/40">No trade ideas have been published by this robot yet.</p>}</section>
    {error && <p role="alert" className="mt-5 rounded-xl border border-red-300/20 bg-red-300/[.06] p-3 text-xs text-red-200">{error}</p>}
    <footer className="mt-10 border-t border-white/10 pt-5 text-[10px] leading-5 text-white/30">Trading analysis can be wrong. Paper mode does not place real orders. Live execution is not enabled by connecting an API key alone.</footer>
  </div></main>;
}
