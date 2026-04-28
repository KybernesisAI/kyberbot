/**
 * KyberBot — Channel Conversation History
 *
 * Maintains a rolling buffer of recent messages per conversation so
 * messaging channels (Telegram, WhatsApp, web) are stateful. The history
 * is prepended to each prompt so Claude has context from prior exchanges.
 *
 * History lives in memory — it persists across messages within a session
 * but resets on restart. Long-term memory is handled by storeConversation()
 * and the brain subsystems.
 *
 * Fleet-mode safety: the rolling buffer is process-wide. Without per-agent
 * namespacing, two agents in one fleet process would share history slots
 * keyed by `telegram:<chatId>` because the chat_id is identical for the
 * same human user across different bots. Callers running in fleet mode MUST
 * pass `root` so the key is namespaced by agent name.
 */

import { createLogger } from '../../logger.js';
import { getAgentName, getAgentNameForRoot } from '../../config.js';

const logger = createLogger('history');

interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

const MAX_ENTRIES = 40;        // 20 exchanges (user + assistant each)
const MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours — older messages are stale

// Per-conversation histories, keyed by `${agentName}:${conversationId}`.
// In single-agent mode, agentName is resolved via the global singleton.
// In fleet mode, callers MUST pass `root` so the agent-name lookup is
// per-root (the singleton there reflects whichever agent loaded last).
const histories = new Map<string, HistoryEntry[]>();

/**
 * Compose a stable per-agent key from a conversation id.
 * If `root` is provided (fleet mode), resolve the agent name per-root.
 * If omitted (single-agent), fall back to the singleton.
 */
function makeKey(conversationId: string, root?: string): string {
  const agentName = root ? getAgentNameForRoot(root) : getAgentName();
  return `${agentName}:${conversationId}`;
}

/**
 * Add a user message to the conversation history.
 */
export function pushUserMessage(conversationId: string, content: string, root?: string): void {
  const key = makeKey(conversationId, root);
  const history = getOrCreateHistory(key);
  history.push({ role: 'user', content, timestamp: Date.now() });
  trim(key);
}

/**
 * Add an assistant response to the conversation history.
 */
export function pushAssistantMessage(conversationId: string, content: string, root?: string): void {
  const key = makeKey(conversationId, root);
  const history = getOrCreateHistory(key);
  history.push({ role: 'assistant', content, timestamp: Date.now() });
  trim(key);
}

/**
 * Build a prompt that includes conversation history before the current message.
 * Returns the full prompt string to pass to the Agent SDK.
 */
export function buildPromptWithHistory(conversationId: string, currentMessage: string, root?: string): string {
  const key = makeKey(conversationId, root);
  const history = getOrCreateHistory(key);

  // Filter out stale entries
  const cutoff = Date.now() - MAX_AGE_MS;
  const recent = history.filter(e => e.timestamp >= cutoff);

  if (recent.length === 0) {
    return currentMessage;
  }

  const lines: string[] = [];
  lines.push('--- Conversation history (most recent messages) ---');
  for (const entry of recent) {
    const label = entry.role === 'user' ? 'User' : 'Assistant';
    // Truncate long assistant responses in history to save context
    const content = entry.role === 'assistant' && entry.content.length > 500
      ? entry.content.slice(0, 497) + '...'
      : entry.content;
    lines.push(`${label}: ${content}`);
  }
  lines.push('--- End of history ---');
  lines.push('');
  lines.push(`User: ${currentMessage}`);

  return lines.join('\n');
}

/**
 * Get the number of entries in a conversation's history.
 */
export function getHistoryLength(conversationId: string, root?: string): number {
  const key = makeKey(conversationId, root);
  return histories.get(key)?.length ?? 0;
}

/**
 * Clear history for a conversation (e.g., on /start).
 */
export function clearHistory(conversationId: string, root?: string): void {
  const key = makeKey(conversationId, root);
  histories.delete(key);
}

function getOrCreateHistory(key: string): HistoryEntry[] {
  let history = histories.get(key);
  if (!history) {
    history = [];
    histories.set(key, history);
  }
  return history;
}

function trim(key: string): void {
  const history = histories.get(key);
  if (!history) return;

  // Remove entries beyond max
  while (history.length > MAX_ENTRIES) {
    history.shift();
  }

  // Remove stale entries from the front
  const cutoff = Date.now() - MAX_AGE_MS;
  while (history.length > 0 && history[0].timestamp < cutoff) {
    history.shift();
  }
}
