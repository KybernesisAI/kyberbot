---
title: Data parity matrix — Cortex vs KyberBot, six cells to verify before migration
status: harness-1-done; harness-2-done; harness-3-next
date: 2026-05-24
last-updated: 2026-05-24 (session 3)
owner: kyberbot
related:
  - .comms/arcana-kyberbot.md (2026-05-24 KBOT → CORTEX GAPS + TWO FINDINGS)
  - 2026-05-24-kyberbot-full-refactor-to-cortex-native.md (the eventual migration this unblocks)
  - 2026-05-24-handover-session-2.md (current session handover)
---

## Progress log

**2026-05-24 (session 3) — Harness 2 done, run against real data, all methods PASS at 1.000.**

- Harness 2 built: `kyberbot brain cortex-read-parity` (`packages/cli/src/brain/read-parity.ts`)
- Fixture set extended: 8 entities, 8 edges, 10 memories, 5 memory queries, 4 entity queries
- Seeding via KB dual-write paths (storeFact, findOrCreateEntity, addToTimeline, linkEntities)
- Measured against `~/dev/ad/brains/.kyberbot/` (2026-05-24):
  - hybridSearch: **1.000** (5 queries)
  - getFactsForEntity: **1.000** (4 entities)
  - listEntities: **1.000** (set comparison)
  - getNeighbors: **1.000** (4 entities, 8 edges)
  - mean: **1.000 PASS**
- getEntityProfile: structural check only (sleep-populated on KB, LLM-on-demand on Cortex; divergence expected at seed time)
- Known residuals documented (not affecting pass gate):
  - Gap A: Cortex Entity lacks mentionCount → ordering by frequency diverges
  - Gap C: Cortex Edge lacks confidence/method/rationale → shape gap in getTypedRelationships
- Two harness design issues found and fixed during run:
  - KB FTS5 MATCH fails silently on hyphenated query terms (KB bug, not Cortex gap)
  - runParityHarness returns overlap=0 on empty baseline (by design) — need non-empty fixtures for all queried entities

**Next: Harness 3 (sleep parity).**

---

**2026-05-24 (session 2) — Harness 1 done, run against real data, three findings.**

- Harness 1 built: `kyberbot brain cortex-write-parity` (`packages/cli/src/brain/cortex-write-parity.ts`)
- Verified end-to-end via two smoke scripts in `$CLAUDE_JOB_DIR` (happy path + drift injection)
- Run against `~/dev/ad/brains/.kyberbot/`. Numbers as of session-end:
  - facts: 316 mirrored, **0% match** (historical v0.x lossy mirror — workstream-A backfill territory)
  - memories: 55 mirrored, **100% match**, BUT 62 orphan Cortex memories with no KB FK (and growing — see finding 3)
  - entities: 244 mirrored, **87.3% match**, 31 missing (orphan KB FKs pointing to deleted Cortex entities)
- Three findings escalated:
  1. **Cortex provider has no v0.x → v1.0.0 facts-schema migration** (filed via 2026-05-24 GAP comms)
  2. **Cortex provider's `created_at`-on-memories ALTER fails on existing tables** with `Cannot add a column with non-constant default` (filed via 2026-05-24 TWO FINDINGS comms)
  3. **KyberBot sleep cycle creates orphan Cortex rows** — consolidate/entity-hygiene deletes KB rows without cascading to Cortex (filed via 2026-05-24 TWO FINDINGS comms; question to Cortex about whether their `maintain.startSleepSchedule` should handle this)

**Sequencing reconfirmed: Harness 2 before Harness 3.** Sleep depends on reads — if reads diverge between KB and Cortex, sleep outcomes diverge in non-diagnosable ways. Read parity is the prerequisite for trustworthy sleep diffs. The matrix plan's original 1 → 2 → 3 order stands.

---

# Data parity matrix — six cells to trust before migration

David's framing on 2026-05-24:

> "The left-hand side of the system is Cortex, and it has three concepts: it can write, it can read, and it can do sleep time. The right-hand side is that we have KyberBot. It can write, it can read, and it can do sleep time. What we now need to be able to do is ensure that all three steps on the left and the right actually work from a data parity point of view. Then what we've got to do is a proper migration."

This plan defines the testing infrastructure to verify all six cells before any migration step.

## The matrix

|         | Cortex                                                                                        | KyberBot                                                                                |
| ------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Write   | Receives mirror writes (dual-write). Content equivalent to KB's local row?                    | Working baseline. Trusted by long use in production.                                    |
| Read    | **1.000** across all 5 methods (Harness 2 PASS). factRetrieval 0.877 (Harness 1 gap — Workstream A/B). | Working baseline.                                                                       |
| Sleep   | Untested. Cortex `maintain.startSleepSchedule` exists since v1.1.0; never run against KB data | Working baseline. Sleep pipeline runs hourly, produces entity profiles, insights, etc. |

Six cells. KyberBot's three are trusted-by-use (it's the agent that's been running in production). Cortex's three each need explicit verification.

## What "parity" means per cell

### Cortex.Write parity

When KyberBot's `storeFact()` fires, it mirrors to Cortex via `mirrorFactToCortex`. **The question is whether the resulting Cortex Fact row carries semantically equivalent content** to the KyberBot facts row.

Today we have:
- Storage inspector (`cortex-parity` CLI) — counts rows on each side, reports mirror coverage (how many rows have `arcana_fact_id` populated). **Counts only, not content.**
- The `arcana_*_id` FK columns prove a mirror happened. They don't prove the content matches.

What we don't have:
- Per-row content diff. e.g., for fact 42 on KyberBot side with `arcana_fact_id = 'abc-uuid'`, fetch the Cortex Fact `abc-uuid` and assert: same content string, same entities array, same category, same confidence, same source backlinks.
- Similar diffs for memory (timeline event → memory) and entity (KB entity → Cortex entity).

### Cortex.Read parity

We have the most coverage here.
- `factRetrieval`: parity harness at 0.877 (synthetic fixtures, 7 queries, fact-FTS layer)
- `hybridSearch`: not parity-tested
- `getFactsForEntity`: not parity-tested
- `getEntity`, `listEntities`: not parity-tested
- `getNeighbors`: not parity-tested
- `getEntityProfile`: not parity-tested
- `listInsights`, `listContradictions`: not parity-tested

### Cortex.Sleep parity

Completely untested. KyberBot's sleep pipeline runs 10 steps (decay → tag → consolidate → link → tier → summarize → observe → profile → reasoning → entity-hygiene) and produces visible outcomes: entity profiles get regenerated, insights get stored, contradictions get detected, tiers shift, summaries get cached.

Cortex's `maintain.startSleepSchedule` since v1.1.0 promises a KB-faithful port of the same 10 steps. Whether the outcomes match has never been verified.

### KyberBot.* — what to verify

Long-running production code; verification is mostly "did our recent changes break anything." Specifically:
- After every commit on `cortex-adoption`, does KyberBot's local-store-only path (flag off) still produce the same results it did before our changes? Risk surfaces from: the rename (arcana → cortex), the adapter wiring (flag-gated branches added to read functions), schema column renames, etc.

Existing test suite covers some of this. We haven't audited whether the suite covers the regression surface for our recent changes specifically.

## Test infrastructure needed

Three harnesses + one regression baseline:

### Harness 1 — Write-parity content diff

`kyberbot brain cortex-write-parity` CLI subcommand. For each KB row with a mirrored Cortex id:
1. Fetch the Cortex row by id
2. Diff content per field (KB.content == Cortex.fact for facts; KB.title/summary == Cortex.title/summary for memories; etc.)
3. Report drift count + sample drifted rows

Implementation: extend `cortex-parity.ts` to do row-by-row diffing in addition to the existing count comparison.

Pass criteria: 100% of mirrored rows have content-equivalent shapes.

### Harness 2 — Read-parity expansion

Extends the existing `cortex-fact-parity` harness to cover the other reads. Per-method harness for:
- `hybridSearch` (KyberBot's local vs `cortex.retrieve.hybridSearch`)
- `getFactsForEntity` (KyberBot's local vs `cortex.providers.structured.getFactsForEntity`)
- `getEntityProfile` (KyberBot's local vs `cortex.retrieve.getEntityProfile`)
- `listEntities` (variants of KB `searchEntities` / `getRecentEntities` / `getMostMentionedEntities` vs `cortex.providers.structured.listEntities`)
- `getNeighbors` (KyberBot's `getTypedRelationships` vs `cortex.providers.structured.getNeighbors`)

This is the work already scoped in `2026-05-24-parity-harness-full-shape-fixture.md` — full-shape fixture with seeded entities + memories + edges. That plan is now subsumed by this one. See the per-method section in that doc for fixture additions needed (memories, entities, edges).

Pass criteria: meanOverlap ≥ 0.95 per method, with documented residuals for any known gaps (e.g. Cortex Entity lacks `mention_count` so `getMostMentionedEntities` parity will not hit 1.0 until Cortex Gap A lands).

### Harness 3 — Sleep-parity outcome diff

`kyberbot brain cortex-sleep-parity` CLI subcommand. Hardest of the three.

1. Seed both sides identically (full-shape fixture: facts + memories + entities + edges, plus enough volume for the sleep steps to have something to do)
2. Run KyberBot's `runSleepCycleNow` against the local stores
3. Run Cortex's `maintain.startSleepSchedule` (one cycle) against the Cortex stores
4. Diff outcomes per step:
   - **Decay:** which facts/memories got decay-score updates? Are the deltas equivalent?
   - **Tag:** what tags were assigned to which rows? Set-equality per row
   - **Consolidate:** which rows got dedup-merged? Same merge decisions on both sides?
   - **Link:** which memory-pairs got linked? Set-equality on edge set
   - **Tier:** which rows got tier transitions? Same transitions on both sides?
   - **Summarize:** which rows got regenerated summaries? Content diff (probably can't expect byte-equivalence because LLM; check structural shape — non-empty, reasonable length)
   - **Observe:** which facts got extracted from conversations? Set-equality on extracted-fact content (with the same LLM caveat)
   - **Profile:** which entity profiles got regenerated? Content diff
   - **Reasoning:** which insights got produced? Set diff (LLM-driven; structural check)
   - **Entity-hygiene:** which entities got merged? Same merges on both sides?

Some steps are LLM-driven and won't be byte-deterministic. The harness has to distinguish "structurally equivalent" from "byte-equivalent" per step.

Pass criteria: deterministic steps (decay, link, tier, consolidate, entity-hygiene merge decisions) at 100% match. LLM-driven steps (tag, summarize, observe, profile, reasoning) at "structurally equivalent — same number of outcomes, same target rows, similar shape." Defined per-step.

### Regression baseline — KyberBot's local-only path

Run the existing test suite (`pnpm test`) on `cortex-adoption` and confirm all green. Especially the `*.cortex-integration.test.ts` files we renamed, the `cortex-parity.test.ts`, and the channel/server tests that exercise read paths. If any test fails, the cortex-adoption branch has regressed KyberBot's local-only behaviour — that needs fixing before any migration.

## Sequencing

1. **Harness 1 (write-parity)** — first because it's the smallest scope and validates the foundation (dual-write data is trustworthy). Probably 1 session.
2. **Cortex roadmap reply on the 2026-05-24 GAPS comms note** — affects Harness 2's expected residuals. Wait briefly; if no reply in a few days, proceed assuming the gaps stay open.
3. **Harness 2 (read-parity expansion + full-shape fixture)** — extends the existing harness. Subsumes the parked `2026-05-24-parity-harness-full-shape-fixture.md`. 1–2 sessions.
4. **Harness 3 (sleep-parity)** — biggest piece. 2–3 sessions because of the per-step diff logic.
5. **Regression baseline check** — runs continuously during the above. Anytime test suite goes red on `cortex-adoption`, stop and fix.
6. **Decision point** — once all three harnesses are green (or have explicitly documented residuals), David evaluates the [full refactor plan](2026-05-24-kyberbot-full-refactor-to-cortex-native.md) against continuing incrementally.

## Acceptance criteria for "ready to migrate"

All six cells trust-level explicit:

|         | Cortex                                          | KyberBot                                |
| ------- | ----------------------------------------------- | --------------------------------------- |
| Write   | Harness 1 reports 100% content equivalence      | Regression suite green                  |
| Read    | Harness 2 ≥ 0.95 per method, residuals documented | Regression suite green                  |
| Sleep   | Harness 3 deterministic-steps 100%, LLM-steps structurally equivalent | Sleep cycle still produces correct outcomes |

When all six cells meet criteria, migration becomes a one-shot script that walks KyberBot's tables, confirms every row has a populated `arcana_*_id`, and drops the local stores. The dual-write era ends.

## Non-goals

- This plan does NOT execute the migration. It builds the trust infrastructure.
- Does NOT change Cortex's API surface — Gap A/B/C/D from the 2026-05-24 GAPS NOTE are Cortex's roadmap question, not this plan's.
- Does NOT replace the runtime A/B differential study (`KYBERBOT_USE_CORTEX_READS=1`) — that's a separate user-experience comparison, this is a data-correctness comparison.
- Does NOT cover non-brain subsystems (CLI commands, channels, heartbeat, web UI) — those use the brain via its API surface, so brain parity covers their data needs by transitivity.
