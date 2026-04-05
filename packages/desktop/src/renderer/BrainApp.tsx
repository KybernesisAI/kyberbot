/**
 * Standalone brain graph window for pop-out.
 */

import { useState, useEffect, useCallback } from 'react';
import MemoryCanvas from './components/brain/canvas/MemoryCanvas';
import type { GraphResponse, GraphNodeDTO } from './components/brain/canvas/types';

export default function BrainApp() {
  const [graphData, setGraphData] = useState<GraphResponse>({ nodes: [], edges: [] });
  const [selectedNode, setSelectedNode] = useState<GraphNodeDTO | null>(null);
  const [loading, setLoading] = useState(true);

  const loadGraph = useCallback(async () => {
    try {
      const kb = (window as any).kyberbot;
      if (!kb) return;
      const [token, url] = await Promise.all([kb.config.getApiToken(), kb.config.getServerUrl()]);
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`${url}/brain/graph?limit=200`, { headers });
      if (res.ok) setGraphData(await res.json());
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { loadGraph(); }, [loadGraph]);

  return (
    <div style={{ height: '100%', width: '100%', background: '#0a0a0a' }}>
      {loading ? (
        <div className="h-full flex items-center justify-center">
          <span className="text-[11px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>Loading brain graph...</span>
        </div>
      ) : (
        <MemoryCanvas nodes={graphData.nodes} edges={graphData.edges} onNodeSelect={setSelectedNode} />
      )}
    </div>
  );
}
