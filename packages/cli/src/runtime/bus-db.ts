/**
 * KyberBot — Bus Database
 *
 * SQLite persistence layer for the inter-agent message bus.
 * Stores messages and topic subscriptions with WAL-mode journaling.
 */

import { Database } from '../database.js';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { createLogger } from '../logger.js';
import type { AgentMessage } from './agent-bus.js';

const logger = createLogger('bus-db');
let db: Database | null = null;

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Subscription {
  id: number;
  subscriber: string;
  from_agent: string;
  topic: string;
  created_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONNECTION
// ═══════════════════════════════════════════════════════════════════════════════

export function getBusDb(): Database {
  if (db) return db;

  const dir = join(homedir(), '.kyberbot');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const dbPath = join(dir, 'bus.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS bus_messages (
      id TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('query', 'notify', 'delegate', 'response')),
      topic TEXT,
      payload TEXT NOT NULL,
      reply_to TEXT,
      depth INTEGER DEFAULT 0,
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bus_from ON bus_messages(from_agent);
    CREATE INDEX IF NOT EXISTS idx_bus_to ON bus_messages(to_agent);
    CREATE INDEX IF NOT EXISTS idx_bus_topic ON bus_messages(topic);
    CREATE INDEX IF NOT EXISTS idx_bus_timestamp ON bus_messages(timestamp DESC);

    CREATE TABLE IF NOT EXISTS bus_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscriber TEXT NOT NULL,
      from_agent TEXT NOT NULL,
      topic TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(subscriber, from_agent, topic)
    );
  `);

  logger.info('Bus database initialized', { path: dbPath });
  return db;
}

export function resetBusDb(): void {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
  }
  db = null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGES
// ═══════════════════════════════════════════════════════════════════════════════

export function saveBusMessage(msg: AgentMessage): void {
  const database = getBusDb();
  const stmt = database.prepare(`
    INSERT OR IGNORE INTO bus_messages (id, from_agent, to_agent, type, topic, payload, reply_to, depth, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    msg.id,
    msg.from,
    msg.to,
    msg.type,
    msg.topic || null,
    msg.payload,
    msg.replyTo || null,
    msg.depth || 0,
    msg.timestamp,
  );
}

export function loadBusHistory(options?: {
  limit?: number;
  agent?: string;
  topic?: string;
  after?: string;
  before?: string;
}): AgentMessage[] {
  const database = getBusDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (options?.agent) {
    conditions.push('(from_agent = ? OR to_agent = ?)');
    params.push(options.agent, options.agent);
  }
  if (options?.topic) {
    conditions.push('topic = ?');
    params.push(options.topic);
  }
  if (options?.after) {
    conditions.push('timestamp > ?');
    params.push(options.after);
  }
  if (options?.before) {
    conditions.push('timestamp < ?');
    params.push(options.before);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options?.limit || 50;

  const rows = database
    .prepare(`SELECT * FROM bus_messages ${where} ORDER BY timestamp DESC LIMIT ?`)
    .all(...params, limit) as Array<{
      id: string;
      from_agent: string;
      to_agent: string;
      type: string;
      topic: string | null;
      payload: string;
      reply_to: string | null;
      depth: number;
      timestamp: string;
    }>;

  // Return in chronological order (oldest first)
  return rows.reverse().map((row) => ({
    id: row.id,
    from: row.from_agent,
    to: row.to_agent,
    type: row.type as AgentMessage['type'],
    topic: row.topic || undefined,
    payload: row.payload,
    replyTo: row.reply_to || undefined,
    depth: row.depth,
    timestamp: row.timestamp,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUBSCRIPTIONS
// ═══════════════════════════════════════════════════════════════════════════════

export function saveSubscription(subscriber: string, from: string, topic: string): void {
  const database = getBusDb();
  database
    .prepare(
      `INSERT OR IGNORE INTO bus_subscriptions (subscriber, from_agent, topic) VALUES (?, ?, ?)`
    )
    .run(subscriber, from, topic);
}

export function removeSubscription(subscriber: string, from: string, topic: string): void {
  const database = getBusDb();
  database
    .prepare(
      `DELETE FROM bus_subscriptions WHERE subscriber = ? AND from_agent = ? AND topic = ?`
    )
    .run(subscriber, from, topic);
}

export function loadSubscriptions(subscriber?: string): Subscription[] {
  const database = getBusDb();
  if (subscriber) {
    return database
      .prepare(`SELECT * FROM bus_subscriptions WHERE subscriber = ?`)
      .all(subscriber) as Subscription[];
  }
  return database
    .prepare(`SELECT * FROM bus_subscriptions`)
    .all() as Subscription[];
}
