/**
 * Minimal title bar that blends with the app.
 * Stoplight buttons are native (hiddenInset). Title bar is just a
 * draggable strip with agent name, theme toggle, and agent switcher.
 * Matches Samantha WindowControls pattern: 36px height, bg-secondary,
 * emerald title, icon buttons on right.
 */

import { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';

export default function TitleBar() {
  const { agentRoot } = useApp();
  const [agentName, setAgentName] = useState('KyberBot');
  const [isDark, setIsDark] = useState(true);
  const [showMenu, setShowMenu] = useState(false);

  useEffect(() => {
    const kb = (window as any).kyberbot;
    if (!kb) return;
    kb.config.readIdentity().then((id: any) => {
      if (id?.agent_name) setAgentName(id.agent_name);
    });
    setIsDark(!document.documentElement.classList.contains('light'));
  }, [agentRoot]);

  const toggleTheme = () => {
    const next = !isDark;
    setIsDark(next);
    if (next) {
      document.documentElement.classList.remove('light');
      localStorage.setItem('kyberbot_theme', 'dark');
    } else {
      document.documentElement.classList.add('light');
      localStorage.setItem('kyberbot_theme', 'light');
    }
  };

  const switchAgent = async () => {
    const kb = (window as any).kyberbot;
    const result = await kb.config.selectAgentRoot();
    if (result?.hasIdentity) window.location.reload();
    else if (result) alert(`No identity.yaml found in ${result.path}`);
    setShowMenu(false);
  };

  const createNewAgent = () => {
    (window as any).kyberbot.config.setAgentRoot('').then(() => window.location.reload());
    setShowMenu(false);
  };

  return (
    <div
      className="flex items-center h-[36px] px-3 relative"
      style={{
        WebkitAppRegion: 'drag' as any,
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border-color)',
      }}
    >
      {/* Spacer for native macOS stoplight buttons (hiddenInset) */}
      <div className="w-[70px] flex-shrink-0" />

      {/* Center: Agent name — clickable dropdown */}
      <div className="flex-1 flex items-center justify-center">
        <button
          onClick={() => setShowMenu(!showMenu)}
          className="flex items-center gap-1"
          style={{ WebkitAppRegion: 'no-drag' as any, background: 'transparent', border: 'none', cursor: 'pointer' }}
        >
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '9px', letterSpacing: '0.15em', color: 'var(--accent-emerald)', textTransform: 'uppercase' }}>
            {`// ${agentName}`}
          </span>
          <span style={{ fontSize: '7px', color: 'var(--fg-muted)', marginLeft: '4px' }}>{'\u25BE'}</span>
        </button>
      </div>

      {/* Right: Theme toggle */}
      <div className="flex items-center gap-2 w-[70px] justify-end" style={{ WebkitAppRegion: 'no-drag' as any }}>
        <button
          onClick={toggleTheme}
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontSize: '12px',
            color: 'var(--fg-muted)',
            opacity: 0.4,
            width: '20px',
            height: '20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.4')}
        >
          {isDark ? '\u263E' : '\u2600'}
        </button>
      </div>

      {/* Dropdown */}
      {showMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
          <div
            className="absolute top-full left-1/2 -translate-x-1/2 z-50 border py-1 min-w-[200px]"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-color)', WebkitAppRegion: 'no-drag' as any }}
          >
            <button onClick={switchAgent} className="w-full text-left px-3 py-1.5 text-[11px]" style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-secondary)', background: 'transparent', border: 'none', cursor: 'pointer' }} onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-tertiary)')} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
              Switch Agent...
            </button>
            <button onClick={createNewAgent} className="w-full text-left px-3 py-1.5 text-[11px]" style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-emerald)', background: 'transparent', border: 'none', cursor: 'pointer' }} onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-tertiary)')} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
              + Create New Agent
            </button>
          </div>
        </>
      )}
    </div>
  );
}
