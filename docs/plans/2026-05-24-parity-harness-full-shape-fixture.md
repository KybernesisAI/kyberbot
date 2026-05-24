---
title: Parity harness — full-shape fixture (memories + entities + edges)
status: parked
date: 2026-05-24
owner: kyberbot
gated-on: Cortex Gap 1 fix shipped + KyberBot deps bumped to that version
related:
  - .comms/arcana-kyberbot.md (2026-05-24 KBOT → CORTEX DECISIONS)
  - 2026-05-22-arcana-fact-retrieval-parity-harness.md (this plan's predecessor)
  - 2026-05-21-arcana-parity-workstream-a-backfill.md (different workstream — real prod data)
  - 2026-05-21-arcana-parity-workstream-b-constrained-ingestion.md (different workstream — ingest)
---

# Parity harness — full-shape fixture

Expand `fact-retrieval-parity.ts` from fact-only seeding to full-shape seeding (facts + memories + entities + edges) so we can measure two things the current harness cannot: Cortex Gap 2 (memory-bridge layer), and the deferred memory-id half of the ADR 009 parity gate.

## Why this exists

The current harness (`packages/cli/src/brain/fact-retrieval-parity.ts`) seeds only facts via `storeFact()` → `mirrorFactToCortex` → Cortex `recordFact`. That populates both sides' fact tables identically but leaves Cortex's entity rows, memory rows, and edges empty. Consequences:

1. **Cortex's Layer 4 memory-bridge cannot fire.** `getNeighbors()` returns nothing because the entity graph is empty. KyberBot's Layer 2.5 fact-bridge fires because it reads denormalised `entities_json` directly off the fact row. The 0.042 gap at `q-kube-outage` (bio-2 surfacing on KyberBot but not Cortex) is currently undiagnosable — we don't know if Cortex has a true algorithmic gap or if it's just a setup gap.
2. **Memory-id parity cannot be measured.** The harness's `extractIds` returns only `factIds`. Per the 2026-05-22 13:30 KBOT → CORTEX QUESTION, the memory-id set was explicitly deferred to "workstream A/B" because there was no shared memory store on both sides to compare against. Without seeded memories, we still only see half of the ADR 009 parity surface.

This plan addresses both at once with a single harness expansion.

## Scope

### Fixture additions (`packages/cli/src/brain/__fixtures__/parity-facts.ts`)

- **`PARITY_MEMORIES`** — ~10 conversational text snippets that the existing `PARITY_FACTS` were "extracted from". Each memory has a stable `id`, `content`, `timestamp`, and an `entities[]` array. Memories link to facts via `source_path` / `source_conversation_id` (the bridge already exists in KyberBot's schema; mirror it on Cortex side).
- **`PARITY_ENTITIES`** — distinct entity rows (~8 names with types): `Alice` (Person), `Bob` (Person), `Carol` (Person), `David` (Person), `Acme` (Org), `Kubernetes` (Topic), `Postgres` (Topic), `Yosemite` (Place), `Berkeley` (Place), `Tokyo` (Place).
- **`PARITY_EDGES`** — entity → memory attachments (which memories mention which entity), and entity → entity relationships (Alice ↔ David married, Bob ↔ Alice reports-to, etc.). Modelled on KyberBot's existing `linkEntities` shape.

### Harness expansion (`packages/cli/src/brain/fact-retrieval-parity.ts`)

After the existing fact seeding loop:
1. Seed memories on both sides — KyberBot `addToTimeline()`, Cortex `arcana.command.storeMemory()`. Build `arcanaMemoryId ↔ kbMemoryId ↔ fixtureId` map (parallel to existing fact-id map).
2. Seed entities on both sides — KyberBot `findOrCreateEntity()`, Cortex `arcana.command.upsertEntity()`. Build entity-id map (or use entity names as natural keys since both sides accept names).
3. Seed edges on both sides — KyberBot `linkEntities()` for entity-entity + memory-attached-entity rows, Cortex `arcana.command.link()`. Build edge ref tracking only if needed for diagnostics.
4. Update `extractIds` to return `[...factIds, ...memoryIds]` so the harness measures both sets simultaneously.
5. Update `formatFactRetrievalParityReport` to break out fact-id vs memory-id overlap separately so divergences are diagnosable per set.

### Design decisions captured

- **Manual seeding, not conversation-driven.** Each fixture is hand-written; we do NOT run `storeConversation` to extract facts via LLM. Reason: parity tests should isolate retrieval logic. If we routed through extraction, retrieval divergences would mix with extraction divergences (LLM quality, model version drift, prompt skew). Both sides start from byte-identical shapes; any divergence is purely about retrieval.
- **`topN` bumped from 10 to 20.** With ~31 facts + ~10 memories, a top-10 window forces both layers to compete for the same slots. Top-20 gives breathing room to observe layer behaviour distinctly. The per-query overlap calculation still uses the full top-N.
- **Memory fixture content shaped to surface bridges.** Specifically include memories where the same entity appears in multiple memories on different topics, so KyberBot's Layer 2.5 and Cortex's Layer 4 both have something interesting to find. e.g. a memory mentioning Bob + Kubernetes, another mentioning Bob + Acme — the bridge layer should surface both when queried about either topic.

## What this unblocks

1. **Gap 2 real diagnosis.** With entities + memories + edges populated, Cortex's Layer 4 memory-bridge fires for the first time in the harness. Three possible outcomes:
   - Cortex surfaces bio-2-equivalent bridges correctly → no Cortex code change needed; Gap 2 was a harness limitation.
   - Cortex surfaces wrong bridges (different memories than KyberBot would surface) → real algorithmic divergence to diagnose.
   - Cortex misses bridges KyberBot finds → confirmed capability gap, write Layer 4b proposal (per my held thinking from earlier).
2. **Memory-id parity becomes measurable.** The ADR 009 gate becomes complete: fact-id parity AND memory-id parity in one harness run.
3. **`q-kube-outage` 0.83 → expected to close.** Once Cortex's Layer 4 fires, the bio-2 equivalent should surface (or we learn precisely why it doesn't).

## Sequencing

Gated on Cortex's Gap 1 fix shipping. Order:

1. Cortex publishes the layered-defence stopword fix (their decision, their timing).
2. KyberBot bumps `@kybernesis/cortex-*` to the new version.
3. Re-run current (fact-only) harness. Confirm `q-events-april` closes from 0.88 → 1.0. Confirm `q-kube-outage` 0.83 unchanged (it's not stopword-related). Post brief comms NOTE with the result.
4. **Then** implement this plan — fixture expansion + harness rewiring.
5. Re-run full-shape harness. Post comms NOTE diagnosing Gap 2 and reporting memory-id overlap for the first time.
6. If Gap 2 turns out to be a real Cortex capability gap, write the Layer 4b proposal as a follow-up comms entry.

## Non-goals

- Real-prod fixture variant (workstream A/B's domain). This plan is synthetic-only.
- Backfilling existing `arcana_*_id IS NULL` rows in production KyberBot databases (also workstream A territory).
- Testing the ingestion pipeline (manual seeding deliberately bypasses it).
- Changes to KyberBot's own `mirrorFactToCortex` to auto-promote entities into Cortex's graph. That's a separate design question — relevant if Cortex's recommendation post-diagnosis is "consumers should populate the entity graph themselves," but premature now.
- CLI changes to `kyberbot brain cortex-fact-parity`. The same subcommand should produce a richer report after the harness expansion; no operator-facing CLI surface change.

## Open questions to resolve at implementation time

- **Topology of `PARITY_EDGES`** — how many edges per entity is realistic? Too few → bridges don't fire meaningfully. Too many → bridges dominate results. Probably 3-5 memory attachments per entity, 1-2 entity-entity relationships per entity.
- **Should memory `content` overlap with fact `content`?** If yes, Layer 1 (memory FTS) will pick up the same text as Layer 0 (fact FTS) — useful for testing fusion. If no, the two layers are cleanly separated for diagnostics. Probably both — split fixtures into "memory-only content" and "memory content overlapping fact content" subsets.
- **How to handle the asymmetry between KyberBot's two databases (timeline.db + entity-graph.db) and Cortex's single store.** Existing harness already handles this for facts; expansion needs to preserve the same per-side seeding logic.

These don't block the plan being parked — they're judgement calls made at code time, not architectural decisions made now.
