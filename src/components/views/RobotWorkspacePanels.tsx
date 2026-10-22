import { useEffect, useState } from 'react';
import { Image as ImageIcon, Palette, Search, Send, ShieldCheck } from 'lucide-react';
import type { StrategyDefinition } from '../../services/strategy/schema';
import type { RobotSummary } from '../strategy/RobotCard';
import { RoomCoverPicker } from '../RoomCoverPicker';

type Theme = 'red' | 'green' | 'blue' | 'orange' | 'gold';
type HeadersFactory = (json?: boolean) => Promise<Headers>;
type Asset = { symbol: string; name: string };
const themes: Theme[] = ['red','green','blue','orange','gold'];

export function AssetPicker({ slug, headers, current, selected, canManage, running, onSelected }: { slug: string; headers: HeadersFactory; current: StrategyDefinition['market']; selected: boolean; canManage: boolean; running: boolean; onSelected: () => Promise<void> }) {
  const [assets,setAssets] = useState<{ biquote: Asset[]; hyperliquid: Asset[] }>({ biquote: [], hyperliquid: [] });
  const [provider,setProvider] = useState<'biquote'|'hyperliquid'>(current.provider === 'biquote' ? 'biquote' : 'hyperliquid');
  const [query,setQuery] = useState('');
  const [loading,setLoading] = useState(true);
  const [saving,setSaving] = useState('');
  const [error,setError] = useState('');
  useEffect(() => { let cancelled=false; void (async()=>{try{const response=await fetch(`/api/robot-marketplace/${encodeURIComponent(slug)}/assets`,{headers:await headers(),cache:'no-store'});const body=await response.json();if(!response.ok)throw new Error(body?.error?.message||'Assets could not be loaded.');if(!cancelled)setAssets(body)}catch(cause){if(!cancelled)setError(cause instanceof Error?cause.message:'Assets could not be loaded.')}finally{if(!cancelled)setLoading(false)}})();return()=>{cancelled=true}},[slug,headers]);
  const choose=async(symbol:string)=>{setSaving(symbol);setError('');try{const response=await fetch(`/api/robot-marketplace/${encodeURIComponent(slug)}/market`,{method:'POST',headers:await headers(true),body:JSON.stringify({provider,instrument:symbol})});const body=await response.json();if(!response.ok)throw new Error(body?.error?.message||'Asset could not be saved.');await onSelected()}catch(cause){setError(cause instanceof Error?cause.message:'Asset could not be saved.')}finally{setSaving('')}};
  const matching=assets[provider].filter(asset=>`${asset.symbol} ${asset.name}`.toLowerCase().includes(query.toLowerCase()));
  const shown=matching.slice(0,100);
  return <div className="robot-asset-picker">
    <p className="robot-section-intro">Pick one chart for this robot. Changing the asset creates a new strategy version and starts fresh paper results.</p>
    <div className="robot-segmented"><button className={provider==='biquote'?'active':''} onClick={()=>setProvider('biquote')}>BiQuote</button><button className={provider==='hyperliquid'?'active':''} onClick={()=>setProvider('hyperliquid')}>Hyperliquid</button></div>
    <label className="robot-search"><Search size={16}/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search assets" aria-label="Search assets"/></label>
    {running&&<p className="robot-inline-warning">Stop the robot before changing its asset.</p>}
    {error&&<p className="robot-inline-warning" role="alert">{error}</p>}
    {!loading&&matching.length>100&&<p className="robot-section-intro">Showing 100 of {matching.length} assets. Search to narrow the list.</p>}
    <div className="robot-asset-list">{loading?<p>Loading assets…</p>:shown.length?shown.map(asset=><button key={asset.symbol} disabled={!canManage||running||Boolean(saving)} className={selected&&current.provider===provider&&current.instrument===asset.symbol?'active':''} onClick={()=>void choose(asset.symbol)}><span><b>{asset.symbol}</b><small>{asset.name}</small></span><em>{saving===asset.symbol?'Saving…':selected&&current.provider===provider&&current.instrument===asset.symbol?'Selected':'Choose'}</em></button>):<p>No assets match your search.</p>}</div>
  </div>;
}

export function RobotSettings({ detail, theme, setTheme, headers, reload }: { detail: { robot: RobotSummary; canManage: boolean }; theme: Theme; setTheme: (theme: Theme) => void; headers: HeadersFactory; reload: () => Promise<void> }) {
  const [telegram,setTelegram]=useState<{ connected:boolean; tokenConfigured?:boolean; chatId:string|null; bot:{username:string}|null }|null>(null);
  const [token,setToken]=useState('');
  const [chatId,setChatId]=useState('');
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  const [coverOpen,setCoverOpen]=useState(false);
  const [contactPhone,setContactPhone]=useState(detail.robot.contactPhone??'');
  const telegramUrl=`/api/robot-marketplace/${encodeURIComponent(detail.robot.slug)}/telegram`;
  const readTelegram=async()=>{try{const response=await fetch(telegramUrl,{headers:await headers(),cache:'no-store'});if(response.ok){const body=await response.json();setTelegram(body);setChatId(body.chatId??'')}}catch{setMessage('Telegram status is unavailable.')}};
  useEffect(()=>{if(detail.canManage)void readTelegram()},[detail.canManage]);
  const connect=async()=>{setBusy(true);setMessage('');try{const response=await fetch(telegramUrl,{method:'POST',headers:await headers(true),body:JSON.stringify({telegramToken:token.trim(),chatId:chatId.trim()})});const body=await response.json();if(!response.ok)throw new Error(body?.error?.message||'Telegram could not connect.');setToken('');setMessage('Telegram connected. Send a test message to verify delivery.');await readTelegram()}catch(cause){setMessage(cause instanceof Error?cause.message:'Telegram could not connect.')}finally{setBusy(false)}};
  const test=async()=>{setBusy(true);setMessage('');try{const response=await fetch(`${telegramUrl}/test`,{method:'POST',headers:await headers(true),body:'{}'});const body=await response.json();if(!response.ok||body.ok===false)throw new Error(body?.error?.message||body?.description||'Test message failed.');setMessage('Test message sent.')}catch(cause){setMessage(cause instanceof Error?cause.message:'Test message failed.')}finally{setBusy(false)}};
  const disconnect=async()=>{setBusy(true);setMessage('');try{const response=await fetch(telegramUrl,{method:'DELETE',headers:await headers()});const body=await response.json();if(!response.ok)throw new Error(body?.error?.message||'Telegram could not be disconnected.');setChatId('');setMessage('Telegram disconnected.');await readTelegram()}catch(cause){setMessage(cause instanceof Error?cause.message:'Telegram could not be disconnected.')}finally{setBusy(false)}};
  const saveContact=async()=>{setBusy(true);setMessage('');try{const response=await fetch(`/api/robot-marketplace/${encodeURIComponent(detail.robot.slug)}/contact`,{method:'POST',headers:await headers(true),body:JSON.stringify({contactPhone})});const body=await response.json();if(!response.ok)throw new Error(body?.error?.message||'Contact number could not be saved.');setMessage('Contact number saved.');await reload()}catch(cause){setMessage(cause instanceof Error?cause.message:'Contact number could not be saved.')}finally{setBusy(false)}};
  return <div className="robot-screen"><header className="screen-heading"><small>ROBOT APP</small><h1>Settings</h1></header>
    <section className="robot-panel"><h2><Palette/> Appearance & identity</h2><p className="robot-section-intro">Choose the accent for this robot workspace.</p><div className="robot-themes">{themes.map(option=><button key={option} className={theme===option?'active':''} onClick={()=>setTheme(option)} aria-pressed={theme===option}><i data-theme={option}/><span>{option}</span></button>)}</div>{detail.canManage&&<><button className="robot-text-button" onClick={()=>setCoverOpen(value=>!value)}><ImageIcon size={16}/> Robot cover</button>{coverOpen&&<RoomCoverPicker purpose="robot-cover" robotId={detail.robot.id} currentUrl={detail.robot.coverUrl??null} aspect="portrait" onChange={()=>void reload()}/>}</>}</section>
    <section className="robot-panel"><h2><Send/> Telegram connection</h2>{!detail.canManage?<p>Only the robot creator can manage notifications.</p>:<><p className="robot-section-intro">Connect a Telegram bot for this robot. Its token is encrypted and is not shared with your other robots.</p><div className="robot-field-grid"><label>Bot token<input type="password" autoComplete="off" value={token} onChange={event=>setToken(event.target.value)} placeholder={telegram?.bot?'Saved token · enter to replace':'Token from BotFather'}/></label><label>Telegram chat ID<input inputMode="numeric" value={chatId} onChange={event=>setChatId(event.target.value)} placeholder="Numeric chat ID"/></label></div><div className="robot-settings-actions"><button className="robot-primary fit" disabled={busy||!token.trim()} onClick={()=>void connect()}><Send size={15}/>Connect Telegram</button><button disabled={busy||!telegram?.connected} onClick={()=>void test()}>Send test</button>{telegram?.tokenConfigured&&<button disabled={busy} onClick={()=>void disconnect()}>Disconnect</button>}</div><p className="robot-connection-state"><ShieldCheck size={15}/>{telegram?.connected?`Connected to @${telegram.bot?.username??'bot'} · chat ${telegram.chatId}`:'Telegram is not connected yet'}</p><a className="robot-text-button" href={telegram?.bot?.username?`https://t.me/${telegram.bot.username}`:'https://t.me/BotFather'} target="_blank" rel="noreferrer">Open Telegram ↗</a></>}</section>
    {detail.canManage&&<section className="robot-panel"><h2>Contact details</h2><p className="robot-section-intro">Optional phone number shown with this robot.</p><div className="robot-field-grid"><label>Phone number<input type="tel" value={contactPhone} onChange={event=>setContactPhone(event.target.value)} placeholder="+27 82 000 0000"/></label></div><button className="robot-text-button" disabled={busy} onClick={()=>void saveContact()}>Save contact number</button></section>}
    {detail.canManage&&<RobotAlerts robot={detail.robot} headers={headers} reload={reload}/>}
    {message&&<p className="robot-inline-warning" role="status">{message}</p>}
  </div>;
}

export function RobotAlerts({robot,headers,reload}:{robot:RobotSummary;headers:HeadersFactory;reload:()=>Promise<void>}){
  const [alerts,setAlerts]=useState(robot.alertPreferences??{entry:false,exit:false,fill:false,risk:false});
  const [message,setMessage]=useState('');
  const save=async(next:typeof alerts)=>{const previous=alerts;setAlerts(next);setMessage('');try{const response=await fetch(`/api/robot-marketplace/${encodeURIComponent(robot.slug)}/alerts`,{method:'POST',headers:await headers(true),body:JSON.stringify(next)});const body=await response.json();if(!response.ok)throw new Error(body?.error?.message||'Alerts could not be saved.');await reload()}catch(cause){setAlerts(previous);setMessage(cause instanceof Error?cause.message:'Alerts could not be saved.')}};
  return <section className="robot-panel"><h2>Strategy notifications</h2><p className="robot-section-intro">Choose the events that should reach your Telegram chat while this paper bot runs.</p><div className="robot-alert-options">{([['entry','Entry signal'],['exit','Exit signal'],['fill','Paper fill or close'],['risk','Risk rejection']] as const).map(([key,label])=><label key={key}><span>{label}</span><input type="checkbox" checked={alerts[key]} onChange={event=>void save({...alerts,[key]:event.target.checked})}/></label>)}</div>{message&&<p className="robot-inline-warning" role="alert">{message}</p>}</section>;
}
