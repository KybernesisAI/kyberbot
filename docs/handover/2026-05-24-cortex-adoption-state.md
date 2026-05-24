---
title: Cortex adoption — session-2 handover
status: handover
date: 2026-05-24
branch: cortex-adoption
last-commit: 7602875 (chore: support Node 25+, clean up pnpm install-script allowlist)
next-action: start Harness 2 (read parity expansion) per the matrix plan
---

# Cortex adoption — session-2 handover

For whoever opens the next session on the `cortex-adoption` branch. Read this first; everything else is cross-references.

## What this project is in one paragraph

KyberBot's brain is being incrementally rewritten to dual-write into Cortex (the `@kybernesis/cortex-*` library, formerly Arcana, renamed mid-session). Writes go to BOTH stores; reads still come from KyberBot's local stores. The goal is to verify Cortex is good enough to swap reads to, then eventually retire KyberBot's local brain entirely. We are weeks into this work and Cortex itself has had multiple parity issues we've helped find.

## Where the work sits right now

**Branch:** `cortex-adoption` (renamed from `arcana-adoption` earlier today). Pushed. ~6 commits ahead of main.

**Live test agent:** `~/dev/ad/brains/.kyberbot/` is set up with cortex-adoption code, dual-write live, all services running cleanly. We booted it during this session, ran a partial sleep cycle, observed dual-write working for new content. You can boot it any time with:

```bash
cd ~/dev/ad/brains/.kyberbot
node /Users/davidcruwys/dev/kybernesis/kyberbot/packages/cli/dist/index.js run
```

**Cortex version live:** `@kybernesis/cortex-*@^2.1.2`. We hit and worked through v0.x → v1.0.0 schema migration gaps; the test agent's `arcana.db` has been manually patched to current schema.

## The umbrella plan

`docs/plans/2026-05-24-data-parity-matrix.md` — the David-driven framing: six cells (Cortex/KyberBot × write/read/sleep), all need parity-verified before any migration. Three harnesses to build.

**Status:**
- Harness 1 (write content diff): DONE this session. CLI `kyberbot brain cortex-write-parity`. Run against real data, three findings escalated.
- Harness 2 (read parity expansion): NOT STARTED. **This is what the next session should do.**
- Harness 3 (sleep parity): NOT STARTED. Sequence after Harness 2 (sleep depends on reads).

## Three findings from Harness 1's first real run

All filed via comms to Cortex (`/Users/davidcruwys/dev/kybernesis/.comms/arcana-kyberbot.md`):

1. **Historical fact drift (316 rows at 0% match)** — workstream-A backfill territory. Not blocking.
2. **Cortex provider migration bugs** — non-constant default ALTER COLUMN, missing v0.x → v1.0.0 facts schema migration. Both filed; Cortex's call to fix or not.
3. **Sleep-cycle cascade gap** — KyberBot sleep consolidate/entity-hygiene deletes KB rows without cascading to Cortex. Orphans accumulate. Asked Cortex whether their `maintain.startSleepSchedule` is meant to handle this from their side; awaiting answer.

## What the next session should do

**Build Harness 2 — read parity expansion.** Specifically:

1. Extend `packages/cli/src/brain/__fixtures__/parity-facts.ts` with `PARITY_MEMORIES` (~10 conversational text snippets), `PARITY_ENTITIES` (~8 entities with types), `PARITY_EDGES` (entity → memory + entity → entity links).
2. Extend `packages/cli/src/brain/fact-retrieval-parity.ts` (or create sibling) to seed memories + entities + edges identically on both sides via KB's `addToTimeline`, `findOrCreateEntity`, `linkEntities` (which dual-write to Cortex via the mirror funcs).
3. Add per-method parity checks for:
   - `hybridSearch` (KB local vs `cortex.retrieve.hybridSearch`)
   - `getFactsForEntity` (KB local vs `cortex.providers.structured.getFactsForEntity`)
   - `getEntityProfile` (KB local vs `cortex.retrieve.getEntityProfile`)
   - `listEntities` (KB's `searchEntities` / `getRecentEntities` / `getMostMentionedEntities` vs `cortex.providers.structured.listEntities`)
   - `getNeighbors` (KB's `getTypedRelationships` vs `cortex.providers.structured.getNeighbors`)
4. Update `extractIds` in the parity harness to return `[...factIds, ...memoryIds]` so memory-id parity becomes measurable for the first time.

**Pass criteria per method:** meanOverlap ≥ 0.95 with documented residuals for the Cortex shape gaps (mention_count, aliases, edge metadata — see `2026-05-24 KBOT → CORTEX GAPS` comms entry).

**Estimated effort:** 1–2 focused sessions. ~300–500 lines of fixture + harness code.

## What NOT to do

- **Do not start Harness 3 (sleep) before Harness 2.** Sleep depends on reads; reads diverging would make sleep diffs un-diagnosable.
- **Do not restart the full-refactor question** without the matrix work being further along. The full-refactor plan (`docs/plans/2026-05-24-kyberbot-full-refactor-to-cortex-native.md`) exists as a strategic alternative but is parked-for-decision pending more parity data.
- **Do not merge `cortex-adoption` to `main`.** Memory rule: never publish without explicit approval + real prod smoke. The branch is alive and ahead; the merge is its own event.
- **Do not delete `origin/arcana-adoption`** without David's explicit go-ahead. Renamed local to `cortex-adoption`; old origin branch still exists as a safety ref.
- **Do not rebuild the read swap adapters** (`cortex-read-adapters.ts` work I started then reverted earlier). They're orthogonal to the matrix work. If we decide to do the runtime A/B differential study separately, that's where they belong — but the matrix path doesn't need them.

## Open Cortex roadmap items (we're waiting on their reply, no urgency)

Filed via comms; non-blocking but informs Harness 2's expected residuals:

- **Gap A:** `Entity.mentionCount` not in Cortex Entity schema. KB tracks it. Affects `getMostMentionedEntities` parity.
- **Gap B:** `Entity.aliases` not in Cortex. Affects entity dedup / lookup-by-variant.
- **Gap C:** Edge metadata (`confidence`, `method`, `rationale`, `lastVerified`) not in Cortex Edge schema. Affects `getTypedRelationships` parity.
- **Gap D:** Timeline concept divergence. Cortex Memory ≠ KB TimelineEvent. Design conversation, not a bug.
- Provider migration bugs (filed today, see above).
- Sleep cascade question (filed today).

## Useful commands for next session

```bash
# Check what state the cortex-adoption branch is in
cd /Users/davidcruwys/dev/kybernesis/kyberbot
git status && git log --oneline -5

# Read the latest comms entries (multiple new ones added this session)
tail -200 ~/dev/kybernesis/.comms/arcana-kyberbot.md

# Verify the test agent's parity (baseline before any new work)
cd ~/dev/ad/brains/.kyberbot
node /Users/davidcruwys/dev/kybernesis/kyberbot/packages/cli/dist/index.js brain cortex-parity
node /Users/davidcruwys/dev/kybernesis/kyberbot/packages/cli/dist/index.js brain cortex-write-parity --sample-limit 3

# Boot the test agent (dual-write live)
cd ~/dev/ad/brains/.kyberbot
node /Users/davidcruwys/dev/kybernesis/kyberbot/packages/cli/dist/index.js run
```

## Critical context for understanding any "wired but not done" reports

Memory at `~/.claude/projects/-Users-davidcruwys-dev-kybernesis-kyberbot/memory/feedback_dont_be_lazy.md` captures the contract: **wired ≠ done.** A swap isn't done until the flag is on and the path produces correct output on real data. If you (next session) read a status report saying "X is wired," verify by running X before believing it's working.

## Key files and locations

| What | Where |
|---|---|
| Branch | `cortex-adoption` (KybernesisAI/kyberbot) |
| Cortex source repo | `~/dev/kybernesis/cortex/` (local clone of `klueless-io/cortex`) |
| Test agent root | `~/dev/ad/brains/.kyberbot/` |
| Cross-session comms | `~/dev/kybernesis/.comms/arcana-kyberbot.md` (5500+ lines, append-only) |
| Matrix plan | `docs/plans/2026-05-24-data-parity-matrix.md` |
| Full-refactor alternative plan | `docs/plans/2026-05-24-kyberbot-full-refactor-to-cortex-native.md` |
| Workstream A backfill plan | `docs/plans/2026-05-21-arcana-parity-workstream-a-backfill.md` |
| Workstream B constrained-ingest plan | `docs/plans/2026-05-21-arcana-parity-workstream-b-constrained-ingestion.md` |
| Migration SQL (one-off applied today) | `docs/migrations/2026-05-24-cortex-facts-v0-to-v1.sql` |
| System health audit (full codebase review from earlier this week) | `docs/SYSTEM-HEALTH.md` |
| Memory files (per-project) | `~/.claude/projects/-Users-davidcruwys-dev-kybernesis-kyberbot/memory/` |
