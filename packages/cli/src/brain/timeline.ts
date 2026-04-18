/**
 * KyberBot — Timeline Index
 *
 * Enables temporal queries like "What did I discuss last Tuesday?"
 * by indexing all events with timestamps and full-text search.
 *
 * Uses SQLite with FTS5 for full-text search.
 */

import Database from 'libsql';
import { openWithRecovery } from './db-recovery.js';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { createLogger } from '../logger.js';

const logger = createLogger('timeline');

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type EventType = 'conversation' | 'idea' | 'file' | 'transcript' | 'note' | 'intake';

export interface TimelineEvent {
  id: number;
  type: EventType;
  timestamp: string;
  end_timestamp?: string;
  title: string;
  summary: string;
  source_path: string;
  entities: string[];
  topics: string[];
}

export interface TimelineQuery {
  start?: string;
  end?: string;
  type?: EventType;
  search?: string;
  entities?: string[];
  topics?: string[];
  limit?: number;
  offset?: number;
}

export interface TimelineStats {
  total_events: number;
  by_type: Record<EventType, number>;
  date_range: {
    earliest: string | null;
    latest: string | null;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

const databases = new Map<string, Database.Database>();

/**
 * Reset the timeline DB connection(s). If root is given, closes only that
 * root's connection. If no root, closes all (backward compat for eval/tests).
 */
export function resetTimelineDb(root?: string): void {
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

async function ensureDatabase(root: string): Promise<Database.Database> {
  const existing = databases.get(root);
  if (existing) return existing;

  const dataDir = join(root, 'data');
  await mkdir(dataDir, { recursive: true });

  const newDbPath = join(dataDir, 'timeline.db');
  const newDb = openWithRecovery(newDbPath);

  newDb.pragma('journal_mode = WAL');

  newDb.exec(`
    CREATE TABLE IF NOT EXISTS timeline_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('conversation', 'idea', 'file', 'transcript', 'note', 'intake')),
      timestamp TEXT NOT NULL,
      end_timestamp TEXT,
      title TEXT NOT NULL,
      summary TEXT,
      source_path TEXT NOT NULL UNIQUE,
      entities_json TEXT DEFAULT '[]',
      topics_json TEXT DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_timeline_timestamp ON timeline_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_timeline_type ON timeline_events(type);
    CREATE INDEX IF NOT EXISTS idx_timeline_source ON timeline_events(source_path);

    CREATE VIRTUAL TABLE IF NOT EXISTS timeline_fts USING fts5(
      title,
      summary,
      entities,
      topics,
      content=''
    );

    CREATE TRIGGER IF NOT EXISTS timeline_ai AFTER INSERT ON timeline_events BEGIN
      INSERT INTO timeline_fts(rowid, title, summary, entities, topics)
      VALUES (new.id, new.title, new.summary, new.entities_json, new.topics_json);
    END;

    CREATE TRIGGER IF NOT EXISTS timeline_ad AFTER DELETE ON timeline_events BEGIN
      INSERT INTO timeline_fts(timeline_fts, rowid, title, summary, entities, topics)
      VALUES ('delete', old.id, old.title, old.summary, old.entities_json, old.topics_json);
    END;

    CREATE TRIGGER IF NOT EXISTS timeline_au AFTER UPDATE ON timeline_events BEGIN
      INSERT INTO timeline_fts(timeline_fts, rowid, title, summary, entities, topics)
      VALUES ('delete', old.id, old.title, old.summary, old.entities_json, old.topics_json);
      INSERT INTO timeline_fts(rowid, title, summary, entities, topics)
      VALUES (new.id, new.title, new.summary, new.entities_json, new.topics_json);
    END;
  `);

  rebuildBrokenTimelineFts(newDb);
  runMigrations(newDb);

  databases.set(root, newDb);
  logger.info('Timeline database initialized', { path: newDbPath });
  return newDb;
}

/**
 * Early builds declared timeline_fts with `content=timeline_events` but FTS
 * column names (`entities`, `topics`) didn't match base-table columns
 * (`entities_json`, `topics_json`), leaving FTS unqueryable. Detect the
 * broken shape, drop it, and repopulate a contentless FTS from the rows we
 * already have.
 */
function rebuildBrokenTimelineFts(database: Database.Database): void {
  let needsRebuild = false;
  try {
    database.prepare('SELECT count(*) as c FROM timeline_fts').get();
  } catch {
    needsRebuild = true;
  }
  if (!needsRebuild) return;

  logger.info('Rebuilding broken timeline_fts index from timeline_events');
  database.exec('DROP TABLE IF EXISTS timeline_fts');
  database.exec(`
    CREATE VIRTUAL TABLE timeline_fts USING fts5(
      title, summary, entities, topics, content=''
    );
  `);
  const rows = database.prepare(
    'SELECT id, title, summary, entities_json, topics_json FROM timeline_events'
  ).all() as Array<{ id: number; title: string; summary: string | null; entities_json: string; topics_json: string }>;
  const insert = database.prepare(
    'INSERT INTO timeline_fts(rowid, title, summary, entities, topics) VALUES (?,?,?,?,?)'
  );
  const txn = database.transaction((batch: typeof rows) => {
    for (const r of batch) insert.run(r.id, r.title, r.summary ?? '', r.entities_json, r.topics_json);
  });
  txn(rows);
  logger.info(`Repopulated timeline_fts with ${rows.length} rows`);
}

function runMigrations(database: Database.Database): void {
  const columns = database.prepare(`PRAGMA table_info(timeline_events)`).all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map(c => c.name));

  if (!columnNames.has('priority')) {
    database.exec(`ALTER TABLE timeline_events ADD COLUMN priority REAL DEFAULT 0.5`);
  }
  if (!columnNames.has('decay_score')) {
    database.exec(`ALTER TABLE timeline_events ADD COLUMN decay_score REAL DEFAULT 0.0`);
  }
  if (!columnNames.has('tier')) {
    database.exec(`ALTER TABLE timeline_events ADD COLUMN tier TEXT DEFAULT 'warm'`);
  }
  if (!columnNames.has('tags_json')) {
    database.exec(`ALTER TABLE timeline_events ADD COLUMN tags_json TEXT DEFAULT '[]'`);
  }
  if (!columnNames.has('last_enriched')) {
    database.exec(`ALTER TABLE timeline_events ADD COLUMN last_enriched TEXT`);
  }
  if (!columnNames.has('access_count')) {
    database.exec(`ALTER TABLE timeline_events ADD COLUMN access_count INTEGER DEFAULT 0`);
  }
  if (!columnNames.has('is_pinned')) {
    database.exec(`ALTER TABLE timeline_events ADD COLUMN is_pinned INTEGER DEFAULT 0`);
  }
  if (!columnNames.has('last_accessed')) {
    database.exec(`ALTER TABLE timeline_events ADD COLUMN last_accessed TEXT`);
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_timeline_tier ON timeline_events(tier);
    CREATE INDEX IF NOT EXISTS idx_timeline_priority ON timeline_events(priority DESC);
    CREATE INDEX IF NOT EXISTS idx_timeline_last_enriched ON timeline_events(last_enriched);
  `);
}

export async function getTimelineDb(root: string): Promise<Database.Database> {
  return ensureDatabase(root);
}

export async function initializeTimeline(root: string): Promise<void> {
  await ensureDatabase(root);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVENT OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export async function addToTimeline(
  root: string,
  event: Omit<TimelineEvent, 'id'>
): Promise<number> {
  const database = await ensureDatabase(root);

  const entitiesJson = JSON.stringify(event.entities || []);
  const topicsJson = JSON.stringify(event.topics || []);

  try {
    const result = database
      .prepare(
        `INSERT INTO timeline_events (type, timestamp, end_timestamp, title, summary, source_path, entities_json, topics_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_path) DO UPDATE SET
           type = excluded.type,
           timestamp = excluded.timestamp,
           end_timestamp = excluded.end_timestamp,
           title = excluded.title,
           summary = excluded.summary,
           entities_json = excluded.entities_json,
           topics_json = excluded.topics_json`
      )
      .run(
        event.type,
        event.timestamp,
        event.end_timestamp || null,
        event.title,
        event.summary || '',
        event.source_path,
        entitiesJson,
        topicsJson
      );

    logger.debug(`Added to timeline: ${event.title}`, {
      id: result.lastInsertRowid,
      type: event.type,
    });

    return result.lastInsertRowid as number;
  } catch (error) {
    logger.error('Failed to add to timeline', {
      error: String(error),
      title: event.title,
    });
    throw error;
  }
}

export async function removeFromTimeline(
  root: string,
  sourcePath: string
): Promise<boolean> {
  const database = await ensureDatabase(root);

  const result = database
    .prepare('DELETE FROM timeline_events WHERE source_path = ?')
    .run(sourcePath);

  return result.changes > 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUERY OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export async function queryTimeline(
  root: string,
  query: TimelineQuery = {}
): Promise<TimelineEvent[]> {
  const database = await ensureDatabase(root);

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (query.start) {
    conditions.push('timestamp >= ?');
    params.push(query.start);
  }

  if (query.end) {
    conditions.push('timestamp <= ?');
    params.push(query.end);
  }

  if (query.type) {
    conditions.push('type = ?');
    params.push(query.type);
  }

  if (query.search) {
    conditions.push('id IN (SELECT rowid FROM timeline_fts WHERE timeline_fts MATCH ?)');
    params.push(query.search);
  }

  if (query.entities && query.entities.length > 0) {
    const entityConditions = query.entities.map(() => 'entities_json LIKE ?');
    conditions.push(`(${entityConditions.join(' OR ')})`);
    for (const entity of query.entities) {
      params.push(`%${entity.toLowerCase()}%`);
    }
  }

  if (query.topics && query.topics.length > 0) {
    const topicConditions = query.topics.map(() => 'topics_json LIKE ?');
    conditions.push(`(${topicConditions.join(' OR ')})`);
    for (const topic of query.topics) {
      params.push(`%${topic.toLowerCase()}%`);
    }
  }

  let sql = 'SELECT * FROM timeline_events';
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY timestamp DESC';

  const limit = query.limit || 50;
  const offset = query.offset || 0;
  sql += ' LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const results = database.prepare(sql).all(...params) as Array<{
    id: number;
    type: EventType;
    timestamp: string;
    end_timestamp: string | null;
    title: string;
    summary: string;
    source_path: string;
    entities_json: string;
    topics_json: string;
  }>;

  return results.map((row) => ({
    id: row.id,
    type: row.type,
    timestamp: row.timestamp,
    end_timestamp: row.end_timestamp || undefined,
    title: row.title,
    summary: row.summary,
    source_path: row.source_path,
    entities: JSON.parse(row.entities_json),
    topics: JSON.parse(row.topics_json),
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVENIENCE QUERIES
// ═══════════════════════════════════════════════════════════════════════════════

export async function getRecentActivity(root: string, limit = 20): Promise<TimelineEvent[]> {
  return queryTimeline(root, { limit });
}

export async function getActivityOnDate(root: string, date: string): Promise<TimelineEvent[]> {
  const start = `${date}T00:00:00.000Z`;
  const end = `${date}T23:59:59.999Z`;
  return queryTimeline(root, { start, end });
}

export async function getActivityInRange(root: string, start: string, end: string): Promise<TimelineEvent[]> {
  return queryTimeline(root, { start, end });
}

export async function searchTimeline(
  root: string,
  searchQuery: string,
  options: { limit?: number; type?: EventType } = {}
): Promise<TimelineEvent[]> {
  return queryTimeline(root, {
    search: searchQuery,
    limit: options.limit,
    type: options.type,
  });
}

export async function getEventByPath(root: string, sourcePath: string): Promise<TimelineEvent | null> {
  const database = await ensureDatabase(root);

  const row = database
    .prepare('SELECT * FROM timeline_events WHERE source_path = ?')
    .get(sourcePath) as {
    id: number;
    type: EventType;
    timestamp: string;
    end_timestamp: string | null;
    title: string;
    summary: string;
    source_path: string;
    entities_json: string;
    topics_json: string;
  } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    type: row.type,
    timestamp: row.timestamp,
    end_timestamp: row.end_timestamp || undefined,
    title: row.title,
    summary: row.summary,
    source_path: row.source_path,
    entities: JSON.parse(row.entities_json),
    topics: JSON.parse(row.topics_json),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEDUPLICATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Find a recent timeline event with a matching title within the given time window.
 * Used to deduplicate repetitive entries (e.g., heartbeat task executions).
 */
export async function findRecentDuplicate(
  root: string,
  title: string,
  withinHours: number
): Promise<{ id: number; title: string } | null> {
  const database = await ensureDatabase(root);
  const cutoff = new Date(Date.now() - withinHours * 60 * 60 * 1000).toISOString();

  // Normalize: strip channel prefix and truncation suffix for comparison
  const normalized = title.replace(/^\[.*?\]\s*/, '').replace(/\.{3}$/, '').trim().toLowerCase();

  const rows = database.prepare(`
    SELECT id, title FROM timeline_events
    WHERE timestamp >= ?
    ORDER BY timestamp DESC
    LIMIT 100
  `).all(cutoff) as Array<{ id: number; title: string }>;

  for (const row of rows) {
    const rowNorm = row.title.replace(/^\[.*?\]\s*/, '').replace(/\.{3}$/, '').trim().toLowerCase();
    if (rowNorm === normalized) {
      return row;
    }
  }

  return null;
}

/**
 * Increment the access count and update last_accessed on a timeline event.
 * Used when deduplicating repeated entries.
 */
export async function incrementTimelineEventCount(
  root: string,
  eventId: number
): Promise<void> {
  const database = await ensureDatabase(root);
  database.prepare(`
    UPDATE timeline_events
    SET access_count = COALESCE(access_count, 0) + 1,
        last_accessed = datetime('now')
    WHERE id = ?
  `).run(eventId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════════════

export async function getTimelineStats(root: string): Promise<TimelineStats> {
  const database = await ensureDatabase(root);

  const totalEvents = database
    .prepare('SELECT COUNT(*) as count FROM timeline_events')
    .get() as { count: number };

  const byType = database
    .prepare('SELECT type, COUNT(*) as count FROM timeline_events GROUP BY type')
    .all() as Array<{ type: EventType; count: number }>;

  const dateRange = database
    .prepare(`SELECT MIN(timestamp) as earliest, MAX(timestamp) as latest FROM timeline_events`)
    .get() as { earliest: string | null; latest: string | null };

  const byTypeRecord: Record<EventType, number> = {
    conversation: 0,
    idea: 0,
    file: 0,
    transcript: 0,
    note: 0,
    intake: 0,
  };

  for (const row of byType) {
    byTypeRecord[row.type] = row.count;
  }

  return {
    total_events: totalEvents.count,
    by_type: byTypeRecord,
    date_range: {
      earliest: dateRange.earliest,
      latest: dateRange.latest,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export async function addConversationToTimeline(
  root: string,
  conversationId: string,
  sourcePath: string,
  startedAt: string,
  finishedAt: string | undefined,
  title: string,
  summary: string,
  entities: string[],
  topics: string[]
): Promise<number> {
  return addToTimeline(root, {
    type: 'conversation',
    timestamp: startedAt,
    end_timestamp: finishedAt,
    title,
    summary,
    source_path: sourcePath,
    entities,
    topics,
  });
}

export async function addIdeaToTimeline(
  root: string,
  ideaId: string,
  sourcePath: string,
  createdAt: string,
  title: string,
  description: string,
  tags: string[]
): Promise<number> {
  return addToTimeline(root, {
    type: 'idea',
    timestamp: createdAt,
    title,
    summary: description,
    source_path: sourcePath,
    entities: [],
    topics: tags,
  });
}
