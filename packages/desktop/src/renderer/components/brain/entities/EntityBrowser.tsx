/**
 * 3-panel entity browser — ported from Samantha CRM.
 * Layout: 260px EntityList | 1fr EntityDetail | 480px RelationshipGraph
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../../../context/AppContext';
import { brainFetch } from '../../../utils/api';

// Type colors matching Samantha
const TYPE_COLORS: Record<string, string> = {
  person: '#10b981',
  company: '#22d3ee',
  project: '#14b8a6',
  place: '#a855f7',
  topic: '#f59e0b',
};

const TYPE_ICONS: Record<string, string> = {
  person: '\u2666',
  company: '\u25A0',
  project: '\u25B2',
  place: '\u25CF',
  topic: '#',
};

interface Entity {
  id: number;
  name: string;
  type: string;
  mention_count: number;
  last_seen: string;
  tier?: string;
  priority?: number;
  aliases?: string;
  first_seen?: string;
}

interface EntityContext {
  entity: Entity;
  mentions: any[];
  related_entities: any[];
  facts?: any[];
  contradictions?: any[];
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(ms / 3600000);
  if (h < 24) return `${h}h`;
  const d = Math.floor(ms / 86400000);
  if (d < 30) return `${d}d`;
  return `${Math.floor(d / 30)}mo`;
}

export default function EntityBrowser() {
  const { serverUrl, apiToken } = useApp();
  const [entities, setEntities] = useState<Entity[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [context, setContext] = useState<EntityContext | null>(null);
  const [query, setQuery] = useState('');
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<'mentions' | 'recent' | 'alpha'>('mentions');
  const [loading, setLoading] = useState(true);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();

  const search = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (activeTypes.size > 0) params.set('type', [...activeTypes].join(','));
      params.set('limit', '100');
      const data = await brainFetch<{ results: Entity[] }>(serverUrl, apiToken, `/entities?${params}`);
      let results = data.results || [];

      // Client-side sort
      if (sort === 'mentions') results.sort((a, b) => b.mention_count - a.mention_count);
      else if (sort === 'recent') results.sort((a, b) => new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime());
      else results.sort((a, b) => a.name.localeCompare(b.name));

      setEntities(results);
    } catch {}
    setLoading(false);
  }, [serverUrl, apiToken, query, activeTypes, sort]);

  useEffect(() => {
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(search, 200);
    return () => clearTimeout(searchTimer.current);
  }, [search]);

  const selectEntity = useCallback(async (id: number) => {
    setSelectedId(id);
    try {
      const data = await brainFetch<EntityContext>(serverUrl, apiToken, `/entities/${id}`);
      setContext(data);
    } catch { setContext(null); }
  }, [serverUrl, apiToken]);

  const toggleType = (type: string) => {
    setActiveTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  return (
    <div className="h-full" style={{ display: 'grid', gridTemplateColumns: '260px 1fr', overflow: 'hidden' }}>
      {/* Left: Entity List */}
      <div className="flex flex-col border-r" style={{ borderColor: 'var(--border-color)', minHeight: 0 }}>
        {/* Search */}
        <div className="p-2 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex items-center gap-1.5 px-2 py-1" style={{ background: 'var(--bg-tertiary)' }}>
            <span style={{ fontSize: '11px', color: 'var(--fg-muted)' }}>{'\u2315'}</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search entities..."
              className="flex-1 text-[11px] outline-none"
              style={{ fontFamily: 'var(--font-mono)', background: 'transparent', color: 'var(--fg-primary)', border: 'none' }}
            />
          </div>
        </div>

        {/* Type filters */}
        <div className="p-2 border-b flex flex-wrap gap-1" style={{ borderColor: 'var(--border-color)' }}>
          {Object.entries(TYPE_COLORS).map(([type, color]) => (
            <button
              key={type}
              onClick={() => toggleType(type)}
              className="px-1.5 py-0.5 text-[8px] tracking-[0.5px] uppercase border"
              style={{
                fontFamily: 'var(--font-mono)',
                borderColor: activeTypes.has(type) ? `${color}60` : 'var(--border-color)',
                color: activeTypes.has(type) ? color : 'var(--fg-muted)',
                background: activeTypes.has(type) ? `${color}15` : 'transparent',
                cursor: 'pointer',
              }}
            >
              {TYPE_ICONS[type]} {type.slice(0, 3)}
            </button>
          ))}
          <div className="w-full flex gap-1 mt-1">
            {(['mentions', 'recent', 'alpha'] as const).map(s => (
              <button key={s} onClick={() => setSort(s)} className="text-[7px] tracking-[0.5px] uppercase" style={{ fontFamily: 'var(--font-mono)', color: sort === s ? 'var(--accent-emerald)' : 'var(--fg-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}>
                {s === 'alpha' ? 'A-Z' : s.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Entity cards */}
        <div className="flex-1 overflow-y-auto">
          {loading && <div className="p-2 text-[9px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>Loading...</div>}
          {entities.map(entity => {
            const color = TYPE_COLORS[entity.type] || '#71717a';
            const isSelected = entity.id === selectedId;
            return (
              <div
                key={entity.id}
                onClick={() => selectEntity(entity.id)}
                className="px-2 py-1.5 cursor-pointer flex items-center gap-2 transition-colors"
                style={{
                  borderLeft: isSelected ? `2px solid ${color}` : '2px solid transparent',
                  background: isSelected ? `${color}08` : 'transparent',
                }}
                onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
              >
                <div style={{ width: '6px', height: '6px', borderRadius: '9999px', background: color, flexShrink: 0, boxShadow: isSelected ? `0 0 6px ${color}80` : 'none' }} />
                <span className="flex-1 truncate text-[11px]" style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)' }}>{entity.name}</span>
                <span className="text-[8px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{timeAgo(entity.last_seen)}</span>
                <span className="text-[8px] px-1" style={{ color, background: `${color}15`, fontFamily: 'var(--font-mono)' }}>{entity.mention_count}</span>
              </div>
            );
          })}
        </div>

        {/* Count */}
        <div className="px-2 py-1 border-t text-[8px]" style={{ borderColor: 'var(--border-color)', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
          {entities.length} entities
        </div>
      </div>

      {/* Right: Entity Detail */}
      <div className="flex-1 overflow-y-auto" style={{ minHeight: 0 }}>
        {!context ? (
          <div className="h-full flex items-center justify-center">
            <span className="text-[11px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>Select an entity</span>
          </div>
        ) : (
          <div className="p-4">
            {/* Header */}
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[16px] font-bold" style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)' }}>{context.entity.name}</span>
                <span className="text-[8px] tracking-[0.5px] uppercase px-1.5 py-0.5 border" style={{ fontFamily: 'var(--font-mono)', color: TYPE_COLORS[context.entity.type] || '#71717a', borderColor: `${TYPE_COLORS[context.entity.type] || '#71717a'}40`, background: `${TYPE_COLORS[context.entity.type] || '#71717a'}10` }}>
                  {context.entity.type}
                </span>
                {context.entity.tier && (
                  <span className="text-[8px] tracking-[0.5px] uppercase px-1.5 py-0.5" style={{ fontFamily: 'var(--font-mono)', color: 'var(--status-warning)', background: 'rgba(245,158,11,0.1)' }}>{context.entity.tier}</span>
                )}
              </div>

              {/* Stats row */}
              <div className="grid grid-cols-4 gap-3 mt-3">
                {[
                  ['MENTIONS', context.entity.mention_count],
                  ['RELATIONS', context.related_entities?.length || 0],
                  ['FIRST SEEN', context.entity.first_seen ? new Date(context.entity.first_seen).toLocaleDateString() : '—'],
                  ['LAST SEEN', context.entity.last_seen ? new Date(context.entity.last_seen).toLocaleDateString() : '—'],
                ].map(([label, value]) => (
                  <div key={label as string}>
                    <div className="text-[7px] tracking-[1px] uppercase mb-0.5" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{label}</div>
                    <div className="text-[13px] font-bold" style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)' }}>{value}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Confidence bar */}
            {context.entity.priority != null && (
              <div className="mb-4">
                <div className="text-[7px] tracking-[1px] uppercase mb-1" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>CONFIDENCE</div>
                <div className="h-1.5 w-full" style={{ background: 'var(--bg-tertiary)' }}>
                  <div
                    className="h-full"
                    style={{
                      width: `${(context.entity.priority || 0) * 100}%`,
                      background: (context.entity.priority || 0) >= 0.7 ? '#10b981' : (context.entity.priority || 0) >= 0.4 ? '#f59e0b' : '#ef4444',
                    }}
                  />
                </div>
              </div>
            )}

            {/* Contradictions */}
            {context.contradictions && context.contradictions.length > 0 && (
              <div className="mb-4 p-2 border" style={{ borderColor: 'rgba(245,158,11,0.3)', background: 'rgba(245,158,11,0.05)' }}>
                <div className="text-[9px] tracking-[1px] uppercase mb-2" style={{ color: '#f59e0b', fontFamily: 'var(--font-mono)' }}>
                  {`// CONTRADICTIONS (${context.contradictions.length})`}
                </div>
                {context.contradictions.map((c: any, i: number) => (
                  <div key={i} className="text-[11px] mb-1" style={{ color: 'var(--fg-secondary)' }}>{c.description || c.fact_a || JSON.stringify(c).slice(0, 150)}</div>
                ))}
              </div>
            )}

            {/* Facts */}
            {context.facts && context.facts.length > 0 && (
              <div className="mb-4">
                <div className="text-[9px] tracking-[1px] uppercase mb-2" style={{ color: 'var(--accent-emerald)', fontFamily: 'var(--font-mono)' }}>
                  {`// FACTS (${context.facts.length})`}
                </div>
                {context.facts.map((f: any, i: number) => (
                  <div key={i} className="flex items-start gap-2 py-1 border-b" style={{ borderColor: 'var(--border-color)' }}>
                    <span className="text-[7px] tracking-[0.5px] uppercase px-1 py-0.5 mt-0.5" style={{
                      fontFamily: 'var(--font-mono)',
                      color: f.source_type === 'corrected' ? '#10b981' : f.source_type === 'confirmed' ? '#22d3ee' : 'var(--fg-muted)',
                      background: f.source_type === 'corrected' ? 'rgba(16,185,129,0.1)' : f.source_type === 'confirmed' ? 'rgba(34,211,238,0.1)' : 'var(--bg-tertiary)',
                      flexShrink: 0,
                    }}>
                      {(f.source_type || 'fact').slice(0, 4)}
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--fg-secondary)' }}>{f.content || f.fact || JSON.stringify(f).slice(0, 200)}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Relationships */}
            {context.related_entities && context.related_entities.length > 0 && (
              <div className="mb-4">
                <div className="text-[9px] tracking-[1px] uppercase mb-2" style={{ color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>
                  {`// RELATIONSHIPS (${context.related_entities.length})`}
                </div>
                <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
                  {context.related_entities.map((rel: any, i: number) => {
                    const relColor = TYPE_COLORS[rel.type] || '#71717a';
                    return (
                      <div key={i} className="flex items-center gap-2 py-1" onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-tertiary)')} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')} style={{ cursor: 'pointer' }} onClick={() => selectEntity(rel.id)}>
                        <span className="text-[9px]" style={{ color: 'var(--fg-muted)' }}>{rel.direction === 'outgoing' ? '\u2192' : '\u2190'}</span>
                        <span className="text-[8px] px-1 py-0.5 border" style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-violet)', borderColor: 'rgba(139,92,246,0.3)', background: 'rgba(139,92,246,0.1)' }}>
                          {rel.relationship || 'related'}
                        </span>
                        <span className="text-[11px]" style={{ fontFamily: 'var(--font-mono)', color: relColor }}>{rel.name}</span>
                        {rel.confidence != null && (
                          <div className="ml-auto w-[30px] h-[3px]" style={{ background: 'var(--bg-tertiary)' }}>
                            <div className="h-full" style={{ width: `${rel.confidence * 100}%`, background: 'var(--accent-emerald)' }} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Mentions timeline */}
            {context.mentions && context.mentions.length > 0 && (
              <div>
                <div className="text-[9px] tracking-[1px] uppercase mb-2" style={{ color: 'var(--accent-teal, #14b8a6)', fontFamily: 'var(--font-mono)' }}>
                  {`// MENTIONS (${context.mentions.length})`}
                </div>
                {context.mentions.slice(0, 20).map((m: any, i: number) => (
                  <div key={i} className="flex items-start gap-2 py-1">
                    <div style={{ width: '4px', height: '4px', borderRadius: '9999px', background: 'var(--accent-emerald)', marginTop: '5px', flexShrink: 0 }} />
                    <div>
                      <div className="text-[8px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
                        {new Date(m.timestamp || m.created_at).toLocaleString()}
                      </div>
                      <div className="text-[10px]" style={{ color: 'var(--fg-secondary)' }}>
                        {(m.context || m.content || '').slice(0, 200)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
