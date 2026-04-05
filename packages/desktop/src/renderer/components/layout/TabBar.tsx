/**
 * Tab navigation bar.
 */

const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'chat', label: 'Chat' },
  { id: 'skills', label: 'Skills' },
  { id: 'agents', label: 'Agents' },
  { id: 'channels', label: 'Channels' },
  { id: 'heartbeat', label: 'Heartbeat' },
  { id: 'brain', label: 'Brain' },
  { id: 'settings', label: 'Settings' },
] as const;

export type TabId = (typeof TABS)[number]['id'];

interface TabBarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

export default function TabBar({ activeTab, onTabChange }: TabBarProps) {
  return (
    <div
      className="flex items-center gap-0 px-2 border-b overflow-x-auto"
      style={{
        borderColor: 'rgba(255, 255, 255, 0.08)',
        background: 'var(--bg-secondary)',
      }}
    >
      {TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className="px-3 py-2 transition-colors relative"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '9px',
            letterSpacing: '2px',
            textTransform: 'uppercase',
            color: activeTab === tab.id ? 'var(--accent-emerald)' : 'var(--fg-muted)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {tab.label}
          {activeTab === tab.id && (
            <div
              className="absolute bottom-0 left-0 right-0 h-[1px]"
              style={{ background: 'var(--accent-emerald)' }}
            />
          )}
        </button>
      ))}
    </div>
  );
}
