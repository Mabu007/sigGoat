import React from 'react';
import { useAuth } from '../context/AuthContext';
import { useGoat } from '../context/GoatContext';
import { useMarket } from '../context/MarketContext';
import { Sparkles, LogIn } from 'lucide-react';

interface HeaderProps {
  onOpenSettings: () => void;
  onOpenCreateGoat: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onOpenSettings, onOpenCreateGoat }) => {
  const { currentUser, profile, loginWithGoogle } = useAuth();
  const { activeGoat, goats, setActiveGoatId } = useGoat();

  return (
    <header className="sticky top-0 z-40 bg-[#080a0f]/90 backdrop-blur-md border-b border-slate-800/80 px-4 py-3">
      <div className="max-w-6xl mx-auto flex items-center justify-between gap-3">
        {/* Brand */}
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-base shadow-sm">
            🐐
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-slate-100 tracking-tight text-base sm:text-lg">
                Signal<span className="text-amber-400">GOAT</span>
              </span>
              <span className="text-[10px] text-amber-300 font-medium tracking-wide bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full">
                AI Market Analyst
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>Live Market Intelligence</span>
              <span className="text-slate-600">·</span>
              <span>Session Rhythm Active</span>
            </div>
          </div>
        </div>

        {/* Right Action Cluster */}
        <div className="flex items-center gap-2">
          {/* Quick GOAT Selector if multiple */}
          {goats.length > 1 && (
            <select
              value={activeGoat?.id}
              onChange={(e) => setActiveGoatId(e.target.value)}
              className="hidden sm:block text-xs bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-slate-300 focus:outline-none focus:border-amber-500/50"
            >
              {goats.map((g) => (
                <option key={g.id} value={g.id}>
                  🐐 {g.name}
                </option>
              ))}
            </select>
          )}

          {/* Quick Create GOAT Button */}
          <button
            onClick={onOpenCreateGoat}
            className="hidden xs:flex items-center gap-1.5 text-xs bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2.5 py-1.5 rounded-lg transition-colors font-medium"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>New GOAT</span>
          </button>

          {/* User Profile or Login */}
          {currentUser ? (
            <button
              onClick={onOpenSettings}
              className="flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 text-xs px-2.5 py-1.5 rounded-lg transition-colors"
              title="Account & Settings"
            >
              <div className="w-4 h-4 rounded-full bg-slate-700 flex items-center justify-center text-[10px] text-slate-200">
                {profile?.displayName?.charAt(0) || 'U'}
              </div>
              <span className="hidden sm:inline max-w-[90px] truncate text-slate-200">
                {profile?.displayName || 'Trader'}
              </span>
            </button>
          ) : (
            <button
              onClick={loginWithGoogle}
              className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs px-2.5 py-1.5 rounded-lg transition-colors"
            >
              <LogIn className="w-3.5 h-3.5" />
              <span>Sign In</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
