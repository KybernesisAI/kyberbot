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
import { createLogger } from '../logger.js';

import { indexDocument, isChromaAvailable } from './embeddings.js';

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

/**
 * Who said the thing the fact was extracted from.
 * 'unknown' is a migration-only sentinel — new writes must use an explicit value.
 */
export type SpeakerId = 'user' | 'agent' | 'external_party' | 'system' | 'unknown';

/**
 * What kind of utterance the fact came from.
 * 'unknown' is a migration-only sentinel — new writes must use an explicit value.
 */
export type SpeechType =
  | 'user_utterance'
  | 'agent_utterance'
  | 'quoted_external'
  | 'reported_speech'
  | 'hypothetical'
  | 'acknowledgment'
  | 'system_event'
  | 'unknown';

export const VALID_SPEAKER_IDS: ReadonlySet<string> = new Set<SpeakerId>([
  'user', 'agent', 'external_party', 'system', 'unknown',
]);

export const VALID_SPEECH_TYPES: ReadonlySet<string> = new Set<SpeechType>([
  'user_utterance', 'agent_utterance', 'quoted_external', 'reported_speech',
  'hypothetical', 'acknowledgment', 'system_event', 'unknown',
]);

export interface FactInput {
  content: string;
  source_path: string;
  source_conversation_id: string;
  entities: string[];
  timestamp: string;
  confidence: number;
  category: FactCategory;
  speaker_id: SpeakerId;   // who said this — required on every new write
  speech_type: SpeechType; // kind of utterance — required on every new write
  expires_at?: string;  // ISO 8601 — temporal facts expire automatically
  source_type?: string; // 'user-correction' | 'user-direct' | 'chat' | 'heartbeat' | 'ai-extraction'
  // ── ARP unification (Phase A) — agent-resource metadata ─────────────
  // Defined in @kybernesis/arp-spec :: AgentResourceMetadata. All
  // optional. When set, ARP-typed handlers (notes.search, knowledge
  // .query, etc.) filter by these dimensions at query time; the
  // policy engine on the cloud side gates whether the request happens
  // at all, but the data layer is the source of truth for what's
  // actually scoped.
  project_id?: string;
  tags?: string[];
  classification?: 'public' | 'internal' | 'confidential' | 'pii';
  connection_id?: string;
  source_did?: string;
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
  if (!colNames.has('source_type')) {
    db.exec(`ALTER TABLE facts ADD COLUMN source_type TEXT DEFAULT 'chat'`);
  }
  if (!colNames.has('is_retracted')) {
    db.exec(`ALTER TABLE facts ADD COLUMN is_retracted INTEGER DEFAULT 0`);
  }
  if (!colNames.has('retracted_by')) {
    db.exec(`ALTER TABLE facts ADD COLUMN retracted_by TEXT`);
  }
  if (!colNames.has('last_reinforced_at')) {
    db.exec(`ALTER TABLE facts ADD COLUMN last_reinforced_at TEXT`);
  }
  if (!colNames.has('speaker_id')) {
    // 'unknown' is the migration sentinel for pre-attribution rows.
    // All new writes must set an explicit non-'unknown' value.
    db.exec(`ALTER TABLE facts ADD COLUMN speaker_id TEXT NOT NULL DEFAULT 'unknown'
      CHECK (speaker_id IN ('user','agent','external_party','system','unknown'))`);
  }
  if (!colNames.has('speech_type')) {
    db.exec(`ALTER TABLE facts ADD COLUMN speech_type TEXT NOT NULL DEFAULT 'unknown'
      CHECK (speech_type IN ('user_utterance','agent_utterance','quoted_external','reported_speech','hypothetical','acknowledgment','system_event','unknown'))`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_speaker ON facts(speaker_id, speech_type)`);
  }

  // ── ARP unification (Phase A) — agent-resource metadata ─────────────
  // Schema vocabulary defined in @kybernesis/arp-spec :: AgentResourceMetadata.
  // These columns make ARP scope policies enforceable at the data layer:
  // typed /api/arp/* handlers filter by project_id / tags / classification
  // / connection_id at query time so a peer can never see a row outside
  // their declared scope, even if their request claims it's in scope.
  // All optional — pre-existing rows have nulls and match policies that
  // don't constrain the dimension. New rows MAY populate any subset.
  if (!colNames.has('project_id')) {
    db.exec(`ALTER TABLE facts ADD COLUMN project_id TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_project ON facts(project_id)`);
  }
  if (!colNames.has('tags_json')) {
    db.exec(`ALTER TABLE facts ADD COLUMN tags_json TEXT DEFAULT '[]'`);
  }
  if (!colNames.has('classification')) {
    db.exec(`ALTER TABLE facts ADD COLUMN classification TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_classification ON facts(classification)`);
  }
  if (!colNames.has('connection_id')) {
    db.exec(`ALTER TABLE facts ADD COLUMN connection_id TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_connection ON facts(connection_id)`);
  }
  if (!colNames.has('source_did')) {
    db.exec(`ALTER TABLE facts ADD COLUMN source_did TEXT`);
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
      (content, source_path, source_conversation_id, entities_json, timestamp, confidence, category, expires_at, source_type,
       project_id, tags_json, classification, connection_id, source_did,
       speaker_id, speech_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fact.content,
    fact.source_path,
    fact.source_conversation_id,
    JSON.stringify(fact.entities),
    fact.timestamp,
    fact.confidence,
    fact.category,
    fact.expires_at || null,
    fact.source_type || 'chat',
    fact.project_id ?? null,
    fact.tags ? JSON.stringify(fact.tags) : '[]',
    fact.classification ?? null,
    fact.connection_id ?? null,
    fact.source_did ?? null,
    fact.speaker_id,
    fact.speech_type,
  );

  const factId = result.lastInsertRowid as number;

  // Index in ChromaDB for semantic search (best-effort)
  try {
    if (isChromaAvailable()) {
      const chromaId = `fact_${fact.source_path.replace(/[^a-zA-Z0-9]/g, '_')}`;
      await indexDocument(root, chromaId, fact.content, {
        type: 'note',
        source_path: fact.source_path,
        title: `[fact] ${fact.content.slice(0, 80)}`,
        timestamp: fact.timestamp,
        entities: fact.entities,
        topics: [fact.category],
        summary: fact.content,
        ...(fact.project_id ? { project_id: fact.project_id } : {}),
        ...(fact.tags && fact.tags.length > 0 ? { tags_csv: fact.tags.join(',') } : {}),
        ...(fact.classification ? { classification: fact.classification } : {}),
        ...(fact.connection_id ? { connection_id: fact.connection_id } : {}),
        ...(fact.source_did ? { source_did: fact.source_did } : {}),
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
 * Retract a fact (mark as no longer valid without deleting).
 * Used when a user explicitly says something is wrong.
 */
export async function retractFact(
  root: string,
  factId: number,
  retractedBy: string = 'user-correction'
): Promise<void> {
  const db = await getTimelineDb(root);
  db.prepare(`
    UPDATE facts SET is_retracted = 1, retracted_by = ?, is_latest = 0, updated_at = datetime('now')
    WHERE id = ?
  `).run(retractedBy, factId);
  logger.debug('Retracted fact', { factId, retractedBy });
}

/**
 * Reinforce a fact — update last_reinforced_at when the same fact is seen again.
 * Prevents confidence decay on facts that keep getting confirmed.
 */
export async function reinforceFact(
  root: string,
  factId: number
): Promise<void> {
  const db = await getTimelineDb(root);
  db.prepare(`
    UPDATE facts SET last_reinforced_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(factId);
  logger.debug('Reinforced fact', { factId });
}

/**
 * Get a single fact by ID.
 */
export async function getFactById(
  root: string,
  factId: number
): Promise<StoredFact | null> {
  const db = await getTimelineDb(root);
  const row = db.prepare(`
    SELECT id, content, source_path, source_conversation_id, entities_json,
           timestamp, confidence, category, created_at,
           COALESCE(is_latest, 1) as is_latest, superseded_by
    FROM facts WHERE id = ?
  `).get(factId) as (Omit<StoredFact, 'entities'> & { entities_json: string }) | undefined;
  if (!row) return null;
  return { ...row, entities: JSON.parse(row.entities_json) } as StoredFact;
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
  // Escape LIKE metacharacters in user input
  const escapedEntity = entity.toLowerCase().replace(/[%_\\]/g, ch => `\\${ch}`);
  const entityPattern = `%${escapedEntity}%`;

  let sql = `
    SELECT id, content, source_path, source_conversation_id, entities_json,
           timestamp, confidence, category, created_at,
           COALESCE(is_latest, 1) as is_latest,
           superseded_by,
           COALESCE(speaker_id, 'unknown') as speaker_id,
           COALESCE(speech_type, 'unknown') as speech_type
    FROM facts
    WHERE LOWER(entities_json) LIKE ? ESCAPE '\\'
      AND COALESCE(is_retracted, 0) = 0
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
    speaker_id: string;
    speech_type: string;
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
    speaker_id: (row.speaker_id || 'unknown') as SpeakerId,
    speech_type: (row.speech_type || 'unknown') as SpeechType,
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
