# Cortex Adoption — KyberBot bugs + upgrades log

Audit window: 2026-05-18 (Arcana adoption start) → 2026-05-25.
Branch: `cortex-adoption` (formerly `arcana-adoption`).
Sources: git history on `cortex-adoption` + `main`, comms file at `~/dev/kybernesis/.comms/arcana-kyberbot.md` (~7000 lines), data-parity matrix plan, session-2 handover.

---

## KyberBot bugs surfaced during adoption

### Fixed

- **FTS5 hyphen-as-negation in `searchFactsDirect`** (commit `7e1e7f9`, 2026-05-23)
  - What: `searchFactsDirect` built FTS5 MATCH queries by joining bare tokens with `OR`. FTS5 parses unary `-` as a NOT operator, so `"post-mortem"` became `post NOT mortem` and nulled matches. The error was caught and swallowed → empty result, no log.
  - Effect in production: queries containing any hyphenated term (post-mortem, kube-outage, follow-up, etc.) silently returned zero fact matches from KB's Layer 1 retrieval for as long as KB has shipped.
  - Fix status: FIXED. Adopted Cortex's `buildFtsQuery` approach — strip non-alphanumeric, quote each token. Parity meanOverlap 0.650 → 0.769 after the fix.

- **Server bound 0.0.0.0 by default with auth-off default** (commit `29d37b5`, 2026-05-22, breaking)
  - What: discovered during the system-health audit prompted by the adoption work. Express server bound to all interfaces while `KYBERBOT_API_TOKEN` defaulted to absent, exposing brain / execute / management endpoints (some RCE-class) to LAN/VPN/tailscale peers. CLAUDE.md's "loopback-only" claim was untrue.
  - Effect in production: any single-machine install on a network with other peers (most laptops on home Wi-Fi, all tailscale users) was remotely reachable.
  - Fix status: FIXED. Default bind now `127.0.0.1`; opt-out via `KYBERBOT_BIND_HOST`. Startup warns when exposed bind paired with no token. Breaking for VPS deployments (now must set env var).

- **`kyberbot status` hardcoded service list, lied about runtime state** (commit `b37bd89`, 2026-05-20)
  - What: status command guessed from filesystem (e.g. "Sleep Agent running" if `data/sleep.db` exists). Didn't list Arcana/Cortex or Watched Folders. Misreported when `--no-*` flags used.
  - Effect in production: operators couldn't trust `kyberbot status` output during adoption work.
  - Fix status: FIXED. Now queries live orchestrator `/health` registry; falls back to heuristics only when server unreachable.

- **Sleep-cycle delete cascade gap (consolidate + entity-hygiene)** (commit `ed86494`, 2026-05-24)
  - What: KB sleep steps `consolidate` and `entity-hygiene` delete KB rows directly (memories, entities) without mirroring DELETEs to Cortex. Orphans accumulated on the Cortex side.
  - Effect in production: dual-write divergence over time on any agent running sleep cycles. Latent pre-adoption since deletes themselves were always KB-local, so technically a *new* bug introduced by dual-write — but exposed and fixed in the same window.
  - Fix status: FIXED. `consolidate.ts`, `entity-graph.ts`, `timeline.ts` now mirror deletes via Cortex provider calls.

- **`mirrorFactToCortex` drops `expires_at`** (Harness 3 finding, 2026-05-24, comms line 6467; KB-side patch flagged inline)
  - What: when KB's `storeFact` mirrors to Cortex, the `expires_at` field isn't part of the payload, even though both schemas carry it.
  - Effect in production: temporal facts never expire on the Cortex side post-cutover.
  - Fix status: flagged in comms; user noted "patching on our side" — verify whether commit landed. Not yet observed in git log between the comms NOTE and audit time.

### Open / documented for cutover

- **`facts_fts` virtual table UPDATE triggers use FTS5 contentless-table syntax against a regular FTS5 table** (discovered 2026-05-18 during baseline-tests work, comms line 1069; reconfirmed today around `decay.ts`)
  - What: triggers `facts_fts_ai/ad/au` use the FTS5 `'delete'` command form, which only works on contentless FTS5 tables. `facts_fts` is content-bearing, so every trigger fire throws `SqliteError: SQL logic error`. In `decay.ts` the error was swallowed by an empty `catch {}` until commit-time today; the wider production path through `sleep/observe.ts → markFactSuperseded` errors silently.
  - Effect in production: KB has never actually expired temporal facts in production. `markFactSuperseded`-based supersede also silently fails. (Tests work around this by `DROP TRIGGER` in `beforeEach`.)
  - Fix status: OPEN. `decay.ts` catch now logs (commit window today), so the error becomes visible — but the underlying trigger syntax is unfixed. Likely "won't fix — dies with cutover" since Cortex owns the table post-migration; worth a comment + tracking issue regardless. **Recommend: file a tracking issue OR fix the trigger now to restore fact-expiration on KB.**

- **`metadataSearch` FTS5 MATCH fails silently on hyphened query terms** (discovered 2026-05-24 during Harness 2, comms line 6082)
  - What: KB's `metadataSearch` (timeline.db SQLite FTS5 on `timeline_events`) hits the same hyphen-as-negation parser issue as `searchFactsDirect` did. Errors caught and swallowed as empty results.
  - Effect in production: any timeline search with a hyphenated query returns empty, silently. Has been latent forever.
  - Fix status: OPEN. Harness works around it by removing hyphens from fixture queries. User comment in comms: "separate cleanup item — not blocking parity work." Same fix shape as the `7e1e7f9` `searchFactsDirect` patch.

---

## KyberBot capabilities improved during adoption

### Tokenization / FTS5 query construction

- **Quoted-token FTS5 query construction in `searchFactsDirect`** (commit `7e1e7f9`, 2026-05-23)
  - What changed: tokens stripped to alphanumeric (`/[^\p{L}\p{N}]/gu`) then double-quoted before joining with `OR`. Treats each as a literal phrase, immune to FTS5 operator chars.
  - Why: surfaced by Pattern 1 of the parity harness — Cortex's `buildFtsQuery` was the more robust implementation. KB adopted it. Beyond pure parity restoration because it ALSO fixes a real KB bug for the local-reads code path.

### Stopwords / min-token-length filter

- Existing in KB pre-adoption (`hybrid-search.ts:244-253`: `.filter(w => w.length >= 3 && !stopwords.has(w))`, introduced by pre-adoption commit `1c5c89d`). **NOT** an adoption-window upgrade per the audit — note for the user's reference. The adoption-driven tokenisation work was in `searchFactsDirect` (above) and in matching Cortex's `buildFtsQuery` semantics. Cortex side adopted a layered defence including `length > 3` (see comms line 5346, 5349) — that conversation happened in the parity work but the KB code already had it.

### Sleep-cycle parity infrastructure

- **`kyberbot brain cortex-parity` / `cortex-write-parity` / `cortex-read-parity` / `cortex-sleep-parity` inspector subcommands** (commits `e12443a`, `234dce1`, `37391e0`, `670d675`, `8bbdc86`)
  - What changed: four new CLI surfaces for measuring write/read/sleep parity between KB-local and Cortex stores on a real agent's data.
  - Why: gate before any read swap. Beyond parity-only since these become permanent debugging tools for any future store-migration project. Read-parity hit 1.000 across all five methods (`hybridSearch`, `getFactsForEntity`, `listEntities`, `getNeighbors`, `getEntityProfile`).

### Flag-gated runtime read swap

- **`KYBERBOT_USE_CORTEX_READS` env flag for live A/B read source** (commit `5de30a5`, 2026-05-24)
  - What changed: 3 read paths (`factFirstSearch`, `hybridSearch`, `getFactsForEntity`) now check the env flag and route to Cortex when set. Adapters translate Cortex shapes → KB return types; UUID→number-id mapping via FNV-1a hash. Falls through to local when Cortex singleton uninitialised.
  - Why: enables differential validation on real-prod data without a deploy. Genuine new capability — KB had no runtime store-source toggle before.

### Sleep-cycle DELETE mirroring

- **Mirror DELETEs to Cortex from `consolidate` and `entity-hygiene` steps** (commit `ed86494`)
  - What changed: KB sleep steps now propagate deletes to Cortex (see also bug entry above).
  - Why: new capability driven by dual-write; not present in pre-adoption KB.

---

## Cortex bugs found and fixed

### Cortex v2.1.1
- **`v2.1.0` npm artefact was stale — published dist did not match source** (comms 2026-05-24, line 5548 BLOCKER → line 5609 FIX)
  - Filed: 2026-05-24
  - Fixed: v2.1.1 (publish-pipeline root-caused on Cortex side)
  - Still caught by parity harness? No — release-process fix, not a runtime regression.

### Cortex v2.1.2
- **`minMatchRatio` denominator bug — parity regressed 0.958 → 0.820 in v2.1.1** (comms line 5666 REGRESSION → line 5800 FIX)
  - Filed: 2026-05-24
  - Fixed: v2.1.2 (deps bump `338be3f`)
  - Still caught by parity harness? Yes — `kyberbot brain cortex-parity` would re-detect if regressed. v2.1.2 parity 0.877.

### Cortex v2.1.3
- **Followup polish on the v2.1.2 fix series (Gap A/C residual framing clarified, harness still green)** (comms line 6228, deps bump `303aa09`)
  - Filed: 2026-05-24
  - Fixed: v2.1.3
  - Still caught by parity harness? Yes — bumping forward keeps parity test as continuous regression gate.

### Cortex v2.1.5
- **(Implicit — bump landed, harnesses still green)** (deps bump `83414bb`)
  - Filed: rolled into the rapid 2.1.x iteration window.
  - Fixed: v2.1.5
  - Still caught by parity harness? Yes.

### Cortex v2.1.6 (+ pending v2.1.7/v2.1.8 work queued)
- **THREE port-faithfulness bugs in `packages/cortex-core/src/maintain/steps/`** (comms lines 6304, 6431, 6492, 6565, 6639 — "consolidated fix list")
  - **Bug 1 (`tier`)**: AND instead of OR; drops 2 of 5 signals → 0 vs 14 transitions on same data.
  - **Bug 2 (`entity-hygiene` Phase 2 prune)**: 4 KB filters dropped → overly aggressive entity pruning.
  - **Bug 3 (`decay-memories`)**: missing 2 of 3 KB subjobs (fact-expiration sweep + weekly fact-confidence decay); the one ported subjob has formula drift (no tier filter, no per-cycle cap, no repetitive-content multiplier, no access-boost priority adjustment).
  - Filed: 2026-05-24 (TWO PORTING BUGS NOTE, then THIRD PORTING BUG follow-up, then CONSOLIDATED FIX LIST)
  - Fixed: v2.1.6 bumped (`330b495`) but `2.1.7/8` queued (comms line 6998 — open-items header format adopted, link convention decided, v2.1.8 work queued). **Verify in next session whether all three bugs landed in v2.1.6 or are still in flight.**
  - Still caught by parity harness? Yes — Harness 3 sleep-parity (`cortex-sleep-parity`) is the regression gate for all three. `link` step has a convention divergence (not a bug); `consolidate` was a fixture issue (fixed in `8b8184f`).

### Cortex v1.0.0 series (pre-rename)
- **Layer 0 Pattern 2/3 score divergences** (comms line 4716, 4994) — fixed in `arcana-*@1.2.1` per the 09:00 diagnosis cycle. Still caught by parity harness.
- **Provider migration bugs: non-constant default ALTER COLUMN + missing v0.x → v1.0.0 facts schema migration** (comms lines 5967, 6002)
  - Filed: 2026-05-24
  - Fixed: status unclear at audit time — flagged "Cortex's call to fix or not" in the session-2 handover. Worked around by hand-applying `docs/migrations/2026-05-24-cortex-facts-v0-to-v1.sql` on the test agent.
  - Still caught by parity harness? No — these are migration-time bugs (run-once on a legacy agent), not runtime ones. The parity harness wouldn't see them on a fresh-schema agent.

---

## Skipped (PARITY/MAINT only — listed for completeness)

`84f41d6` Arcana→Cortex rename · `2da2c5e d7561fa 3c94021 fb4ba59 2fc561e` dual-write module rewrites (#1-#4) · baseline test commits (`1f23d68 4a1d48c c165e65 b5af8c9 26a898d e3f8fb9 0c3cd8e 975d0fd`) · `58c44ec` ClaudeLLMProvider adapter · `2fac4c1` `initArcana()` wiring · `989b9f8 79e26bd d86799a` delivery-review patches · dep bumps · plan docs · handover docs.
