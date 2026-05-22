---
title: Arcana factRetrieval parity harness (v1.0.0)
status: in-progress
date: 2026-05-22
owner: kyberbot
related:
  - .comms/arcana-kyberbot.md (2026-05-22 11:55 ARCANA → KBOT BREAKING)
  - 2026-05-21-arcana-parity-workstream-a-backfill.md
  - 2026-05-21-arcana-parity-workstream-b-constrained-ingestion.md
---

# Arcana factRetrieval parity harness (v1.0.0)

Wire KyberBot's `fact-retrieval.ts` (baseline) against Arcana v1.0.0's
`factRetrieval` (candidate) through `runParityHarness` from
`@kybernesis/arcana-testkit@1.0.0`. Per ADR 009 the pass bar is
`meanOverlap === 1` on both the memory-id and fact-id sets.

## Scope (this pass)

1. Bump `@kybernesis/arcana-*` from `^0.3.0` to `^1.0.0` in
   `packages/cli/package.json`. KB has no callers of the old
   `factRetrieval` shape, so this is a clean bump.
2. Extract a stable ~30-fact fixture set from existing
   `fact-retrieval.test.ts` seeds into
   `packages/cli/src/brain/__fixtures__/parity-facts.ts`. Covers all
   8 categories and multi-entity facts.
3. New module `packages/cli/src/brain/fact-retrieval-parity.ts` that:
   - Seeds the same fixtures into KB's real `fact-store` +
     `memory-store` AND into Arcana's real `StructuredStore`
     (libsql + sqlite-vec providers).
   - Defines a small query corpus (~5–10 queries spanning categories,
     entities, time windows).
   - Invokes `runParityHarness({ baseline, candidate, extractIds })`
     where `extractIds` returns `[...memoryIds, ...factIds]`.
4. New CLI subcommand `kyberbot brain arcana-fact-parity` that runs the
   harness, prints a human-readable report (per-query overlap, missing
   ids, extras), and exits non-zero on `passes === false`.
5. Run it. If `meanOverlap < 1`, bounce-back to Arcana via the comms
   file per their stated rules (paste failing query + both outputs).

## Deferred (capture so we don't forget)

- **Vitest gate in CI.** Wrap the same harness in a vitest test under
  `packages/cli/src/brain/fact-retrieval-parity.test.ts` so `pnpm test`
  fails on drift. Keep the CLI subcommand for ad-hoc runs. Premature
  until the harness is stable and fast (<5s) and we trust the
  fixtures — otherwise CI flakes block unrelated PRs. Revisit after
  the first three clean runs of the CLI form.
- **Real-prod fixture variant.** A separate harness invocation that
  reuses a snapshot of the live KB brain corpus instead of synthetic
  fixtures. Catches divergences synthetic data can't. Only worth
  building after the synthetic harness is green and we have a clean
  way to anonymise/snapshot the corpus.
- **Per-query failure diff dump.** On `meanOverlap < threshold`,
  auto-dump the failing query, both outputs, and a delta into
  `.kyberbot/parity-failures/<timestamp>/` so bounce-back to Arcana
  is one paste, not a grep.

## Non-goals

- Migrating the rest of KB to call Arcana `factRetrieval` directly.
  That comes after the harness greens — this pass is the gate, not the
  swap.
- Touching `hybridSearch` parity (covered by workstream A/B plans).
- Backfilling the ~4,343 unmirrored facts (workstream A's problem).
