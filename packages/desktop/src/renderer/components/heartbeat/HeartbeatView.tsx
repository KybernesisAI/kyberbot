/**
 * Heartbeat tab — task list, structured task form, raw editor, manual trigger, log viewer.
 */

import { useState, useEffect, useCallback } from 'react';
import { useApp } from '../../context/AppContext';
import { manageFetch } from '../../utils/api';

interface HeartbeatTask {
  name: string;
  schedule: string;
  action: string;
  skill: string | null;
  window: string | null;
  lastRun: string | null;
}

export default function HeartbeatView() {
  const { serverUrl, apiToken } = useApp();
  const [tasks, setTasks] = useState<HeartbeatTask[]>([]);
  const [rawContent, setRawContent] = useState('');
  const [editContent, setEditContent] = useState('');
  const [logContent, setLogContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [message, setMessage] = useState('');
  const [tab, setTab] = useState<'tasks' | 'editor' | 'log'>('tasks');
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTask, setNewTask] = useState({ name: '', cadence: 'every 30m', action: '', skill: '', window: '' });

  const loadData = useCallback(async () => {
    try {
      const data = await manageFetch<{ tasks: HeartbeatTask[]; rawContent: string }>(serverUrl, apiToken, '/heartbeat');
      setTasks(data.tasks);
      setRawContent(data.rawContent);
      setEditContent(data.rawContent);
    } catch { /* offline */ }
    setLoading(false);
  }, [serverUrl, apiToken]);

  const loadLog = useCallback(async () => {
    try {
      const data = await manageFetch<{ content: string }>(serverUrl, apiToken, '/heartbeat/log?lines=200');
      setLogContent(data.content);
    } catch { /* offline */ }
  }, [serverUrl, apiToken]);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => { if (tab === 'log') loadLog(); }, [tab, loadLog]);

  const saveContent = async (content: string) => {
    setSaving(true);
    try {
      await manageFetch(serverUrl, apiToken, '/heartbeat', { method: 'PUT', body: JSON.stringify({ content }) });
      setRawContent(content);
      loadData();
      setMessage('Saved');
      setTimeout(() => setMessage(''), 2000);
    } catch (err) { setMessage(`Error: ${(err as Error).message}`); }
    setSaving(false);
  };

  const triggerHeartbeat = async () => {
    setTriggering(true);
    setMessage('Running heartbeat...');
    try {
      const data = await manageFetch<{ ok: boolean; output: string }>(serverUrl, apiToken, '/heartbeat/run', { method: 'POST' });
      setMessage(data.output ? 'Heartbeat completed' : 'Heartbeat triggered');
      loadData();
      setTimeout(() => setMessage(''), 5000);
    } catch (err) { setMessage(`Error: ${(err as Error).message}`); }
    setTriggering(false);
  };

  const addTask = async () => {
    if (!newTask.name || !newTask.action) return;
    const taskMd = `\n### ${newTask.name}\n- **Cadence**: ${newTask.cadence}\n${newTask.window ? `- **Window**: ${newTask.window}\n` : ''}- **Action**: ${newTask.action}\n${newTask.skill ? `- **Skill**: ${newTask.skill}\n` : ''}`;
    const updated = rawContent.trimEnd() + '\n' + taskMd;
    await saveContent(updated);
    setNewTask({ name: '', cadence: 'every 30m', action: '', skill: '', window: '' });
    setShowAddForm(false);
  };

  const formatTime = (iso: string | null) => {
    if (!iso) return 'Never';
    return new Date(iso).toLocaleString();
  };

  const inputStyle = { fontFamily: 'var(--font-mono)', fontSize: '11px', background: 'var(--bg-tertiary)', color: 'var(--fg-primary)', border: '1px solid var(--border-color)', outline: 'none', width: '100%', padding: '6px 8px' };
  const labelStyle = { color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', fontSize: '9px', letterSpacing: '1px', textTransform: 'uppercase' as const, display: 'block', marginBottom: '2px' };

  return (
    <div className="flex-col-layout" style={{ height: '100%', background: 'var(--bg-primary)' }}>
      {/* Header with tabs + actions */}
      <div className="flex items-center px-4 border-b" style={{ borderColor: 'var(--border-color)' }}>
        <div className="flex items-center gap-0 flex-1">
          {(['tasks', 'editor', 'log'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} className="px-3 py-2 relative" style={{ fontFamily: 'var(--font-mono)', fontSize: '9px', letterSpacing: '2px', textTransform: 'uppercase', color: tab === t ? 'var(--accent-emerald)' : 'var(--fg-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}>
              {t}
              {tab === t && <div className="absolute bottom-0 left-0 right-0 h-[1px]" style={{ background: 'var(--accent-emerald)' }} />}
            </button>
          ))}
        </div>
        <button
          onClick={triggerHeartbeat}
          disabled={triggering}
          className="px-3 py-1 text-[9px] tracking-[1px] uppercase border mr-2"
          style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--accent-amber)', color: 'var(--accent-amber)', background: 'transparent', cursor: triggering ? 'default' : 'pointer', opacity: triggering ? 0.5 : 1 }}
        >
          {triggering ? 'Running...' : 'Trigger Now'}
        </button>
      </div>

      {message && <div className="mx-4 mt-2 p-2 text-[11px] border" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--accent-emerald)', color: 'var(--accent-emerald)' }}>{message}</div>}

      {/* Content */}
      <div className="flex-fill scroll-panel">
        {tab === 'tasks' && (
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[9px] tracking-[1px] uppercase" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{tasks.length} tasks</span>
              <button onClick={() => setShowAddForm(!showAddForm)} className="text-[9px] tracking-[1px]" style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-emerald)', background: 'transparent', border: 'none', cursor: 'pointer' }}>
                {showAddForm ? 'Cancel' : '+ Add Task'}
              </button>
            </div>

            {showAddForm && (
              <div className="border p-3 mb-3 space-y-2" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}>
                <div><label style={labelStyle}>Task Name</label><input value={newTask.name} onChange={e => setNewTask({ ...newTask, name: e.target.value })} style={inputStyle} placeholder="e.g. Check Signups" /></div>
                <div><label style={labelStyle}>Cadence</label><input value={newTask.cadence} onChange={e => setNewTask({ ...newTask, cadence: e.target.value })} style={inputStyle} placeholder="e.g. every 30m, daily 9am" /></div>
                <div><label style={labelStyle}>Action</label><textarea value={newTask.action} onChange={e => setNewTask({ ...newTask, action: e.target.value })} style={{ ...inputStyle, height: '60px', resize: 'none' }} placeholder="What should the agent do?" /></div>
                <div><label style={labelStyle}>Skill (optional)</label><input value={newTask.skill} onChange={e => setNewTask({ ...newTask, skill: e.target.value })} style={inputStyle} placeholder="skill-name" /></div>
                <div><label style={labelStyle}>Time Window (optional)</label><input value={newTask.window} onChange={e => setNewTask({ ...newTask, window: e.target.value })} style={inputStyle} placeholder="e.g. 09:00-17:00" /></div>
                <button onClick={addTask} disabled={!newTask.name || !newTask.action} className="px-3 py-1 text-[9px] tracking-[1px] uppercase border" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--accent-emerald)', color: 'var(--accent-emerald)', background: 'transparent', cursor: 'pointer', opacity: !newTask.name || !newTask.action ? 0.3 : 1 }}>Add Task</button>
              </div>
            )}

            {loading && <span className="text-[11px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>Loading...</span>}
            {tasks.length === 0 && !loading && <div className="text-center py-8"><span className="text-[11px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>No heartbeat tasks defined</span></div>}

            <div className="grid gap-2">
              {tasks.map(task => (
                <div key={task.name} className="p-3 border" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[13px] font-medium" style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)' }}>{task.name}</span>
                    <span className="text-[9px] px-1" style={{ color: 'var(--accent-cyan)', background: 'rgba(34,211,238,0.1)' }}>{task.schedule}</span>
                  </div>
                  <div className="text-[11px] mb-1" style={{ color: 'var(--fg-secondary)' }}>{task.action}</div>
                  <div className="flex gap-4 text-[9px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
                    {task.skill && <span>Skill: {task.skill}</span>}
                    {task.window && <span>Window: {task.window}</span>}
                    <span>Last: {formatTime(task.lastRun)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'editor' && (
          <div className="h-full flex flex-col">
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="flex-1 resize-none outline-none p-3"
              style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', background: 'var(--bg-secondary)', color: 'var(--fg-primary)', border: 'none' }}
            />
            <div className="flex items-center justify-between p-2 border-t" style={{ borderColor: 'var(--border-color)' }}>
              <span className="text-[9px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{editContent.length} chars</span>
              <button
                onClick={() => saveContent(editContent)}
                disabled={saving || editContent === rawContent}
                className="px-3 py-1 text-[9px] tracking-[1px] uppercase border"
                style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--accent-emerald)', color: 'var(--accent-emerald)', background: 'transparent', cursor: 'pointer', opacity: saving || editContent === rawContent ? 0.3 : 1 }}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        )}

        {tab === 'log' && (
          <div className="p-4">
            <div className="flex justify-end mb-2">
              <button onClick={loadLog} className="text-[9px] tracking-[1px] uppercase" style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-cyan)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Refresh</button>
            </div>
            <pre className="text-[11px] whitespace-pre-wrap" style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-secondary)' }}>
              {logContent || 'No heartbeat log entries yet.'}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
