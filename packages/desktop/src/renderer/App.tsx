/**
 * KyberBot Desktop — Root App Component
 */

import { useState } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import TitleBar from './components/layout/TitleBar';
import TabBar, { type TabId } from './components/layout/TabBar';
import DashboardView from './components/dashboard/DashboardView';
import LogView from './components/logs/LogView';
import PlaceholderView from './components/shared/PlaceholderView';

function AppContent() {
  const [activeTab, setActiveTab] = useState<TabId>('dashboard');
  const { isReady, agentRoot } = useApp();

  if (!isReady) {
    return (
      <div className="h-screen flex items-center justify-center" style={{ background: 'var(--bg-primary)' }}>
        <span className="text-[11px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
          Loading...
        </span>
      </div>
    );
  }

  if (!agentRoot) {
    return (
      <div className="h-screen flex flex-col" style={{ background: 'var(--bg-primary)' }}>
        <TitleBar />
        <div className="flex-1 flex flex-col items-center justify-center p-8">
          <span className="section-title mb-4" style={{ color: 'var(--accent-emerald)' }}>
            {'// WELCOME TO KYBERBOT'}
          </span>
          <p className="text-[13px] text-center max-w-md mb-6" style={{ color: 'var(--fg-secondary)', fontFamily: 'var(--font-sans)' }}>
            No agent directory configured. Run the onboarding wizard or set your agent root directory.
          </p>
          <span className="text-[9px] tracking-[2px] uppercase" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
            Onboarding wizard coming in Phase B
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      <TitleBar />
      <TabBar activeTab={activeTab} onTabChange={setActiveTab} />
      <div className="flex-1 min-h-0">
        {activeTab === 'dashboard' && <DashboardView />}
        {activeTab === 'chat' && <PlaceholderView title="Chat" description="Phase D — SSE chat with @kyberbot/web components" />}
        {activeTab === 'skills' && <PlaceholderView title="Skills" description="Phase F — Skill CRUD via management API" />}
        {activeTab === 'agents' && <PlaceholderView title="Agents" description="Phase F — Agent CRUD + spawn via management API" />}
        {activeTab === 'channels' && <PlaceholderView title="Channels" description="Phase G — Channel status and configuration" />}
        {activeTab === 'heartbeat' && <PlaceholderView title="Heartbeat" description="Phase G — Task management and heartbeat log" />}
        {activeTab === 'brain' && <PlaceholderView title="Brain" description="Phase H — p5.js canvas + entity browser" />}
        {activeTab === 'settings' && <PlaceholderView title="Settings" description="Phase E — Identity, API keys, server config" />}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}
