/**
 * Chat tab — SSE streaming chat matching the web UI design.
 * Shows tool calls, thinking status, agent name from identity.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useApp } from '../../context/AppContext';
import MemoryBlocks from './MemoryBlocks';
import SessionList from './SessionList';
import MarkdownRenderer from './MarkdownRenderer';

interface ToolCall {
  id: string;
  name: string;
  label: string;
  detail: string;
  status: 'running' | 'done' | 'error';
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  memoryUpdates?: string[];
}

// Tool-specific icons and colors (from web ToolCallCard.tsx)
const TOOL_META: Record<string, { icon: string; color: string }> = {
  Read: { icon: '\u25B7', color: '#22d3ee' },
  Write: { icon: '\u25C1', color: '#10b981' },
  Edit: { icon: '\u2710', color: '#10b981' },
  Glob: { icon: '\u2315', color: '#8b5cf6' },
  Grep: { icon: '\u2315', color: '#8b5cf6' },
  Bash: { icon: '\u276F', color: '#f59e0b' },
  WebFetch: { icon: '\u21E3', color: '#3b82f6' },
  WebSearch: { icon: '\u2317', color: '#3b82f6' },
  Agent: { icon: '\u2B22', color: '#ec4899' },
  Skill: { icon: '\u2726', color: '#ec4899' },
};

function getToolMeta(name: string) {
  return TOOL_META[name] || { icon: '\u25CF', color: '#71717a' };
}

export default function ChatView() {
  const { serverUrl, apiToken } = useApp();
  const [agentName, setAgentName] = useState('Atlas');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [streamStatus, setStreamStatus] = useState('');
  const [streamTools, setStreamTools] = useState<ToolCall[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [claudeModel, setClaudeModel] = useState('opus');
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Load agent name and model from identity
  useEffect(() => {
    const kb = (window as any).kyberbot;
    if (!kb) return;
    kb.config.readIdentity().then((id: any) => {
      if (id?.agent_name) setAgentName(id.agent_name);
      if (id?.claude?.model) setClaudeModel(id.claude.model);
    });
  }, []);

  // Load session messages
  const loadSession = useCallback(async (id: string) => {
    try {
      const headers: Record<string, string> = {};
      if (apiToken) headers['Authorization'] = `Bearer ${apiToken}`;
      const res = await fetch(`${serverUrl}/api/web/sessions/${id}/messages`, { headers });
      if (res.ok) {
        const data = await res.json();
        const msgs: Message[] = (data.messages || []).map((m: any) => ({
          role: m.role,
          content: m.content,
          toolCalls: m.toolCalls,
          memoryUpdates: m.memoryUpdates,
        }));
        setMessages(msgs);
        setSessionId(id);
      }
    } catch {}
  }, [serverUrl, apiToken]);

  const startNewSession = useCallback(() => {
    setMessages([]);
    setSessionId(undefined);
    setStreamText('');
    setStreamTools([]);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamText, streamTools]);

  const sendMessage = async () => {
    if (!input.trim() || streaming) return;
    const prompt = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: prompt }]);
    setStreaming(true);
    setStreamText('');
    setStreamStatus('thinking');
    setStreamTools([]);

    const controller = new AbortController();
    abortRef.current = controller;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiToken) headers['Authorization'] = `Bearer ${apiToken}`;

    try {
      const res = await fetch(`${serverUrl}/api/web/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt }),
        signal: controller.signal,
      });

      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();

      let fullText = '';
      const tools: ToolCall[] = [];
      const memoryUpdates: string[] = [];
      let currentEvent = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              switch (currentEvent) {
                case 'text':
                  fullText += data.text;
                  setStreamText(fullText);
                  setStreamStatus('');
                  break;
                case 'status':
                  setStreamStatus(data.status === 'thinking' ? 'Thinking...' : data.label ? `${data.label}` : data.status);
                  break;
                case 'tool_start': {
                  const tool: ToolCall = { id: data.id, name: data.name, label: data.label, detail: data.detail, status: 'running' };
                  tools.push(tool);
                  setStreamTools([...tools]);
                  setStreamStatus(`${data.label || data.name}...`);
                  break;
                }
                case 'tool_end': {
                  const t = tools.find(t => t.id === data.id);
                  if (t) {
                    t.status = data.success ? 'done' : 'error';
                    // Detect memory updates
                    const toolName = t.name;
                    const toolDetail = t.detail || '';
                    if ((toolName === 'Edit' || toolName === 'Write') && data.success) {
                      if (toolDetail.includes('SOUL')) memoryUpdates.push('soul');
                      else if (toolDetail.includes('USER')) memoryUpdates.push('user');
                      else if (toolDetail.includes('HEARTBEAT')) memoryUpdates.push('heartbeat');
                    }
                    setStreamTools([...tools]);
                  }
                  break;
                }
                case 'result':
                  setStreamStatus('');
                  break;
                case 'error':
                  fullText += `\n\nError: ${data.message}`;
                  setStreamText(fullText);
                  break;
              }
            } catch { /* skip unparseable */ }
          }
        }
      }

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: fullText,
        toolCalls: tools.length > 0 ? [...tools] : undefined,
        memoryUpdates: memoryUpdates.length > 0 ? memoryUpdates : undefined,
      }]);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${(err as Error).message}` }]);
      }
    } finally {
      setStreaming(false);
      setStreamText('');
      setStreamStatus('');
      setStreamTools([]);
      abortRef.current = null;
    }
  };

  return (
    <div style={{ height: '100%', display: 'flex', background: 'var(--bg-primary)', minHeight: 0 }}>
      {/* Main chat area */}
      <div className="flex-col-layout" style={{ flex: 1, borderRight: '1px solid var(--border-color)' }}>
        {/* Chat header */}
        <div className="border-b p-3 flex items-center gap-3" style={{ borderColor: 'var(--border-color)' }}>
          <div className="w-8 h-8 border flex items-center justify-center" style={{ borderColor: 'rgba(139,92,246,0.3)', background: 'rgba(139,92,246,0.1)' }}>
            <span className="text-[14px]" style={{ fontFamily: 'var(--font-sans)', fontWeight: 500, color: '#8b5cf6' }}>
              {agentName.charAt(0).toUpperCase()}
            </span>
          </div>
          <div>
            <h2 className="text-[14px]" style={{ fontFamily: 'var(--font-sans)', fontWeight: 400, color: 'var(--fg-primary)' }}>{agentName}</h2>
            <p className="text-[9px] tracking-[1px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{claudeModel.toUpperCase()}</p>
          </div>
        </div>

        {/* Messages */}
        <div style={{ flex: '1 1 0%', minHeight: 0, overflowY: 'auto', padding: '16px' }}>
        {messages.length === 0 && !streaming && (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <span className="text-[20px]" style={{ fontFamily: 'var(--font-sans)', fontWeight: 300, color: 'var(--fg-primary)' }}>
              {agentName}
            </span>
            <span className="text-[11px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
              What can I help you with?
            </span>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className="mb-4">
            {/* Memory update badges */}
            {msg.memoryUpdates && msg.memoryUpdates.length > 0 && (
              <div className="flex gap-1 mb-1">
                {msg.memoryUpdates.map(u => (
                  <span key={u} className="text-[8px] tracking-[1px] uppercase px-1.5 py-0.5" style={{ color: '#22d3ee', background: 'rgba(34, 211, 238, 0.1)', fontFamily: 'var(--font-mono)' }}>
                    {u} updated
                  </span>
                ))}
              </div>
            )}

            {/* Role label */}
            <div className="text-[9px] tracking-[1px] uppercase mb-1" style={{
              color: msg.role === 'user' ? '#8b5cf6' : 'var(--accent-emerald)',
              fontFamily: 'var(--font-mono)',
            }}>
              {msg.role === 'user' ? 'You' : agentName}
            </div>

            {/* Tool calls (collapsed summary) */}
            {msg.toolCalls && msg.toolCalls.length > 0 && (
              <ToolCallSummary tools={msg.toolCalls} />
            )}

            {/* Content */}
            {msg.role === 'user' ? (
              <div className="text-[13px] whitespace-pre-wrap" style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)', lineHeight: '1.6' }}>
                {msg.content}
              </div>
            ) : (
              <div className="text-[13px]" style={{ fontFamily: 'var(--font-sans)', color: 'var(--fg-primary)' }}>
                <MarkdownRenderer content={msg.content} />
              </div>
            )}
          </div>
        ))}

        {/* Streaming bubble */}
        {streaming && (
          <div className="mb-4">
            <div className="text-[9px] tracking-[1px] uppercase mb-1" style={{ color: 'var(--accent-emerald)', fontFamily: 'var(--font-mono)' }}>
              {agentName}
            </div>

            {/* Live tool calls */}
            {streamTools.length > 0 && (
              <div className="mb-2 space-y-1">
                {streamTools.map(tool => (
                  <ToolCallLine key={tool.id} tool={tool} />
                ))}
              </div>
            )}

            {/* Status indicator */}
            {streamStatus && !streamText && (
              <div className="flex items-center gap-2 mb-1">
                <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--accent-emerald)' }} />
                <span className="text-[11px]" style={{ color: 'var(--fg-tertiary)', fontFamily: 'var(--font-mono)' }}>
                  {streamStatus}
                </span>
              </div>
            )}

            {/* Streaming text */}
            {streamText && (
              <div className="text-[13px]" style={{ fontFamily: 'var(--font-sans)', color: 'var(--fg-primary)' }}>
                <MarkdownRenderer content={streamText} />
                <span className="inline-block w-[2px] h-[14px] ml-0.5 animate-pulse" style={{ background: 'var(--accent-emerald)', verticalAlign: 'text-bottom' }} />
              </div>
            )}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t p-3 flex gap-2" style={{ borderColor: 'var(--border-color)' }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && sendMessage()}
          placeholder={`Message ${agentName}...`}
          disabled={streaming}
          className="flex-1 px-3 py-2 text-[13px] outline-none"
          style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-secondary)', color: 'var(--fg-primary)', border: '1px solid var(--border-color)' }}
          autoFocus
        />
        {streaming ? (
          <button onClick={() => abortRef.current?.abort()} className="px-4 py-2 text-[9px] tracking-[1px] uppercase border" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--status-error)', color: 'var(--status-error)', background: 'transparent', cursor: 'pointer' }}>Stop</button>
        ) : (
          <button onClick={sendMessage} disabled={!input.trim()} className="px-4 py-2 text-[9px] tracking-[1px] uppercase border" style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--accent-emerald)', color: 'var(--accent-emerald)', background: 'transparent', cursor: 'pointer', opacity: input.trim() ? 1 : 0.3 }}>Send</button>
        )}
      </div>
      </div>

      {/* Sidebar — memory blocks, sessions, agent config */}
      <div style={{ width: '288px', padding: '12px', background: 'var(--bg-primary)', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <MemoryBlocks />
        <SessionList
          currentSessionId={sessionId}
          onSelectSession={loadSession}
          onNewSession={startNewSession}
        />
      </div>
    </div>
  );
}

// ── Tool call components (matching web ToolCallCard.tsx design) ──

function ToolCallLine({ tool }: { tool: ToolCall }) {
  const meta = getToolMeta(tool.name);
  const statusColor = tool.status === 'running' ? '#f59e0b' : tool.status === 'done' ? '#10b981' : '#ef4444';

  return (
    <div className="flex items-center gap-2 py-0.5 pl-2" style={{ borderLeft: `2px solid ${tool.status === 'running' ? '#8b5cf6' : tool.status === 'error' ? '#ef4444' : 'var(--border-color)'}` }}>
      <span style={{ color: meta.color, fontSize: '11px' }}>{meta.icon}</span>
      <span className="text-[10px]" style={{ color: 'var(--fg-secondary)', fontFamily: 'var(--font-mono)' }}>
        {tool.label || tool.name}
      </span>
      <span className="text-[9px] truncate max-w-[300px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
        {tool.detail}
      </span>
      <span className="text-[8px] tracking-[1px] uppercase ml-auto" style={{ color: statusColor, fontFamily: 'var(--font-mono)' }}>
        {tool.status === 'running' && <span className="inline-block animate-pulse">RUNNING</span>}
        {tool.status === 'done' && 'DONE'}
        {tool.status === 'error' && 'ERROR'}
      </span>
    </div>
  );
}

function ToolCallSummary({ tools }: { tools: ToolCall[] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-[9px] tracking-[1px] uppercase flex items-center gap-1"
        style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', background: 'transparent', border: 'none', cursor: 'pointer' }}
      >
        <span>{expanded ? '\u25BE' : '\u25B8'}</span>
        {tools.length} tool call{tools.length !== 1 ? 's' : ''}
      </button>
      {expanded && (
        <div className="mt-1 space-y-0.5">
          {tools.map(tool => <ToolCallLine key={tool.id} tool={tool} />)}
        </div>
      )}
    </div>
  );
}
