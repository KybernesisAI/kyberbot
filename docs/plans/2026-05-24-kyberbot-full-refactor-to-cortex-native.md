---
title: KyberBot full refactor to Cortex-native shape
status: parked-for-decision
date: 2026-05-24
owner: kyberbot
related:
  - .comms/arcana-kyberbot.md (2026-05-24 KBOT → CORTEX GAPS)
  - 2026-05-24-data-parity-matrix.md (the prerequisite testing plan)
  - 2026-05-24-parity-harness-full-shape-fixture.md
---

# KyberBot full refactor to Cortex-native shape

The alternative to the current incremental adoption (dual-write + adapters + flag-gated swap). Under this path, KyberBot's local stores are decommissioned and Cortex becomes the brain. No adapter layer, no mirror functions, no `arcana_*_id` FK columns. Documented for consideration; **not approved for execution**.

## Why this exists as an option

Eight days of incremental adoption have produced a working dual-write, a parity harness at 0.877, and a flag-gated read swap that requires an adapter layer to translate between KyberBot's integer-id world and Cortex's UUID world. Every adapter is mass that has to be deleted later if we ever do this full refactor. David's framing on 2026-05-24: "What if instead of writing adapters, we modified KyberBot to have method and field parity with Cortex?"

The honest answer is: probably a week of focused refactor + a real migration story. Bigger upfront, smaller surface area afterwards.

## Scope of changes

### Schema migration

Every KyberBot local-store primary key flips from `INTEGER PRIMARY KEY AUTOINCREMENT` to `TEXT PRIMARY KEY` (UUID):

- `facts.id` (timeline.db)
- `timeline_events.id` (timeline.db)
- `entities.id` (entity-graph.db)
- `entity_mentions.entity_id` (FK)
- `entity_relations.from_id` / `to_id` (FK)
- `entity_profiles.entity_id` (FK)
- `entity_insights.entity_id` (FK) + `source_entity_ids` (JSON array of FKs)
- `contradictions.entity_id` / `fact_a_id` / `fact_b_id` (FKs)
- `fact_supersede` chain
- Sleep-related tables (`sleep_runs`, `sleep_telemetry`, `maintenance_queue`, etc. — may or may not need UUIDs depending on whether they're consumed externally)

For each table: ALTER TABLE rename, plus migration script that walks existing rows, mints UUIDs, rewrites FK columns. Or simpler: drop and re-extract from conversation history (if we trust the extraction pipeline to reproduce).

### API surface — function signatures

Every read function changes:
- `getFactById(root, id: number)` → `getFactById(root, id: string)`
- `getEntityProfile(root, entityId: number)` → `getEntityProfile(root, entityId: string)`
- `getOpenContradictions(root, entityId: number)` → `getOpenContradictions(root, entityId: string)`
- `getEntityInsights(root, entityId: number, minConfidence)` → `getEntityInsights(root, entityId: string, minConfidence)`
- `findOrCreateEntity` return type
- `storeFact` return type (currently `Promise<number>`, becomes `Promise<string>`)
- `addToTimeline` return type
- `getMessageById`, `getSessionMessages` — touched if message IDs change
- `getEntityById`, `searchEntities`, `getRecentEntities`, etc. — return shapes

### Callers — every file that holds an integer fact/entity/memory id

Probably 25–40 files. Includes:
- `commands/recall.ts`, `commands/search.ts`, `commands/pin.ts`, `commands/timeline.ts`, `commands/brain.ts` (CLI handlers)
- `server/brain-api.ts`, `server/management-api.ts`, `server/web-api.ts`, `server/orchestration-api.ts` (HTTP routes)
- `server/channels/telegram.ts`, `server/channels/whatsapp.ts` (channel handlers that surface entity links)
- Sleep pipeline steps (`brain/sleep/steps/*.ts`) that iterate facts/entities by id
- React/Vite UI in `packages/web/` (if it consumes IDs from the API)

Each caller updates from `number` to `string` parameters, plus any URL routing, JSON serialisation, and display formatting.

### KyberBot-specific fields — decision per field

Cortex doesn't model these (per the 2026-05-24 KBOT → CORTEX GAPS comms entry):
- `Entity.mention_count` — drop OR move to a sidecar `entity_metadata` table KyberBot maintains separately
- `Entity.aliases` — drop OR sidecar
- Edge metadata (`confidence`, `method`, `rationale`, `last_verified`) — drop OR sidecar
- `TimelineEvent.source_path` / `type` discriminator / `topics` — drop OR sidecar OR projection over Cortex memories

If Cortex's roadmap (per the GAPS NOTE) includes these natively in v2.2 or later, this refactor can wait for them. If not, sidecar tables become permanent infrastructure.

### Dual-write decommissioning

Once Cortex is the source of truth:
- Delete `mirrorFactToCortex`, `mirrorMemoryToCortex`, `mirrorEntityToCortex`, `mirrorConversationToCortex`, etc. (the 6 mirror functions in fact-store.ts / timeline.ts / entity-graph.ts / store-conversation.ts)
- Delete `arcana_*_id` FK columns from local schemas (or just stop populating them and let them sit as legacy)
- Delete `cortex-parity.ts` storage inspector (no longer needed — single store)
- Delete `fact-retrieval-parity.ts` harness (or repurpose to test Cortex against itself)
- Delete `cortex-read-adapters.ts` (the swap layer)
- Delete `cortex-reads.ts` (the flag helper)

Net delete: probably ~1000+ lines of mirror/adapter/flag plumbing.

### Migration story for existing user data

Critical path. Options:
1. **One-shot migration script** — read every KyberBot row, call corresponding Cortex `command.*` to insert, capture UUIDs, write `local_id → cortex_uuid` mapping file for any downstream consumers needing translation
2. **Use the dual-write data already in Cortex** — the mirror functions have been running, so most prod data already exists in Cortex form with the UUIDs populated. Walk KyberBot's `arcana_*_id` columns, confirm every row is mirrored, drop the local tables
3. **Drop and re-extract** — wipe local stores, re-run extraction over conversation history into Cortex. Honest about data loss for sessions that don't have raw text available

Option (2) is the cleanest IF the dual-write data is trustworthy. That's part of why the [data parity matrix](2026-05-24-data-parity-matrix.md) work matters before this refactor can begin.

## Estimated effort

- **Schema migration script:** 1–2 days (with care, given it's production data)
- **API surface refactor:** 3–5 days (touch every caller, update types, handle URL routes, channel handlers)
- **Field decisions:** 1 day (sidecar tables or drop, per gap)
- **Decommission dual-write + adapters:** 1 day
- **Testing on real data:** 2–3 days

**Total: ~1.5–2.5 weeks of focused work.** Bigger than each incremental round but absorbs the cost of every future round at once.

## Trade-offs vs continuing incremental

| | Incremental (current) | Full refactor |
|---|---|---|
| Risk | Each round small, easy to roll back | Big bang; failures harder to isolate |
| Code mass | Grows (adapters, flag, mirrors) | Shrinks (everything to Cortex) |
| User data | Continuously migrated via dual-write | Migrated once via script |
| Trust accumulation | Built per-round via parity tests | Front-loaded; either it works or it doesn't |
| Reversibility | High (flip flag off, dual-write keeps populating) | Low (once local stores deleted, can't go back) |
| Time-to-finish | Many sessions, no obvious endpoint | Bounded scope, clear definition of done |

The incremental approach has been the right call IF the cost is paid for accumulated trust. If we trust Cortex's algorithms enough (via the data-parity-matrix work), the full refactor becomes the cheaper finishing move.

## Prerequisites (don't start the refactor without these)

1. **All three operation types on both sides verified for parity** (per `2026-05-24-data-parity-matrix.md`). Specifically: write parity (Cortex receives identical content to KyberBot's local), read parity (already at 0.877 on factRetrieval; expand to other reads), sleep parity (Cortex's sleep produces equivalent outcomes — entity profiles, insights, tier transitions — to KyberBot's).
2. **Cortex roadmap response** to the 2026-05-24 GAPS comms note. If Gap A/B/C land natively, the sidecar-table decision is avoided. If they're out-of-scope, we know to build the sidecars from day 1.
3. **Backup of production user data** (David's actual KyberBot agent dir) before any schema-altering script runs.

## Non-goals

- This plan does NOT cover the migration of any specific production user's data — that's an operational step taken at refactor time, scoped to the actual data shapes present
- Does NOT change Cortex's API surface — that's Cortex's roadmap (per the GAPS comms)
- Does NOT remove KyberBot's CLI / channel / heartbeat / agent layer — only the brain layer is rewritten

## Decision required

Not asking for one now. The plan exists so David can evaluate it against continuing the current adapter approach when the data-parity-matrix work surfaces enough confidence to choose a path.
