import React, { useState } from 'react';
import { AuthProvider } from './context/AuthContext';
import { MarketProvider } from './context/MarketContext';
import { GoatProvider } from './context/GoatContext';

// Logic is sitting inside this components 
import { Header } from './components/Header';
import { Navigation, TabId } from './components/Navigation';
import { QuotesView } from './components/views/QuotesView';
import { GoatsView } from './components/views/GoatsView';
import { SkillsView } from './components/views/SkillsView';
import { BacktestView } from './components/views/BacktestView';
import { SettingsView } from './components/views/SettingsView';

const MainApp: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabId>('quotes');
  const [isOpenCreateGoatModal, setIsOpenCreateGoatModal] = useState(false);

  return (
    <div className="min-h-screen bg-[#080a0f] text-slate-100 flex flex-col md:flex-row font-sans selection:bg-amber-500/30 selection:text-amber-200">
      {/* Persistent Desktop Sidebar & Mobile Bottom Navigation */}
      <Navigation activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 min-h-screen pb-20 md:pb-6">
        {/* Top Header */}
        <Header
          onOpenSettings={() => setActiveTab('settings')}
          onOpenCreateGoat={() => {
            setActiveTab('goats');
            setIsOpenCreateGoatModal(true);
          }}
        />

        {/* View Surface */}
        <main className="flex-1 max-w-6xl w-full mx-auto px-3 sm:px-6 py-4 sm:py-6">
          {activeTab === 'quotes' && <QuotesView />}

          {activeTab === 'goats' && (
            <GoatsView
              isOpenCreateModal={isOpenCreateGoatModal}
              onCloseCreateModal={() => setIsOpenCreateGoatModal(false)}
              onOpenCreateModal={() => setIsOpenCreateGoatModal(true)}
            />
          )}

          {activeTab === 'skills' && <SkillsView />}

          {activeTab === 'backtest' && <BacktestView />}

          {activeTab === 'settings' && <SettingsView />}
        </main>
      </div>
    </div>
  );
};

export default function App() {
  return (
    <AuthProvider>
      <MarketProvider>
        <GoatProvider>
          <MainApp />
        </GoatProvider>
      </MarketProvider>
    </AuthProvider>
  );
}
