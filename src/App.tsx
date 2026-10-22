import React, { useCallback, useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { MarketProvider, useMarket } from './context/MarketContext';
import { ThemeProvider } from './context/ThemeContext';

import { Header } from './components/Header';
import { Navigation, type TabId } from './components/Navigation';
import { AuthGate } from './components/AuthGate';
import { AuthModal } from './components/AuthModal';

const AiRobotsView = React.lazy(() => import('./components/views/AiRobotsView').then(module => ({ default: module.AiRobotsView })));
const SettingsView = React.lazy(() => import('./components/views/SettingsView').then(module => ({ default: module.SettingsView })));
const PublicTeamView = React.lazy(() => import('./components/PublicTeamView').then(module => ({ default: module.PublicTeamView })));

const ViewLoadingFallback: React.FC = () => (
  <div role="status" className="flex min-h-40 items-center justify-center text-sm text-fg-muted">
    Loading…
  </div>
);

/**
 * Deep-link support without a router dependency.
 *
 * The tab lives in the URL hash rather than component state so a section can
 * be linked to and the browser Back button works. Reading and writing one
 * string is a proportionate amount of routing for a handful of views;
 * introducing a router would be a dependency and a migration for no
 * user-visible gain.
 */
function tabFromHash(): TabId {
  if (typeof window === 'undefined') return 'bots';
  const raw = hashPath();
  const allowed: TabId[] = ['bots', 'settings'];
  /**
   * Everything that used to be a destination belongs to a different product.
   * Those hashes now land on the bot directory, which is where the product
   * actually lives, rather than rendering a dead screen.
   */
  if (raw.startsWith('robots/') || raw === 'rooms' || raw === 'robots') return 'bots';
  if (raw === 'markets' || raw === 'proposals' || raw === 'skills' || raw === 'backtest' || raw === 'goats' || raw === 'overview') return 'bots';
  return allowed.includes(raw as TabId) ? (raw as TabId) : 'bots';
}

/** The path part of the hash, without any query string. */
function hashPath(): string {
  if (typeof window === 'undefined') return '';
  const raw = window.location.hash.replace(/^#\/?/, '');
  const query = raw.indexOf('?');
  return query >= 0 ? raw.slice(0, query) : raw;
}

/**
 * The section of the current tab to put in view.
 *
 * A room's "Connect Broker" panel sends the member to the exact connection
 * screen they need — cTrader or PropDAO — rather than to the top of a long
 * settings page and leaving them to hunt for it.
 */
function hashSection(): string {
  if (typeof window === 'undefined') return '';
  const raw = window.location.hash.replace(/^#\/?/, '');
  const query = raw.indexOf('?');
  if (query < 0) return '';
  return new URLSearchParams(raw.slice(query + 1)).get('section') ?? '';
}

const MainApp: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabId>(tabFromHash);
  const [settingsSection, setSettingsSection] = useState<string>(hashSection);
  const { currentUser, profile } = useAuth();
  const { refreshQuotes, quotes } = useMarket();

  useEffect(() => {
    const onHashChange = () => { setActiveTab(tabFromHash()); setSettingsSection(hashSection()); };
    window.addEventListener('hashchange', onHashChange);
    if (!hashPath() || hashPath() === 'rooms' || hashPath() === 'robots') window.history.replaceState(null, '', '#/bots');
    if (window.location.pathname === '/' && !window.location.hash) window.history.replaceState(null, '', '/robots/');
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((tab: TabId) => {
    setActiveTab(tab);
    if (typeof window !== 'undefined') {
      if (tab === 'bots') window.location.assign('/robots/');
      else window.location.hash = `/${tab}`;
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    }
  }, []);

  const lastUpdatedMs = Object.values(quotes).reduce<number | null>(
    (newest, quote) => (quote.timestamp > (newest ?? 0) ? quote.timestamp : newest),
    null,
  );

  return (
    <div className="premium-shell flex min-h-screen flex-col text-fg">
      <div className="flex min-h-screen min-w-0 flex-1 flex-col pb-20">
        <Header
          displayName={profile?.displayName ?? null}
          email={currentUser?.email ?? null}
          onOpenSettings={() => navigate('settings')}
          onRefresh={() => void refreshQuotes()}
          lastUpdatedMs={lastUpdatedMs}
        />

        <main className="w-full flex-1 px-3 py-5 sm:px-6 sm:py-7 lg:px-8">
          <React.Suspense fallback={<ViewLoadingFallback />}>
            {activeTab === 'bots' && <AiRobotsView />}
            {activeTab === 'settings' && <SettingsView section={settingsSection} />}
          </React.Suspense>
        </main>
      </div>
      <Navigation activeTab={activeTab} onSelect={navigate} />
    </div>
  );
};

export default function App() {
  return (
    // Theme is outermost: it must be able to apply before anything paints.
    <ThemeProvider>
      <AuthProvider>
        <AuthGate>
          <>
            {typeof window !== 'undefined' && /^\/(?:team|robots)\/[^/]+\/?$/.test(window.location.pathname)
              ? <React.Suspense fallback={<ViewLoadingFallback />}><PublicTeamView slug={decodeURIComponent(window.location.pathname.split('/')[2] || '')} backLabel="AI Robots" onBack={() => window.location.assign('/robots/')} /></React.Suspense>
              : <>
                  <MarketProvider>
                    <MainApp />
                  </MarketProvider>
                </>}
            {/* One sign-in surface for the whole product. */}
            <AuthModal />
          </>
        </AuthGate>
      </AuthProvider>
    </ThemeProvider>
  );
}
