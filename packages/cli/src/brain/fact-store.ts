/**
 * KyberBot — Fact Store (Arcana dual-write wrapper)
 *
 * Module #4 of the Arcana adoption (see docs/arcana-adoption.md).
 *
 * Per Arcana's ADR 004 (which supersedes ADR 003): the corrected `FactSchema`
 * makes `fact` (sentence form) required and `attribute`/`value` (triple
 * decomposition) optional. KyberBot's sentence-shaped facts ARE Facts under
 * that schema — they just lack the optional decomposition. So this module
 * mirrors via `command.recordFact` (not `ingest.storeMemory`).
 *
 * Local SQLite `facts` table remains the interface-layer index (richer
 * schema: source_path upsert, FTS, category/ARP filtering, is_latest /
 * superseded_by lineage). Each store mirrors to Arcana; the returned
 * fact id is stored in `facts.arcana_fact_id`.
 *
 * Note: Arcana's `command.correctFact` (the supersede-on-rewrite primitive)
 * is still a v0.1 stub. Until it lands, the "duplicate source_path" path
 * keeps the prior `arcana_fact_id` link in libsql and skips re-recording in
 * Arcana — the Arcana fact stays at its original content. When `correctFact`
 * is implemented we'll branch like timeline does for `updateMemory`.
 */

import { getTimelineDb } from './timeline.js';
import { createLogger } from '../logger.js';

import { indexDocument, isChromaAvailable } from './embeddings.js';
import { getCortexInstance } from './cortex-singleton.js';
import { NotImplementedError } from '@kybernesis/cortex-core';
import type { FactSourceType, Scopes } from '@kybernesis/cortex-contracts';

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

  // Arcana adoption — FK to the Fact mirrored into Arcana via
  // command.recordFact (per ADR 004). Nullable: pre-existing rows have no
  // Arcana mirror, and the mirror is skipped while the Arcana singleton is
  // uninitialised or when entities[] is empty (Arcana's Fact requires a
  // subject entity).
  //
  // History: this column was originally `arcana_memory_id` (when fact-store
  // mirrored via ingest.storeMemory under ADR 003). ADR 004 superseded that
  // direction; the column is renamed in place. Older DBs run the migration
  // below; fresh DBs only see arcana_fact_id.
  if (colNames.has('arcana_memory_id') && !colNames.has('arcana_fact_id')) {
    db.exec(`ALTER TABLE facts RENAME COLUMN arcana_memory_id TO arcana_fact_id`);
    db.exec(`DROP INDEX IF EXISTS idx_facts_arcana_memory`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_arcana_fact ON facts(arcana_fact_id)`);
  } else if (!colNames.has('arcana_fact_id')) {
    db.exec(`ALTER TABLE facts ADD COLUMN arcana_fact_id TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_arcana_fact ON facts(arcana_fact_id)`);
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
// ARCANA MIRROR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Map KyberBot's source_type vocabulary onto Arcana's narrower FactSourceType
 * enum (`'terminal' | 'chat' | 'ai-extraction' | 'upload' | 'connector'`).
 *
 * KyberBot's source_type values (defined in callsites, not a strict enum):
 *   - 'chat'             — channel input. Maps to 'chat'.
 *   - 'user-direct'      — user typed at the terminal. Maps to 'terminal'.
 *   - 'user-correction'  — user corrected a prior fact at the terminal. Maps to 'terminal'.
 *   - 'ai-extraction'    — Haiku/Sonnet auto-extracted. Maps to 'ai-extraction'.
 *   - 'heartbeat'        — extracted during a heartbeat run. Maps to 'ai-extraction'.
 *   - default / unknown  → 'ai-extraction' (safe default; most production facts).
 */
function mapFactSourceTypeToArcanaSource(kbSourceType?: string): FactSourceType {
  switch (kbSourceType) {
    case 'chat': return 'chat';
    case 'user-direct':
    case 'user-correction':
      return 'terminal';
    case 'ai-extraction':
    case 'heartbeat':
      return 'ai-extraction';
    default:
      return 'ai-extraction';
  }
}

/**
 * Best-effort mirror of a KyberBot fact into Arcana's Fact store.
 * Returns the new fact id, or null if Arcana is unavailable / still stubbed
 * / mirror fails / fact has no entities. Failures never block the local
 * fact write.
 *
 * Per Arcana v1.0.0 (ADR 013): the full `entities` array is denormalised
 * into the Fact row, `category` is required, and `sourcePath` +
 * `sourceConversationId` backlinks light up Layer 0 fact-FTS at retrieval.
 */
async function mirrorFactToCortex(fact: FactInput): Promise<string | null> {
  const arcana = getCortexInstance();
  if (!arcana) return null;

  const entities = (fact.entities ?? []).filter(e => typeof e === 'string' && e.length > 0);
  if (entities.length === 0) {
    logger.debug('Skipping Arcana fact mirror — no entities', {
      source_path: fact.source_path,
    });
    return null;
  }

  const scopes: Scopes = {};
  if (fact.project_id) scopes.project_id = fact.project_id;
  if (fact.classification) scopes.classification = fact.classification;
  if (fact.connection_id) scopes.connection_id = fact.connection_id;
  if (fact.source_did) scopes.source_did = fact.source_did;

  try {
    return await arcana.command.recordFact({
      fact: fact.content,
      entities,
      category: fact.category,
      confidence: fact.confidence,
      sourceType: mapFactSourceTypeToArcanaSource(fact.source_type),
      ...(fact.source_path ? { sourcePath: fact.source_path } : {}),
      ...(fact.source_conversation_id ? { sourceConversationId: fact.source_conversation_id } : {}),
      ...(fact.expires_at ? { expiresAt: fact.expires_at } : {}),
      ...(Object.keys(scopes).length > 0 ? { scopes } : {}),
    });
  } catch (err) {
    if (err instanceof NotImplementedError) {
      logger.debug('Arcana command.recordFact still a stub; skipping fact mirror', {
        source_path: fact.source_path,
      });
      return null;
    }
    logger.warn('Arcana fact mirror failed; local write proceeds', {
      error: String(err),
      source_path: fact.source_path,
    });
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Store a single fact in the database and optionally index it in ChromaDB.
 * Also mirrors to Arcana's Memory store when the singleton is initialised.
 */
export async function storeFact(root: string, fact: FactInput): Promise<number> {
  const db = await getTimelineDb(root);

  // Look up the existing Arcana fact id for this source_path so a re-write
  // can carry it forward (until command.correctFact lands, this means the
  // Arcana fact stays at its original content while the local row updates —
  // documented in the module header).
  const existingRow = db
    .prepare('SELECT arcana_fact_id FROM facts WHERE source_path = ?')
    .get(fact.source_path) as { arcana_fact_id: string | null } | undefined;
  const existingArcanaFactId = existingRow?.arcana_fact_id ?? null;

  const arcanaFactId = existingArcanaFactId ?? await mirrorFactToCortex(fact);

  const result = db.prepare(`
    INSERT OR REPLACE INTO facts
      (content, source_path, source_conversation_id, entities_json, timestamp, confidence, category, expires_at, source_type,
       project_id, tags_json, classification, connection_id, source_did, arcana_fact_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    arcanaFactId,
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
           superseded_by
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
 *
 * Also mirrors the link to Arcana via `command.markFactSuperseded` (module
 * #11). Mirror is best-effort: requires both local facts to already have
 * `arcana_fact_id` populated (i.e., they were mirrored at recordFact time);
 * skips silently if either is null.
 */
export async function markFactSuperseded(
  root: string,
  oldFactId: number,
  newFactId: number
): Promise<void> {
  const db = await getTimelineDb(root);

  // Look up arcana_fact_id for both facts BEFORE the local UPDATE — the read
  // is cheap and lets us skip the mirror cleanly when either side hasn't
  // mirrored.
  const oldRow = db
    .prepare('SELECT arcana_fact_id FROM facts WHERE id = ?')
    .get(oldFactId) as { arcana_fact_id: string | null } | undefined;
  const newRow = db
    .prepare('SELECT arcana_fact_id FROM facts WHERE id = ?')
    .get(newFactId) as { arcana_fact_id: string | null } | undefined;

  db.prepare(`
    UPDATE facts
    SET is_latest = 0, superseded_by = ?
    WHERE id = ?
  `).run(newFactId, oldFactId);

  logger.debug('Marked fact as superseded', { oldFactId, newFactId });

  if (oldRow?.arcana_fact_id && newRow?.arcana_fact_id) {
    const arcana = getCortexInstance();
    if (arcana) {
      try {
        await arcana.command.markFactSuperseded(oldRow.arcana_fact_id, newRow.arcana_fact_id);
      } catch (err) {
        if (err instanceof NotImplementedError) {
          logger.debug('Arcana command.markFactSuperseded still a stub; skipping mirror', {
            oldFactId,
            newFactId,
          });
        } else {
          logger.warn('Arcana markFactSuperseded mirror failed; local update proceeds', {
            error: String(err),
            oldFactId,
            newFactId,
          });
        }
      }
    }
  }
}
