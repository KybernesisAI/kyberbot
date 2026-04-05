/**
 * Brain tab — sub-tab container with Graph, Entities, Timeline, Search views.
 */

import { useState, useEffect, useCallback } from 'react';
import { useApp } from '../../context/AppContext';
import { brainFetch } from '../../utils/api';
import MemoryCanvas from './canvas/MemoryCanvas';
import EntityBrowser from './entities/EntityBrowser';
import type { GraphResponse, GraphNodeDTO } from './canvas/types';

type BrainSubTab = 'graph' | 'entities' | 'timeline' | 'search';

export default function BrainView() {
  const { serverUrl, apiToken } = useApp();
  const [activeTab, setActiveTab] = useState<BrainSubTab>('graph');
  const [graphData, setGraphData] = useState<GraphResponse>({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNodeDTO | null>(null);

  const loadGraph = useCallback(async () => {
    try {
      const data = await brainFetch<GraphResponse>(serverUrl, apiToken, '/graph?limit=150');
      setGraphData(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [serverUrl, apiToken]);

  useEffect(() => { loadGraph(); }, [loadGraph]);

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Sub-tab bar */}
      <div className="flex items-center gap-0 px-4 border-b" style={{ borderColor: 'var(--border-color)' }}>
        {(['graph', 'entities', 'timeline', 'search'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className="px-3 py-2 relative"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '9px',
              letterSpacing: '2px',
              textTransform: 'uppercase',
              color: activeTab === tab ? 'var(--accent-violet)' : 'var(--fg-muted)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            {tab}
            {activeTab === tab && (
              <div className="absolute bottom-0 left-0 right-0 h-[1px]" style={{ background: 'var(--accent-violet)' }} />
            )}
          </button>
        ))}
        <div className="flex-1" />
        <button
          onClick={() => (window as any).kyberbot?.brain?.popout()}
          className="px-2 py-1 text-[9px] tracking-[1px] uppercase"
          style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-violet)', background: 'transparent', border: 'none', cursor: 'pointer' }}
        >
          Pop Out
        </button>
        <button
          onClick={loadGraph}
          className="px-2 py-1 text-[9px] tracking-[1px] uppercase"
          style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}
        >
          Refresh
        </button>
        <span className="text-[9px] ml-2" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
          {graphData.nodes.length} nodes / {graphData.edges.length} edges
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 relative">
        {error && (
          <div className="absolute top-2 left-2 right-2 p-2 text-[11px] border z-10" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--status-error)', color: 'var(--status-error)', background: 'var(--bg-primary)' }}>
            {error}
          </div>
        )}

        {activeTab === 'graph' && (
          loading ? (
            <div className="h-full flex items-center justify-center">
              <span className="text-[11px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>Loading graph...</span>
            </div>
          ) : (
            <div className="h-full flex">
              <div className="flex-1">
                <MemoryCanvas
                  nodes={graphData.nodes}
                  edges={graphData.edges}
                  onNodeSelect={setSelectedNode}
                />
              </div>
              {selectedNode && (
                <div className="w-[280px] border-l p-3 overflow-y-auto" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
                  <div className="flex items-center justify-between mb-3">
                    <span className="section-title" style={{ color: 'var(--accent-violet)' }}>{'// ENTITY'}</span>
                    <button onClick={() => setSelectedNode(null)} className="text-[9px]" style={{ color: 'var(--fg-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Close</button>
                  </div>
                  <div className="text-[13px] font-medium mb-1" style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)' }}>{selectedNode.name}</div>
                  <div className="text-[9px] tracking-[1px] uppercase mb-3" style={{ color: 'var(--accent-cyan)' }}>{selectedNode.type}</div>
                  <div className="grid gap-2 text-[11px]" style={{ color: 'var(--fg-secondary)' }}>
                    <div><span style={{ color: 'var(--fg-muted)' }}>Mentions:</span> {selectedNode.mention_count}</div>
                    <div><span style={{ color: 'var(--fg-muted)' }}>Priority:</span> {(selectedNode.priority * 100).toFixed(0)}%</div>
                    <div><span style={{ color: 'var(--fg-muted)' }}>Tier:</span> {selectedNode.tier}</div>
                    <div><span style={{ color: 'var(--fg-muted)' }}>Last seen:</span> {new Date(selectedNode.last_seen).toLocaleDateString()}</div>
                  </div>
                </div>
              )}
            </div>
          )
        )}

        {activeTab === 'entities' && (
          <EntityBrowser />
        )}

        {activeTab === 'timeline' && (
          <TimelineSearchView serverUrl={serverUrl} apiToken={apiToken} />
        )}

        {activeTab === 'search' && (
          <HybridSearchView serverUrl={serverUrl} apiToken={apiToken} />
        )}
      </div>
    </div>
  );
}

// ── Entity Search Sub-View ──

function EntitySearchView({ serverUrl, apiToken }: { serverUrl: string; apiToken: string | null }) {
  const [query, setQuery] = useState('');
  const [entities, setEntities] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const search = async () => {
    setLoading(true);
    try {
      const data = await brainFetch<{ results: any[] }>(serverUrl, apiToken, `/entities?q=${encodeURIComponent(query)}&limit=50`);
      setEntities(data.results);
    } catch { /* offline */ }
    setLoading(false);
  };

  useEffect(() => { search(); }, []);

  return (
    <div className="h-full flex flex-col p-4">
      <div className="flex gap-2 mb-3">
        <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder="Search entities..." className="flex-1 px-2 py-1 text-[11px] outline-none" style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-secondary)', color: 'var(--fg-primary)', border: '1px solid var(--border-color)' }} />
        <button onClick={search} className="px-3 py-1 text-[9px] tracking-[1px] uppercase border" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--accent-emerald)', color: 'var(--accent-emerald)', background: 'transparent', cursor: 'pointer' }}>Search</button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && <span className="text-[11px]" style={{ color: 'var(--fg-muted)' }}>Searching...</span>}
        {entities.map((e: any) => (
          <div key={e.id || e.name} className="p-2 border-b flex items-center gap-2" style={{ borderColor: 'var(--border-color)' }}>
            <span className="text-[9px] px-1 uppercase" style={{ color: 'var(--accent-cyan)', background: 'rgba(34,211,238,0.1)' }}>{e.type}</span>
            <span className="text-[12px]" style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)' }}>{e.name}</span>
            <span className="text-[9px] ml-auto" style={{ color: 'var(--fg-muted)' }}>{e.mention_count} mentions</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Timeline Sub-View ──

function TimelineSearchView({ serverUrl, apiToken }: { serverUrl: string; apiToken: string | null }) {
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    brainFetch<{ events: any[] }>(serverUrl, apiToken, '/timeline?limit=50')
      .then(data => setEvents(data.events))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [serverUrl, apiToken]);

  return (
    <div className="h-full overflow-y-auto p-4">
      {loading && <span className="text-[11px]" style={{ color: 'var(--fg-muted)' }}>Loading timeline...</span>}
      {events.map((ev: any, i: number) => (
        <div key={i} className="p-2 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[9px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{new Date(ev.timestamp || ev.created_at).toLocaleString()}</span>
            {ev.event_type && <span className="text-[9px] px-1 uppercase" style={{ color: 'var(--accent-emerald)', background: 'rgba(16,185,129,0.1)' }}>{ev.event_type}</span>}
          </div>
          <div className="text-[11px]" style={{ color: 'var(--fg-secondary)' }}>{ev.summary || ev.content || JSON.stringify(ev).slice(0, 200)}</div>
        </div>
      ))}
      {!loading && events.length === 0 && <span className="text-[11px]" style={{ color: 'var(--fg-muted)' }}>No timeline events</span>}
    </div>
  );
}

// ── Hybrid Search Sub-View ──

function HybridSearchView({ serverUrl, apiToken }: { serverUrl: string; apiToken: string | null }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const search = async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const data = await brainFetch<{ results: any[] }>(serverUrl, apiToken, '/search', {
        method: 'POST',
        body: JSON.stringify({ query, limit: 30 }),
      });
      setResults(data.results);
    } catch { /* offline */ }
    setLoading(false);
  };

  return (
    <div className="h-full flex flex-col p-4">
      <div className="flex gap-2 mb-3">
        <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder="Semantic + keyword search..." className="flex-1 px-2 py-1 text-[11px] outline-none" style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-secondary)', color: 'var(--fg-primary)', border: '1px solid var(--border-color)' }} />
        <button onClick={search} className="px-3 py-1 text-[9px] tracking-[1px] uppercase border" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--accent-emerald)', color: 'var(--accent-emerald)', background: 'transparent', cursor: 'pointer' }}>Search</button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && <span className="text-[11px]" style={{ color: 'var(--fg-muted)' }}>Searching...</span>}
        {results.map((r: any, i: number) => (
          <div key={i} className="p-2 border-b" style={{ borderColor: 'var(--border-color)' }}>
            <div className="text-[11px] mb-1" style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)' }}>{r.title || r.content?.slice(0, 100) || 'Untitled'}</div>
            {r.score && <span className="text-[9px]" style={{ color: 'var(--fg-muted)' }}>Score: {r.score.toFixed(3)}</span>}
          </div>
        ))}
        {!loading && results.length === 0 && query && <span className="text-[11px]" style={{ color: 'var(--fg-muted)' }}>No results</span>}
      </div>
    </div>
  );
}
