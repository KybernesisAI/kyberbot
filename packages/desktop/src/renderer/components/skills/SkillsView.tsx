/**
 * Skills management tab — list, create, edit, delete skills.
 */

import { useState, useEffect, useCallback } from 'react';
import { useApp } from '../../context/AppContext';
import { manageFetch } from '../../utils/api';

interface Skill {
  name: string;
  description: string;
  version: string;
  path: string;
  hasSetup: boolean;
  requiresEnv: string[];
  isReady: boolean;
}

export default function SkillsView() {
  const { serverUrl, apiToken } = useApp();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const loadSkills = useCallback(async () => {
    try {
      const data = await manageFetch<{ skills: Skill[] }>(serverUrl, apiToken, '/skills');
      setSkills(data.skills);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [serverUrl, apiToken]);

  useEffect(() => { loadSkills(); }, [loadSkills]);

  const createSkill = async () => {
    if (!newName || !newDesc) return;
    try {
      await manageFetch(serverUrl, apiToken, '/skills', {
        method: 'POST',
        body: JSON.stringify({ name: newName, description: newDesc }),
      });
      setNewName('');
      setNewDesc('');
      setCreating(false);
      loadSkills();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const deleteSkill = async (name: string) => {
    try {
      await manageFetch(serverUrl, apiToken, `/skills/${name}`, { method: 'DELETE' });
      loadSkills();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const openEditor = async (name: string) => {
    try {
      const data = await manageFetch<{ content: string }>(serverUrl, apiToken, `/skills/${name}/content`);
      setEditContent(data.content);
      setEditing(name);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const saveContent = async () => {
    if (!editing) return;
    try {
      await manageFetch(serverUrl, apiToken, `/skills/${editing}/content`, {
        method: 'PUT',
        body: JSON.stringify({ content: editContent }),
      });
      setEditing(null);
      loadSkills();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (editing) {
    return (
      <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
        <div className="flex items-center justify-between px-4 py-2 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <span className="section-title" style={{ color: 'var(--accent-emerald)' }}>
            {`// EDITING ${editing.toUpperCase()}`}
          </span>
          <div className="flex gap-2">
            <button onClick={() => setEditing(null)} className="px-3 py-1 text-[9px] tracking-[1px] uppercase border" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--fg-muted)', color: 'var(--fg-muted)', background: 'transparent', cursor: 'pointer' }}>Cancel</button>
            <button onClick={saveContent} className="px-3 py-1 text-[9px] tracking-[1px] uppercase border" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--accent-emerald)', color: 'var(--accent-emerald)', background: 'transparent', cursor: 'pointer' }}>Save</button>
          </div>
        </div>
        <textarea
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          className="flex-1 p-4 resize-none outline-none"
          style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', background: 'var(--bg-secondary)', color: 'var(--fg-primary)', border: 'none' }}
        />
      </div>
    );
  }

  return (
    <div className="scroll-panel" style={{ height: '100%', padding: '16px', background: 'var(--bg-primary)' }}>
      <div className="flex items-center justify-between mb-4">
        <span className="section-title" style={{ color: 'var(--accent-emerald)' }}>{'// SKILLS'}</span>
        <button onClick={() => setCreating(!creating)} className="px-3 py-1 text-[9px] tracking-[1px] uppercase border" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--accent-emerald)', color: 'var(--accent-emerald)', background: 'transparent', cursor: 'pointer' }}>
          {creating ? 'Cancel' : '+ New'}
        </button>
      </div>

      {error && <div className="mb-3 p-2 text-[11px] border" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--status-error)', color: 'var(--status-error)' }}>{error}</div>}

      {creating && (
        <div className="mb-4 p-3 border" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="skill-name (kebab-case)" className="w-full mb-2 px-2 py-1 text-[11px] outline-none" style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-tertiary)', color: 'var(--fg-primary)', border: '1px solid var(--border-color)' }} />
          <input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Description" className="w-full mb-2 px-2 py-1 text-[11px] outline-none" style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-tertiary)', color: 'var(--fg-primary)', border: '1px solid var(--border-color)' }} />
          <button onClick={createSkill} className="px-3 py-1 text-[9px] tracking-[1px] uppercase border" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--accent-emerald)', color: 'var(--accent-emerald)', background: 'transparent', cursor: 'pointer' }}>Create</button>
        </div>
      )}

      {loading && <span className="text-[11px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>Loading...</span>}

      <div className="grid gap-2">
        {skills.map((skill) => (
          <div key={skill.name} className="p-3 border flex items-start justify-between" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[13px] font-medium" style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)' }}>{skill.name}</span>
                <span className="text-[9px] px-1" style={{ color: skill.isReady ? 'var(--status-success)' : 'var(--status-warning)', background: skill.isReady ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.1)' }}>
                  {skill.isReady ? 'READY' : 'NEEDS SETUP'}
                </span>
              </div>
              <span className="text-[11px]" style={{ color: 'var(--fg-secondary)' }}>{skill.description}</span>
            </div>
            <div className="flex gap-1 ml-2">
              <button onClick={() => openEditor(skill.name)} className="px-2 py-1 text-[9px] tracking-[1px] uppercase" style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-cyan)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Edit</button>
              <button onClick={() => deleteSkill(skill.name)} className="px-2 py-1 text-[9px] tracking-[1px] uppercase" style={{ fontFamily: 'var(--font-mono)', color: 'var(--status-error)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Del</button>
            </div>
          </div>
        ))}
      </div>

      {!loading && skills.length === 0 && (
        <div className="text-center py-8">
          <span className="text-[11px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>No skills installed</span>
        </div>
      )}
    </div>
  );
}
