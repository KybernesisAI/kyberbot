/**
 * Brain tab — 5 sub-tabs: Graph, Entities, Notes, Timeline, Search.
 * All memories are expandable to show full content.
 */

import { useState, useEffect, useCallback } from 'react';
import { useApp } from '../../context/AppContext';
import { brainFetch, manageFetch } from '../../utils/api';
import MemoryCanvas from './canvas/MemoryCanvas';
import EntityBrowser from './entities/EntityBrowser';
import type { GraphResponse, GraphNodeDTO } from './canvas/types';

type BrainSubTab = 'graph' | 'entities' | 'notes' | 'timeline' | 'search';

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
      const msg = (err as Error).name === 'AbortError'
        ? 'Brain API timed out — the entity graph database may be busy. Try again.'
        : (err as Error).message;
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [serverUrl, apiToken]);

  useEffect(() => { loadGraph(); }, [loadGraph]);

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)' }}>
      {/* Sub-tab bar */}
      <div className="flex items-center gap-0 px-4 border-b" style={{ borderColor: 'var(--border-color)' }}>
        {(['graph', 'entities', 'notes', 'timeline', 'search'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className="px-3 py-2 relative"
            style={{
              fontFamily: 'var(--font-mono)', fontSize: '9px', letterSpacing: '2px', textTransform: 'uppercase',
              color: activeTab === tab ? 'var(--accent-violet)' : 'var(--fg-muted)',
              background: 'transparent', border: 'none', cursor: 'pointer',
            }}
          >
            {tab}
            {activeTab === tab && <div className="absolute bottom-0 left-0 right-0 h-[1px]" style={{ background: 'var(--accent-violet)' }} />}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {activeTab === 'graph' && (
          <>
            <button onClick={() => (window as any).kyberbot?.brain?.popout()} className="px-2 py-1 text-[9px] tracking-[1px] uppercase" style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-violet)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Pop Out</button>
            <button onClick={loadGraph} className="px-2 py-1 text-[9px] tracking-[1px] uppercase" style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Refresh</button>
          </>
        )}
        <span className="text-[9px] ml-2" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
          {graphData.nodes.length} nodes / {graphData.edges.length} edges
        </span>
      </div>

      {/* Content */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
        {error && (
          <div className="absolute top-2 left-2 right-2 p-2 text-[11px] border z-10" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--status-error)', color: 'var(--status-error)', background: 'var(--bg-primary)' }}>
            {error}
          </div>
        )}

        {activeTab === 'graph' && (
          loading ? (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: '11px', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>Loading graph...</span>
            </div>
          ) : (
            <div style={{ height: '100%', display: 'flex' }}>
              <div style={{ flex: 1 }}>
                <MemoryCanvas nodes={graphData.nodes} edges={graphData.edges} onNodeSelect={setSelectedNode} />
              </div>
              {selectedNode && (
                <div style={{ width: '280px', borderLeft: '1px solid var(--border-color)', padding: '12px', overflowY: 'auto', background: 'var(--bg-secondary)' }}>
                  <div className="flex items-center justify-between mb-3">
                    <span className="section-title" style={{ color: 'var(--accent-violet)' }}>{'// ENTITY'}</span>
                    <button onClick={() => setSelectedNode(null)} style={{ fontSize: '9px', color: 'var(--fg-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Close</button>
                  </div>
                  <div style={{ fontSize: '13px', fontWeight: 'bold', fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)', marginBottom: '4px' }}>{selectedNode.name}</div>
                  <div style={{ fontSize: '9px', letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--accent-cyan)', marginBottom: '12px' }}>{selectedNode.type}</div>
                  <div className="grid gap-2" style={{ fontSize: '11px', color: 'var(--fg-secondary)' }}>
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

        {activeTab === 'entities' && <EntityBrowser />}
        {activeTab === 'notes' && <BrainNotesView serverUrl={serverUrl} apiToken={apiToken} />}
        {activeTab === 'timeline' && <TimelineView serverUrl={serverUrl} apiToken={apiToken} />}
        {activeTab === 'search' && <SearchView serverUrl={serverUrl} apiToken={apiToken} />}
      </div>
    </div>
  );
}

// ── Brain Notes ──

function BrainNotesView({ serverUrl, apiToken }: { serverUrl: string; apiToken: string | null }) {
  const [notes, setNotes] = useState<any[]>([]);
  const [selectedNote, setSelectedNote] = useState<{ name: string; content: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    manageFetch<{ notes: any[] }>(serverUrl, apiToken, '/brain-notes')
      .then(d => setNotes(d.notes))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [serverUrl, apiToken]);

  const openNote = async (name: string) => {
    try {
      const data = await manageFetch<{ name: string; content: string }>(serverUrl, apiToken, `/brain-notes/${encodeURIComponent(name)}`);
      setSelectedNote(data);
    } catch {}
  };

  if (selectedNote) {
    return (
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--accent-emerald)' }}>{selectedNote.name}</span>
          <button onClick={() => setSelectedNote(null)} style={{ fontSize: '9px', letterSpacing: '1px', textTransform: 'uppercase', fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Back</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
          <pre style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{selectedNote.content}</pre>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflowY: 'auto', padding: '16px' }}>
      <span className="section-title" style={{ color: 'var(--accent-emerald)' }}>{'// BRAIN NOTES'}</span>
      <p style={{ fontSize: '11px', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', marginTop: '4px', marginBottom: '16px' }}>
        Long-form knowledge, research findings, and reference material stored in brain/
      </p>
      {loading && <span style={{ fontSize: '11px', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>Loading...</span>}
      {notes.length === 0 && !loading && <span style={{ fontSize: '11px', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>No brain notes yet</span>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {notes.map(note => (
          <div key={note.name} onClick={() => openNote(note.name)} style={{ padding: '12px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', cursor: 'pointer' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
              <span style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)' }}>{note.name}</span>
              <span style={{ fontSize: '9px', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{(note.size / 1024).toFixed(1)}KB</span>
            </div>
            <span style={{ fontSize: '9px', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
              Modified: {new Date(note.lastModified).toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Timeline (expandable) ──

function TimelineView({ serverUrl, apiToken }: { serverUrl: string; apiToken: string | null }) {
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    brainFetch<{ events: any[] }>(serverUrl, apiToken, '/timeline?limit=100')
      .then(data => setEvents(data.events))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [serverUrl, apiToken]);

  const toggle = (i: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflowY: 'auto', padding: '16px' }}>
      <span className="section-title" style={{ color: 'var(--accent-emerald)' }}>{'// TIMELINE'}</span>
      <p style={{ fontSize: '11px', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', marginTop: '4px', marginBottom: '16px' }}>
        Temporal events — click to expand full content
      </p>
      {loading && <span style={{ fontSize: '11px', color: 'var(--fg-muted)' }}>Loading...</span>}
      {events.map((ev, i) => {
        const isExpanded = expanded.has(i);
        const content = ev.summary || ev.content || JSON.stringify(ev);
        return (
          <div key={i} onClick={() => toggle(i)} style={{ padding: '8px', borderBottom: '1px solid var(--border-color)', cursor: 'pointer' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <span style={{ fontSize: '9px', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{new Date(ev.timestamp || ev.created_at).toLocaleString()}</span>
              {ev.event_type && <span style={{ fontSize: '9px', padding: '1px 4px', textTransform: 'uppercase', color: 'var(--accent-emerald)', background: 'rgba(16,185,129,0.1)', fontFamily: 'var(--font-mono)' }}>{ev.event_type}</span>}
              {ev.channel && <span style={{ fontSize: '9px', padding: '1px 4px', textTransform: 'uppercase', color: 'var(--accent-cyan)', background: 'rgba(34,211,238,0.1)', fontFamily: 'var(--font-mono)' }}>{ev.channel}</span>}
              <span style={{ fontSize: '8px', color: 'var(--fg-muted)', marginLeft: 'auto' }}>{isExpanded ? '\u25BE' : '\u25B8'}</span>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--fg-secondary)', whiteSpace: isExpanded ? 'pre-wrap' : 'nowrap', overflow: isExpanded ? 'visible' : 'hidden', textOverflow: isExpanded ? 'unset' : 'ellipsis', wordBreak: isExpanded ? 'break-word' : 'normal' }}>
              {isExpanded ? content : content.slice(0, 200)}
            </div>
          </div>
        );
      })}
      {!loading && events.length === 0 && <span style={{ fontSize: '11px', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>No timeline events</span>}
    </div>
  );
}

// ── Search (expandable results) ──

function SearchView({ serverUrl, apiToken }: { serverUrl: string; apiToken: string | null }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const search = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setExpanded(new Set());
    try {
      const data = await brainFetch<{ results: any[] }>(serverUrl, apiToken, '/search', {
        method: 'POST',
        body: JSON.stringify({ query, limit: 50 }),
      });
      setResults(data.results);
    } catch {}
    setLoading(false);
  };

  const toggle = (i: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-color)', display: 'flex', gap: '8px' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          placeholder="Search all memories (semantic + keyword)..."
          style={{ flex: 1, padding: '6px 8px', fontSize: '11px', fontFamily: 'var(--font-mono)', background: 'var(--bg-secondary)', color: 'var(--fg-primary)', border: '1px solid var(--border-color)', outline: 'none' }}
        />
        <button onClick={search} style={{ padding: '4px 12px', fontSize: '9px', letterSpacing: '1px', textTransform: 'uppercase', fontFamily: 'var(--font-mono)', border: '1px solid var(--accent-emerald)', color: 'var(--accent-emerald)', background: 'transparent', cursor: 'pointer' }}>Search</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
        {loading && <span style={{ fontSize: '11px', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>Searching...</span>}
        {results.map((r, i) => {
          const isExpanded = expanded.has(i);
          const content = r.content || '';
          const title = r.title || content.slice(0, 80) || 'Untitled';
          return (
            <div key={i} onClick={() => toggle(i)} style={{ padding: '10px', borderBottom: '1px solid var(--border-color)', cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                {r.type && <span style={{ fontSize: '8px', padding: '1px 4px', textTransform: 'uppercase', fontFamily: 'var(--font-mono)', color: r.type === 'conversation' ? 'var(--accent-cyan)' : r.type === 'note' ? 'var(--accent-emerald)' : 'var(--accent-violet)', background: r.type === 'conversation' ? 'rgba(34,211,238,0.1)' : r.type === 'note' ? 'rgba(16,185,129,0.1)' : 'rgba(139,92,246,0.1)' }}>{r.type}</span>}
                <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
                {r.score != null && <span style={{ fontSize: '8px', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{(r.score * 100).toFixed(0)}%</span>}
                <span style={{ fontSize: '8px', color: 'var(--fg-muted)' }}>{isExpanded ? '\u25BE' : '\u25B8'}</span>
              </div>
              {r.entities && r.entities.length > 0 && (
                <div style={{ display: 'flex', gap: '4px', marginBottom: '4px', flexWrap: 'wrap' }}>
                  {r.entities.slice(0, 5).map((e: string, j: number) => (
                    <span key={j} style={{ fontSize: '8px', padding: '1px 4px', color: 'var(--accent-amber)', background: 'rgba(245,158,11,0.1)', fontFamily: 'var(--font-mono)' }}>{e}</span>
                  ))}
                </div>
              )}
              <div style={{ fontSize: '11px', color: 'var(--fg-secondary)', fontFamily: 'var(--font-mono)', whiteSpace: isExpanded ? 'pre-wrap' : 'nowrap', overflow: isExpanded ? 'visible' : 'hidden', textOverflow: isExpanded ? 'unset' : 'ellipsis', wordBreak: isExpanded ? 'break-word' : 'normal' }}>
                {isExpanded ? content : content.slice(0, 200)}
              </div>
              {isExpanded && r.created_at && (
                <div style={{ fontSize: '8px', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', marginTop: '8px' }}>
                  Stored: {new Date(r.created_at).toLocaleString()}
                  {r.tier && ` | Tier: ${r.tier}`}
                  {r.priority != null && ` | Priority: ${(r.priority * 100).toFixed(0)}%`}
                </div>
              )}
            </div>
          );
        })}
        {!loading && results.length === 0 && query && <span style={{ fontSize: '11px', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>No results found</span>}
        {!query && <span style={{ fontSize: '11px', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>Enter a query to search across all memories — conversations, notes, entity facts, and brain documents</span>}
      </div>
    </div>
  );
}
