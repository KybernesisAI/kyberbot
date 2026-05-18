/**
 * KyberBot — Timeline Index (Arcana dual-write wrapper)
 *
 * v0.1 of the Arcana adoption (see ~/dev/kybernesis/arcana/docs/adoption/kyberbot.md):
 * - Local libsql `timeline_events` table remains the interface-layer index
 *   (typed events, source_path upsert, FTS, ARP filtering, date-range queries).
 * - Each write also calls `arcana.ingest.storeMemory(...)` when an Arcana
 *   instance is wired; the returned memory id is stored in `arcana_memory_id`.
 * - If Arcana is unavailable (singleton not initialised) or returns a
 *   NotImplementedError, the local write still succeeds — Arcana adoption is
 *   incremental and KyberBot must keep working.
 *
 * Reads stay local. Arcana doesn't expose timeline-shaped queries at the
 * kernel level (typed events / source_path / FTS / date range are consumer
 * concerns).
 */

import Database from 'libsql';
import { openWithRecovery } from './db-recovery.js';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { createLogger } from '../logger.js';
import { getArcanaInstance } from './arcana-singleton.js';
import { NotImplementedError } from '@kybernesisai/arcana-core';
import type { Memory } from '@kybernesisai/arcana-contracts';

const logger = createLogger('timeline');

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
  // ── ARP unification (Phase A) ───────────────────────────────────────
  project_id?: string;
  tags?: string[];
  classification?: 'public' | 'internal' | 'confidential' | 'pii';
  connection_id?: string;
  source_did?: string;
  // ── Arcana adoption: caller-supplied Memory id (module #10) ─────────
  // When the caller already owns the canonical Arcana Memory (store-conversation
  // mints one with full content before calling addConversationToTimeline),
  // they pass the memoryId here. addToTimeline then SKIPS its own mirror and
  // just records the link. Avoids one-conversation-two-Memories duplication.
  arcana_memory_id?: string;
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

const databases = new Map<string, Database.Database>();

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

  // ARP fields
  if (!columnNames.has('project_id')) {
    database.exec(`ALTER TABLE timeline_events ADD COLUMN project_id TEXT`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_timeline_project ON timeline_events(project_id)`);
  }
  if (!columnNames.has('classification')) {
    database.exec(`ALTER TABLE timeline_events ADD COLUMN classification TEXT`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_timeline_classification ON timeline_events(classification)`);
  }
  if (!columnNames.has('connection_id')) {
    database.exec(`ALTER TABLE timeline_events ADD COLUMN connection_id TEXT`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_timeline_connection ON timeline_events(connection_id)`);
  }
  if (!columnNames.has('source_did')) {
    database.exec(`ALTER TABLE timeline_events ADD COLUMN source_did TEXT`);
  }

  // Arcana adoption — FK to the Memory mirrored into Arcana via ingest.storeMemory.
  // Nullable: pre-existing rows have no Arcana mirror, and dual-write may skip
  // Arcana while the kernel method is still a v0.1 stub.
  if (!columnNames.has('arcana_memory_id')) {
    database.exec(`ALTER TABLE timeline_events ADD COLUMN arcana_memory_id TEXT`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_timeline_arcana_memory ON timeline_events(arcana_memory_id)`);
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

/**
 * Best-effort write-through to Arcana's kernel memory. Returns the resolved
 * memory id (existing or newly-minted), or null if Arcana is unavailable /
 * still stubbed. Failures are logged but never block the local timeline
 * write.
 *
 * Branches on `existingArcanaMemoryId`:
 * - non-null → `command.updateMemory(id, fields)` — Arcana memory mutates
 *   in place. Returns the same id. No orphan accumulation. (ADR 005)
 * - null     → `ingest.storeMemory(...)` — new canonical memory minted.
 */
async function mirrorToArcana(
  event: Omit<TimelineEvent, 'id'>,
  existingArcanaMemoryId: string | null,
): Promise<string | null> {
  const arcana = getArcanaInstance();
  if (!arcana) return null;

  // Map KyberBot's typed-event vocabulary into Arcana's flat tag namespace.
  // Per the adoption playbook: `type:foo`, `entity:Foo`, `topic:Foo` are the
  // convention until/unless Memory grows first-class typed-event support.
  const tags: string[] = [`type:${event.type}`];
  for (const e of event.entities ?? []) tags.push(`entity:${e}`);
  for (const t of event.topics ?? []) tags.push(`topic:${t}`);
  for (const t of event.tags ?? []) tags.push(t);

  const scopes: NonNullable<Memory['scopes']> = {};
  if (event.project_id) scopes.project_id = event.project_id;
  if (event.classification) scopes.classification = event.classification;
  if (event.connection_id) scopes.connection_id = event.connection_id;
  if (event.source_did) scopes.source_did = event.source_did;

  const content = event.summary || event.title;
  const source: Memory['source'] = event.type === 'conversation' ? 'chat' : 'cli';
  const scopesField = Object.keys(scopes).length > 0 ? scopes : undefined;

  try {
    if (existingArcanaMemoryId) {
      await arcana.command.updateMemory(existingArcanaMemoryId, {
        content,
        title: event.title,
        summary: event.summary,
        tags,
        source,
        scopes: scopesField,
      });
      return existingArcanaMemoryId;
    }

    return await arcana.ingest.storeMemory({
      content,
      title: event.title,
      summary: event.summary,
      tags,
      source,
      scopes: scopesField,
    });
  } catch (err) {
    if (err instanceof NotImplementedError) {
      logger.debug('Arcana memory mirror still a stub; skipping', {
        source_path: event.source_path,
        update: existingArcanaMemoryId !== null,
      });
      return existingArcanaMemoryId;
    }
    logger.warn('Arcana mirror failed; local timeline write proceeds', {
      error: String(err),
      source_path: event.source_path,
    });
    return existingArcanaMemoryId;
  }
}

export async function addToTimeline(
  root: string,
  event: Omit<TimelineEvent, 'id'>
): Promise<number> {
  const database = await ensureDatabase(root);

  // Resolution order for the Arcana memory id this row links to:
  //   1. Caller-supplied (event.arcana_memory_id) — they already minted the
  //      canonical Memory upstream (e.g., store-conversation owns the write
  //      with full content; module #10). Skip the mirror entirely.
  //   2. Existing row's arcana_memory_id for this source_path — re-write
  //      flows through command.updateMemory in place (DVR-UT-006 / ADR 005).
  //   3. Null — mint a new Memory via ingest.storeMemory.
  let arcanaMemoryId: string | null;
  if (event.arcana_memory_id) {
    arcanaMemoryId = event.arcana_memory_id;
  } else {
    const existingRow = database
      .prepare('SELECT arcana_memory_id FROM timeline_events WHERE source_path = ?')
      .get(event.source_path) as { arcana_memory_id: string | null } | undefined;
    arcanaMemoryId = await mirrorToArcana(event, existingRow?.arcana_memory_id ?? null);
  }

  const entitiesJson = JSON.stringify(event.entities || []);
  const topicsJson = JSON.stringify(event.topics || []);
  const tagsJson = event.tags ? JSON.stringify(event.tags) : null;

  try {
    const result = database
      .prepare(
        `INSERT INTO timeline_events
           (type, timestamp, end_timestamp, title, summary, source_path,
            entities_json, topics_json,
            project_id, tags_json, classification, connection_id, source_did,
            arcana_memory_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_path) DO UPDATE SET
           type = excluded.type,
           timestamp = excluded.timestamp,
           end_timestamp = excluded.end_timestamp,
           title = excluded.title,
           summary = excluded.summary,
           entities_json = excluded.entities_json,
           topics_json = excluded.topics_json,
           project_id = COALESCE(excluded.project_id, timeline_events.project_id),
           tags_json = COALESCE(excluded.tags_json, timeline_events.tags_json),
           classification = COALESCE(excluded.classification, timeline_events.classification),
           connection_id = COALESCE(excluded.connection_id, timeline_events.connection_id),
           source_did = COALESCE(excluded.source_did, timeline_events.source_did),
           arcana_memory_id = COALESCE(excluded.arcana_memory_id, timeline_events.arcana_memory_id)`
      )
      .run(
        event.type,
        event.timestamp,
        event.end_timestamp || null,
        event.title,
        event.summary || '',
        event.source_path,
        entitiesJson,
        topicsJson,
        event.project_id ?? null,
        tagsJson,
        event.classification ?? null,
        event.connection_id ?? null,
        event.source_did ?? null,
        arcanaMemoryId,
      );

    logger.debug(`Added to timeline: ${event.title}`, {
      id: result.lastInsertRowid,
      type: event.type,
      arcana_memory_id: arcanaMemoryId,
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

export async function findRecentDuplicate(
  root: string,
  title: string,
  withinHours: number
): Promise<{ id: number; title: string } | null> {
  const database = await ensureDatabase(root);
  const cutoff = new Date(Date.now() - withinHours * 60 * 60 * 1000).toISOString();

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

export async function addConversationToTimeline(
  root: string,
  conversationId: string,
  sourcePath: string,
  startedAt: string,
  finishedAt: string | undefined,
  title: string,
  summary: string,
  entities: string[],
  topics: string[],
  arpMetadata?: {
    project_id?: string;
    tags?: string[];
    classification?: 'public' | 'internal' | 'confidential' | 'pii';
    connection_id?: string;
    source_did?: string;
  },
  // Module #10: store-conversation may have already minted the canonical
  // Arcana Memory with full content (segments + parent text) BEFORE calling
  // here. When set, addToTimeline links to this id rather than minting a new
  // (summary-only) Memory and producing duplicates.
  arcanaMemoryId?: string,
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
    ...(arpMetadata ?? {}),
    ...(arcanaMemoryId ? { arcana_memory_id: arcanaMemoryId } : {}),
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
