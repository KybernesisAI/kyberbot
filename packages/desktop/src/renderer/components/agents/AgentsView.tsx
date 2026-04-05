/**
 * Agents management tab — list, create, edit, delete, spawn agents.
 */

import { useState, useEffect, useCallback } from 'react';
import { useApp } from '../../context/AppContext';
import { manageFetch } from '../../utils/api';

interface Agent {
  name: string;
  description: string;
  role: string;
  model: string;
  maxTurns: number;
}

export default function AgentsView() {
  const { serverUrl, apiToken } = useApp();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newRole, setNewRole] = useState('');
  const [spawning, setSpawning] = useState<string | null>(null);
  const [spawnPrompt, setSpawnPrompt] = useState('');
  const [spawnOutput, setSpawnOutput] = useState('');

  const loadAgents = useCallback(async () => {
    try {
      const data = await manageFetch<{ agents: Agent[] }>(serverUrl, apiToken, '/agents');
      setAgents(data.agents);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [serverUrl, apiToken]);

  useEffect(() => { loadAgents(); }, [loadAgents]);

  const createAgent = async () => {
    if (!newName || !newDesc) return;
    try {
      await manageFetch(serverUrl, apiToken, '/agents', {
        method: 'POST',
        body: JSON.stringify({ name: newName, description: newDesc, role: newRole || undefined }),
      });
      setNewName('');
      setNewDesc('');
      setNewRole('');
      setCreating(false);
      loadAgents();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const deleteAgent = async (name: string) => {
    try {
      await manageFetch(serverUrl, apiToken, `/agents/${name}`, { method: 'DELETE' });
      loadAgents();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const openEditor = async (name: string) => {
    try {
      const data = await manageFetch<{ content: string }>(serverUrl, apiToken, `/agents/${name}/content`);
      setEditContent(data.content);
      setEditing(name);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const saveContent = async () => {
    if (!editing) return;
    try {
      await manageFetch(serverUrl, apiToken, `/agents/${editing}/content`, {
        method: 'PUT',
        body: JSON.stringify({ content: editContent }),
      });
      setEditing(null);
      loadAgents();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const spawnAgent = async () => {
    if (!spawning || !spawnPrompt) return;
    setSpawnOutput('');

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiToken) headers['Authorization'] = `Bearer ${apiToken}`;

    try {
      const response = await fetch(`${serverUrl}/api/web/manage/agents/${spawning}/spawn`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt: spawnPrompt }),
      });

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) return;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        // Parse SSE events
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.text) setSpawnOutput(prev => prev + data.text);
            } catch { /* skip */ }
          }
        }
      }
    } catch (err) {
      setSpawnOutput(prev => prev + `\n\nError: ${(err as Error).message}`);
    }
  };

  if (spawning) {
    return (
      <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
        <div className="flex items-center justify-between px-4 py-2 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <span className="section-title" style={{ color: 'var(--accent-violet)' }}>{`// SPAWN ${spawning.toUpperCase()}`}</span>
          <button onClick={() => { setSpawning(null); setSpawnOutput(''); setSpawnPrompt(''); }} className="px-3 py-1 text-[9px] tracking-[1px] uppercase border" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--fg-muted)', color: 'var(--fg-muted)', background: 'transparent', cursor: 'pointer' }}>Close</button>
        </div>
        <div className="p-3 border-b flex gap-2" style={{ borderColor: 'var(--border-color)' }}>
          <input value={spawnPrompt} onChange={(e) => setSpawnPrompt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && spawnAgent()} placeholder="Enter prompt..." className="flex-1 px-2 py-1 text-[11px] outline-none" style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-tertiary)', color: 'var(--fg-primary)', border: '1px solid var(--border-color)' }} />
          <button onClick={spawnAgent} className="px-3 py-1 text-[9px] tracking-[1px] uppercase border" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--accent-emerald)', color: 'var(--accent-emerald)', background: 'transparent', cursor: 'pointer' }}>Run</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <pre className="text-[11px] whitespace-pre-wrap" style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-secondary)' }}>{spawnOutput || 'Awaiting prompt...'}</pre>
        </div>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
        <div className="flex items-center justify-between px-4 py-2 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <span className="section-title" style={{ color: 'var(--accent-emerald)' }}>{`// EDITING ${editing.toUpperCase()}`}</span>
          <div className="flex gap-2">
            <button onClick={() => setEditing(null)} className="px-3 py-1 text-[9px] tracking-[1px] uppercase border" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--fg-muted)', color: 'var(--fg-muted)', background: 'transparent', cursor: 'pointer' }}>Cancel</button>
            <button onClick={saveContent} className="px-3 py-1 text-[9px] tracking-[1px] uppercase border" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--accent-emerald)', color: 'var(--accent-emerald)', background: 'transparent', cursor: 'pointer' }}>Save</button>
          </div>
        </div>
        <textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} className="flex-1 p-4 resize-none outline-none" style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', background: 'var(--bg-secondary)', color: 'var(--fg-primary)', border: 'none' }} />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4" style={{ background: 'var(--bg-primary)' }}>
      <div className="flex items-center justify-between mb-4">
        <span className="section-title" style={{ color: 'var(--accent-emerald)' }}>{'// SUB-AGENTS'}</span>
        <button onClick={() => setCreating(!creating)} className="px-3 py-1 text-[9px] tracking-[1px] uppercase border" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--accent-emerald)', color: 'var(--accent-emerald)', background: 'transparent', cursor: 'pointer' }}>{creating ? 'Cancel' : '+ New'}</button>
      </div>

      {error && <div className="mb-3 p-2 text-[11px] border" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--status-error)', color: 'var(--status-error)' }}>{error}</div>}

      {creating && (
        <div className="mb-4 p-3 border" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="agent-name (kebab-case)" className="w-full mb-2 px-2 py-1 text-[11px] outline-none" style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-tertiary)', color: 'var(--fg-primary)', border: '1px solid var(--border-color)' }} />
          <input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Description" className="w-full mb-2 px-2 py-1 text-[11px] outline-none" style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-tertiary)', color: 'var(--fg-primary)', border: '1px solid var(--border-color)' }} />
          <input value={newRole} onChange={(e) => setNewRole(e.target.value)} placeholder="Role (optional)" className="w-full mb-2 px-2 py-1 text-[11px] outline-none" style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-tertiary)', color: 'var(--fg-primary)', border: '1px solid var(--border-color)' }} />
          <button onClick={createAgent} className="px-3 py-1 text-[9px] tracking-[1px] uppercase border" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--accent-emerald)', color: 'var(--accent-emerald)', background: 'transparent', cursor: 'pointer' }}>Create</button>
        </div>
      )}

      {loading && <span className="text-[11px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>Loading...</span>}

      <div className="grid gap-2">
        {agents.map((agent) => (
          <div key={agent.name} className="p-3 border flex items-start justify-between" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[13px] font-medium" style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)' }}>{agent.name}</span>
                <span className="text-[9px] px-1" style={{ color: 'var(--accent-violet)', background: 'rgba(139,92,246,0.1)' }}>{agent.model.toUpperCase()}</span>
              </div>
              <span className="text-[11px]" style={{ color: 'var(--fg-secondary)' }}>{agent.description}</span>
              {agent.role && <div className="text-[9px] mt-1" style={{ color: 'var(--fg-muted)' }}>Role: {agent.role}</div>}
            </div>
            <div className="flex gap-1 ml-2">
              <button onClick={() => setSpawning(agent.name)} className="px-2 py-1 text-[9px] tracking-[1px] uppercase" style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-emerald)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Spawn</button>
              <button onClick={() => openEditor(agent.name)} className="px-2 py-1 text-[9px] tracking-[1px] uppercase" style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-cyan)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Edit</button>
              <button onClick={() => deleteAgent(agent.name)} className="px-2 py-1 text-[9px] tracking-[1px] uppercase" style={{ fontFamily: 'var(--font-mono)', color: 'var(--status-error)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Del</button>
            </div>
          </div>
        ))}
      </div>

      {!loading && agents.length === 0 && (
        <div className="text-center py-8">
          <span className="text-[11px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>No sub-agents installed. Create one to delegate specialized tasks.</span>
        </div>
      )}
    </div>
  );
}
