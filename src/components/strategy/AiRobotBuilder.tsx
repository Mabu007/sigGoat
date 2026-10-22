import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Loader2, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { RoomCoverPicker } from '../RoomCoverPicker';

type Provider = 'hyperliquid' | 'ctrader';
type Asset = { symbol: string; name: string; category: string };
type Model = { id: string; name: string; free?: boolean; supportsStructuredOutputs?: boolean };

const DEFAULT_PROMPT = 'You are a disciplined trading analyst. Review higher-timeframe market structure, identify confirmed liquidity areas, inspect relevant indicators and catalysts, and maintain a clear thesis with supporting and contradicting evidence. Be skeptical, use only supplied market data, and return WAIT when evidence is insufficient. Propose ideas only; never bypass the platform risk rules or claim that an order was placed.';

export function AiRobotBuilder({ headers, onClose, onCreated }: {
  headers: (json?: boolean) => Promise<Headers>;
  onClose: () => void;
  onCreated: (roomPath: string) => void;
}) {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [provider, setProvider] = useState<Provider>('hyperliquid');
  const [interval, setInterval] = useState(15);
  const [model, setModel] = useState('');
  const [models, setModels] = useState<Model[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [asset, setAsset] = useState('');
  const [assetQuery, setAssetQuery] = useState('');
  const [sources, setSources] = useState<string[]>([]);
  const [sourceInput, setSourceInput] = useState('');
  const [createdRoom, setCreatedRoom] = useState<{ id: string; path: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const requestHeaders = await headers();
        const [availableModels, availableAssets] = await Promise.all([
      fetch('/api/ai/models?provider=openrouter', { headers: requestHeaders, cache: 'no-store' }).then(async response => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.error?.message || 'OpenRouter models are unavailable.');
        return (body.models ?? []) as Model[];
      }),
      fetch(`/api/markets/assets?provider=${provider}`, { headers: requestHeaders, cache: 'no-store' }).then(async response => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.error?.message || 'Could not load supported assets.');
        return (body.assets ?? []) as Asset[];
      }),
    ]);
        if (cancelled) return;
        setModels(availableModels);
        setAssets(availableAssets);
        setModel(current => current || availableModels.find(item => item.supportsStructuredOutputs)?.id || availableModels[0]?.id || '');
        setAsset(current => availableAssets.some(item => item.symbol === current) ? current : availableAssets[0]?.symbol || '');
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load AI robot settings.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [headers, provider]);

  const filteredAssets = useMemo(() => assets.filter(item => `${item.symbol} ${item.name}`.toLowerCase().includes(assetQuery.toLowerCase())).slice(0, 200), [assets, assetQuery]);

  const addSource = () => {
    try {
      const parsed = new URL(sourceInput.trim());
      const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !host || host === 'localhost' || host.endsWith('.local') || /^\d+(?:\.\d+){3}$/.test(host)) throw new Error();
      if (!sources.includes(parsed.origin + parsed.pathname.replace(/\/$/, ''))) setSources(current => [...current, parsed.origin + parsed.pathname.replace(/\/$/, '')].slice(0, 8));
      setSourceInput('');
    } catch { setError('Enter a public HTTPS website, such as https://www.coindesk.com.'); }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/goat-teams', {
        method: 'POST', headers: await headers(true),
        body: JSON.stringify({
          name: name.trim(),
          instructions: 'This is a public AI trading analyst robot. Use the member instructions as the user-authored analytical style, obey platform security and risk controls, and publish each market review and proposal to the public room. This robot is configured for paper research only.',
          coordinationMode: 'INDEPENDENT', visibility: 'PUBLIC', robotKind: 'AI_ROBOT', deploy: true,
          monitoringIntervals: [interval],
          deployment: { provider, asset, liveTrading: false, risk: {} },
          newMembers: [{
            name: name.trim(), jobTitle: 'AI Trading Analyst', jobDescription: prompt.trim(),
            skills: ['Market structure', 'Liquidity analysis', 'Catalyst research'],
            asset, tradingProvider: provider, model, aiProvider: 'openrouter', researchSources: sources,
          }],
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || 'Could not create the AI robot.');
      if (!body.team?.publicSlug) throw new Error('The robot was created, but its workspace link was not returned. Refresh the bots page to continue.');
      setCreatedRoom({ id: body.team.id, path: `/team/${encodeURIComponent(body.team.publicSlug)}` });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the AI robot.');
    } finally { setBusy(false); }
  };

  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 p-0 backdrop-blur-sm sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-labelledby="ai-robot-title">
    <section className="flex max-h-[96vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-[24px] border border-white/10 bg-[#0d0d12] text-white shadow-2xl sm:rounded-[24px]">
      <header className="flex items-start justify-between border-b border-white/10 p-5 sm:px-7">
        <div><p className="text-[10px] font-bold uppercase tracking-[.2em] text-red-500">AI robot studio</p><h2 id="ai-robot-title" className="mt-1 text-xl font-black">Create an AI trading robot</h2><p className="mt-1 text-xs text-white/45">It reviews the market on a schedule and keeps its thesis between reviews.</p></div>
        <button type="button" onClick={onClose} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-xl border border-white/10 bg-white/5"><X size={18}/></button>
      </header>
      {createdRoom ? <div className="space-y-5 overflow-y-auto p-5 sm:px-7 sm:py-6">
        <div role="status" className="rounded-xl border border-emerald-500/20 bg-emerald-500/[.04] p-4"><h3 className="text-sm font-bold text-emerald-100">Your public AI robot is ready</h3><p className="mt-1 text-xs text-emerald-100/65">Reviews run every {interval} minutes when scheduling is configured. Anyone can watch its analysis. Each viewer must connect and enable their own account separately to trade.</p></div>
        <RoomCoverPicker roomId={createdRoom.id} purpose="room-cover" aspect="landscape" label="Robot cover image" />
        <div className="flex justify-end gap-2"><button type="button" className="btn btn-secondary" onClick={()=>onCreated(createdRoom.path)}>Skip cover</button><button type="button" className="btn btn-primary" onClick={()=>onCreated(createdRoom.path)}>Open robot workspace</button></div>
      </div> : <form onSubmit={event => void submit(event)} className="space-y-5 overflow-y-auto p-5 sm:px-7 sm:py-6">
        {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-300">{error}</p>}
        <label className="block text-xs text-white/65">Robot name<input required minLength={2} maxLength={80} value={name} onChange={event => setName(event.target.value)} className="input mt-1 w-full" placeholder="e.g. Gold Structure Analyst" /></label>
        <label className="block text-xs text-white/65">Personality and analysis instructions<textarea required minLength={20} maxLength={4000} rows={7} value={prompt} onChange={event => setPrompt(event.target.value)} className="input mt-1 w-full" /><span className="mt-1 block text-[10px] text-white/35">This shapes the robot's analysis. Platform risk and tool restrictions still apply.</span></label>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block text-xs text-white/65">AI model<select required value={model} onChange={event => setModel(event.target.value)} className="input mt-1 w-full" disabled={loading}><option value="">Select a model</option>{models.map(item=><option key={item.id} value={item.id} disabled={!item.supportsStructuredOutputs}>{item.name}{item.free?' · free':''}{item.supportsStructuredOutputs?' · structured JSON':' · incompatible'}</option>)}</select><span className="mt-1 block text-[10px] text-white/35">The runtime requires structured JSON decisions. Its market tools are server-controlled context, not open-ended model tool calls.</span></label>
          <label className="block text-xs text-white/65">Trading provider<select value={provider} onChange={event=>{setProvider(event.target.value as Provider);setAsset('')}} className="input mt-1 w-full"><option value="hyperliquid">PropDAO / Hyperliquid</option><option value="ctrader">cTrader</option></select></label>
          <label className="block text-xs text-white/65">AI analysis interval<select value={interval} onChange={event=>setInterval(Number(event.target.value))} className="input mt-1 w-full"><option value={5}>5 minutes</option><option value={15}>15 minutes · default</option><option value={30}>30 minutes</option><option value={60}>1 hour</option></select></label>
        </div>
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr]">
          <label className="block text-xs text-white/65">Supported asset<select required value={asset} onChange={event=>setAsset(event.target.value)} className="input mt-1 w-full" disabled={loading}>{filteredAssets.map(item=><option key={item.symbol} value={item.symbol}>{item.symbol} · {item.name}</option>)}</select></label>
          <label className="block text-xs text-white/65">Search assets<input value={assetQuery} onChange={event=>setAssetQuery(event.target.value)} className="input mt-1 w-full" placeholder="Search supported instruments" /></label>
        </div>
        {provider==='ctrader'&&<p className="-mt-3 text-[10px] text-amber-200/75">The current cTrader adapter supplies the market data available to this runtime. The selected broker account must support this symbol before live execution is enabled.</p>}
        <section className="rounded-xl border border-white/10 bg-white/[.025] p-4">
          <div className="flex items-center justify-between gap-2"><div><h3 className="text-xs font-bold">Research sources</h3><p className="mt-1 text-[10px] text-white/40">Preferred domains are searched through cached news results; websites are not scraped directly.</p></div><span className="text-[10px] text-white/35">{sources.length}/8</span></div>
          <div className="mt-3 flex gap-2"><input value={sourceInput} onChange={event=>setSourceInput(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();addSource()}}} className="input min-w-0 flex-1" placeholder="https://www.reuters.com"/><button type="button" onClick={addSource} disabled={sources.length>=8} className="btn btn-secondary"><Plus size={14}/> Add</button></div>
          {sources.length>0&&<ul className="mt-3 space-y-1">{sources.map(source=><li key={source} className="flex items-center justify-between rounded-lg bg-black/20 px-3 py-2 text-[11px]"><span className="truncate">{source}</span><button type="button" aria-label={`Remove ${source}`} onClick={()=>setSources(current=>current.filter(item=>item!==source))} className="ml-2 text-white/45 hover:text-white"><Trash2 size={14}/></button></li>)}</ul>}
        </section>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[.04] p-3 text-[11px] text-emerald-100/70"><span>Paper research only. This robot will not place live orders.</span><span className="shrink-0 font-bold">LIVE OFF</span></div>
        <footer className="flex justify-end gap-2 border-t border-white/10 pt-4"><button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button><button type="submit" disabled={busy||loading||!model||!asset} className="btn btn-primary">{busy||loading?<Loader2 size={15} className="animate-spin"/>:<Sparkles size={15}/>} {busy?'Creating robot…':'Create and start'}</button></footer>
      </form>}
    </section>
  </div>;
}
