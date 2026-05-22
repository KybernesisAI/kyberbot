# System Health Report

**Generated:** 2026-05-22
**Codebase:** KyberBot (`/Users/davidcruwys/dev/kybernesis/kyberbot`)
**Branch:** `arcana-adoption`
**Stack:** pnpm monorepo (TypeScript ESM), custom CLI + Express server + React/Vite UI
**Layers reviewed:** Brain-core, Brain-sleep, Brain-providers, HTTP-server, CLI-commands, Runtime, Orchestration, Misc app code, Test suite

---

## Executive Summary

KyberBot's **codebase is fundamentally healthy and the Arcana integration is being executed with unusual discipline** — the dual-write pattern is clean, mirror functions are colocated, the `arcana_*_id` FK convention holds across timeline / facts / entities / edges, and the parity inspectors give real diagnostic signal. The honest answer to "are we making a mess by trying to make these two brains coexist?" is **mostly no**: the visible debt is cleanup (three `*.legacy.ts` orphan files, one cross-DB reach, mirror-success drift) — not architecture rot.

The serious findings live elsewhere. Three independent layer audits surfaced the same critical: **the documented "Agent SDK is the default runtime" story is a lie** — `claude.ts:84-96` silently rewrites `agent-sdk` → `subprocess` for memory safety, and neither CLAUDE.md nor CONTEXT.md mention it. The HTTP server is **publicly bound on `0.0.0.0` with auth disabled by default**, which exposes `POST /api/execute` (arbitrary `claude` subprocess + caller-supplied env), `POST /api/web/manage/brain-notes/read` (arbitrary file read with no allowlist), and the bus/management surfaces to the LAN. The sleep pipeline has **no transactions around multi-statement mutations**, so a crash during entity-hygiene or consolidate leaves the brain in an inconsistent state. And **5 of 9 HTTP modules plus all 4 ARP handlers have zero tests** — the external contract surfaces are uncovered.

**First action:** bind the server to `127.0.0.1` when `KYBERBOT_API_TOKEN` is unset (one-line fix, defangs five Critical/High findings simultaneously) and reconcile the runtime-mode documentation with reality (delete `agent-sdk` from the public story OR fix the memory issue and re-enable it).

---

## Critical

### C-1 — `agent-sdk` runtime mode is silently downgraded to `subprocess`; docs say otherwise
**Layers:** Runtime (AR-2), Tests (UT-12), Misc (CQ-14) — three independent witnesses
**Files:** `packages/cli/src/claude.ts:84-96` ; `CLAUDE.md` ; `.context/CONTEXT.md`
**Issue:** Constructor accepts `agent-sdk` then immediately rewrites `this.mode = 'subprocess'` with the comment "agent-sdk disabled for memory safety — leaks hundreds of MB." Every doc surface — README, CLAUDE.md, CONTEXT.md mental-model section — describes the "three runtime modes" and presents Agent SDK as the default, no-extra-cost backend. In production it doesn't exist.
**Risk:** Operators believe they're getting tool use + MCP + skills via Agent SDK; they're actually getting `claude -p` subprocess spawns. Per-invocation overhead is much higher and the feature surface differs subtly. Anyone reading `runtime-triad.ts` test fixtures or wiring third-party callers acts on the documented contract, not the real one. New consumers (the bus-handler is one) are starting to hard-code `subprocess: true`, baking the lie deeper.
**Fix:** Pick one: (a) delete `agent-sdk` from the type union, docs, and constructor; document that there are two modes (subprocess + raw SDK); (b) fix the memory leak and re-enable Agent SDK behind an opt-in flag with a memory cap; (c) keep the current behaviour and add a startup warning the first time `agent-sdk` is configured. Add a `claude.ts` mode-selection test that asserts the chosen mode, so the next regression is visible.

### C-2 — Server binds `0.0.0.0` with auth disabled by default → multiple RCE-class endpoints publicly reachable
**Layers:** Server (EC-1, EC-2, EC-3, EC-4, EC-8, EC-12)
**Files:** `packages/cli/src/middleware/auth.ts:57-61` ; `packages/cli/src/server/index.ts:99`
**Issue:** `authMiddleware` early-returns `next()` when `KYBERBOT_API_TOKEN` is unset. `server.listen(port)` binds with no host → all interfaces. CLAUDE.md claims "loopback-only public" — false. With no token set, any LAN/VPN/tailscale peer can hit `POST /api/execute` (runs `claude --dangerously-skip-permissions` with caller-supplied env, so `ANTHROPIC_API_KEY` / `PATH` / `NODE_OPTIONS` are attacker-controlled), `POST /api/web/manage/brain-notes/read` (reads any absolute path — `~/.ssh/id_rsa`, `.env`, `~/.aws/credentials`), `POST /api/web/manage/heartbeat/run` (shells out to `kyberbot` via PATH), `POST /api/bus/register-fleet` (overwrites `_fleetUrl`/`_fleetToken` from body), `POST /api/web/manage/channels/:type` (writes any JSON shape into `identity.yaml` — takes over channel auth).
**Risk:** Unauthenticated remote code execution on default install. The brain-notes/read endpoint is exploitable even with auth enabled if any XSS exists in the desktop renderer or web UI.
**Fix:** Bind `127.0.0.1` when no token is set. As secondary defence, constrain the brain-notes/read path to dirs `GET /brain-notes` actually scans. Allowlist env keys passed to `/api/execute`. Add schema validation to `/channels/:type`. The bind fix alone defangs the bulk of the attack surface.

### C-3 — Sleep pipeline has no transactions around multi-statement mutations
**Layer:** Brain-sleep (EC-1)
**Files:** `packages/cli/src/brain/sleep/steps/entity-hygiene.ts:160-176` ; `consolidate.ts:79-95` ; `observe.ts:182-244`
**Issue:** Multi-statement state changes are not wrapped in `db.transaction()`. Consolidate sums access counts, writes to the keeper, then deletes duplicates. Observe stores a new fact, marks the old superseded, creates a contradiction record. Entity-hygiene's merge loop does N orphan-relation cleanups serially.
**Risk:** A SIGTERM, OOM, or unhandled rejection between statements leaves the brain inconsistent — keeper with triple-counted access AND duplicates still present, two `is_latest = 1` facts with no `superseded_by` link, orphan relations after a partial merge. None of this is detectable by the parity inspector because row counts can stay correct.
**Fix:** Wrap each logical unit in `db.transaction(() => { ... })()`. Most urgent: the entity-hygiene merge loop (`mergeEntities` called with no outer transaction).

### C-4 — Half-onboarded directory silently corrupts subsequent commands
**Layer:** CLI commands (EC-1)
**Files:** `packages/cli/src/commands/onboard.ts:41-53` ; `packages/cli/src/config.ts:34-52`
**Issue:** `onboard` uses `process.cwd()` with a monorepo guard. `getRoot()` walks up looking for `identity.yaml` with a *different* monorepo guard. If `kyberbot onboard` is aborted mid-wizard, the partial `identity.yaml` becomes the "nearest" identity for every subsequent command from that subtree. There is no "is this directory fully initialised?" check anywhere.
**Risk:** `kyberbot recall`, `remember`, `run` happily operate on a malformed agent. Subtle data corruption with no error signal until much later.
**Fix:** Write an `agent-state.json` (or marker line in `identity.yaml`) on completion of `onboard`. Make `getRoot()` refuse to operate on an incomplete dir with a clear "run `kyberbot onboard` to finish setup" message.

### C-5 — External contract surfaces have zero tests
**Layer:** Tests (UT-6, UT-7)
**Files:** `packages/cli/src/server/{bus-api,chat-sse,management-api,orchestration-api,agent-router}.ts` ; `packages/cli/src/server/arp/{router,handler-knowledge-query,handler-notes-read,handler-notes-search,obligations}.ts`
**Issue:** 5 of 9 HTTP modules and 4 of 4 ARP handlers have no integration tests. These are the contract surfaces the desktop renderer and external agents bind to.
**Risk:** A response-shape change is invisible from inside the CLI's test run and explodes downstream. Combined with BH-1 (four different error envelopes already in use across the routers), the contract is fragile and undefended.
**Fix:** Smoke test per endpoint at minimum. ARP handlers each need: malformed-request rejection, happy-path, obligation-violation. Pick a single error envelope (the `arp/router` `{ ok: false, error: 'code', reason: '...' }` shape is the cleanest) and document it.

---

## High

### H-1 — Sleep cycle orchestrator's outer try/catch defeats the per-step degradation contract
**Layer:** Brain-sleep (CQ-2). **File:** `packages/cli/src/brain/sleep/index.ts:93-211`
**Issue:** All 10 steps run inside one `try` block. CONTEXT.md says "individual failures are non-fatal" — but the first uncaught throw aborts every later step.
**Fix:** Wrap each `await runXStep(...)` in its own try/catch that logs and pushes to `metrics.<step>.errors`.

### H-2 — `runSleepCycleNow` differs from scheduled `runCycle` (missing reasoning step, no isStoreActive wait, no error recovery)
**Layer:** Brain-sleep (CQ-1, EC-5). **File:** `packages/cli/src/brain/sleep/index.ts:247-338`
**Issue:** The pipeline is hand-written twice with subtle drift. `kyberbot sleep run` produces materially different output than the scheduled cycle and skips the OOM-prevention wait.
**Fix:** Refactor into a single `runPipeline(root, cfg, db, runId, opts)`.

### H-3 — Decay step's "weekly fact decay" gate can never fire on an active agent
**Layer:** Brain-sleep (EC-2). **File:** `packages/cli/src/brain/sleep/steps/decay.ts:131-156`
**Issue:** Gate reads `MAX(updated_at) FROM facts WHERE confidence < 0.85` — but real-time fact extraction keeps `updated_at` fresh, so decay never runs on busy agents.
**Fix:** Store last-decay timestamp in a dedicated `sleep_state` row.

### H-4 — `consolidate.ts` title-normalization SQL silently misgroups titles
**Layer:** Brain-sleep (EC-3). **File:** `packages/cli/src/brain/sleep/steps/consolidate.ts:39-57`
**Issue:** `REPLACE(x, '...', '')` removes *every* `...`, not just trailing. `INSTR(..., '] ')` matches the first `]`. Unrelated titles can get merged.
**Fix:** Strip via regex in JS after `SELECT`.

### H-5 — Mirror failures have no operator health signal
**Layer:** Brain-core (BH-1). **Files:** all `mirrorTo*` helpers
**Issue:** Mirror failures degrade silently to `logger.warn` + null return. Combined with watchdog auto-restart, a misconfigured Arcana provider silently produces a long tail of `arcana_*_id IS NULL` rows. The parity inspector only surfaces this when manually run.
**Fix:** Add a module-local mirror-failure counter exposed via `getArcanaMirrorHealth()` and surface in `kyberbot status` / management API.

### H-6 — `findOrCreateEntity` mints local FK *before* the mirror call (FK loses parity meaning)
**Layer:** Brain-core (BH-4). **File:** `packages/cli/src/brain/entity-graph.ts:649-662`
**Issue:** Local row mints `arcana_entity_id = randomUUID()` and writes it before `mirrorEntityToArcana` is called. If the mirror throws (caught internally), the local row claims to be mirrored when it isn't. Inconsistent with `timeline.ts:346` where the FK is only written on mirror success.
**Fix:** Propagate mirror success out of `mirrorEntityToArcana` and only write the FK on success; or have `arcana-parity` do a real existence join.

### H-7 — Three `*.legacy.ts` orphan files (~2,226 LOC) sit in production source with zero importers
**Layer:** Brain-core (AR-1). **Files:** `entity-graph.legacy.ts`, `timeline.legacy.ts`, `fact-store.legacy.ts`
**Issue:** Still compiled by `tsc`, still surface in jump-to-definition, still risk being edited "to fix a bug" when the change should land in the live module.
**Fix:** Delete or move to `_archived/` and exclude from `tsconfig.json`. `git log` already serves historical reference.

### H-8 — `bus-handler.ts` hard-codes `subprocess: true` + `model: 'sonnet'`, defeating the runtime + identity abstractions
**Layer:** Runtime (AR-3, AR-4). **File:** `packages/cli/src/runtime/bus-handler.ts:58-66`
**Issue:** Bus replies always run on Sonnet via subprocess, regardless of `identity.yaml claude.model` (a hot-reload-allowlisted field) and regardless of configured runtime mode. Bus replies have different latency, model, and feature surface than the same agent's chat replies.
**Fix:** Route through the same `getClaudeClient(root)` channel as chat.

### H-9 — `AgentRuntime.identity` (snapshot) vs `getIdentity()` (live) — fleet code reads the wrong one
**Layer:** Runtime (AR-5). **Files:** `agent-runtime.ts:64,74,93-95` ; `fleet-manager.ts:190,274-278,299,354,375,407-408`
**Issue:** Hot-reloaded `agent_description` won't change `/fleet`, `/health`, snapshot API output until process restart. Identity-watcher is largely cosmetic today.
**Fix:** Route reads through `getIdentity()`, or make `identity` itself the live view.

### H-10 — Identity-watcher allowlist documented but not enforced
**Layer:** Runtime (AR-6). **File:** `packages/cli/src/runtime/identity-watcher.ts:46-90`
**Issue:** CONTEXT.md says hot-reload restricted to 6 fields; implementation accepts the whole parsed config.
**Fix:** Merge only allowed keys into `currentIdentity`, or update the doc.

### H-11 — Bus message recursion is not bounded
**Layer:** Runtime (EC-5). **File:** `packages/cli/src/runtime/agent-bus.ts:130-243`
**Issue:** `depth` carried but never checked. Circular handlers/subscriptions bounded only by per-sender 10/hr rate limit (= 20 messages/hr from a two-agent loop).
**Fix:** `if ((msg.depth ?? 0) >= MAX_BUS_DEPTH) return null;`

### H-12 — `AgentRuntime.start()` always sets `_status='running'` even if every subsystem failed
**Layer:** Runtime (EC-4). **File:** `packages/cli/src/runtime/agent-runtime.ts:101-197`
**Fix:** Aggregate per-subsystem health.

### H-13 — Orchestration: schema migrations are ad-hoc with no version table
**Layer:** Orchestration (AR-1). **File:** `packages/cli/src/orchestration/db.ts:30-87`
**Issue:** Eight check-then-ALTER sequences executed on every `getOrchDb()`. No `schema_migrations` table, no way to know what version a DB is at. Next migration needing backfill ordering will be brittle.
**Fix:** `PRAGMA user_version` or a numbered `schema_migrations` table.

### H-14 — Orchestration: FK constraints declared but never enforced (`PRAGMA foreign_keys` not set)
**Layer:** Orchestration (AR-2). **Files:** `db.ts:170-198` and friends
**Issue:** Declared `ON DELETE CASCADE` silently does nothing; manual cleanups duplicate logic the schema already declares; any future delete missing manual cleanup orphans rows. The comment "FKs are advisory in SQLite without PRAGMA" acknowledges without fixing.
**Fix:** Turn the pragma on.

### H-15 — Orchestration: heartbeat runs joined to issues via `LIKE '%KYB-<id>%'` text-pattern match
**Layer:** Orchestration (AR-3). **Files:** `reconcile.ts:215-228`, `runs.ts:208-214`
**Issue:** Fragile (`KYB-1` matches `KYB-12`/`KYB-123`; prose mentions contaminate), unindexed (full scan), ties run-identity to user-facing formatting.
**Fix:** Add `heartbeat_runs.issue_id INTEGER` + index; `createRun` already has the issue id.

### H-16 — `runWorkerHeartbeat` is a 357-line function with eight responsibilities
**Layer:** Orchestration (CQ-1). **File:** `packages/cli/src/orchestration/worker-heartbeat.ts:156-513`
**Fix:** Extract `pickTargetIssue`, `dispatchTurnLoop`, `detectArtifactsFromOutput`, `finishRun`.

### H-17 — Agent status parsing is fragile `string.includes()` matching on raw output
**Layer:** Orchestration (CQ-2). **File:** `packages/cli/src/orchestration/worker-heartbeat.ts:401-407`
**Issue:** `if (result.includes('STATUS: DONE'))` misclassifies any output mentioning the token in passing — code block, quoted transcript, `IN_PROGRESS` followed by `DONE`.
**Fix:** Use the regex already at line 425; match the captured value.

### H-18 — Server: bruteforceable Telegram verification code (24-bit, no expiry, no attempt cap)
**Layer:** Server (EC-6). **File:** `packages/cli/src/server/channels/telegram.ts:60-104`
**Fix:** Expire in 10 min, 8+ hex chars, attempt counter.

### H-19 — Server: WhatsApp reconnect loop has no backoff cap, leaks sockets
**Layer:** Server (EC-7). **File:** `packages/cli/src/server/channels/whatsapp.ts:42-55`
**Fix:** Exponential backoff with cap.

### H-20 — Server: `require()` in ESM module → endpoint permanently broken behind silent try/catch
**Layer:** Server (EC-9), Misc (CQ-7 — same pattern in `watched-folders.ts:166-189`). **File:** `packages/cli/src/server/management-api.ts:734`
**Issue:** `ReferenceError: require is not defined`; outer `try/catch` returns `{ folders: [] }`. The watched-folders branch has the same dead path for PDF reads.
**Fix:** `await import(...)` or static top-of-file import. Grep for other `require(` occurrences.

### H-21 — Server: SSE under auth with no documented browser-auth path
**Layer:** Server (BH-2). **File:** `chat-sse.ts:109-122`
**Issue:** Browsers can't set `Authorization` on `EventSource`. With token set, web UI is either broken or loading the token via an unstated path.
**Fix:** Document or move web routes under `optionalAuthMiddleware`.

### H-22 — Server: at least four distinct error response shapes across routers
**Layer:** Server (BH-1).
**Issue:** Desktop and web clients must branch on path for error handling. New routes copy whichever style they see first. Desktop is a contract consumer — this is the cross-repo seam most likely to bite.
**Fix:** Pick one (the `arp/router` envelope is cleanest); document and migrate.

### H-23 — CLI: `console.error(\`Error: ${error}\`)` repeated everywhere produces `Error: Error: …`
**Layer:** Commands (CQ-2). **Files:** ~20 handlers
**Fix:** Single `printCliError(error, { verbose })` helper.

### H-24 — CLI: `run.ts` service-numbering banners are out of order and a number is reused
**Layer:** Commands (CQ-3). **File:** `packages/cli/src/commands/run.ts:185-247`
**Issue:** "Service 3" appears twice, "Service 6" appears twice, docstring still says "all 6 services" while there are eight. Desktop reads the resulting `/health` `services[]` — drift makes dashboard ordering unpredictable.

### H-25 — CLI: localhost HTTP probes use raw `localhost` — broken on IPv6-only stacks
**Layer:** Commands (EC-3). **Files:** `remember.ts:100-133`, `status.ts:88-92`, all `fleetFetch` callers
**Issue:** Node 18+ resolves `localhost` to `::1` first; if Express binds only `0.0.0.0`, client picks IPv6 → `ECONNREFUSED`. Users see "server not running" while it is.
**Fix:** Force `127.0.0.1`. (Also aligns with C-2's localhost binding fix.)

### H-26 — CLI: watchdog "crashed too fast" branch retries 10s with no backoff
**Layer:** Commands (EC-4). **File:** `packages/cli/src/commands/run.ts:64-109`
**Issue:** Missing API key → 50 attempts × 10s = ~8 minutes of failed restarts. Compounds CLAUDE.md's "watchdog hides crash loops" note.
**Fix:** Exponential cap + "if last N restarts each failed within 5s, abort".

### H-27 — CLI: `kyberbot remember` accepts text only as positional arg; no stdin
**Layer:** Commands (EC-2). **File:** `packages/cli/src/commands/remember.ts:40-71`
**Issue:** `echo "fact" | kyberbot remember` fails. Documented intent is "Bash tool from Claude Code", which pipes via stdin.

### H-28 — CLI: tunnel may publish a dead loopback if Express isn't listening
**Layer:** Commands (EC-5). **File:** `commands/run.ts:307-313`
**Fix:** Pre-check `probeHttp('http://127.0.0.1:'+port+'/health')`.

### H-29 — CLI: `bus send`/`broadcast` `--timeout` has no upper bound (ms-vs-s typo waits 16h)
**Layer:** Commands (EC-6).

### H-30 — Embedding provider: no input validation, no batch sizing, no order-alignment check
**Layer:** Brain-providers (EC-1, EC-2). **File:** `packages/cli/src/brain/providers/openai-embedding-provider.ts:56-70`
**Issue:** Empty/whitespace inputs pollute the vector index. >2048 batch silently 400s. `response.data` order assumed not verified — a partial response misaligns `texts[i] → vectors[i]`.

### H-31 — Misc: `services/telemetry.ts` is 1,005 LOC (collector + server + 550-line inlined SPA + pricing data)
**Layer:** Misc (CQ-1). **File:** `packages/cli/src/services/telemetry.ts`
**Fix:** Split into `telemetry/{collector,server,dashboard.html,rates}.ts`.

### H-32 — Misc: `services/heartbeat.ts` module-level `intervalId`/`running` is fleet-incorrect
**Layer:** Misc (CQ-3). **File:** `packages/cli/src/services/heartbeat.ts:24-36`
**Issue:** Per-root state should be in a `Map<root, HeartbeatState>` (as `lastBeatByRoot` already is). Second call overwrites the first; original timer never cleared.

### H-33 — Tests: 12 of 16 orchestration files untested
**Layer:** Tests (UT-16). 20 of 23 commands untested (UT-18). `services/` zero tests (UT-20). 7 of 9 runtime files untested (UT-13).
**Fix:** Triage critical paths; smoke tests first.

### H-34 — Tests: Arcana dual-write tests don't assert "Arcana fails, local succeeds"
**Layer:** Tests (UT-4). **Files:** `*.arcana-integration.test.ts`
**Issue:** Every test uses `createFakeStructuredStore` that never fails. The documented "dual-write is non-fatal — local always succeeds" contract is unasserted. Highest-leverage missing assertion in the most active subsystem.

---

## Medium

(36 findings; details in `findings-*.md`)

**Themes:**
- **Brain-core (5):** `entity-graph` cross-DB reach to `facts` table (AR-2), mirror helpers reimplement the same skeleton with subtle divergences (CQ-2), `as any` casts where good types are nearby (CQ-1), arcana_*_id migration shape inconsistency between timeline and fact-store (AR-3), re-write skips Arcana mirror leaving stale content (BH-3).
- **Brain-sleep (7):** consolidate's GROUP_CONCAT ordering assumption (EC-4), `tier.ts` NaN on zoned timestamps (EC-6), `observe.ts` implicit non-null assumption (EC-7), tag/summarize re-pick missing source files indefinitely (EC-9), entity profile staleness misses content edits (EC-11), `entity-hygiene.ts` 680-line function with 5 phases (CQ-3), reasoning JSON-array parsing duplicated in 4 files (CQ-4).
- **Brain-providers (5):** silent contract narrowing in claude-llm (CQ-1), no embedding timeout / retry (EC-3, EC-4), `dimensions` field doesn't actually constrain OpenAI's return shape (EC-5), no error normalization in claude-llm (EC-6).
- **Server (8):** SSE keepalive leaks on subprocess wedge (EC-11), management writes any JSON into identity.yaml (EC-12), artifacts allow absolute path read (EC-13), conversation histories never evict (EC-14), sync writeFileSync blocks event loop (EC-15), fleet connection state is module singleton (BH-5), saveOwnerChatId races IdentityWatcher (BH-8), SSE startup patterns inconsistent (BH-9).
- **Runtime (7):** identity-watcher fires on partial saves (EC-1), doesn't re-attach on file recreation (EC-2), Telegram throw skips WhatsApp init (EC-3), broadcast rate limit ignores fan-out (EC-6), broadcast swallows partial failures (EC-7), `setActiveBus` global singleton (AR-9), hooks `bash -lc` inherits login env (EC-11), hooks unbounded stdout (EC-12), bus-handler hybridSearch no timeout (EC-14), per-agent port bind failure silent yet tunnel starts (EC-17).
- **Orchestration (6):** state machine `done`/`cancelled` are absolutely terminal (AR-4), phase ordering not validated (AR-5), `phase_history` JSON blob (AR-6), per-process queue invariant broken in fleet (AR-7), dynamic-import layering inversion (AR-8), comment auto-mention rewrite (AR-9), 285-line CEO prompt builder (CQ-3), pagination "more" expression wrong (CQ-4), `executeTool` 95-line switch with dead `report_artifact` (CQ-6), 4× duplicate SQL UPDATE builder (CQ-7).
- **CLI (10):** ChromaDB error message references missing docker-compose.yml (CQ-8), `LIKE '%name%'` unescaped (CQ-9), 100+ line action handlers (CQ-10), commands with `<name>` don't reject empty/whitespace (EC-7), no SIGPIPE handler → ugly EPIPE traces (EC-8), `parseInt(opt) || default` silently coerces (EC-9), re-running `onboard` overwrites SOUL/USER (EC-10), `token regenerate` doesn't warn about live channels (EC-11), `getRoot()` nearest-ancestor shadowing (EC-12), `--no-channels` only suppresses registration (EC-13), template-copy silently skips missing files (EC-14), `status.ts` dead Arcana status ternary `arcanaDbExists ? 'stopped' : 'stopped'` (EC-15), watchdog SIGINT fire-and-forget orphans ChromaDB containers (EC-16).
- **Misc (6):** pricing data duplicated server/client (CQ-2), dynamic-import + empty catch in heartbeat tick (CQ-4), watched-folders couples to brain SQL schema with positional title match (CQ-6), `agents/spawner.ts` doesn't pass `cwd` (CQ-9), `getApiToken()` quietly generates random UUID (CQ-10), three `parseDuration` implementations with divergent defaults (CQ-13), `claude.ts#completeSubprocess` 226-line function (CQ-15), skills/agents loader pairs duplicate ~90% (CQ-19), `rebuildClaudeMd` template engine mis-located (CQ-20).
- **Tests (5):** relationship-extractor / fact-retrieval-parity untested (UT-3), fact-store stable-id test pins a known bug as intended (UT-5), `brain-api.test.ts` over-mocks the brain (UT-8), `commands/fleet.test.ts` tests a helper not the command (UT-19), agents/skills loader untested (UT-21), pervasive over-mocking (UT-22).

---

## Low / Observations

(~50 findings; details in `findings-*.md`)

Notable: brand colour palette redefined per-file with different hex values across 4 commands (Misc-not-flagged, Commands CQ-11); `cli.ts` imports 28 commands with no grouping → tree-shaking failure (Misc CQ-25); `utils/date-parser.ts` 270 LOC with ambiguous-timezone foot-gun (Misc CQ-23); `hooks.ts` lives in `runtime/` but doesn't interact with the triad (Runtime AR-8 — note also relevant: `runtime/` is misnamed for its current contents per AR-1).

---

## Praise

Patterns worth reinforcing across the codebase:

- **`arcana-singleton.ts:18-36`** — `initInFlight` promise + dispose-before-reinit guard correctly defends shared-fleet-mode race; comment names the race.
- **`boot-arcana.ts:29, 44-77`** — `.trim()` on `OPENAI_API_KEY` catches `.env` trailing-whitespace footgun; structured rollback disconnects libsql on vector init failure. Both carry one-line "why" comments.
- **`arcana-parity.ts`** — short, read-only, defensively coded with `openIfExists`/`safeCount`, reports drift in operator-actionable language. Template for future parity tools.
- **`brain/sleep/utils/checkpoint.ts`** — small, single-purpose, uniformly invoked; crashed cycles are forensically reconstructible.
- **`brain/sleep/steps/reasoning.ts:46-76, 145-222`** — deduction/induction split with server-side confidence clamping; the most algorithmically honest part of the codebase.
- **`server/arp/handler-notes-*.ts`** — scope at the SQL `WHERE` clause, not via post-filter. Prevents a future handler bug from leaking cross-project data.
- **`server/execute-api.ts:86-106`** — proper subprocess backpressure (`res.write()` return checked, `proc.stdout.pause()` on false, 5MB cap). The discipline `chat-sse.ts` lacks.
- **`middleware/auth.ts:41-50`** — constant-time compare handles length mismatch via `timingSafeEqual(bufB, bufB)` (though see Misc CQ-11 on the length leak).
- **`server/channels/telegram.test.ts:382-531`** — exemplary timer-based async testing with `vi.useFakeTimers` and threshold-edge assertions. Pattern to spread.
- **`runtime/hooks.test.ts`** — zero `vi.mock`; real temp dirs, real shell processes. The right level for shell-out behaviour.
- **`orchestration/state-machine.ts:14-22`** — clean total table-driven state machine; `isValidTransition`/`getValidTargets`/`isTerminal` are tiny and pure.
- **`orchestration/issues.ts:196-233`** — atomic checkout with proper SQLite transaction; idempotent re-checkout.
- **`config.ts:300-336`** — per-root accessor pattern (`getIdentityForRoot` + cache + `clearIdentityCache`) mirrored consistently. Template for future per-root state.
- **`commands/remember.ts:46-71`** — try-server-first / fall-back-to-direct pattern with comment explaining *why* (avoid spawning a second full kyberbot process → OOM).
- **`commands/fleet.ts:85-94`** — `parseTurnCount` is the right level of strictness at the CLI boundary. Pattern to spread to `--limit`, `--timeout`, `--max-turns` everywhere.

---

## Clean — No Issues

None of the layers came back clean. Lightest finding-density: **Brain-providers** (2 files, 9 CQ/EC, 2 praise) and **Brain-core** (22 files, 14 findings, 3 praise — see executive summary on integration discipline).

---

## Review Coverage

| Layer | Files reviewed | Dimensions | Findings (C/H/M/L/P) |
|-------|---------------|------------|----------------------|
| Brain-core (1a) | 22 | AR + CQ + BH | 0/2/7/3/3 |
| Brain-sleep (1b) | 11 | CQ + EC | 1/5/7/6/3 |
| Brain-providers (1c) | 2 | CQ + EC | 0/2/6/5/2 |
| HTTP-server (2) | 22 | EC + BH | 2/7/12/6/3 |
| Commands (3) | 23 | CQ + EC | 1/5/16/9/3 |
| Runtime (4) | 9 | AR + EC | 1/6/9/5/3 |
| Orchestration (5) | 18 | AR + CQ | 0/3/13/4/3 |
| Misc (6) | 30 | CQ | 0/2/8/13/3 |
| Tests (7) | 55 | UT | 3/6/8/5/3 |
| **Totals** | **~157** unique production files | 5 dimensions | **8 / 38 / 86 / 56 / 26** |

---

## First-action checklist

1. **Bind `127.0.0.1` when `KYBERBOT_API_TOKEN` is unset** — one-line fix in `server/index.ts`. Defangs the bulk of C-2 and aligns with H-25.
2. **Reconcile the runtime-mode documentation** — pick (a) delete `agent-sdk` from the type union and docs, or (b) re-enable it. Closes C-1.
3. **Wrap entity-hygiene merge loop and observe supersession in `db.transaction()`** — closes the most damaging part of C-3.
4. **Add an `onboard` completion marker + `getRoot()` refusal on incomplete dir** — closes C-4.
5. **Add smoke tests for the 4 ARP handlers and the 5 untested HTTP modules** — closes C-5 enough to detect contract drift.

Together: ~1 day of focused work eliminates every Critical and several Highs.
