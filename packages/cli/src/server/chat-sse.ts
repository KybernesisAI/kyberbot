/**
 * KyberBot — Chat SSE Handler
 *
 * SSE streaming chat endpoint for the KyberBot web UI.
 * Spawns `claude` subprocess with stream-json output and pipes
 * incremental text, tool activity, and status to the browser via SSE.
 */

import { spawn } from 'node:child_process';
import type { Request, Response } from 'express';
import { getClaudeModel, getClaudeModelForRoot, isFleetMode } from '../config.js';
import { createLogger } from '../logger.js';
import { buildChannelSystemPrompt } from './channels/system-prompt.js';
import { pushUserMessage, pushAssistantMessage, buildPromptWithHistory } from './channels/conversation-history.js';
import { saveMessage, getSessionMessages, getClaudeSessionId, setClaudeSessionId } from '../brain/messages.js';

const logger = createLogger('chat-sse');

/**
 * Send an SSE event to the client.
 */
function sendEvent(res: Response, event: string, data: unknown) {
  if (!res.writableEnded) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

/**
 * Map a tool_use block to a human-readable label and detail string.
 */
function describeToolUse(name: string, input: Record<string, unknown>): { label: string; detail: string } {
  switch (name) {
    case 'Read':
      return { label: 'Reading', detail: shortPath(input.file_path as string) };
    case 'Write':
      return { label: 'Writing', detail: shortPath(input.file_path as string) };
    case 'Edit':
      return { label: 'Editing', detail: shortPath(input.file_path as string) };
    case 'Glob':
      return { label: 'Searching files', detail: String(input.pattern || '') };
    case 'Grep':
      return { label: 'Searching code', detail: String(input.pattern || '') };
    case 'Bash':
      return { label: 'Running command', detail: truncate(String(input.command || ''), 60) };
    case 'WebFetch':
      return { label: 'Fetching', detail: truncate(String(input.url || ''), 60) };
    case 'WebSearch':
      return { label: 'Searching web', detail: truncate(String(input.query || ''), 60) };
    case 'Agent':
      return { label: 'Running agent', detail: truncate(String(input.description || input.prompt || ''), 60) };
    case 'Skill':
      return { label: 'Using skill', detail: String(input.skill || '') };
    default:
      return { label: name, detail: '' };
  }
}

function shortPath(p: string | undefined): string {
  if (!p) return '';
  const parts = p.split('/');
  return parts.length <= 3 ? p : '.../' + parts.slice(-2).join('/');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '...';
}

/**
 * Build prompt with conversation history from SQLite.
 * Loads the last 20 exchanges from the session, keeps full content
 * (up to 1500 chars per message) so Claude has real context.
 */
function buildPromptFromSession(cwd: string, sessionId: string, currentMessage: string): string {
  try {
    const messages = getSessionMessages(cwd, sessionId);
    // Exclude the current user message we just saved (last entry)
    const history = messages.slice(0, -1);

    // Take the most recent 40 messages (20 exchanges)
    const recent = history.slice(-40);

    if (recent.length === 0) {
      return currentMessage;
    }

    const lines: string[] = [];
    lines.push('--- Conversation history (this session) ---');
    for (const entry of recent) {
      const label = entry.role === 'user' ? 'User' : 'Assistant';
      const content = entry.content.length > 1500
        ? entry.content.slice(0, 1497) + '...'
        : entry.content;
      lines.push(`${label}: ${content}`);
    }
    lines.push('--- End of history ---');
    lines.push('');
    lines.push(`User: ${currentMessage}`);

    return lines.join('\n');
  } catch (err) {
    logger.debug('Failed to load session history, falling back to plain prompt', { error: String(err) });
    return currentMessage;
  }
}

/**
 * SSE streaming chat handler.
 */
export async function chatSseHandler(req: Request, res: Response, root: string) {
  const { prompt, sessionId } = req.body ?? {};

  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Build system prompt — pass `root` so fleet mode resolves the right
  // agent's identity/SOUL/USER/recent-activity, not whichever loaded last.
  let systemPrompt: string;
  try {
    systemPrompt = await buildChannelSystemPrompt('web', root);
  } catch (err) {
    logger.error('Failed to build system prompt', { error: String(err) });
    sendEvent(res, 'error', { message: 'Failed to build system prompt' });
    res.end();
    return;
  }

  const cwd = root;

  // Resolve the model for THIS handler's agent root. In fleet mode the
  // legacy getClaudeModel() singleton throws to surface hidden callers;
  // here we always have `root` so route through getClaudeModelForRoot().
  // Outside fleet mode this is also strict — if a single-agent install
  // has no claude.model set, we want to know rather than silently route
  // through 'opus'.
  const model = isFleetMode()
    ? getClaudeModelForRoot(root)
    : (getClaudeModel() || 'opus');

  // Persist user message
  if (sessionId) {
    try {
      saveMessage(cwd, sessionId, 'user', prompt);
    } catch (err) {
      logger.debug('Failed to persist user message', { error: String(err) });
    }
  }

  // Check if we can resume an existing Claude Code session (real multi-turn)
  let claudeSessionId: string | null = null;
  if (sessionId) {
    try {
      claudeSessionId = getClaudeSessionId(cwd, sessionId);
    } catch {
      // First message or DB error — will create new session
    }
  }

  // For resumed sessions, just send the user message (Claude has full context).
  // For new sessions, build prompt with system context and history.
  let fullPrompt: string;
  if (claudeSessionId) {
    // Real multi-turn: Claude already has the conversation context
    fullPrompt = prompt;
  } else if (sessionId) {
    fullPrompt = buildPromptFromSession(cwd, sessionId, prompt);
  } else {
    fullPrompt = buildPromptWithHistory('web:default', prompt);
    pushUserMessage('web:default', prompt);
  }

  const keepalive = setInterval(() => {
    sendEvent(res, 'keepalive', {});
  }, 15_000);

  let aborted = false;
  res.on('close', () => { aborted = true; });

  try {
    await chatViaSubprocess(res, fullPrompt, systemPrompt, cwd, model, () => aborted, sessionId, claudeSessionId);
  } finally {
    clearInterval(keepalive);
    if (!res.writableEnded) res.end();
  }
}

/**
 * Subprocess chat — spawns `claude` with stream-json output.
 * Parses all event types: system, assistant (text/thinking/tool_use), user (tool_result), result.
 */
function chatViaSubprocess(
  res: Response,
  fullPrompt: string,
  systemPrompt: string,
  cwd: string,
  model: string,
  isAborted: () => boolean,
  sessionId?: string,
  claudeSessionId?: string | null,
): Promise<void> {
  return new Promise((resolve) => {
    const isResume = !!claudeSessionId;
    const args: string[] = [
      '--print', '-',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', model,
      '--dangerously-skip-permissions',
      '--allowedTools', 'Bash', 'WebFetch', 'WebSearch', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Skill',
    ];

    if (isResume) {
      args.push('--resume', claudeSessionId);
    }

    logger.info(`Spawning claude subprocess, cwd=${cwd}, resume=${isResume ? claudeSessionId : 'none'}`);

    const proc = spawn('claude', args, {
      cwd,
      env: {
        ...process.env,
        CLAUDECODE: '',
        CLAUDE_CODE_ENTRYPOINT: '',
      } as Record<string, string>,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Pipe prompt via stdin.
    // For new sessions: system prompt + user message (full context bootstrap).
    // For resumed sessions: just the user message (Claude already has context).
    if (proc.stdin) {
      if (isResume) {
        proc.stdin.write(fullPrompt);
      } else {
        proc.stdin.write(`<system-context>\n${systemPrompt}\n</system-context>\n\n${fullPrompt}`);
      }
      proc.stdin.end();
    }

    let stdoutBuffer = '';
    const assistantTexts: string[] = [];
    let sentInit = false;

    // Track active tool uses by ID for matching results
    const activeTools = new Map<string, { name: string; label: string; detail: string }>();
    const completedTools: Array<{ id: string; name: string; label: string; detail: string; success: boolean }> = [];
    const memoryUpdates: string[] = [];
    let resultUsage: { inputTokens: number; outputTokens: number } | null = null;
    let resultCostUsd: number | null = null;

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (isAborted()) return;
      const raw = chunk.toString();
      stdoutBuffer += raw;

      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        const type = typeof event.type === 'string' ? event.type : '';

        if (type === 'system' && event.subtype === 'init') {
          if (!sentInit) {
            const claudeSid = typeof event.session_id === 'string' ? event.session_id : '';
            sendEvent(res, 'init', { sessionId: claudeSid, model: event.model });
            sentInit = true;

            // Store Claude session ID for future --resume
            if (sessionId && claudeSid) {
              try {
                setClaudeSessionId(cwd, sessionId, claudeSid);
                logger.info(`Stored Claude session ${claudeSid} for web session ${sessionId}`);
              } catch (err) {
                logger.debug('Failed to store Claude session ID', { error: String(err) });
              }
            }
          }
        } else if (type === 'assistant') {
          const message = typeof event.message === 'object' && event.message
            ? event.message as Record<string, unknown>
            : {};
          const content = Array.isArray(message.content) ? message.content : [];

          for (const entry of content) {
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
            const block = entry as Record<string, unknown>;

            if (block.type === 'text' && typeof block.text === 'string' && block.text) {
              // Text content — send to browser
              assistantTexts.push(block.text);
              sendEvent(res, 'text', { text: block.text });

            } else if (block.type === 'thinking') {
              // Thinking — emit status
              sendEvent(res, 'status', { status: 'thinking' });

            } else if (block.type === 'tool_use') {
              // Tool invocation starting
              const toolId = String(block.id || '');
              const toolName = String(block.name || '');
              const toolInput = (typeof block.input === 'object' && block.input)
                ? block.input as Record<string, unknown>
                : {};

              const { label, detail } = describeToolUse(toolName, toolInput);
              activeTools.set(toolId, { name: toolName, label, detail });

              sendEvent(res, 'tool_start', { id: toolId, name: toolName, label, detail });
              sendEvent(res, 'status', { status: 'tool_use', tool: toolName, label, detail });
            }
          }
        } else if (type === 'user') {
          // Tool result — match back to tool_start
          const message = typeof event.message === 'object' && event.message
            ? event.message as Record<string, unknown>
            : {};
          const content = Array.isArray(message.content) ? message.content : [];

          for (const entry of content) {
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
            const block = entry as Record<string, unknown>;

            if (block.type === 'tool_result') {
              const toolId = String(block.tool_use_id || '');
              const isError = block.is_error === true;
              const resultContent = typeof block.content === 'string'
                ? block.content
                : '';

              const toolInfo = activeTools.get(toolId);
              activeTools.delete(toolId);

              // Track completed tools for persistence
              completedTools.push({
                id: toolId,
                name: toolInfo?.name || '',
                label: toolInfo?.label || '',
                detail: toolInfo?.detail || '',
                success: !isError,
              });

              // Detect memory block updates
              if (toolInfo && !isError && (toolInfo.name === 'Edit' || toolInfo.name === 'Write')) {
                const detail = toolInfo.detail.toUpperCase();
                if (detail.includes('SOUL')) memoryUpdates.push('soul');
                else if (detail.includes('USER')) memoryUpdates.push('user');
                else if (detail.includes('HEARTBEAT')) memoryUpdates.push('heartbeat');
              }

              sendEvent(res, 'tool_end', {
                id: toolId,
                name: toolInfo?.name || '',
                label: toolInfo?.label || '',
                success: !isError,
                summary: truncate(resultContent, 200),
              });

              // If there are still active tools, emit status for the most recent one
              if (activeTools.size > 0) {
                const [, last] = [...activeTools.entries()].pop()!;
                sendEvent(res, 'status', { status: 'tool_use', tool: last.name, label: last.label, detail: last.detail });
              } else {
                sendEvent(res, 'status', { status: 'thinking' });
              }
            }
          }
        } else if (type === 'result') {
          if (assistantTexts.length === 0 && typeof event.result === 'string' && (event.result as string).trim()) {
            assistantTexts.push((event.result as string).trim());
            sendEvent(res, 'text', { text: (event.result as string).trim() });
          }

          const usageObj = typeof event.usage === 'object' && event.usage
            ? event.usage as Record<string, unknown>
            : {};
          const usage = {
            inputTokens: typeof usageObj.input_tokens === 'number' ? usageObj.input_tokens : 0,
            outputTokens: typeof usageObj.output_tokens === 'number' ? usageObj.output_tokens : 0,
          };
          resultUsage = usage;
          const costRaw = event.total_cost_usd;
          const costUsd = typeof costRaw === 'number' && Number.isFinite(costRaw) ? costRaw : null;
          resultCostUsd = costUsd;
          sendEvent(res, 'result', { usage, costUsd, summary: assistantTexts.join('\n\n').trim() });
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      logger.debug(`claude stderr: ${chunk.toString().trim()}`);
    });

    res.on('close', () => {
      if (!proc.killed) {
        proc.kill('SIGTERM');
        setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5_000);
      }
    });

    proc.on('close', (code) => {
      logger.info(`Subprocess exited code=${code}, texts=${assistantTexts.length}`);
      const fullResponse = assistantTexts.join('\n\n').trim();
      if (fullResponse) pushAssistantMessage('web:default', fullResponse);

      // Persist assistant message to SQLite
      if (sessionId && fullResponse) {
        try {
          saveMessage(cwd, sessionId, 'assistant', fullResponse, {
            toolCalls: completedTools.length > 0 ? completedTools : undefined,
            memoryUpdates: memoryUpdates.length > 0 ? [...new Set(memoryUpdates)] : undefined,
            usage: resultUsage ?? undefined,
            costUsd: resultCostUsd ?? undefined,
          });
        } catch (err) {
          logger.debug('Failed to persist assistant message', { error: String(err) });
        }
      }
      resolve();
    });

    proc.on('error', (err) => {
      logger.error(`Subprocess error: ${err.message}`);
      sendEvent(res, 'error', { message: `Process error: ${err.message}` });
      resolve();
    });
  });
}
