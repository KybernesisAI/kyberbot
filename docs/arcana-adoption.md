# Arcana adoption — branch lifecycle & dogfooding

Operational notes for the `arcana-adoption` branch. The architectural playbook lives in `~/dev/kybernesis/arcana/docs/adoption/kyberbot.md`; this file covers **how to actually run the in-progress branch on David's machines**.

## What this branch is

A long-running development branch where KyberBot's `packages/cli/src/brain/*` modules are incrementally rewritten as Arcana dual-write wrappers. The branch:

- **Never merges to main** until Arcana publishes to npm and the `file:` deps in `package.json` get swapped for version pins.
- **Only resolves on David's machines** — the `file:../../../arcana/...` paths assume `~/dev/kybernesis/arcana/` is a sibling of `~/dev/kybernesis/kyberbot/`, which is true on machines synced via syncthing and nowhere else.
- **Functionally equivalent to main** as long as `getArcanaInstance()` returns `null`. The dual-write code path is dormant until something calls `initArcana()` — and nothing does yet.

## Running this branch's CLI as `kyberbot`

```bash
cd ~/dev/kybernesis/kyberbot
git checkout arcana-adoption
pnpm install        # only if not already done
pnpm build          # rebuild dist/ on each change
cd packages/cli
pnpm link --global  # makes ~/.../arcana-adoption's CLI the active `kyberbot` on PATH
```

After this, `which kyberbot` should point to the global pnpm bin, which symlinks to this branch's `dist/index.js`. Any future `pnpm build` here updates that symlink target in-place — no re-link needed.

## How `kyberbot-desktop` picks it up

Desktop's `LifecycleManager` (in `kyberbot-desktop/src/main/lifecycle.ts`) resolves the CLI in this order:

1. `~/.kyberbot/source/packages/cli/dist/index.js`
2. `pnpm link` locations (this is what we hit)
3. `PATH`

So once the `pnpm link --global` above is in place, **desktop will spawn this branch's CLI automatically per agent**. No desktop config changes needed.

Restart any running agents in desktop after re-linking so they pick up the new binary.

## Reverting to stable

```bash
cd ~/dev/kybernesis/kyberbot/packages/cli
pnpm uninstall --global @kyberbot/cli
# then either install the published version:
npm install -g @kyberbot/cli
# or pnpm link --global from your stable checkout
```

Or just `git checkout main && pnpm install && pnpm build` from the same directory and the existing link's target rebuilds against main.

## Risks while dogfooding

| Risk | Reality | Mitigation |
|---|---|---|
| Arcana dual-write breaks live data | Singleton is uninit in production. `mirrorToArcana()` short-circuits. Zero Arcana calls happen. | None needed yet. When we wire `initArcana()` in the orchestrator, this changes — re-evaluate then. |
| Schema migration affects live DB | First DB open adds `arcana_memory_id TEXT NULL` to `timeline_events`. Stable CLI ignores the column on a switch-back. | Tested by the unchanged test suite. Worth a one-time visual confirmation: `sqlite3 ~/<agent>/data/timeline.db '.schema timeline_events'` after first launch. |
| Behavior drift vs main | Module #1 preserves the full public surface + test contract. Future modules will too. | Tests are the gate. If `pnpm test` is green, runtime parity is intact. |
| Branch falls behind main | Main may patch brain modules while we're rewriting them. | See "Merge cadence" below. |

## Merge cadence

Assumption (David, 2026-05-18): if the rewrite finishes in 1-2 days, we skip merging entirely and just diff against main once at the end. If it stretches, we merge from main weekly.

If/when we do merge:

```bash
git checkout arcana-adoption
git merge main
# resolve conflicts in packages/cli/src/brain/*.ts (new wrappers) — forward-port fixes from main into the wrapper
# legacy.ts files are frozen snapshots — do NOT update them on merge
```

**Convention**: `*.legacy.ts` files are frozen at rip-out time and not updated by merges from main. They exist as references + rollback targets. If main's version of a not-yet-migrated brain module has new behavior, that behavior gets absorbed when we get to that module's rewrite.

## Testing checklist before declaring "dogfood works"

After `pnpm build` + restarting an agent in desktop:

- [ ] Agent starts cleanly. No new errors in desktop logs around `LifecycleManager` spawn.
- [ ] `kyberbot status` reports server up on 3456, services healthy.
- [ ] Channel chat (Telegram or WhatsApp) round-trips a message; the response appears in `kyberbot recall` after a sleep cycle — same as before.
- [ ] `kyberbot timeline list` returns recent events.
- [ ] First DB open writes the schema migration without error: `sqlite3 ~/<agent>/data/timeline.db '.schema timeline_events'` shows `arcana_memory_id TEXT`.
- [ ] `arcana_memory_id` is NULL for all new rows (expected — Arcana not wired).
- [ ] Heartbeat fires on schedule, writes timeline events as before.

If all green, the branch is safe to leave installed for ongoing module work.

## Why this file exists

Operational, not architectural. The architectural playbook (in the Arcana repo) tells the two Claude sessions how to coordinate the migration. This file tells the human (David) how to keep using KyberBot while that migration is underway.
