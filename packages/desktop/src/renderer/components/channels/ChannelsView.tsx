/**
 * Channels tab — status display + configuration for Telegram and WhatsApp.
 */

import { useState, useEffect, useCallback } from 'react';
import { useApp } from '../../context/AppContext';
import { manageFetch } from '../../utils/api';

interface ChannelInfo { name: string; connected: boolean; verified: boolean | null; }
interface ChannelConfig { telegram?: { bot_token?: string; owner_chat_id?: number }; whatsapp?: { enabled?: boolean }; }

export default function ChannelsView() {
  const { serverUrl, apiToken } = useApp();
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [config, setConfig] = useState<ChannelConfig>({});
  const [loading, setLoading] = useState(true);
  const [telegramToken, setTelegramToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const loadData = useCallback(async () => {
    try {
      const [statusData, configData] = await Promise.all([
        manageFetch<{ channels: ChannelInfo[] }>(serverUrl, apiToken, '/channels'),
        manageFetch<{ channels: ChannelConfig }>(serverUrl, apiToken, '/channels/config'),
      ]);
      setChannels(statusData.channels);
      setConfig(configData.channels);
      if (configData.channels.telegram?.bot_token) setTelegramToken(configData.channels.telegram.bot_token);
    } catch { /* offline */ }
    setLoading(false);
  }, [serverUrl, apiToken]);

  useEffect(() => { loadData(); const t = setInterval(loadData, 15_000); return () => clearInterval(t); }, [loadData]);

  const saveTelegram = async () => {
    setSaving(true);
    try {
      await manageFetch(serverUrl, apiToken, '/channels/telegram', {
        method: 'POST',
        body: JSON.stringify({ bot_token: telegramToken }),
      });
      setMessage('Telegram configured. Restart services for changes to take effect.');
      setTimeout(() => setMessage(''), 5000);
      loadData();
    } catch (err) { setMessage(`Error: ${(err as Error).message}`); }
    setSaving(false);
  };

  const removeTelegram = async () => {
    setSaving(true);
    try {
      await manageFetch(serverUrl, apiToken, '/channels/telegram', { method: 'DELETE' });
      setTelegramToken('');
      setMessage('Telegram removed.');
      setTimeout(() => setMessage(''), 3000);
      loadData();
    } catch (err) { setMessage(`Error: ${(err as Error).message}`); }
    setSaving(false);
  };

  const toggleWhatsApp = async (enabled: boolean) => {
    setSaving(true);
    try {
      if (enabled) {
        await manageFetch(serverUrl, apiToken, '/channels/whatsapp', {
          method: 'POST',
          body: JSON.stringify({ enabled: true }),
        });
      } else {
        await manageFetch(serverUrl, apiToken, '/channels/whatsapp', { method: 'DELETE' });
      }
      setMessage(enabled ? 'WhatsApp enabled. Restart services and scan QR code.' : 'WhatsApp disabled.');
      setTimeout(() => setMessage(''), 5000);
      loadData();
    } catch (err) { setMessage(`Error: ${(err as Error).message}`); }
    setSaving(false);
  };

  const telegramStatus = channels.find(c => c.name === 'telegram');

  return (
    <div className="view-scroll" style={{ padding: '16px', background: 'var(--bg-primary)' }}>
      <span className="section-title" style={{ color: 'var(--accent-emerald)' }}>{'// CHANNELS'}</span>
      <p className="text-[11px] mt-1 mb-4" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
        Configure messaging channels. Restart services after changes.
      </p>

      {message && <div className="mb-3 p-2 text-[11px] border" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--accent-emerald)', color: 'var(--accent-emerald)' }}>{message}</div>}

      {loading && <span className="text-[11px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>Loading...</span>}

      {/* Telegram */}
      <div className="border p-4 mb-3" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className={`status-dot ${telegramStatus?.connected ? 'status-dot--online' : 'status-dot--offline'}`} />
            <span className="text-[13px] font-medium" style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)' }}>Telegram</span>
            {telegramStatus?.connected && <span className="text-[9px] tracking-[1px] uppercase" style={{ color: 'var(--status-success)' }}>CONNECTED</span>}
            {telegramStatus?.verified !== null && telegramStatus?.verified && <span className="text-[9px] tracking-[1px] uppercase" style={{ color: 'var(--accent-cyan)' }}>VERIFIED</span>}
          </div>
          {config.telegram?.bot_token && (
            <button onClick={removeTelegram} disabled={saving} className="text-[9px] tracking-[1px] uppercase" style={{ fontFamily: 'var(--font-mono)', color: 'var(--status-error)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Remove</button>
          )}
        </div>
        <div className="space-y-2">
          <label className="text-[9px] tracking-[1px] uppercase block" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>Bot Token</label>
          <input
            value={telegramToken}
            onChange={(e) => setTelegramToken(e.target.value)}
            placeholder="Paste token from @BotFather"
            className="w-full px-2 py-1.5 text-[11px] outline-none"
            style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-tertiary)', color: 'var(--fg-primary)', border: '1px solid var(--border-color)' }}
          />
          {config.telegram?.owner_chat_id && (
            <div className="text-[9px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>Owner ID: {config.telegram.owner_chat_id}</div>
          )}
          <button onClick={saveTelegram} disabled={saving || !telegramToken} className="px-3 py-1 text-[9px] tracking-[1px] uppercase border" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--accent-emerald)', color: 'var(--accent-emerald)', background: 'transparent', cursor: 'pointer', opacity: saving || !telegramToken ? 0.3 : 1 }}>
            {saving ? 'Saving...' : 'Save Token'}
          </button>
        </div>
      </div>

      {/* WhatsApp */}
      <div className="border p-4" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={`status-dot ${channels.find(c => c.name === 'whatsapp')?.connected ? 'status-dot--online' : 'status-dot--offline'}`} />
            <span className="text-[13px] font-medium" style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)' }}>WhatsApp</span>
          </div>
          <label className="flex items-center gap-2 cursor-pointer" style={{ WebkitAppRegion: 'no-drag' as any }}>
            <span className="text-[9px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
              {config.whatsapp?.enabled ? 'ENABLED' : 'DISABLED'}
            </span>
            <input
              type="checkbox"
              checked={config.whatsapp?.enabled ?? false}
              onChange={(e) => toggleWhatsApp(e.target.checked)}
              disabled={saving}
              style={{ accentColor: 'var(--accent-emerald)' }}
            />
          </label>
        </div>
        {config.whatsapp?.enabled && (
          <p className="text-[9px] mt-2" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
            Scan the QR code that appears in the terminal after restarting services.
          </p>
        )}
      </div>
    </div>
  );
}
