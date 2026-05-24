-- Workaround migration: v0.x facts schema → v1.0.0+ shape.
-- Cortex's libsql provider only auto-migrates `memories.created_at` —
-- doesn't handle the v0.x → v1.0.0 facts schema change. This script
-- bridges that gap for the .kyberbot test agent so the write-parity
-- harness can run.
--
-- Adds new columns:
--   entities_json TEXT NOT NULL DEFAULT '[]'  (replaces single `entity`)
--   category TEXT NOT NULL DEFAULT 'general'
--   source_memory_id TEXT
--   source_path TEXT
--   source_conversation_id TEXT
--
-- Backfills entities_json from the singular `entity` column. Data
-- shape after: ["entity_value"] (single-element array) for every row.
-- The original multi-entity information was lost at v0.x mirror time
-- (the mirror only passed the first entity); cannot be recovered here.
--
-- Original `entity` column kept in place for traceability — Cortex's
-- v1.0.0+ code ignores it but doesn't drop it either.

BEGIN TRANSACTION;

ALTER TABLE facts ADD COLUMN entities_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE facts ADD COLUMN category TEXT NOT NULL DEFAULT 'general';
ALTER TABLE facts ADD COLUMN source_memory_id TEXT;
ALTER TABLE facts ADD COLUMN source_path TEXT;
ALTER TABLE facts ADD COLUMN source_conversation_id TEXT;

-- Backfill entities_json from the legacy singular entity. JSON-encode
-- the single value as a one-element array.
UPDATE facts SET entities_json = '["' || REPLACE(entity, '"', '\"') || '"]';

COMMIT;

-- Verify
SELECT 'rows migrated:', count(*) FROM facts WHERE entities_json != '[]';
SELECT 'sample row:', id, fact, entities_json, category FROM facts LIMIT 1;
