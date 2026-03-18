/**
 * KyberBot — Fact Store
 *
 * Stores structured facts extracted from conversations. Each fact is a
 * specific, verifiable statement with metadata (category, confidence,
 * entities, source conversation). Facts are stored in SQLite alongside
 * the timeline database and optionally indexed in ChromaDB for semantic
 * search.
 */

import { getTimelineDb } from './timeline.js';
import { indexDocument, isChromaAvailable } from './embeddings.js';
import { createLogger } from '../logger.js';

const logger = createLogger('fact-store');

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type FactCategory =
  | 'biographical'
  | 'preference'
  | 'event'
  | 'relationship'
  | 'temporal'
  | 'opinion'
  | 'plan'
  | 'general';

export const VALID_CATEGORIES: ReadonlySet<string> = new Set<FactCategory>([
  'biographical',
  'preference',
  'event',
  'relationship',
  'temporal',
  'opinion',
  'plan',
  'general',
]);

export interface FactInput {
  content: string;
  source_path: string;
  source_conversation_id: string;
  entities: string[];
  timestamp: string;
  confidence: number;
  category: FactCategory;
  expires_at?: string;  // ISO 8601 — temporal facts expire automatically
}

export interface StoredFact extends FactInput {
  id: number;
  created_at: string;
  is_latest: number;
  superseded_by: number | null;
}

export interface GetFactsOptions {
  latestOnly?: boolean;
  limit?: number;
  category?: FactCategory;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMA
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ensure the facts table exists in the timeline database.
 * Safe to call multiple times — uses CREATE TABLE IF NOT EXISTS.
 */
export async function ensureFactsTable(root: string): Promise<void> {
  const db = await getTimelineDb(root);

  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      source_path TEXT NOT NULL UNIQUE,
      source_conversation_id TEXT NOT NULL,
      entities_json TEXT DEFAULT '[]',
      timestamp TEXT NOT NULL,
      confidence REAL DEFAULT 0.7,
      category TEXT DEFAULT 'general',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_facts_source_conv
      ON facts(source_conversation_id);
    CREATE INDEX IF NOT EXISTS idx_facts_category
      ON facts(category);
    CREATE INDEX IF NOT EXISTS idx_facts_timestamp
      ON facts(timestamp);
    CREATE INDEX IF NOT EXISTS idx_facts_source_path
      ON facts(source_path);
  `);

  // Migration: add is_latest and superseded_by columns if not present
  const cols = db.prepare(`PRAGMA table_info(facts)`).all() as Array<{ name: string }>;
  const colNames = new Set(cols.map(c => c.name));

  if (!colNames.has('is_latest')) {
    db.exec(`ALTER TABLE facts ADD COLUMN is_latest INTEGER DEFAULT 1`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_is_latest ON facts(is_latest)`);
  }
  if (!colNames.has('superseded_by')) {
    db.exec(`ALTER TABLE facts ADD COLUMN superseded_by INTEGER`);
  }
  if (!colNames.has('expires_at')) {
    db.exec(`ALTER TABLE facts ADD COLUMN expires_at TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_expires_at ON facts(expires_at)`);
  }
  if (!colNames.has('updated_at')) {
    db.exec(`ALTER TABLE facts ADD COLUMN updated_at TEXT`);
  }
  if (!colNames.has('access_count')) {
    db.exec(`ALTER TABLE facts ADD COLUMN access_count INTEGER DEFAULT 0`);
  }

  // Create standalone FTS5 table for fact search (no content= mapping to avoid column issues)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(content, entities);

      CREATE TRIGGER IF NOT EXISTS facts_fts_ai AFTER INSERT ON facts BEGIN
        INSERT INTO facts_fts(rowid, content, entities) VALUES (new.id, new.content, new.entities_json);
      END;

      CREATE TRIGGER IF NOT EXISTS facts_fts_ad AFTER DELETE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, content, entities) VALUES ('delete', old.id, old.content, old.entities_json);
      END;

      CREATE TRIGGER IF NOT EXISTS facts_fts_au AFTER UPDATE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, content, entities) VALUES ('delete', old.id, old.content, old.entities_json);
        INSERT INTO facts_fts(rowid, content, entities) VALUES (new.id, new.content, new.entities_json);
      END;
    `);
  } catch {
    // FTS table or triggers may already exist with different names
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Store a single fact in the database and optionally index it in ChromaDB.
 */
export async function storeFact(root: string, fact: FactInput): Promise<number> {
  const db = await getTimelineDb(root);

  const result = db.prepare(`
    INSERT OR REPLACE INTO facts
      (content, source_path, source_conversation_id, entities_json, timestamp, confidence, category, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fact.content,
    fact.source_path,
    fact.source_conversation_id,
    JSON.stringify(fact.entities),
    fact.timestamp,
    fact.confidence,
    fact.category,
    fact.expires_at || null,
  );

  const factId = result.lastInsertRowid as number;

  // Index in ChromaDB for semantic search (best-effort)
  try {
    if (isChromaAvailable()) {
      const chromaId = `fact_${fact.source_path.replace(/[^a-zA-Z0-9]/g, '_')}`;
      await indexDocument(chromaId, fact.content, {
        type: 'note',
        source_path: fact.source_path,
        title: `[fact] ${fact.content.slice(0, 80)}`,
        timestamp: fact.timestamp,
        entities: fact.entities,
        topics: [fact.category],
        summary: fact.content,
      });
    }
  } catch {
    // Embedding is best-effort
  }

  logger.debug('Stored fact', {
    id: factId,
    category: fact.category,
    confidence: fact.confidence,
    content: fact.content.slice(0, 60),
  });

  return factId;
}

/**
 * Retrieve facts associated with a given entity name.
 * Searches entities_json for a case-insensitive match.
 */
export async function getFactsForEntity(
  root: string,
  entity: string,
  options: GetFactsOptions = {}
): Promise<StoredFact[]> {
  const { latestOnly = true, limit = 20, category } = options;
  const db = await getTimelineDb(root);

  // SQLite JSON: search entities_json for the entity name (case-insensitive)
  const entityPattern = `%${entity.toLowerCase()}%`;

  let sql = `
    SELECT id, content, source_path, source_conversation_id, entities_json,
           timestamp, confidence, category, created_at,
           COALESCE(is_latest, 1) as is_latest,
           superseded_by
    FROM facts
    WHERE LOWER(entities_json) LIKE ?
  `;
  const params: unknown[] = [entityPattern];

  if (latestOnly) {
    sql += ` AND COALESCE(is_latest, 1) = 1`;
  }
  if (category) {
    sql += ` AND category = ?`;
    params.push(category);
  }

  sql += ` ORDER BY timestamp DESC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    content: string;
    source_path: string;
    source_conversation_id: string;
    entities_json: string;
    timestamp: string;
    confidence: number;
    category: string;
    created_at: string;
    is_latest: number;
    superseded_by: number | null;
  }>;

  return rows.map(row => ({
    id: row.id,
    content: row.content,
    source_path: row.source_path,
    source_conversation_id: row.source_conversation_id,
    entities: JSON.parse(row.entities_json || '[]'),
    timestamp: row.timestamp,
    confidence: row.confidence,
    category: row.category as FactCategory,
    created_at: row.created_at,
    is_latest: row.is_latest,
    superseded_by: row.superseded_by,
  }));
}

/**
 * Mark a fact as superseded by a newer fact.
 * Sets is_latest=0 and records which fact replaced it.
 */
export async function markFactSuperseded(
  root: string,
  oldFactId: number,
  newFactId: number
): Promise<void> {
  const db = await getTimelineDb(root);

  db.prepare(`
    UPDATE facts
    SET is_latest = 0, superseded_by = ?
    WHERE id = ?
  `).run(newFactId, oldFactId);

  logger.debug('Marked fact as superseded', { oldFactId, newFactId });
}
