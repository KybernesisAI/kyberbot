/**
 * Settings tab — identity, API keys, server config, backup, theme.
 */

import { useState, useEffect } from 'react';
import type { IdentityConfig, EnvConfig } from '../../../types/ipc';

export default function SettingsView() {
  const kb = (window as any).kyberbot;
  const [identity, setIdentity] = useState<IdentityConfig | null>(null);
  const [env, setEnv] = useState<EnvConfig>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    if (!kb) return;
    kb.config.readIdentity().then((id: IdentityConfig | null) => setIdentity(id));
    kb.config.readEnv().then((e: EnvConfig) => setEnv(e));
    setIsDark(document.documentElement.classList.contains('dark'));
  }, []);

  const save = async (type: string, fn: () => Promise<void>) => {
    setSaving(true);
    try {
      await fn();
      setMessage(`${type} saved`);
      setTimeout(() => setMessage(''), 2000);
    } catch (err) {
      setMessage(`Error: ${(err as Error).message}`);
    }
    setSaving(false);
  };

  const toggleTheme = () => {
    const next = !isDark;
    setIsDark(next);
    if (next) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('kyberbot_theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('kyberbot_theme', 'light');
    }
  };

  if (!identity) {
    return <div className="h-full flex items-center justify-center" style={{ background: 'var(--bg-primary)' }}>
      <span className="text-[11px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>Loading settings...</span>
    </div>;
  }

  const inputStyle = { fontFamily: 'var(--font-mono)', fontSize: '11px', background: 'var(--bg-tertiary)', color: 'var(--fg-primary)', border: '1px solid var(--border-color)', outline: 'none', width: '100%', padding: '6px 8px' };
  const labelStyle = { color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', fontSize: '9px', letterSpacing: '1px', textTransform: 'uppercase' as const, display: 'block', marginBottom: '2px' };
  const btnStyle = (color: string) => ({ fontFamily: 'var(--font-mono)', fontSize: '9px', letterSpacing: '1px', textTransform: 'uppercase' as const, borderColor: color, color, background: 'transparent', cursor: saving ? 'default' as const : 'pointer' as const, opacity: saving ? 0.5 : 1, border: '1px solid', padding: '4px 12px' });

  return (
    <div className="h-full overflow-y-auto p-4" style={{ background: 'var(--bg-primary)', overflowY: 'auto' }}>
      {message && <div className="mb-3 p-2 text-[11px] border" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--accent-emerald)', color: 'var(--accent-emerald)' }}>{message}</div>}

      {/* Identity */}
      <span className="section-title" style={{ color: 'var(--accent-emerald)' }}>{'// IDENTITY'}</span>
      <div className="grid gap-3 mt-3 mb-6">
        {([['agent_name', 'Agent Name'], ['agent_description', 'Description'], ['timezone', 'Timezone'], ['heartbeat_interval', 'Heartbeat Interval']] as const).map(([key, label]) => (
          <div key={key}><label style={labelStyle}>{label}</label><input value={(identity as any)[key] || ''} onChange={(e) => setIdentity({ ...identity, [key]: e.target.value })} style={inputStyle} /></div>
        ))}

        {/* Active Hours */}
        <div className="grid grid-cols-2 gap-2">
          <div><label style={labelStyle}>Active Hours Start</label><input value={identity.heartbeat_active_hours?.start || ''} onChange={(e) => setIdentity({ ...identity, heartbeat_active_hours: { ...identity.heartbeat_active_hours, start: e.target.value, end: identity.heartbeat_active_hours?.end || '23:00' } })} style={inputStyle} placeholder="07:00" /></div>
          <div><label style={labelStyle}>Active Hours End</label><input value={identity.heartbeat_active_hours?.end || ''} onChange={(e) => setIdentity({ ...identity, heartbeat_active_hours: { ...identity.heartbeat_active_hours, start: identity.heartbeat_active_hours?.start || '07:00', end: e.target.value } })} style={inputStyle} placeholder="23:00" /></div>
        </div>

        <button onClick={() => save('Identity', () => kb.config.writeIdentity(identity))} disabled={saving} style={btnStyle('var(--accent-emerald)')}>
          {saving ? 'Saving...' : 'Save Identity'}
        </button>
      </div>

      {/* Server Config */}
      <span className="section-title" style={{ color: 'var(--accent-cyan)' }}>{'// SERVER'}</span>
      <div className="grid gap-3 mt-3 mb-6">
        <div><label style={labelStyle}>Port</label><input value={identity.server?.port || 3456} onChange={(e) => setIdentity({ ...identity, server: { ...identity.server, port: parseInt(e.target.value) || 3456 } })} style={inputStyle} type="number" /></div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label style={labelStyle}>Claude Mode</label>
            <select
              value={identity.claude?.mode || 'subscription'}
              onChange={(e) => setIdentity({ ...identity, claude: { ...identity.claude, mode: e.target.value as any } })}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              <option value="subscription">Subscription</option>
              <option value="sdk">API Key (SDK)</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>Claude Model</label>
            <select
              value={identity.claude?.model || 'opus'}
              onChange={(e) => setIdentity({ ...identity, claude: { ...identity.claude, model: e.target.value } })}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              <option value="opus">Opus</option>
              <option value="sonnet">Sonnet</option>
              <option value="haiku">Haiku</option>
            </select>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label style={labelStyle} className="mb-0">Tunnel</label>
          <input type="checkbox" checked={identity.tunnel?.enabled || false} onChange={(e) => setIdentity({ ...identity, tunnel: { enabled: e.target.checked } })} style={{ accentColor: 'var(--accent-emerald)' }} />
          <span className="text-[9px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{identity.tunnel?.enabled ? 'Enabled' : 'Disabled'}</span>
        </div>
      </div>

      {/* Tunnel / ngrok */}
      <span className="section-title" style={{ color: 'var(--accent-teal, var(--accent-cyan))' }}>{'// TUNNEL'}</span>
      <div className="grid gap-3 mt-3 mb-6">
        <div><label style={labelStyle}>ngrok Auth Token</label><input type="password" value={env['NGROK_AUTHTOKEN'] || ''} onChange={(e) => setEnv({ ...env, NGROK_AUTHTOKEN: e.target.value })} style={inputStyle} placeholder="Paste your ngrok auth token" /></div>
        {identity.tunnel?.enabled && env['NGROK_AUTHTOKEN'] && (
          <div className="p-2 border" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
            <div className="text-[9px] tracking-[1px] uppercase mb-1" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>Tunnel Status</div>
            <div className="text-[11px]" style={{ color: 'var(--accent-emerald)', fontFamily: 'var(--font-mono)' }}>
              Tunnel will start when services are running. Check dashboard for URL.
            </div>
          </div>
        )}
      </div>

      {/* Backup Config */}
      <span className="section-title" style={{ color: 'var(--accent-violet)' }}>{'// BACKUP'}</span>
      <div className="grid gap-3 mt-3 mb-6">
        <div className="flex items-center gap-2">
          <input type="checkbox" checked={identity.backup?.enabled || false} onChange={(e) => setIdentity({ ...identity, backup: { ...identity.backup, enabled: e.target.checked, remote_url: identity.backup?.remote_url || '', schedule: identity.backup?.schedule || '24h' } })} style={{ accentColor: 'var(--accent-emerald)' }} />
          <span className="text-[11px]" style={{ color: 'var(--fg-secondary)', fontFamily: 'var(--font-mono)' }}>Enable GitHub backup</span>
        </div>
        {identity.backup?.enabled && (
          <>
            <div><label style={labelStyle}>GitHub Remote URL</label><input value={identity.backup?.remote_url || ''} onChange={(e) => setIdentity({ ...identity, backup: { ...identity.backup!, remote_url: e.target.value } })} style={inputStyle} placeholder="https://github.com/user/repo.git" /></div>
            <div className="grid grid-cols-2 gap-2">
              <div><label style={labelStyle}>Schedule</label><input value={identity.backup?.schedule || '24h'} onChange={(e) => setIdentity({ ...identity, backup: { ...identity.backup!, schedule: e.target.value } })} style={inputStyle} placeholder="24h" /></div>
              <div><label style={labelStyle}>Branch</label><input value={identity.backup?.branch || 'main'} onChange={(e) => setIdentity({ ...identity, backup: { ...identity.backup!, branch: e.target.value } })} style={inputStyle} placeholder="main" /></div>
            </div>
          </>
        )}
      </div>

      {/* API Keys */}
      <span className="section-title" style={{ color: 'var(--accent-amber)' }}>{'// API KEYS'}</span>
      <div className="grid gap-3 mt-3 mb-6">
        {['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'KYBERNESIS_API_KEY'].map(key => (
          <div key={key}><label style={labelStyle}>{key}</label><input type="password" value={env[key] || ''} onChange={(e) => setEnv({ ...env, [key]: e.target.value })} style={inputStyle} placeholder="Not set" /></div>
        ))}
        {/* API Token — visible and copyable */}
        <div>
          <label style={labelStyle}>KYBERBOT_API_TOKEN</label>
          <div className="flex gap-1">
            <input
              type="text"
              value={env['KYBERBOT_API_TOKEN'] || ''}
              onChange={(e) => setEnv({ ...env, KYBERBOT_API_TOKEN: e.target.value })}
              style={{ ...inputStyle, userSelect: 'text', WebkitUserSelect: 'text' } as any}
              readOnly={!!env['KYBERBOT_API_TOKEN']}
            />
            <button
              onClick={() => {
                if (env['KYBERBOT_API_TOKEN']) {
                  navigator.clipboard.writeText(env['KYBERBOT_API_TOKEN']);
                  setMessage('Token copied to clipboard');
                  setTimeout(() => setMessage(''), 2000);
                }
              }}
              className="px-2 text-[9px] tracking-[1px] uppercase border whitespace-nowrap"
              style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--accent-cyan)', color: 'var(--accent-cyan)', background: 'transparent', cursor: 'pointer' }}
            >
              Copy
            </button>
          </div>
        </div>
        <button onClick={() => save('.env', () => kb.config.writeEnv(env))} disabled={saving} style={btnStyle('var(--accent-amber)')}>
          {saving ? 'Saving...' : 'Save .env'}
        </button>
      </div>

      {/* Theme */}
      <span className="section-title" style={{ color: 'var(--fg-tertiary)' }}>{'// APPEARANCE'}</span>
      <div className="mt-3 mb-6">
        <button
          onClick={toggleTheme}
          className="flex items-center gap-3 p-3 border w-full transition-colors"
          style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)', cursor: 'pointer' }}
        >
          <span className="text-[16px]">{isDark ? '\u263E' : '\u2600'}</span>
          <div className="text-left">
            <div className="text-[12px]" style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)' }}>{isDark ? 'Dark Mode' : 'Light Mode'}</div>
            <div className="text-[9px]" style={{ color: 'var(--fg-muted)' }}>Click to switch to {isDark ? 'light' : 'dark'} mode</div>
          </div>
        </button>
      </div>
    </div>
  );
}
