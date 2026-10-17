import React, { useCallback, useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { MarketProvider, useMarket } from './context/MarketContext';
import { GoatProvider } from './context/GoatContext';
import { ThemeProvider } from './context/ThemeContext';

import { Header } from './components/Header';
import { Navigation, type TabId } from './components/Navigation';
import { AuthGate } from './components/AuthGate';

const QuotesView = React.lazy(() => import('./components/views/QuotesView').then(module => ({ default: module.QuotesView })));
const TradeRoomsView = React.lazy(() => import('./components/views/TradeRoomsView').then(module => ({ default: module.TradeRoomsView })));
const ProposalsView = React.lazy(() => import('./components/views/ProposalsView').then(module => ({ default: module.ProposalsView })));
const SkillsView = React.lazy(() => import('./components/views/SkillsView').then(module => ({ default: module.SkillsView })));
const BacktestView = React.lazy(() => import('./components/views/BacktestView').then(module => ({ default: module.BacktestView })));
const SettingsView = React.lazy(() => import('./components/views/SettingsView').then(module => ({ default: module.SettingsView })));
const Chatbot = React.lazy(() => import('./components/Chatbot/Chatbot').then(module => ({ default: module.Chatbot })));
const PublicRobotView = React.lazy(() => import('./components/PublicRobotView').then(module => ({ default: module.PublicRobotView })));
const PublicTeamView = React.lazy(() => import('./components/PublicTeamView').then(module => ({ default: module.PublicTeamView })));

const ViewLoadingFallback: React.FC = () => (
  <div role="status" className="flex min-h-40 items-center justify-center text-sm text-fg-muted">
    Loading view…
  </div>
);

/**
 * Deep-link support without a router dependency.
 *
 * The tab lives in the URL hash rather than component state so a section can
 * be linked to and the browser Back button works. Reading and writing one
 * string is a proportionate amount of routing for six views; introducing a
 * router would be a dependency and a migration for no user-visible gain.
 */
function tabFromHash(): TabId {
  if (typeof window === 'undefined') return 'rooms';
  const raw = window.location.hash.replace(/^#\/?/, '');
  const allowed: TabId[] = ['rooms', 'trades', 'settings', 'markets', 'proposals', 'skills', 'backtest'];
  /**
   * `goats` is no longer a destination: trading agents are created as teams.
   * Old bookmarks and persisted hashes land on Trade Rooms, which is where the
   * team builder lives, rather than rendering a blank page.
   */
  if (raw === 'overview' || raw === 'markets' || raw === 'goats') return 'rooms';
  if (raw === 'proposals') return 'trades';
  return allowed.includes(raw as TabId) ? (raw as TabId) : 'rooms';
}

const MainApp: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabId>(tabFromHash);
  const [createTeamRequested, setCreateTeamRequested] = useState(false);
  const [selectedRoom, setSelectedRoom] = useState<{ type: 'team' | 'bot'; slug: string; backLabel: string } | null>(null);
  const { currentUser, profile } = useAuth();
  const { refreshQuotes, quotes } = useMarket();

  useEffect(() => {
    const onHashChange = () => { setSelectedRoom(null); setActiveTab(tabFromHash()); };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((tab: TabId) => {
    setSelectedRoom(null);
    setActiveTab(tab);
    if (typeof window !== 'undefined') {
      window.location.hash = `/${tab}`;
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    }
  }, []);

  const lastUpdatedMs = Object.values(quotes).reduce<number | null>(
    (newest, quote) => (quote.timestamp > (newest ?? 0) ? quote.timestamp : newest),
    null,
  );

  return (
    <div className={(selectedRoom ? "trade-room-app-shell " : "") + "premium-shell flex min-h-screen flex-col text-fg"}>
      <div className={(selectedRoom ? "trade-room-app-frame " : "") + "flex min-h-screen min-w-0 flex-1 flex-col pb-20"}>
        {!selectedRoom && <Header
          displayName={profile?.displayName ?? null}
          email={currentUser?.email ?? null}
          onOpenSettings={() => navigate('settings')}
          onCreateBotTeam={() => { navigate('rooms'); setCreateTeamRequested(true); }}
          onRefresh={() => void refreshQuotes()}
          lastUpdatedMs={lastUpdatedMs}
        />}

        <main className={selectedRoom ? 'trade-room-app-main w-full flex-1' : 'w-full flex-1 px-3 py-5 sm:px-6 sm:py-7 lg:px-8'}>
          <TradeRoomsView
            createTeamRequested={createTeamRequested}
            onCreateTeamRequestHandled={() => setCreateTeamRequested(false)}
            showDirectoryContent={activeTab === 'rooms' && !selectedRoom}
            onOpenRoom={(type, slug, backLabel) => { setSelectedRoom({ type, slug, backLabel }); setActiveTab('rooms'); window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }); }}
            onShowDirectory={() => navigate('rooms')}
          />
          <React.Suspense fallback={<ViewLoadingFallback />}>
            {selectedRoom?.type === 'team' && <PublicTeamView slug={selectedRoom.slug} backLabel={selectedRoom.backLabel} onBack={() => setSelectedRoom(null)} />}
            {selectedRoom?.type === 'bot' && <PublicRobotView slug={selectedRoom.slug} backLabel={selectedRoom.backLabel} onBack={() => setSelectedRoom(null)} />}
            {!selectedRoom && activeTab === 'trades' && <ProposalsView />}
            {!selectedRoom && activeTab === 'skills' && <SkillsView />}
            {!selectedRoom && activeTab === 'backtest' && <BacktestView />}
            {!selectedRoom && activeTab === 'settings' && <SettingsView />}
          </React.Suspense>
        </main>
      </div>
      {!selectedRoom && <Navigation activeTab={activeTab} onSelect={navigate} />}
    </div>
  );
};

/**
 * The intended destination for sign-in.
 *
 * Read from the query string by the gate and passed through here, so a user who
 * was deep-linked to a section lands there after authenticating instead of at
 * the default tab. Same-origin paths only: an absolute URL here would be an
 * open redirect.
 */
export function intendedDestination(): string | null {
  if (typeof window === 'undefined') return null;
  const target = new URLSearchParams(window.location.search).get('next');
  if (!target) return null;
  return isSafeInternalPath(target) ? target : null;
}

/** Only same-origin, single-slash-prefixed paths are accepted. */
export function isSafeInternalPath(value: string): boolean {
  if (!value.startsWith('/')) return false;
  // `//evil.com` and `/\evil.com` are protocol-relative URLs, not local paths.
  if (value.startsWith('//') || value.startsWith('/\\')) return false;
  return true;
}

/**
 * Sign-out destination.
 *
 * A full document navigation, not a router push: every provider above holds
 * fetched user data in memory, and a history-driven back navigation would
 * otherwise be able to re-enter the app with the previous user's data still
 * mounted.
 */
export function signOutUrl(): string {
  return '/login';
}

export default function App() {
  return (
    // Theme is outermost: it must be able to apply before anything paints.
    <ThemeProvider>
      <AuthProvider>
        <AuthGate>
            {typeof window !== 'undefined' && /^\/robot\/[^/]+\/?$/.test(window.location.pathname)
              ? <React.Suspense fallback={<ViewLoadingFallback />}><PublicRobotView slug={decodeURIComponent(window.location.pathname.split('/')[2] || '')} /></React.Suspense>
              : typeof window !== 'undefined' && /^\/team\/[^/]+\/?$/.test(window.location.pathname)
                ? <React.Suspense fallback={<ViewLoadingFallback />}><PublicTeamView slug={decodeURIComponent(window.location.pathname.split('/')[2] || '')} /></React.Suspense>
              : <>
                  <MarketProvider>
                    <GoatProvider>
                      <MainApp />
                    </GoatProvider>
                  </MarketProvider>
                  <React.Suspense fallback={null}><Chatbot /></React.Suspense>
                </>}
        </AuthGate>
      </AuthProvider>
    </ThemeProvider>
  );
}