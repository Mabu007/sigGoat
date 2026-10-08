import React from 'react';
import { TrendingUp, Bot, Sparkles, History, Settings, ShieldCheck, Activity } from 'lucide-react';
import { useGoat } from '../context/GoatContext';
import { useAuth } from '../context/AuthContext';

export type TabId = 'quotes' | 'goats' | 'skills' | 'backtest' | 'settings';

interface NavigationProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

export const Navigation: React.FC<NavigationProps> = ({ activeTab, onTabChange }) => {
  const { activeGoat, activeGoatState } = useGoat();
  const { currentUser, isFirebaseConnected } = useAuth();

  const navItems = [
    { id: 'quotes' as TabId, label: 'Quotes', icon: TrendingUp },
    { id: 'goats' as TabId, label: 'GOATs', icon: Bot },
    { id: 'skills' as TabId, label: 'Skills', icon: Sparkles },
    { id: 'backtest' as TabId, label: 'Backtest', icon: History },
    { id: 'settings' as TabId, label: 'Settings', icon: Settings },
  ];

  return (
    <>
      {/* DESKTOP PERSISTENT LEFT SIDEBAR */}
      <aside className="hidden md:flex flex-col w-64 bg-[#0a0d14] border-r border-slate-800/90 h-screen sticky top-0 shrink-0 select-none z-30">
        {/* Brand / Logo */}
        <div className="p-5 border-b border-slate-800/80">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-amber-500 to-amber-300 flex items-center justify-center font-black text-slate-950 text-base shadow-lg shadow-amber-500/20">
              🐐
            </div>
            <div>
              <div className="font-extrabold tracking-tight text-slate-100 text-sm flex items-center gap-1.5">
                <span>SignalGOAT</span>
                <span className="text-[9px] font-mono font-bold px-1.5 py-0.2 bg-amber-500/15 text-amber-300 rounded border border-amber-500/30">
                  MVP
                </span>
              </div>
              <p className="text-[10px] text-slate-400 font-medium">Personal AI Market Agent</p>
            </div>
          </div>
        </div>

        {/* Active GOAT Quick Status */}
        {activeGoat && (
          <div className="px-4 py-3 mx-3 my-3 bg-[#0e121b] border border-slate-800 rounded-xl space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Active GOAT</span>
              <span className="flex items-center gap-1 text-[10px] font-mono text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                {activeGoatState?.status || 'WATCHING'}
              </span>
            </div>
            <div className="text-xs font-bold text-slate-200 truncate">{activeGoat.name}</div>
            <div className="text-[10px] text-slate-400 truncate">
              {activeGoat.markets?.join(' · ')}
            </div>
          </div>
        )}

        {/* Navigation Links */}
        <nav className="flex-1 px-3 py-2 space-y-1 overflow-y-auto">
          {navItems.map(item => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer ${
                  isActive
                    ? 'bg-amber-500 text-slate-950 font-bold shadow-md shadow-amber-500/15'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-900/60'
                }`}
              >
                <Icon className={`w-4 h-4 ${isActive ? 'stroke-[2.4]' : 'stroke-[1.8]'}`} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Footer info & connection */}
        <div className="p-4 border-t border-slate-800/80 space-y-2 text-[11px] text-slate-400">
          <div className="flex items-center justify-between font-mono text-[10px]">
            <span className="flex items-center gap-1 text-slate-400">
              <Activity className="w-3 h-3 text-sky-400" /> Market Data Feed
            </span>
            <span className="text-emerald-400">Live</span>
          </div>
          <div className="flex items-center justify-between font-mono text-[10px]">
            <span className="text-slate-400">Cloud Sync</span>
            <span className={isFirebaseConnected ? 'text-emerald-400' : 'text-amber-400'}>
              {isFirebaseConnected ? 'Synced' : 'Local'}
            </span>
          </div>
        </div>
      </aside>

      {/* MOBILE BOTTOM NAVIGATION BAR */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-[#080a0f]/95 backdrop-blur-xl border-t border-slate-800/90 pb-safe">
        <div className="grid grid-cols-5 h-16 max-w-lg mx-auto">
          {navItems.map(item => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                className={`flex flex-col items-center justify-center gap-1 transition-colors relative py-1 cursor-pointer ${
                  isActive ? 'text-amber-400' : 'text-slate-400 hover:text-slate-300'
                }`}
              >
                <Icon className={`w-5 h-5 ${isActive ? 'stroke-[2.2]' : 'stroke-[1.8]'}`} />
                <span className={`text-[10px] ${isActive ? 'font-bold text-amber-300' : 'font-normal'}`}>
                  {item.label}
                </span>
                {isActive && (
                  <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-amber-400 rounded-full" />
                )}
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
};
