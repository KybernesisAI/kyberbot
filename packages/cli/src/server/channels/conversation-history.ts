/**
 * KyberBot — Channel Conversation History
 *
 * Maintains a rolling buffer of recent messages per conversation so
 * messaging channels (Telegram, WhatsApp) are stateful. The history
 * is prepended to each prompt so Claude has context from prior exchanges.
 *
 * History lives in memory — it persists across messages within a session
 * but resets on restart. Long-term memory is handled by storeConversation()
 * and the brain subsystems.
 *
 * FLEET MODE WARNING:
 * The Map below is module-scoped — in fleet mode, every AgentRuntime in
 * this process shares it. Callers MUST namespace `conversationId` with
 * the agent's identity (e.g. `${agentName}:telegram:${chatId}`). An
 * un-namespaced key like `telegram:${chatId}` will collide across agents
 * and inject one agent's prior turns into another agent's prompt.
 * This file deliberately does not enforce the convention — that lookup
 * would require knowing the calling agent, which is the exact ambiguity
 * we're trying to remove. The contract lives at the call sites.
 */

import { createLogger } from '../../logger.js';

const logger = createLogger('history');

interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

const MAX_ENTRIES = 40;        // 20 exchanges (user + assistant each)
const MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours — older messages are stale

// Per-conversation histories, keyed by a stable identifier (chat ID, JID, etc.)
const histories = new Map<string, HistoryEntry[]>();

/**
 * Add a user message to the conversation history.
 */
export function pushUserMessage(conversationId: string, content: string): void {
  const history = getOrCreateHistory(conversationId);
  history.push({ role: 'user', content, timestamp: Date.now() });
  trim(conversationId);
}

/**
 * Add an assistant response to the conversation history.
 */
export function pushAssistantMessage(conversationId: string, content: string): void {
  const history = getOrCreateHistory(conversationId);
  history.push({ role: 'assistant', content, timestamp: Date.now() });
  trim(conversationId);
}

/**
 * Build a prompt that includes conversation history before the current message.
 * Returns the full prompt string to pass to the Agent SDK.
 */
export function buildPromptWithHistory(conversationId: string, currentMessage: string): string {
  const history = getOrCreateHistory(conversationId);

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
export function getHistoryLength(conversationId: string): number {
  return histories.get(conversationId)?.length ?? 0;
}

/**
 * Clear history for a conversation (e.g., on /start).
 */
export function clearHistory(conversationId: string): void {
  histories.delete(conversationId);
}

function getOrCreateHistory(conversationId: string): HistoryEntry[] {
  let history = histories.get(conversationId);
  if (!history) {
    history = [];
    histories.set(conversationId, history);
  }
  return history;
}

function trim(conversationId: string): void {
  const history = histories.get(conversationId);
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
