/**
 * KyberBot — Message Persistence
 *
 * Stores web chat messages in SQLite for session persistence.
 * Each session is a conversation with a unique ID, containing
 * ordered user and assistant messages.
 */

import Database from 'libsql';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { createLogger } from '../logger.js';
import { openWithRecovery } from './db-recovery.js';

const logger = createLogger('messages');

const databases = new Map<string, Database.Database>();

/**
 * Reset the messages DB connection(s). If root is given, closes only that
 * root's connection. If no root, closes all.
 */
export function resetMessagesDb(root?: string): void {
  if (root) {
    const existing = databases.get(root);
    if (existing) {
      try { existing.close(); } catch { /* ignore */ }
      databases.delete(root);
    }
  } else {
    for (const [, conn] of databases) {
      try { conn.close(); } catch { /* ignore */ }
    }
    databases.clear();
  }
}

function ensureDatabase(root: string): Database.Database {
  const existing = databases.get(root);
  if (existing) return existing;

  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });

  const newDbPath = join(dataDir, 'messages.db');
  const newDb = openWithRecovery(newDbPath);
  newDb.pragma('journal_mode = WAL');

  newDb.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL DEFAULT 'web',
      title TEXT,
      claude_session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      tool_calls_json TEXT,
      memory_updates_json TEXT,
      usage_json TEXT,
      cost_usd REAL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
  `);

  // Migration: add claude_session_id column if not present
  const cols = newDb.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'claude_session_id')) {
    newDb.exec(`ALTER TABLE sessions ADD COLUMN claude_session_id TEXT`);
  }

  databases.set(root, newDb);
  logger.info('Messages database initialized', { path: newDbPath });
  return newDb;
}

export interface StoredMessage {
  id: number;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  tool_calls_json: string | null;
  memory_updates_json: string | null;
  usage_json: string | null;
  cost_usd: number | null;
  created_at: string;
}

export interface SessionSummary {
  id: string;
  channel: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

/**
 * Create a new session.
 */
export function createSession(root: string, sessionId: string, channel = 'web'): void {
  const database = ensureDatabase(root);
  const now = new Date().toISOString();
  database.prepare(
    `INSERT OR IGNORE INTO sessions (id, channel, created_at, updated_at) VALUES (?, ?, ?, ?)`
  ).run(sessionId, channel, now, now);
}

/**
 * Save a message to a session.
 */
export function saveMessage(
  root: string,
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  opts?: {
    toolCalls?: unknown[];
    memoryUpdates?: string[];
    usage?: { inputTokens: number; outputTokens: number };
    costUsd?: number;
  },
): number {
  const database = ensureDatabase(root);
  const now = new Date().toISOString();

  // Ensure session exists
  createSession(root, sessionId);

  const result = database.prepare(
    `INSERT INTO messages (session_id, role, content, tool_calls_json, memory_updates_json, usage_json, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    role,
    content,
    opts?.toolCalls ? JSON.stringify(opts.toolCalls) : null,
    opts?.memoryUpdates ? JSON.stringify(opts.memoryUpdates) : null,
    opts?.usage ? JSON.stringify(opts.usage) : null,
    opts?.costUsd ?? null,
    now,
  );

  // Update session title (from first user message) and timestamp
  const titleUpdate = role === 'user'
    ? database.prepare(`UPDATE sessions SET title = COALESCE(title, ?), updated_at = ? WHERE id = ?`)
    : database.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`);

  if (role === 'user') {
    titleUpdate.run(content.slice(0, 100), now, sessionId);
  } else {
    titleUpdate.run(now, sessionId);
  }

  return result.lastInsertRowid as number;
}

/**
 * Get messages for a session.
 */
export function getSessionMessages(root: string, sessionId: string): StoredMessage[] {
  const database = ensureDatabase(root);
  return database.prepare(
    `SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC`
  ).all(sessionId) as StoredMessage[];
}

/**
 * List recent sessions.
 */
export function listSessions(root: string, limit = 20): SessionSummary[] {
  const database = ensureDatabase(root);
  return database.prepare(
    `SELECT s.*, COUNT(m.id) as message_count
     FROM sessions s
     LEFT JOIN messages m ON m.session_id = s.id
     GROUP BY s.id
     ORDER BY s.updated_at DESC
     LIMIT ?`
  ).all(limit) as SessionSummary[];
}

/**
 * Get the Claude Code session ID for a web session (for --resume).
 */
export function getClaudeSessionId(root: string, sessionId: string): string | null {
  const database = ensureDatabase(root);
  const row = database.prepare(
    `SELECT claude_session_id FROM sessions WHERE id = ?`
  ).get(sessionId) as { claude_session_id: string | null } | undefined;
  return row?.claude_session_id ?? null;
}

/**
 * Store the Claude Code session ID for a web session.
 */
export function setClaudeSessionId(root: string, sessionId: string, claudeSessionId: string): void {
  const database = ensureDatabase(root);
  database.prepare(
    `UPDATE sessions SET claude_session_id = ? WHERE id = ?`
  ).run(claudeSessionId, sessionId);
}

/**
 * Get the most recent session ID for a channel, or null if none.
 */
export function getLatestSessionId(root: string, channel = 'web'): string | null {
  const database = ensureDatabase(root);
  const row = database.prepare(
    `SELECT id FROM sessions WHERE channel = ? ORDER BY updated_at DESC LIMIT 1`
  ).get(channel) as { id: string } | undefined;
  return row?.id ?? null;
}
