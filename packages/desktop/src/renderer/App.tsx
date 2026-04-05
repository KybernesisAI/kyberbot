/**
 * KyberBot Desktop — Root App Component
 */

import { useState } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import TitleBar from './components/layout/TitleBar';
import TabBar, { type TabId } from './components/layout/TabBar';
import DashboardView from './components/dashboard/DashboardView';
import ChatView from './components/chat/ChatView';
import SkillsView from './components/skills/SkillsView';
import AgentsView from './components/agents/AgentsView';
import ChannelsView from './components/channels/ChannelsView';
import HeartbeatView from './components/heartbeat/HeartbeatView';
import SettingsView from './components/settings/SettingsView';
import BrainView from './components/brain/BrainView';

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
            Select the directory containing your KyberBot agent to get started.
          </p>
          <button
            onClick={async () => {
              const kb = (window as any).kyberbot;
              const result = await kb.config.selectAgentRoot();
              if (result?.hasIdentity) {
                window.location.reload();
              } else if (result) {
                alert(`No identity.yaml found in ${result.path}. Choose a directory with a configured KyberBot agent.`);
              }
            }}
            className="px-6 py-3 text-[11px] tracking-[2px] uppercase border transition-colors"
            style={{
              fontFamily: 'var(--font-mono)',
              borderColor: 'var(--accent-emerald)',
              color: 'var(--accent-emerald)',
              background: 'transparent',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.background = 'rgba(16, 185, 129, 0.1)'; }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'transparent'; }}
          >
            Select Agent Directory
          </button>
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
        {activeTab === 'chat' && <ChatView />}
        {activeTab === 'skills' && <SkillsView />}
        {activeTab === 'agents' && <AgentsView />}
        {activeTab === 'channels' && <ChannelsView />}
        {activeTab === 'heartbeat' && <HeartbeatView />}
        {activeTab === 'brain' && <BrainView />}
        {activeTab === 'settings' && <SettingsView />}
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
