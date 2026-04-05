/**
 * Streaming log viewer.
 */

import { useState, useEffect, useRef } from 'react';

export default function LogView() {
  const [lines, setLines] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const kb = (window as any).kyberbot;
    if (!kb) return;

    const unsubscribe = kb.logs.onLine((line: string) => {
      setLines(prev => {
        const next = [...prev, line];
        return next.length > 500 ? next.slice(-500) : next;
      });
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      <div className="px-4 py-2 border-b" style={{ borderColor: 'var(--border-color)' }}>
        <span className="section-title" style={{ color: 'var(--accent-cyan)' }}>
          {'// LOGS'}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {lines.length === 0 && (
          <span className="text-[11px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
            Waiting for log output...
          </span>
        )}
        {lines.map((line, i) => (
          <div
            key={i}
            className="text-[11px] leading-5 whitespace-pre-wrap break-all"
            style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-secondary)' }}
          >
            {line}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
