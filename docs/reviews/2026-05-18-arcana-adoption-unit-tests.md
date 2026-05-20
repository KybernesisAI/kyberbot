# Unit Tests Review — `arcana-adoption` branch (modules #1–#4)

**Date:** 2026-05-18
**Branch:** `arcana-adoption`
**Reviewed at commit:** `2fc561e` (9 commits ahead of `main`)
**Skill:** `/appydave:review-unit-tests` (diff-scoped, dimension code UT)
**Scope:** all changes on `arcana-adoption` vs `main` — modules #1 (timeline), #2 (entity-graph), #3 (embeddings/providers), #4 (fact-store).

This review evaluates test design for the migration work only. It does **not** run tests, and it does **not** audit pre-existing test debt in the rest of the repo. A deeper codebase-wide pass via `/appydave:test-quality-audit` is planned for the end of the adoption (after the legacy modules are ripped out).

## Test counts at review time

| File | Type | Tests |
|---|---|---|
| `timeline.test.ts` | existing unit (untouched) | 20 |
| `timeline.arcana-integration.test.ts` | new integration | 5 |
| `entity-graph.test.ts` | existing unit (untouched) | 27 |
| `entity-graph.arcana-integration.test.ts` | new integration | 6 |
| `providers/openai-embedding-provider.test.ts` | new unit (adapter) | 9 |
| `providers/chromadb-vector-store.test.ts` | new unit (adapter) | 10 |
| `fact-store.test.ts` | new baseline unit | 22 |
| `fact-store.arcana-integration.test.ts` | new integration | 5 |
| **Total new** | | **57** |
| Full suite | | **588 / 588 passing** |

Zero existing tests removed or modified across all four modules.

## Findings

### DVR-UT-001: `arcana-singleton.ts` has no direct test file

- **Severity**: high
- **Location**: `packages/cli/src/brain/arcana-singleton.ts:16-40` (source — no test exists)
- **Detail**: Module is critical infrastructure exercised by every Arcana integration test in this branch, but only indirectly. Untested explicit behaviors: (a) `initArcana` idempotency — second call returns existing instance without re-running `createArcana`; (b) `disposeArcana` actually calls `disconnect()` on the structured and vector providers (test uses `resetArcanaForTests` which bypasses disconnect); (c) `disposeArcana` tolerates partial provider failure via `Promise.allSettled`; (d) `init → dispose → init` recovers cleanly. None of these would catch a refactor that broke them.

### DVR-UT-002: Arcana mirror error paths are not explicitly tested

- **Severity**: high
- **Location**: `timeline.ts:227-243`, `entity-graph.ts:518-541`, `fact-store.ts:241-262` (source — three try/catch blocks with NO assertions)
- **Detail**: Each dual-write wrapper catches `NotImplementedError` (log debug, continue) vs other errors (log warn, continue). This fallback IS the safety net that makes Option B safe — local write always proceeds. Zero integration tests assert this behavior. If a future Arcana version starts throwing on `storeMemory` / `upsertEntity` / `linkNodes`, callers should still see successful local writes. Recommend one test per module that injects a provider override which throws, then asserts the local row still landed and `arcana_*_id IS NULL`.

### DVR-UT-003: timeline source-mapping coverage is partial

- **Severity**: medium
- **Location**: `packages/cli/src/brain/timeline.arcana-integration.test.ts:60-77`
- **Detail**: Code branches: `type === 'conversation' → source: 'chat'`, else `→ source: 'cli'`. Integration test asserts the `'chat'` case directly. The `'cli'` case is hit implicitly by the `type: 'note'` test but `memory!.source` isn't asserted there. Add `expect(memory!.source).toBe('cli')` to the existing tag-folding test or write a table-driven test across all 6 event types.

### DVR-UT-004: fact-store source_type mapping coverage is partial

- **Severity**: medium
- **Location**: `packages/cli/src/brain/fact-store.arcana-integration.test.ts:90-108`
- **Detail**: Two source_types tested explicitly (`'chat'`, `'ai-extraction'`). Four more in the wild — `'user-correction'`, `'user-direct'`, `'heartbeat'`, `'upload'`, `'connector'` — all hit the `else → 'cli'` branch. Rule is simple but a table-driven test covering each named source_type would lock the mapping contract. Important because `mapFactSourceTypeToArcanaSource` is the function most likely to need refinement as more producers are added.

### DVR-UT-005: alias-matched entity re-find is not asserted via integration

- **Severity**: medium
- **Location**: `packages/cli/src/brain/entity-graph.arcana-integration.test.ts` (missing test)
- **Detail**: `entity-graph.test.ts` covers alias matching on the local-only path. The integration test covers re-find by exact normalized name (test 2: mentionCount sync). The interesting path — alias hits the "existing" branch and `mirrorEntityToArcana` is called with the existing entity's `arcana_entity_id` — isn't asserted. Risk: a refactor that routed alias hits to the "new" branch would create duplicate Arcana entities silently. One test: store entity, add alias, re-find via alias, assert same `arcana_entity_id` and incremented mentionCount in Arcana.

### DVR-UT-006: orphan-mirror behavior on duplicate source_path is undocumented

- **Severity**: medium
- **Location**: `timeline.ts:268-289`, `fact-store.ts:266-287` (both)
- **Detail**: `addToTimeline` and `storeFact` both perform their Arcana mirror **before** the SQL INSERT. With `INSERT OR REPLACE` / `ON CONFLICT … DO UPDATE` semantics, the second write to a given `source_path` generates a *new* Arcana memory id, then updates the local row via `COALESCE(excluded.arcana_memory_id, …)`. Result: the previous Arcana memory becomes orphaned. This may be intentional (every write produces a fresh canonical memory) but no test documents it. Could be a latent storage leak in production. Recommend: explicit test asserting either "second write creates new memory" or "second write reuses old memory" — pick one and lock it.

### DVR-UT-007: mergeEntities local-only scope is not asserted

- **Severity**: low
- **Location**: `packages/cli/src/brain/entity-graph.ts:301-421` (source — local-only behavior)
- **Detail**: Per Arcana's 13:25 ANSWER, `mergeEntities` is local-only by design. Integration test should assert this: merge two entities, then verify `structured.upsertEntity` / `linkNodes` were not called with merged data. Locks the scope decision against accidental drift.

### DVR-UT-008: `disposeArcana` provider disconnect not asserted

- **Severity**: low
- **Location**: `packages/cli/src/brain/arcana-singleton.ts:27-35` (source)
- **Detail**: Tests use `resetArcanaForTests()` which bypasses the disconnect path entirely. Production calls `disposeArcana` on shutdown. Buggy disposal (e.g. one disconnect throwing and silencing the other) wouldn't be caught. Pair with DVR-UT-001 fix.

### DVR-UT-009: provider adapters don't test upstream failure paths

- **Severity**: low
- **Location**: `providers/openai-embedding-provider.test.ts`, `providers/chromadb-vector-store.test.ts`
- **Detail**: OpenAI provider doesn't test what happens when the OpenAI client throws (rate-limit, network). ChromaDB provider doesn't test heartbeat failure on connect (currently the throw bubbles unconditionally). Minor — these are thin adapter classes — but real network conditions hit these first and the production behavior matters.

### DVR-UT-010: praise — Path A integration test strategy is consistent and effective

- **Severity**: praise
- **Location**: `timeline.arcana-integration.test.ts`, `entity-graph.arcana-integration.test.ts`, `fact-store.arcana-integration.test.ts`
- **Detail**: Three integration suites follow the same template: testkit fakes injected via `initArcana`, dual-write verified by reading both the local row's `arcana_*_id` and the Arcana mirror back. Fast, deterministic, no OpenAI / ChromaDB dependency, exercises the real contract. Sets the rhythm for modules #5+.

### DVR-UT-011: praise — pre-migration baseline test investment on fact-store

- **Severity**: praise
- **Location**: `packages/cli/src/brain/fact-store.test.ts` (entire file)
- **Detail**: fact-store had zero tests before module #4. Per playbook §2.1, 22 unit tests were authored **first** (separate commit `1f23d68`), then served as the regression net for the rewrite. The discipline also surfaced a pre-existing FTS5 trigger bug. Right shape of investment for any future "no tests" module.

### DVR-UT-012: praise — test isolation via unique source_paths / entity names

- **Severity**: praise
- **Location**: `packages/cli/src/brain/fact-store.test.ts:283-329`
- **Detail**: When `DELETE FROM facts` proved impossible (pre-existing FTS trigger bug), tests were restructured to use unique entity names per test (`'CaseInsensitiveAlice'`, `'LimitTarget'`, etc.) rather than abandoning isolation. Robust pattern; would survive a parallel test runner.

### DVR-UT-013: praise — existing unit suites passed untouched after migration

- **Severity**: praise
- **Location**: `timeline.test.ts` (20 tests), `entity-graph.test.ts` (27 tests)
- **Detail**: Modules #1 and #2 preserved every existing test verbatim. The original behavior contract was strong enough to gate the rewrites without modification. Strong validation that Option B's "interface-layer index stays primary" architecture didn't break callers.

## Verdict

**CONDITIONAL PASS.**

Core dual-write paths and the public surfaces of all four modules are tested. The integration pattern is sound. The big gap is **explicit error-path assertions** (DVR-UT-002) and **direct tests for `arcana-singleton.ts`** (DVR-UT-001) — both rated *high* because they're the load-bearing parts of the Option B safety net: when Arcana misbehaves, local writes must still succeed, and the singleton lifecycle must be predictable. The other medium/low findings (mapping coverage gaps, orphan-mirror behavior, scope-discipline assertions) are about **locking the contract** so future refactors don't silently violate intent.

Recommended pre-merge work: ~6 additional tests covering DVR-UT-001, DVR-UT-002, and DVR-UT-003/004 mapping completeness. Estimated 30 minutes. The other findings can wait or be folded into later module work.

## Out-of-scope notes

These came up during the review but are NOT findings — they're pre-existing issues independent of the Arcana adoption:

- **FTS5 trigger bug in `fact-store.ts`** (`facts_fts_ai/ad/au` use FTS5 contentless-table delete syntax against a regular FTS table → `SQL logic error` on UPDATE/DELETE). Fires only in `sleep/observe.ts → markFactSuperseded` in production; `retractFact` and `reinforceFact` are dead code at every callsite. Logged to the Arcana ↔ KyberBot comms file at 14:55 KBOT NOTE for separate handling. **The migration carries the bug forward verbatim — it does NOT make the bug worse.**
- **`identity-watcher.test.ts` flake** — passes in isolation, depends on 4500ms filesystem-polling timing. Pre-existing.
- **`retractFact` / `reinforceFact` dead code** — both functions exist with full tests but no production caller. Discovery during baseline test authoring; not a test gap.

## What this review does NOT cover

By design (diff-scoped per the skill's contract):

- Pre-existing test gaps elsewhere in `packages/cli/src/`
- The codebase-wide test architecture / brittleness / shared-state concerns
- Test execution time / flakiness
- The legacy `*.legacy.ts` files (frozen rip-out snapshots — they have no callers and will be deleted at end of adoption)

When the full adoption is done and we're about to delete the legacy files, a `/appydave:test-quality-audit` codebase-wide pass is the right follow-up.
