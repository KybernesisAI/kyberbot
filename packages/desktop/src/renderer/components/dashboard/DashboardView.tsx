/**
 * Dashboard — service status cards and health summary.
 */

import { useState, useEffect, useRef } from 'react';
import { useApp } from '../../context/AppContext';

const SERVICE_NAMES = ['ChromaDB', 'Server', 'Heartbeat', 'Sleep Agent', 'Channels', 'Tunnel'];

function statusColor(status: string): string {
  switch (status) {
    case 'running': return 'var(--status-success)';
    case 'disabled': return 'var(--fg-muted)';
    case 'error': return 'var(--status-error)';
    case 'starting': return 'var(--status-warning)';
    default: return 'var(--fg-muted)';
  }
}

function statusDot(status: string): string {
  switch (status) {
    case 'running': return 'status-dot--online';
    case 'error': return 'status-dot--error';
    default: return 'status-dot--offline';
  }
}

function LogSection() {
  const [lines, setLines] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const kb = (window as any).kyberbot;
    if (!kb) return;
    return kb.logs.onLine((line: string) => {
      setLines(prev => {
        const next = [...prev, line];
        return next.length > 200 ? next.slice(-200) : next;
      });
    });
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  return (
    <div className="mt-6">
      <span className="section-title" style={{ color: 'var(--fg-tertiary)' }}>{'// LOGS'}</span>
      <div className="mt-2 border overflow-y-auto" style={{ maxHeight: '200px', borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
        <div className="p-2">
          {lines.length === 0 && <span className="text-[9px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>Waiting for log output...</span>}
          {lines.map((line, i) => (
            <div key={i} className="text-[10px] leading-4 whitespace-pre-wrap break-all" style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-secondary)' }}>{line}</div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}

export default function DashboardView() {
  const { health, cliStatus } = useApp();
  const kb = (window as any).kyberbot;

  const isRunning = health !== null && health.status !== 'offline';
  const services = health?.services ?? SERVICE_NAMES.map(name => ({ name, status: 'stopped' }));

  return (
    <div className="scroll-panel" style={{ height: '100%', padding: '16px', background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <span className="section-title" style={{ color: 'var(--accent-emerald)' }}>
          {'// SERVICES'}
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => kb?.services.start()}
            disabled={isRunning}
            className="px-3 py-1 text-[9px] tracking-[1px] uppercase border transition-colors"
            style={{
              fontFamily: 'var(--font-mono)',
              borderColor: isRunning ? 'var(--fg-muted)' : 'var(--accent-emerald)',
              color: isRunning ? 'var(--fg-muted)' : 'var(--accent-emerald)',
              background: 'transparent',
              cursor: isRunning ? 'default' : 'pointer',
              opacity: isRunning ? 0.4 : 1,
            }}
          >
            Start
          </button>
          <button
            onClick={() => kb?.services.stop()}
            disabled={!isRunning}
            className="px-3 py-1 text-[9px] tracking-[1px] uppercase border transition-colors"
            style={{
              fontFamily: 'var(--font-mono)',
              borderColor: isRunning ? 'var(--status-error)' : 'var(--fg-muted)',
              color: isRunning ? 'var(--status-error)' : 'var(--fg-muted)',
              background: 'transparent',
              cursor: isRunning ? 'pointer' : 'default',
              opacity: isRunning ? 1 : 0.4,
            }}
          >
            Stop
          </button>
        </div>
      </div>

      {/* Service Grid */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {services.map((svc) => (
          <div
            key={svc.name}
            className="p-3 border"
            style={{
              background: 'var(--bg-secondary)',
              borderColor: 'var(--border-color)',
            }}
          >
            <div className="flex items-center gap-2 mb-1">
              <div className={`status-dot ${statusDot(svc.status)}`} />
              <span
                className="text-[11px] font-medium"
                style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)' }}
              >
                {svc.name}
              </span>
            </div>
            <span
              className="text-[9px] uppercase tracking-[1px]"
              style={{ color: statusColor(svc.status) }}
            >
              {svc.status}
            </span>
          </div>
        ))}
      </div>

      {/* Health Summary */}
      {health && health.status !== 'offline' && (
        <div>
          <span className="section-title" style={{ color: 'var(--accent-cyan)' }}>
            {'// HEALTH'}
          </span>
          <div className="grid grid-cols-3 gap-3 mt-2">
            <div className="p-3 border" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}>
              <div className="text-[9px] tracking-[1px] uppercase mb-1" style={{ color: 'var(--fg-muted)' }}>Uptime</div>
              <div className="text-[13px]" style={{ fontFamily: 'var(--font-mono)' }}>{health.uptime}</div>
            </div>
            <div className="p-3 border" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}>
              <div className="text-[9px] tracking-[1px] uppercase mb-1" style={{ color: 'var(--fg-muted)' }}>Channels</div>
              <div className="text-[13px]" style={{ fontFamily: 'var(--font-mono)' }}>
                {health.channels.filter(c => c.connected).length}/{health.channels.length}
              </div>
            </div>
            <div className="p-3 border" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}>
              <div className="text-[9px] tracking-[1px] uppercase mb-1" style={{ color: 'var(--fg-muted)' }}>PID</div>
              <div className="text-[13px]" style={{ fontFamily: 'var(--font-mono)' }}>{health.pid}</div>
            </div>
          </div>
        </div>
      )}

      {/* Status when offline */}
      {(!health || health.status === 'offline') && (
        <div className="flex items-center justify-center p-8">
          <span className="text-[11px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
            {cliStatus === 'starting' ? 'Starting KyberBot...' : 'KyberBot is not running. Click Start to begin.'}
          </span>
        </div>
      )}

      {/* Integrated Log Viewer */}
      {isRunning && <LogSection />}
    </div>
  );
}
