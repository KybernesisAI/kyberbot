# Workstream B — Constrained ingestion (process N pending files, then stop)

**Status:** approved, awaiting execution
**Sequenced before:** [Workstream A — paginated backfill](./2026-05-21-arcana-parity-workstream-a-backfill.md)
**Branch:** `arcana-adoption`

## Goal

When David runs KyberBot against `/Users/davidcruwys/dev/ad/brains/.kyberbot`, watched-folders normally walks every changed file and ingests it (yesterday's session churned through hundreds of files unbounded). We want a constrained version: "do up to N pending files, write to both legacy AND Arcana via the existing dual-write path, then stop." This lets us validate dual-write batch-by-batch against real new data via the `kyberbot brain arcana-parity` inspector.

## Scope

**In:**
- A standalone command that processes up to N pending watched-folder changes and exits cleanly
- Same dual-write path as production — no special-cased handling, this exercises the real code
- Designed for: `while; do kyberbot brain ingest-pending --limit 20; sleep 5; kyberbot brain arcana-parity; done` style scripting

**Out:**
- Modifying the long-running `kyberbot run` orchestrator's watched-folders service (separate concern; this gate doesn't belong there)
- Backfilling historical data — that's Workstream A
- Any read-path changes
- Telegram/WhatsApp channel ingestion (different code path; not relevant to file-watching)

## Approach

New subcommand: `kyberbot brain ingest-pending --limit <n>` at `packages/cli/src/commands/brain.ts`.

Internally:
1. Initialise the watched-folders service in one-shot mode (don't start the polling loop)
2. Walk configured folders, compare mtime+hash against `data/watched_folders_state.json`
3. Collect the list of pending changes (new + modified files)
4. Truncate to first N entries
5. For each: invoke the same `processWatchedFile` / `storeConversation` path the live service uses
6. Update `watched_folders_state.json` for the files we processed
7. Print a summary: "Processed 18/20 pending. 47 changes remain. Run again to continue."

Implementation lives in:
- New entry point in `packages/cli/src/services/watched-folders.ts` (e.g. `ingestPendingOnce(root, limit)`) that exposes the one-shot loop. Existing live service uses the polling wrapper around the same loop.
- New subcommand handler in `brain.ts` that calls it.

## Open questions

1. **Default limit value if `--limit` omitted?** Probably 20 — matches David's "10 or 20 at a time" framing.
2. **Order of files within a batch?** Suggest: oldest-mtime-first so we work through the backlog deterministically, but newest-mtime-first if you're trying to validate the most-recent additions first. Defaults to oldest; flip with `--newest-first` if needed.
3. **What counts as "pending"?** New files + modified files. Files where the mtime/hash matches state get skipped. This matches current watched-folders behaviour.
4. **Should the inspector run automatically at the end?** Tempting, but couples two responsibilities. Leave them as separate commands the script chains together.

## Verification approach

After each `ingest-pending` batch:
```
kyberbot brain arcana-parity --detail 5
```

Expected signals:
- `memories.legacy` should rise by ~N (one timeline_events row per file)
- `memories.legacyMirrored` should rise by ~N (FK column should be set on each new row)
- `memories.arcana` should rise by ~N (the actual write to arcana.db)
- The three numbers should stay ✓ matched
- `--detail` should show the N most-recent writes all with `arcana_memory_id` set (✓ → arc-id columns)

**Semantic verification — flagged for Workstream A but applies here too**: counts are necessary but not sufficient. Two writes can both succeed but the content could be subtly wrong on one side. For high-trust validation, sample a row and dump both sides for comparison. Programmatic equality won't work (timestamps, IDs, ordering of arrays will differ). Likely path: an LLM-based "are these essentially the same?" check on sampled pairs. See Workstream A for the detailed design.

For B specifically, this is lower-risk because we're using the SAME write path that the live agent uses — if dual-write is broken, it's broken everywhere, not just here. Inspector counts + spot-check the last write's content is probably enough.

## Arcana-side dependencies

**None expected.** This is entirely a KyberBot-side command exercising existing dual-write code. If during implementation we discover the dual-write wrapper has a bug that requires Arcana changes (unlikely — Arcana's contracts are stable), I'll **send a comms NOTE via `~/dev/kybernesis/.comms/arcana-kyberbot.md`** rather than implement an Arcana-side fix or work around it silently.

## Risks

- **`watched_folders_state.json` state coupling** — if the one-shot path doesn't update state correctly, subsequent runs will re-process the same files. Mitigate with a test that runs the command twice and asserts the second run shows 0 pending.
- **Large folder walks** — if the watched config has many folders, just *finding* the pending set could take time. Acceptable since the alternative (the live service) does the same walk continuously.
- **Concurrent runs** — if David has the live `kyberbot run` going AND fires `ingest-pending` in another terminal, both might process the same file. Acceptable for dev tooling; not safe for production scripts. Add a note in `--help` output.

## Definition of done

- `kyberbot brain ingest-pending --limit <n>` works end-to-end against the real k-brains agent dir
- Running it 3× in a row with `--limit 20` processes 60 files cleanly with no errors
- `kyberbot brain arcana-parity` shows the expected delta on each run
- Tests cover: 0 pending → no-op, N pending → processes exactly N, state file gets updated correctly
- Build clean, typecheck clean
- Comms NOTE sent to Arcana on completion per the workflow rule
