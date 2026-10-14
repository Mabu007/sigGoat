import { useCallback, useEffect, useState } from "react";
import { Activity, Bot, CheckCircle2, CircleAlert, Loader2, Play, RefreshCw, ShieldCheck, X } from "lucide-react";

export type ActionMode = "research" | "create-goat" | "deploy-goat" | "proposal" | "trade";

interface ChatActionsPanelProps {
  getAuthHeaders: () => Promise<Record<string, string>>;
  onClose: () => void;
  onResult?: (title: string, detail: string) => void;
  initialMode?: ActionMode;
}

interface Option { id: string; label: string; [key: string]: unknown; }

const cardClass = "rounded-xl border border-line bg-surface p-3 text-fg";
const fieldClass = "w-full rounded-lg border border-line bg-sunken px-3 py-2 text-xs text-fg outline-none focus:border-focus";
const buttonClass = "inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-accent-fg disabled:cursor-not-allowed disabled:opacity-50";
const secondaryClass = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-line px-3 py-2 text-xs font-medium text-fg hover:bg-raised disabled:opacity-50";

export function ChatActionsPanel({ getAuthHeaders, onClose, onResult, initialMode = "research" }: ChatActionsPanelProps) {
  const [mode, setMode] = useState<ActionMode>(initialMode);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [markets, setMarkets] = useState<Option[]>([]);\n  const [propMarkets, setPropMarkets] = useState<Option[]>([]);
  const [skills, setSkills] = useState<Option[]>([]);
  const [goats, setGoats] = useState<Option[]>([]);
  const [accounts, setAccounts] = useState<Option[]>([]);
  const [result, setResult] = useState<any>(null);

  const [query, setQuery] = useState("");
  const [goatName, setGoatName] = useState("");
  const [goal, setGoal] = useState("");
  const [market, setMarket] = useState("");
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [goatId, setGoatId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [qty, setQty] = useState("0.01");
  const [entry, setEntry] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [leverage, setLeverage] = useState("1");

  const request = useCallback(async (path: string, init?: RequestInit) => {
    const headers = await getAuthHeaders();
    const response = await fetch(path, {
      ...init,
      headers: { ...headers, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok && !payload?.action) throw new Error(payload?.error?.message || payload?.message || "The action could not be completed.");
    return payload;
  }, [getAuthHeaders]);

  const refreshContext = useCallback(async () => {
    setError("");
    try {
      const [marketData, skillData, goatData, accountData, propMarketData] = await Promise.all([
        request("/api/markets/symbols").catch(() => ({})),
        request("/api/skills").catch(() => ({})),
        request("/api/goats").catch(() => ({})),
        request("/api/propdao/accounts").catch(() => ({})),\n        request("/api/propdao/markets").catch(() => ({})),
      ]);
      const marketRows = Array.isArray(marketData?.symbols) ? marketData.symbols : Array.isArray(marketData?.markets) ? marketData.markets : [];
      const skillRows = Array.isArray(skillData?.skills) ? skillData.skills : [];
      const goatRows = Array.isArray(goatData?.goats) ? goatData.goats : [];
      const accountRows = Array.isArray(accountData?.accounts) ? accountData.accounts : [];\n      const propMarketRows = Array.isArray(propMarketData?.markets) ? propMarketData.markets : [];
      const nextMarkets = marketRows.map((item: any) => ({ ...item, id: String(item.symbol ?? item.id ?? ""), label: String(item.symbol ?? item.name ?? item.id ?? "") })).filter((item: Option) => item.id);
      const nextSkills = skillRows.map((item: any) => ({ ...item, id: String(item.id ?? ""), label: String(item.name ?? item.title ?? item.id ?? "") })).filter((item: Option) => item.id);
      const nextGoats = goatRows.map((item: any) => ({ ...item, id: String(item.id ?? ""), label: String(item.name ?? item.id ?? "") })).filter((item: Option) => item.id);
      const nextAccounts = accountRows.map((item: any) => ({ ...item, id: String(item.accountId ?? item.id ?? ""), label: String(item.accountId ?? item.name ?? item.id ?? "") })).filter((item: Option) => item.id);\n      const nextPropMarkets = propMarketRows.map((item: any) => ({ ...item, id: String(item.symbol ?? item.id ?? ""), label: String(item.symbol ?? item.name ?? item.id ?? "") })).filter((item: Option) => item.id);
      setMarkets(nextMarkets);
      setSkills(nextSkills);
      setGoats(nextGoats);
      setAccounts(nextAccounts);\n      setPropMarkets(nextPropMarkets);
      if (!market && nextMarkets.length) setMarket(nextMarkets[0].id);
      if (!goatId && nextGoats.length) setGoatId(nextGoats[0].id);
      if (!accountId && nextAccounts.length) setAccountId(nextAccounts[0].id);
      if (!symbol && nextPropMarkets.length) setSymbol(nextPropMarkets[0].id);
      if (!skillIds.length && nextSkills.length) setSkillIds([nextSkills[0].id]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load action context.");
    }
  }, [request, market, goatId, accountId, symbol, skillIds.length]);

  useEffect(() => { setMode(initialMode); }, [initialMode]);\n\n  useEffect(() => { setMode(initialMode); }, [initialMode]);\n\n  useEffect(() => { void refreshContext(); }, [refreshContext]);

  const run = async (fn: () => Promise<any>, successMessage: string) => {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const payload = await fn();
      setResult(payload?.action ?? payload);
      setNotice(successMessage);
      if (onResult) onResult(successMessage, JSON.stringify(payload?.action ?? payload));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The action failed.");
    } finally {
      setLoading(false);
    }
  };

  const post = (path: string, body: unknown) => request(path, { method: "POST", body: JSON.stringify(body) });

  const research = () => run(async () => {
    if (!query.trim()) throw new Error("Enter a market or asset to research.");
    return post("/api/chat/actions/market-research", { query: query.trim() });
  }, "Market research returned");

  const createGoat = () => run(async () => {
    if (!goatName.trim() || !goal.trim() || !market || !skillIds.length) throw new Error("Name, goal, market, and at least one skill are required.");
    const payload = await post("/api/goats", { name: goatName.trim(), goal: goal.trim(), markets: [market], skillIds, deploymentState: "DRAFT" });
    return { action: { type: "create_goat", status: "completed", title: "GOAT draft created", goat: payload.goat ?? payload, message: "The draft is saved. Deploy it separately after reviewing the configuration." } };
  }, "GOAT draft created");

  const deployGoat = () => run(() => post("/api/chat/actions/goats/" + encodeURIComponent(goatId) + "/deploy", { confirmed: false }), "Review the deployment confirmation card");\n\n  const confirmDeployGoat = () => run(() => post("/api/chat/actions/goats/" + encodeURIComponent(goatId) + "/deploy", { confirmed: true }), "Deployment request submitted");

  const createProposal = () => run(() => post("/api/chat/actions/goats/" + encodeURIComponent(goatId) + "/research", { reason: "Market review requested from SIRGOAT chat" }), "GOAT review completed");

  const previewTrade = () => run(() => post("/api/chat/actions/execute-trade", {
    accountId, symbol, side, qty: Number(qty), entry: Number(entry), stopLoss: Number(stopLoss), takeProfit: Number(takeProfit), leverage: Number(leverage),
  }), "Risk checks completed");

  const confirmTrade = () => run(() => post("/api/chat/actions/execute-trade", {
    accountId, symbol, side, qty: Number(qty), entry: Number(entry), stopLoss: Number(stopLoss), takeProfit: Number(takeProfit), leverage: Number(leverage),
    confirmed: true, intentId: result?.intentId,
  }), "Execution response received");

  const tabs: Array<{ id: ActionMode; label: string }> = [
    { id: "research", label: "Research" }, { id: "create-goat", label: "Create GOAT" },
    { id: "deploy-goat", label: "Deploy" }, { id: "proposal", label: "Proposal" }, { id: "trade", label: "Trade order" },
  ];

  return (
    <section className="absolute inset-x-2 bottom-2 z-30 flex max-h-[78%] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl sm:inset-x-4" aria-label="SIRGOAT action tools">
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-accent-text"><ShieldCheck size={15} /></span>
          <div className="min-w-0"><h3 className="text-xs font-semibold text-fg">SIRGOAT action centre</h3><p className="text-[10px] text-fg-subtle">Authenticated tools · server-side checks</p></div>
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-1.5 text-fg-subtle hover:bg-raised" aria-label="Close action centre"><X size={15} /></button>
      </header>
      <nav className="flex gap-1 overflow-x-auto border-b border-line px-2 py-2">
        {tabs.map((tab) => <button key={tab.id} type="button" onClick={() => { setMode(tab.id); setResult(null); setError(""); setNotice(""); }} className={`shrink-0 rounded-lg px-2.5 py-1.5 text-[10px] font-medium ${mode === tab.id ? "bg-accent text-accent-fg" : "text-fg-muted hover:bg-raised"}`}>{tab.label}</button>)}
      </nav>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {mode === "research" && <div className={cardClass}><label className="mb-1.5 block text-[11px] font-semibold">What market should I research?</label><input className={fieldClass} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. gold, BTC, xyz:EUR" /><p className="mt-2 text-[10px] text-fg-subtle">Uses the backend's market-data pipeline; results distinguish LIVE from PAPER data.</p><button className={`${buttonClass} mt-3`} disabled={loading} onClick={() => void research()}><Activity size={13} /> Research market</button></div>}
        {mode === "create-goat" && <div className={cardClass}><label className="mb-1 block text-[11px] font-semibold">GOAT name</label><input className={fieldClass} value={goatName} onChange={(e) => setGoatName(e.target.value)} placeholder="e.g. Gold Breakout GOAT" /><label className="mb-1 mt-3 block text-[11px] font-semibold">Goal and strategy intent</label><textarea className={fieldClass} rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What should the GOAT investigate and monitor?" /><label className="mb-1 mt-3 block text-[11px] font-semibold">Market</label><select className={fieldClass} value={market} onChange={(e) => setMarket(e.target.value)}>{markets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><label className="mb-1 mt-3 block text-[11px] font-semibold">Skills</label><div className="space-y-1.5">{skills.map((item) => <label key={item.id} className="flex items-center gap-2 text-[11px]"><input type="checkbox" checked={skillIds.includes(item.id)} onChange={(e) => setSkillIds((prev) => e.target.checked ? [...prev, item.id] : prev.filter((id) => id !== item.id))} />{item.label}</label>)}</div><button className={`${buttonClass} mt-3`} disabled={loading} onClick={() => void createGoat()}><Bot size={13} /> Create draft GOAT</button><p className="mt-2 text-[10px] text-fg-subtle">Creation saves a DRAFT only. It does not deploy or place trades.</p></div>}
        {mode === "deploy-goat" && <div className={cardClass}><label className="mb-1.5 block text-[11px] font-semibold">Choose your GOAT</label><select className={fieldClass} value={goatId} onChange={(e) => setGoatId(e.target.value)}>{goats.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><p className="mt-2 text-[10px] text-fg-subtle">Deployment starts scheduling and an initial market review. This action is explicitly confirmed by the Deploy button.</p><button className={`${buttonClass} mt-3`} disabled={loading || !goatId} onClick={() => void deployGoat()}><Play size={13} /> Review deployment</button></div>}
        {mode === "proposal" && <div className={cardClass}><label className="mb-1.5 block text-[11px] font-semibold">Choose your GOAT</label><select className={fieldClass} value={goatId} onChange={(e) => setGoatId(e.target.value)}>{goats.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><p className="mt-2 text-[10px] text-fg-subtle">Runs a fresh GOAT review and returns its persisted proposal records. This does not submit an order.</p><button className={`${buttonClass} mt-3`} disabled={loading || !goatId} onClick={() => void createProposal()}><RefreshCw size={13} /> Research and propose</button></div>}
        {mode === "trade" && <div className={cardClass}><p className="mb-2 text-[11px] font-semibold">Trade order intent</p><label className="mb-1 block text-[10px]">PropDAO account</label><select className={fieldClass} value={accountId} onChange={(e) => setAccountId(e.target.value)}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><label className="mb-1 mt-2 block text-[10px]">Provider symbol</label><select className={fieldClass} value={symbol} onChange={(e) => setSymbol(e.target.value)}><option value="">Select a PropDAO market</option>{propMarkets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><div className="mt-2 grid grid-cols-2 gap-2"><div><label className="mb-1 block text-[10px]">Side</label><select className={fieldClass} value={side} onChange={(e) => setSide(e.target.value as "BUY" | "SELL")}><option value="BUY">BUY</option><option value="SELL">SELL</option></select></div><div><label className="mb-1 block text-[10px]">Quantity</label><input className={fieldClass} type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} /></div><div><label className="mb-1 block text-[10px]">Limit entry</label><input className={fieldClass} type="number" min="0" step="any" value={entry} onChange={(e) => setEntry(e.target.value)} /></div><div><label className="mb-1 block text-[10px]">Leverage</label><input className={fieldClass} type="number" min="1" step="any" value={leverage} onChange={(e) => setLeverage(e.target.value)} /></div><div><label className="mb-1 block text-[10px]">Stop loss</label><input className={fieldClass} type="number" min="0" step="any" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} /></div><div><label className="mb-1 block text-[10px]">Take profit</label><input className={fieldClass} type="number" min="0" step="any" value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)} /></div></div><button className={`${buttonClass} mt-3`} disabled={loading || !accountId || !symbol.trim() || !entry || !stopLoss || !takeProfit || Number(qty) <= 0} onClick={() => void previewTrade()}><ShieldCheck size={13} /> Run risk checks</button><p className="mt-2 text-[10px] text-fg-subtle">No order is sent during preflight. Confirmation rechecks risk; server-side execution policy can still block the order.</p></div>}
        {error && <div className="flex items-start gap-2 rounded-lg border border-negative/30 bg-negative-soft p-2.5 text-[11px] text-negative"><CircleAlert size={14} className="mt-0.5 shrink-0" />{error}</div>}
        {notice && !error && <div className="flex items-start gap-2 rounded-lg border border-line bg-sunken p-2.5 text-[11px] text-fg"><CheckCircle2 size={14} className="mt-0.5 shrink-0" />{notice}</div>}
        {loading && <div className="flex items-center gap-2 text-[11px] text-fg-muted"><Loader2 size={13} className="animate-spin" />Checking with the server…</div>}
        {result && <div className={cardClass}>
          <div className="mb-2 flex items-start justify-between gap-2"><div><p className="text-xs font-semibold">{result.title ?? "Action result"}</p><p className="mt-0.5 text-[10px] text-fg-subtle">{result.status ?? "completed"}</p></div><span className="rounded-full border border-line px-2 py-0.5 text-[9px]">Structured result</span></div>
          {result.message && <p className="mb-2 text-[11px] leading-relaxed">{result.message}</p>}
          {result.evidence && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-sunken p-2 text-[10px] leading-relaxed">{result.evidence}</pre>}
          {result.riskCheck && <div className="space-y-1 text-[10px]"><p className={result.riskCheck.ok ? "font-semibold text-positive" : "font-semibold text-negative"}>{result.riskCheck.ok ? "Risk checks passed" : "Risk checks failed"}</p>{(result.riskCheck.violations ?? []).map((v: string) => <p key={v}>• {v}</p>)}{result.riskCheck.measured && <pre className="overflow-auto whitespace-pre-wrap rounded-lg bg-sunken p-2">{JSON.stringify(result.riskCheck.measured, null, 2)}</pre>}</div>}
          {result.order && <pre className="mb-2 overflow-auto whitespace-pre-wrap rounded-lg bg-sunken p-2 text-[10px]">{JSON.stringify(result.order, null, 2)}</pre>}
          {result.execution && <div className="mt-2 rounded-lg border border-line p-2 text-[10px]"><p className="font-semibold">Execution policy: {result.execution.enabled && result.execution.authorised ? "enabled" : "blocked"}</p><p className="mt-1 text-fg-muted">{result.execution.summary}</p></div>}
          {result.type === "execute_trade" && result.status === "confirmation_required" && <div className="mt-3 flex flex-wrap gap-2"><button className={buttonClass} disabled={loading || !(result.execution?.enabled && result.execution?.authorised)} onClick={() => void confirmTrade()}><ShieldCheck size={13} /> Explicitly confirm order</button><button className={secondaryClass} onClick={() => setResult(null)}>Cancel</button></div>}
          {result.type === "deploy_goat" && result.status === "confirmation_required" && <div className="mt-3 flex gap-2"><button className={buttonClass} disabled={loading} onClick={() => void confirmDeployGoat()}>Confirm deployment</button><button className={secondaryClass} onClick={() => setResult(null)}>Cancel</button></div>}
          {Array.isArray(result.signals) && <div className="mt-2 space-y-2">{result.signals.map((signal: any) => <div key={signal.id} className="rounded-lg border border-line p-2 text-[10px]"><p className="font-semibold">{signal.market} · {signal.direction} · {signal.status}</p><p className="mt-1">Entry: {signal.entry ?? signal.entryZone ?? "—"} · SL: {signal.stopLoss ?? "—"} · TP: {signal.takeProfit ?? "—"}</p><p className="mt-1 text-fg-muted">{signal.rationale ?? signal.thesis ?? ""}</p></div>)}</div>}
          {result.goat && <p className="mt-2 text-[10px] text-fg-muted">GOAT: {String(result.goat.name ?? result.goat.id ?? "created")}{result.goat.id ? " · " + String(result.goat.id) : ""}</p>}
          {result.result && <pre className="mt-2 overflow-auto whitespace-pre-wrap rounded-lg bg-sunken p-2 text-[10px]">{JSON.stringify(result.result, null, 2)}</pre>}
          {result.status === "blocked" && result.message && <p className="mt-2 text-[10px] text-negative">{result.message}</p>}
        </div>}
      </div>
    </section>
  );
}
