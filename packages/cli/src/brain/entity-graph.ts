/**
 * KyberBot — Entity Graph Index
 *
 * Links entities across conversations to answer questions like
 * "What do I know about John?" by tracking:
 * - Entities (people, companies, projects, places, topics)
 * - Entity mentions in conversations
 * - Entity co-occurrence relationships
 *
 * Uses SQLite for persistence.
 */

import Database from 'better-sqlite3';
import { openWithRecovery } from './db-recovery.js';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { createLogger } from '../logger.js';

const logger = createLogger('entity-graph');

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type EntityType = 'person' | 'company' | 'project' | 'place' | 'topic';

export interface Entity {
  id: number;
  name: string;
  normalized_name: string;
  aliases: string[];
  type: EntityType;
  first_seen: string;
  last_seen: string;
  mention_count: number;
}

export interface EntityMention {
  id: number;
  entity_id: number;
  conversation_id: string;
  source_path: string;
  context: string;
  timestamp: string;
}

export type RelationshipType =
  | 'co-occurred'
  | 'founded'
  | 'works_at'
  | 'invested_in'
  | 'met_with'
  | 'created'
  | 'manages'
  | 'partners_with'
  | 'located_in'
  | 'discussed'
  | 'related_to'
  | 'reports_to'
  | 'uses'
  | 'depends_on'
  | 'part_of';

export interface EntityRelation {
  source_id: number;
  target_id: number;
  relationship: RelationshipType;
  strength: number;
  confidence?: number;
  method?: string;
  rationale?: string;
}

export interface EntityContext {
  entity: Entity;
  mentions: EntityMention[];
  related_entities: Array<{
    entity: Entity;
    relationship: string;
    strength: number;
  }>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

const databases = new Map<string, Database.Database>();

/**
 * Reset the entity graph DB connection(s). If root is given, closes only that
 * root's connection. If no root, closes all (backward compat for eval/tests).
 */
export function resetEntityGraphDb(root?: string): void {
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

  const newDbPath = join(dataDir, 'entity-graph.db');
  const newDb = openWithRecovery(newDbPath);

  newDb.pragma('journal_mode = WAL');

  newDb.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      aliases TEXT DEFAULT '[]',
      type TEXT NOT NULL CHECK(type IN ('person', 'company', 'project', 'place', 'topic')),
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      mention_count INTEGER DEFAULT 1,
      UNIQUE(normalized_name, type)
    );

    CREATE INDEX IF NOT EXISTS idx_entities_normalized ON entities(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);

    CREATE TABLE IF NOT EXISTS entity_mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL,
      conversation_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      context TEXT,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_mentions_conversation ON entity_mentions(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_mentions_entity ON entity_mentions(entity_id);
    CREATE INDEX IF NOT EXISTS idx_mentions_timestamp ON entity_mentions(timestamp);

    CREATE TABLE IF NOT EXISTS entity_relations (
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      relationship TEXT DEFAULT 'co-occurred',
      strength INTEGER DEFAULT 1,
      PRIMARY KEY (source_id, target_id),
      FOREIGN KEY (source_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES entities(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_relations_source ON entity_relations(source_id);
    CREATE INDEX IF NOT EXISTS idx_relations_target ON entity_relations(target_id);
  `);

  runEntityMigrations(newDb);

  databases.set(root, newDb);
  logger.info('Entity graph database initialized', { path: newDbPath });
  return newDb;
}

function runEntityMigrations(database: Database.Database): void {
  const entityCols = database.prepare(`PRAGMA table_info(entities)`).all() as Array<{ name: string }>;
  const entityColNames = new Set(entityCols.map(c => c.name));

  if (!entityColNames.has('priority')) {
    database.exec(`ALTER TABLE entities ADD COLUMN priority REAL DEFAULT 0.5`);
  }
  if (!entityColNames.has('decay_score')) {
    database.exec(`ALTER TABLE entities ADD COLUMN decay_score REAL DEFAULT 0.0`);
  }
  if (!entityColNames.has('tier')) {
    database.exec(`ALTER TABLE entities ADD COLUMN tier TEXT DEFAULT 'warm'`);
  }
  if (!entityColNames.has('last_accessed')) {
    database.exec(`ALTER TABLE entities ADD COLUMN last_accessed TEXT`);
  }
  if (!entityColNames.has('access_count')) {
    database.exec(`ALTER TABLE entities ADD COLUMN access_count INTEGER DEFAULT 0`);
  }
  if (!entityColNames.has('is_pinned')) {
    database.exec(`ALTER TABLE entities ADD COLUMN is_pinned INTEGER DEFAULT 0`);
  }
  if (!entityColNames.has('last_reasoned_at')) {
    database.exec(`ALTER TABLE entities ADD COLUMN last_reasoned_at TEXT`);
  }

  // Mention-level source tracking
  const mentionCols = database.prepare(`PRAGMA table_info(entity_mentions)`).all() as Array<{ name: string }>;
  const mentionColNames = new Set(mentionCols.map(c => c.name));

  if (!mentionColNames.has('source_type')) {
    database.exec(`ALTER TABLE entity_mentions ADD COLUMN source_type TEXT DEFAULT 'chat'`);
  }
  if (!mentionColNames.has('confidence')) {
    database.exec(`ALTER TABLE entity_mentions ADD COLUMN confidence REAL DEFAULT 0.85`);
  }

  const relCols = database.prepare(`PRAGMA table_info(entity_relations)`).all() as Array<{ name: string }>;
  const relColNames = new Set(relCols.map(c => c.name));

  if (!relColNames.has('confidence')) {
    database.exec(`ALTER TABLE entity_relations ADD COLUMN confidence REAL DEFAULT 0.5`);
  }
  if (!relColNames.has('method')) {
    database.exec(`ALTER TABLE entity_relations ADD COLUMN method TEXT DEFAULT 'co-occurred'`);
  }
  if (!relColNames.has('rationale')) {
    database.exec(`ALTER TABLE entity_relations ADD COLUMN rationale TEXT`);
  }
  if (!relColNames.has('last_verified')) {
    database.exec(`ALTER TABLE entity_relations ADD COLUMN last_verified TEXT`);
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_entities_tier ON entities(tier);
    CREATE INDEX IF NOT EXISTS idx_entities_priority ON entities(priority DESC);
    CREATE INDEX IF NOT EXISTS idx_relations_confidence ON entity_relations(confidence DESC);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS entity_merges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keep_id INTEGER NOT NULL,
      remove_id INTEGER NOT NULL,
      keep_name TEXT,
      remove_name TEXT,
      keep_type TEXT,
      remove_type TEXT,
      reason TEXT NOT NULL,
      confidence REAL,
      ai_rationale TEXT,
      mentions_moved INTEGER DEFAULT 0,
      relations_moved INTEGER DEFAULT 0,
      merged_at TEXT DEFAULT (datetime('now')),
      merged_by TEXT DEFAULT 'sleep:entity-hygiene'
    );
  `);

  // Per-entity narrative profiles (generated by sleep agent)
  database.exec(`
    CREATE TABLE IF NOT EXISTS entity_profiles (
      entity_id INTEGER PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
      profile TEXT NOT NULL,
      generated_at TEXT DEFAULT (datetime('now')),
      fact_count INTEGER DEFAULT 0
    );
  `);

  // Contradiction tracking for close-confidence fact conflicts
  database.exec(`
    CREATE TABLE IF NOT EXISTS contradictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER,
      fact_a_id INTEGER,
      fact_b_id INTEGER,
      fact_a TEXT,
      fact_b TEXT,
      description TEXT,
      status TEXT DEFAULT 'open',
      resolved_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_contradictions_entity ON contradictions(entity_id);
    CREATE INDEX IF NOT EXISTS idx_contradictions_status ON contradictions(status);
  `);

  // Entity insights from reasoning engine (deduction + induction)
  database.exec(`
    CREATE TABLE IF NOT EXISTS entity_insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      insight_type TEXT NOT NULL,
      insight TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      confidence REAL DEFAULT 0.70,
      source_entity_ids TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT,
      is_stale INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_insights_entity ON entity_insights(entity_id);
    CREATE INDEX IF NOT EXISTS idx_insights_type ON entity_insights(insight_type);
  `);
}

export async function getEntityGraphDb(root: string): Promise<Database.Database> {
  return ensureDatabase(root);
}

export async function mergeEntities(
  root: string,
  keepId: number,
  removeId: number,
  reason: string,
  confidence?: number,
  aiRationale?: string,
  mergedBy?: string
): Promise<{ mentionsMoved: number; relationsMoved: number }> {
  const database = await ensureDatabase(root);

  const keepEntity = database.prepare('SELECT * FROM entities WHERE id = ?').get(keepId) as any;
  const removeEntity = database.prepare('SELECT * FROM entities WHERE id = ?').get(removeId) as any;

  if (!keepEntity || !removeEntity) {
    throw new Error(`Entity not found: keep=${keepId} remove=${removeId}`);
  }

  let mentionsMoved = 0;
  let relationsMoved = 0;

  const merge = database.transaction(() => {
    const mentionResult = database
      .prepare('UPDATE entity_mentions SET entity_id = ? WHERE entity_id = ?')
      .run(keepId, removeId);
    mentionsMoved = mentionResult.changes;

    const entityExists = (id: number) =>
      database.prepare('SELECT 1 FROM entities WHERE id = ?').get(id) !== undefined;

    const sourceRels = database
      .prepare('SELECT * FROM entity_relations WHERE source_id = ?')
      .all(removeId) as EntityRelation[];

    for (const rel of sourceRels) {
      const targetId = rel.target_id === removeId ? keepId : rel.target_id;
      if (targetId === keepId) continue;
      if (!entityExists(targetId)) continue;

      const existing = database
        .prepare('SELECT * FROM entity_relations WHERE source_id = ? AND target_id = ?')
        .get(keepId, targetId) as EntityRelation | undefined;

      if (existing) {
        database.prepare(
          'UPDATE entity_relations SET strength = strength + ?, confidence = MAX(confidence, ?) WHERE source_id = ? AND target_id = ?'
        ).run(rel.strength, rel.confidence || 0.5, keepId, targetId);
      } else {
        database.prepare(
          'INSERT INTO entity_relations (source_id, target_id, relationship, strength, confidence, method, rationale) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(keepId, targetId, rel.relationship, rel.strength, rel.confidence || 0.5, rel.method || 'merged', rel.rationale);
        relationsMoved++;
      }
    }

    const targetRels = database
      .prepare('SELECT * FROM entity_relations WHERE target_id = ?')
      .all(removeId) as EntityRelation[];

    for (const rel of targetRels) {
      const sourceId = rel.source_id === removeId ? keepId : rel.source_id;
      if (sourceId === keepId) continue;
      if (!entityExists(sourceId)) continue;

      const existing = database
        .prepare('SELECT * FROM entity_relations WHERE source_id = ? AND target_id = ?')
        .get(sourceId, keepId) as EntityRelation | undefined;

      if (existing) {
        database.prepare(
          'UPDATE entity_relations SET strength = strength + ?, confidence = MAX(confidence, ?) WHERE source_id = ? AND target_id = ?'
        ).run(rel.strength, rel.confidence || 0.5, sourceId, keepId);
      } else {
        database.prepare(
          'INSERT INTO entity_relations (source_id, target_id, relationship, strength, confidence, method, rationale) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(sourceId, keepId, rel.relationship, rel.strength, rel.confidence || 0.5, rel.method || 'merged', rel.rationale);
        relationsMoved++;
      }
    }

    database.prepare('DELETE FROM entity_relations WHERE source_id = ? OR target_id = ?').run(removeId, removeId);
    database.prepare('DELETE FROM entity_relations WHERE source_id = ? AND target_id = ?').run(keepId, keepId);

    const keepAliases: string[] = JSON.parse(keepEntity.aliases || '[]');
    const removeAliases: string[] = JSON.parse(removeEntity.aliases || '[]');
    const removeName = normalizeEntityName(removeEntity.name);

    const allAliases = new Set([...keepAliases, ...removeAliases, removeName]);
    allAliases.delete(normalizeEntityName(keepEntity.name));
    database.prepare('UPDATE entities SET aliases = ? WHERE id = ?')
      .run(JSON.stringify([...allAliases]), keepId);

    database.prepare(`
      UPDATE entities SET
        mention_count = mention_count + ?,
        first_seen = MIN(first_seen, ?),
        last_seen = MAX(last_seen, ?)
      WHERE id = ?
    `).run(removeEntity.mention_count, removeEntity.first_seen, removeEntity.last_seen, keepId);

    database.prepare(`
      INSERT INTO entity_merges (keep_id, remove_id, keep_name, remove_name, keep_type, remove_type, reason, confidence, ai_rationale, mentions_moved, relations_moved, merged_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      keepId, removeId, keepEntity.name, removeEntity.name,
      keepEntity.type, removeEntity.type, reason,
      confidence ?? null, aiRationale ?? null,
      mentionsMoved, relationsMoved,
      mergedBy || 'sleep:entity-hygiene'
    );

    database.prepare('DELETE FROM entities WHERE id = ?').run(removeId);
  });

  merge();
  logger.info(`Merged entity "${removeEntity.name}" (${removeId}) into "${keepEntity.name}" (${keepId})`, {
    reason, mentionsMoved, relationsMoved,
  });

  return { mentionsMoved, relationsMoved };
}

export async function deleteEntity(
  root: string,
  entityId: number,
  reason: string,
  mergedBy?: string
): Promise<void> {
  const database = await ensureDatabase(root);

  const entity = database.prepare('SELECT * FROM entities WHERE id = ?').get(entityId) as any;
  if (!entity) return;

  const del = database.transaction(() => {
    const mentionCount = (database.prepare('SELECT COUNT(*) as c FROM entity_mentions WHERE entity_id = ?').get(entityId) as any).c;
    const relCount = (database.prepare('SELECT COUNT(*) as c FROM entity_relations WHERE source_id = ? OR target_id = ?').get(entityId, entityId) as any).c;

    database.prepare('DELETE FROM entity_mentions WHERE entity_id = ?').run(entityId);
    database.prepare('DELETE FROM entity_relations WHERE source_id = ? OR target_id = ?').run(entityId, entityId);
    database.prepare('DELETE FROM entities WHERE id = ?').run(entityId);

    database.prepare(`
      INSERT INTO entity_merges (keep_id, remove_id, keep_name, remove_name, keep_type, remove_type, reason, mentions_moved, relations_moved, merged_by)
      VALUES (0, ?, NULL, ?, NULL, ?, ?, ?, ?, ?)
    `).run(entityId, entity.name, entity.type, reason, mentionCount, relCount, mergedBy || 'sleep:entity-hygiene');
  });

  del();
  logger.info(`Deleted entity "${entity.name}" (${entityId})`, { reason });
}

export { normalizeEntityName };

export async function initializeEntityGraph(root: string): Promise<void> {
  await ensureDatabase(root);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTITY OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

function normalizeEntityName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Escape LIKE metacharacters (%, _) for safe use in parameterized LIKE queries. */
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, ch => `\\${ch}`);
}

export async function findOrCreateEntity(
  root: string,
  name: string,
  type: EntityType,
  timestamp: string
): Promise<Entity> {
  const database = await ensureDatabase(root);
  const normalizedName = normalizeEntityName(name);

  let existing = database
    .prepare('SELECT * FROM entities WHERE normalized_name = ? AND type = ?')
    .get(normalizedName, type) as Entity | undefined;

  // Fallback: check if this name is stored as an alias of an existing entity
  if (!existing) {
    existing = database
      .prepare(`SELECT * FROM entities WHERE type = ? AND LOWER(aliases) LIKE ? ESCAPE '\\'`)
      .get(type, `%"${escapeLike(normalizedName)}"%`) as Entity | undefined;
    if (existing) {
      logger.debug(`Matched entity via alias: "${name}" → "${existing.name}"`);
    }
  }

  if (existing) {
    database
      .prepare(
        'UPDATE entities SET last_seen = ?, mention_count = mention_count + 1 WHERE id = ?'
      )
      .run(timestamp, existing.id);

    return {
      ...existing,
      aliases: JSON.parse(existing.aliases as unknown as string),
      last_seen: timestamp,
      mention_count: existing.mention_count + 1,
    };
  }

  const result = database
    .prepare(
      `INSERT INTO entities (name, normalized_name, aliases, type, first_seen, last_seen, mention_count)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
    .run(name, normalizedName, '[]', type, timestamp, timestamp);

  logger.debug(`Created entity: ${name} (${type})`, { id: result.lastInsertRowid });

  return {
    id: result.lastInsertRowid as number,
    name,
    normalized_name: normalizedName,
    aliases: [],
    type,
    first_seen: timestamp,
    last_seen: timestamp,
    mention_count: 1,
  };
}

export async function addEntityAlias(
  root: string,
  entityId: number,
  alias: string
): Promise<void> {
  const database = await ensureDatabase(root);

  const entity = database
    .prepare('SELECT aliases FROM entities WHERE id = ?')
    .get(entityId) as { aliases: string } | undefined;

  if (!entity) return;

  const aliases = JSON.parse(entity.aliases);
  const normalizedAlias = normalizeEntityName(alias);

  if (!aliases.includes(normalizedAlias)) {
    aliases.push(normalizedAlias);
    database
      .prepare('UPDATE entities SET aliases = ? WHERE id = ?')
      .run(JSON.stringify(aliases), entityId);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MENTION OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export async function addEntityMention(
  root: string,
  entityId: number,
  conversationId: string,
  sourcePath: string,
  context: string,
  timestamp: string,
  sourceType: string = 'chat',
  confidence: number = 0.85
): Promise<void> {
  const database = await ensureDatabase(root);

  database
    .prepare(
      `INSERT INTO entity_mentions (entity_id, conversation_id, source_path, context, timestamp, source_type, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(entityId, conversationId, sourcePath, context, timestamp, sourceType, confidence);
}

// ═══════════════════════════════════════════════════════════════════════════════
// RELATION OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export async function linkEntities(
  root: string,
  sourceId: number,
  targetId: number,
  relationship: RelationshipType = 'co-occurred'
): Promise<void> {
  const database = await ensureDatabase(root);

  const [id1, id2] = sourceId < targetId ? [sourceId, targetId] : [targetId, sourceId];

  database
    .prepare(
      `INSERT INTO entity_relations (source_id, target_id, relationship, strength)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(source_id, target_id) DO UPDATE SET strength = strength + 1`
    )
    .run(id1, id2, relationship);
}

export async function linkEntitiesWithType(
  root: string,
  sourceId: number,
  targetId: number,
  options: {
    relationship: RelationshipType;
    confidence?: number;
    rationale?: string;
    method?: string;
  }
): Promise<void> {
  const database = await ensureDatabase(root);

  const directional = ['founded', 'works_at', 'invested_in', 'created', 'manages', 'located_in'];
  const isDirectional = directional.includes(options.relationship);

  const [id1, id2] = isDirectional
    ? [sourceId, targetId]
    : sourceId < targetId
      ? [sourceId, targetId]
      : [targetId, sourceId];

  const confidence = options.confidence ?? 0.7;
  const method = options.method ?? 'ai-extraction';
  const now = new Date().toISOString();

  database
    .prepare(
      `INSERT INTO entity_relations (source_id, target_id, relationship, strength, confidence, method, rationale, last_verified)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(source_id, target_id) DO UPDATE SET
         relationship = CASE
           WHEN excluded.confidence > entity_relations.confidence THEN excluded.relationship
           ELSE entity_relations.relationship
         END,
         strength = strength + 1,
         confidence = MAX(entity_relations.confidence, excluded.confidence),
         rationale = COALESCE(excluded.rationale, entity_relations.rationale),
         last_verified = excluded.last_verified`
    )
    .run(id1, id2, options.relationship, confidence, method, options.rationale || null, now);

  logger.debug(`Linked entities with type: ${options.relationship}`, {
    sourceId: id1,
    targetId: id2,
    confidence,
  });
}

export async function getTypedRelationships(
  root: string,
  entityId: number
): Promise<Array<{
  entity: Entity;
  relationship: RelationshipType;
  direction: 'outgoing' | 'incoming';
  confidence: number;
  rationale?: string;
}>> {
  const database = await ensureDatabase(root);

  const results = database
    .prepare(
      `SELECT
         er.source_id,
         er.target_id,
         er.relationship,
         er.confidence,
         er.rationale,
         e.id, e.name, e.normalized_name, e.type, e.aliases
       FROM entity_relations er
       JOIN entities e ON (
         CASE WHEN er.source_id = ? THEN er.target_id ELSE er.source_id END = e.id
       )
       WHERE (er.source_id = ? OR er.target_id = ?)
         AND er.relationship != 'co-occurred'
       ORDER BY er.confidence DESC, er.strength DESC`
    )
    .all(entityId, entityId, entityId) as Array<{
    source_id: number;
    target_id: number;
    relationship: RelationshipType;
    confidence: number;
    rationale: string | null;
    id: number;
    name: string;
    normalized_name: string;
    type: EntityType;
    aliases: string;
  }>;

  return results.map((row) => ({
    entity: {
      id: row.id,
      name: row.name,
      normalized_name: row.normalized_name,
      type: row.type,
      aliases: JSON.parse(row.aliases),
      first_seen: '',
      last_seen: '',
      mention_count: 0,
    },
    relationship: row.relationship,
    direction: row.source_id === entityId ? 'outgoing' : 'incoming',
    confidence: row.confidence || 0.5,
    rationale: row.rationale || undefined,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVERSATION LINKING
// ═══════════════════════════════════════════════════════════════════════════════

export interface ConversationEntity {
  type: EntityType;
  name: string;
  context?: string;
}

export async function linkEntitiesFromConversation(
  root: string,
  conversationId: string,
  sourcePath: string,
  timestamp: string,
  entities: ConversationEntity[]
): Promise<void> {
  if (entities.length === 0) return;

  logger.debug(`Linking ${entities.length} entities from conversation ${conversationId}`);

  const entityIds: number[] = [];

  for (const entity of entities) {
    const dbEntity = await findOrCreateEntity(root, entity.name, entity.type, timestamp);
    await addEntityMention(root, dbEntity.id, conversationId, sourcePath, entity.context || '', timestamp);
    entityIds.push(dbEntity.id);
  }

  // NOTE: Co-occurrence links removed — they polluted the graph with O(n²)
  // meaningless relationships. The sleep agent's link step discovers
  // meaningful edges via tag/entity overlap analysis.

  logger.info(`Linked ${entities.length} entities from conversation`, {
    conversationId,
    entityCount: entities.length,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUERY OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export async function getEntityContext(
  root: string,
  nameOrId: string | number
): Promise<EntityContext | null> {
  const database = await ensureDatabase(root);

  let entity: Entity | undefined;

  if (typeof nameOrId === 'number') {
    entity = database
      .prepare('SELECT * FROM entities WHERE id = ?')
      .get(nameOrId) as Entity | undefined;
  } else {
    const normalized = normalizeEntityName(nameOrId);
    entity = database
      .prepare(
        `SELECT * FROM entities
         WHERE normalized_name = ?
         OR aliases LIKE ? ESCAPE '\\'`
      )
      .get(normalized, `%"${escapeLike(normalized)}"%`) as Entity | undefined;
  }

  if (!entity) return null;

  entity.aliases = JSON.parse(entity.aliases as unknown as string);

  const mentions = database
    .prepare(
      `SELECT * FROM entity_mentions
       WHERE entity_id = ?
       ORDER BY timestamp DESC`
    )
    .all(entity.id) as EntityMention[];

  const relations = database
    .prepare(
      `SELECT
         CASE WHEN source_id = ? THEN target_id ELSE source_id END as related_id,
         relationship,
         strength
       FROM entity_relations
       WHERE source_id = ? OR target_id = ?
       ORDER BY strength DESC
       LIMIT 20`
    )
    .all(entity.id, entity.id, entity.id) as Array<{
    related_id: number;
    relationship: string;
    strength: number;
  }>;

  const relatedEntities = relations
    .map((rel) => {
      const relatedEntity = database
        .prepare('SELECT * FROM entities WHERE id = ?')
        .get(rel.related_id) as Entity | undefined;

      if (!relatedEntity) return null;

      relatedEntity.aliases = JSON.parse(relatedEntity.aliases as unknown as string);

      return {
        entity: relatedEntity,
        relationship: rel.relationship,
        strength: rel.strength,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  return {
    entity,
    mentions,
    related_entities: relatedEntities,
  };
}

export async function searchEntities(
  root: string,
  query: string,
  options: { type?: EntityType; limit?: number } = {}
): Promise<Entity[]> {
  const database = await ensureDatabase(root);
  const normalized = normalizeEntityName(query);
  const limit = options.limit || 20;

  const escaped = escapeLike(normalized);
  let sql = `
    SELECT * FROM entities
    WHERE (normalized_name LIKE ? ESCAPE '\\' OR aliases LIKE ? ESCAPE '\\')
  `;
  const params: (string | number)[] = [`%${escaped}%`, `%${escaped}%`];

  if (options.type) {
    sql += ` AND type = ?`;
    params.push(options.type);
  }

  sql += ` ORDER BY mention_count DESC LIMIT ?`;
  params.push(limit);

  const results = database.prepare(sql).all(...params) as Entity[];

  return results.map((e) => ({
    ...e,
    aliases: JSON.parse(e.aliases as unknown as string),
  }));
}

export async function getRecentEntities(
  root: string,
  limit = 20
): Promise<Entity[]> {
  const database = await ensureDatabase(root);

  const results = database
    .prepare(
      `SELECT * FROM entities
       ORDER BY last_seen DESC
       LIMIT ?`
    )
    .all(limit) as Entity[];

  return results.map((e) => ({
    ...e,
    aliases: JSON.parse(e.aliases as unknown as string),
  }));
}

export async function getMostMentionedEntities(
  root: string,
  options: { type?: EntityType; limit?: number } = {}
): Promise<Entity[]> {
  const database = await ensureDatabase(root);
  const limit = options.limit || 20;

  let sql = 'SELECT * FROM entities';
  const params: (string | number)[] = [];

  if (options.type) {
    sql += ' WHERE type = ?';
    params.push(options.type);
  }

  sql += ' ORDER BY mention_count DESC LIMIT ?';
  params.push(limit);

  const results = database.prepare(sql).all(...params) as Entity[];

  return results.map((e) => ({
    ...e,
    aliases: JSON.parse(e.aliases as unknown as string),
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════════════

export async function getEntityGraphStats(
  root: string
): Promise<{
  total_entities: number;
  total_mentions: number;
  total_relations: number;
  by_type: Record<EntityType, number>;
}> {
  const database = await ensureDatabase(root);

  const totalEntities = database
    .prepare('SELECT COUNT(*) as count FROM entities')
    .get() as { count: number };

  const totalMentions = database
    .prepare('SELECT COUNT(*) as count FROM entity_mentions')
    .get() as { count: number };

  const totalRelations = database
    .prepare('SELECT COUNT(*) as count FROM entity_relations')
    .get() as { count: number };

  const byType = database
    .prepare('SELECT type, COUNT(*) as count FROM entities GROUP BY type')
    .all() as Array<{ type: EntityType; count: number }>;

  const byTypeRecord: Record<EntityType, number> = {
    person: 0,
    company: 0,
    project: 0,
    place: 0,
    topic: 0,
  };

  for (const row of byType) {
    byTypeRecord[row.type] = row.count;
  }

  return {
    total_entities: totalEntities.count,
    total_mentions: totalMentions.count,
    total_relations: totalRelations.count,
    by_type: byTypeRecord,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTITY DETECTION IN QUERIES
// ═══════════════════════════════════════════════════════════════════════════════

export async function detectEntitiesInQuery(
  root: string,
  query: string
): Promise<{ entities: string[]; remainingQuery: string }> {
  const database = await ensureDatabase(root);

  const allEntities = database
    .prepare(`
      SELECT name, normalized_name, type FROM entities
      WHERE type IN ('person', 'project', 'company')
      ORDER BY mention_count DESC
    `)
    .all() as Array<{ name: string; normalized_name: string; type: string }>;

  const detectedEntities: string[] = [];
  let remainingQuery = query;

  for (const entity of allEntities) {
    const nameLower = entity.name.toLowerCase();
    const normalizedLower = entity.normalized_name.toLowerCase();

    const nameRegex = new RegExp(`\\b${escapeRegex(nameLower)}\\b`, 'i');
    const normalizedRegex = new RegExp(`\\b${escapeRegex(normalizedLower)}\\b`, 'i');

    if (nameRegex.test(query) || normalizedRegex.test(query)) {
      detectedEntities.push(entity.name);

      remainingQuery = remainingQuery
        .replace(nameRegex, '')
        .replace(normalizedRegex, '');
    }
  }

  remainingQuery = remainingQuery
    .replace(/\b(and|or|with|about)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { entities: detectedEntities, remainingQuery };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTITY PROFILES
// ═══════════════════════════════════════════════════════════════════════════════

export async function getEntityProfile(
  root: string,
  entityId: number
): Promise<{ profile: string; generated_at: string; fact_count: number } | null> {
  const database = await ensureDatabase(root);
  return database
    .prepare('SELECT profile, generated_at, fact_count FROM entity_profiles WHERE entity_id = ?')
    .get(entityId) as { profile: string; generated_at: string; fact_count: number } | null;
}

export async function saveEntityProfile(
  root: string,
  entityId: number,
  profile: string,
  factCount: number
): Promise<void> {
  const database = await ensureDatabase(root);
  database
    .prepare(`
      INSERT INTO entity_profiles (entity_id, profile, generated_at, fact_count)
      VALUES (?, ?, datetime('now'), ?)
      ON CONFLICT(entity_id) DO UPDATE SET
        profile = excluded.profile,
        generated_at = excluded.generated_at,
        fact_count = excluded.fact_count
    `)
    .run(entityId, profile, factCount);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTRADICTIONS
// ═══════════════════════════════════════════════════════════════════════════════

export async function createContradiction(
  root: string,
  entityId: number,
  factAId: number,
  factBId: number,
  factA: string,
  factB: string,
  description: string
): Promise<number> {
  const database = await ensureDatabase(root);
  const result = database
    .prepare(`
      INSERT INTO contradictions (entity_id, fact_a_id, fact_b_id, fact_a, fact_b, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(entityId, factAId, factBId, factA, factB, description);
  return result.lastInsertRowid as number;
}

export async function getOpenContradictions(
  root: string,
  entityId: number
): Promise<Array<{ id: number; fact_a: string; fact_b: string; description: string; created_at: string }>> {
  const database = await ensureDatabase(root);
  return database
    .prepare(`SELECT id, fact_a, fact_b, description, created_at FROM contradictions WHERE entity_id = ? AND status = 'open'`)
    .all(entityId) as Array<{ id: number; fact_a: string; fact_b: string; description: string; created_at: string }>;
}

export async function resolveContradiction(
  root: string,
  contradictionId: number,
  resolvedBy: string
): Promise<void> {
  const database = await ensureDatabase(root);
  database
    .prepare(`UPDATE contradictions SET status = 'resolved', resolved_by = ? WHERE id = ?`)
    .run(resolvedBy, contradictionId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTITY INSIGHTS (Reasoning Engine)
// ═══════════════════════════════════════════════════════════════════════════════

export type InsightType = 'inference' | 'pattern' | 'quality' | 'synthesis';

export interface EntityInsight {
  id: number;
  entity_id: number;
  insight_type: InsightType;
  insight: string;
  reasoning: string;
  confidence: number;
  source_entity_ids: number[];
  created_at: string;
  expires_at: string | null;
  is_stale: number;
}

export async function saveEntityInsight(
  root: string,
  entityId: number,
  insightType: InsightType,
  insight: string,
  reasoning: string,
  confidence: number,
  sourceEntityIds: number[] = [],
  expiresAt?: string
): Promise<number> {
  const database = await ensureDatabase(root);
  const result = database
    .prepare(`
      INSERT INTO entity_insights (entity_id, insight_type, insight, reasoning, confidence, source_entity_ids, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(entityId, insightType, insight, reasoning, confidence, JSON.stringify(sourceEntityIds), expiresAt || null);
  return result.lastInsertRowid as number;
}

export async function getEntityInsights(
  root: string,
  entityId: number,
  minConfidence: number = 0.60
): Promise<EntityInsight[]> {
  const database = await ensureDatabase(root);
  const rows = database
    .prepare(`
      SELECT * FROM entity_insights
      WHERE entity_id = ? AND is_stale = 0 AND confidence >= ?
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY confidence DESC, created_at DESC
    `)
    .all(entityId, minConfidence) as Array<EntityInsight & { source_entity_ids: string }>;

  return rows.map(r => ({
    ...r,
    source_entity_ids: JSON.parse(r.source_entity_ids as string),
  }));
}

export async function markInsightsStale(
  root: string,
  entityId: number
): Promise<void> {
  const database = await ensureDatabase(root);
  database
    .prepare('UPDATE entity_insights SET is_stale = 1 WHERE entity_id = ?')
    .run(entityId);
}

export async function getEntitiesForReasoning(
  root: string,
  limit: number = 5,
  staleDays: number = 7
): Promise<Array<{ id: number; name: string; type: string }>> {
  const database = await ensureDatabase(root);
  return database
    .prepare(`
      SELECT e.id, e.name, e.type FROM entities e
      WHERE e.mention_count >= 3
        AND (e.last_reasoned_at IS NULL OR e.last_reasoned_at < datetime('now', ?))
      ORDER BY e.mention_count DESC
      LIMIT ?
    `)
    .all(`-${staleDays} days`, limit) as Array<{ id: number; name: string; type: string }>;
}

export async function markEntityReasoned(
  root: string,
  entityId: number
): Promise<void> {
  const database = await ensureDatabase(root);
  database
    .prepare('UPDATE entities SET last_reasoned_at = datetime(\'now\') WHERE id = ?')
    .run(entityId);
}
