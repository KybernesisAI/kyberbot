# Arcana adoption — session handover (2026-05-19)

Picking up from the end of the previous session (KyberBot side of the Arcana adoption). This is a brief for a fresh Claude Code session to re-orient without re-reading the full comms log.

## Where we are

The per-module **playbook is complete** (modules #1-#15 closed). Branch `arcana-adoption` is at **20 commits, 720/720 tests passing, typecheck clean**. Wrappers exist in `packages/cli/src/brain/*` that mirror writes to Arcana via `command.upsertEntity`, `ingest.storeMemory`, `command.recordFact`, `command.markFactSuperseded`, `command.storeContradiction`, etc. The mirror paths are **dormant in production** — `getArcanaInstance()` returns null because nothing calls `initArcana()` outside of integration tests.

## What Arcana just delivered (2026-05-19 10:15 IMPLEMENTED in comms)

**ADR 007 — 3 schema additions:**
- `Memory.status: 'active'|'archived'|'deleted'` (required, default `'active'`)
- `Memory.isLatest: boolean` + `Memory.supersededBy?: string` + new `command.markMemorySuperseded(oldId, newId)` (mirrors fact-level supersession at memory level)
- `EntityProfile.staticFacts` is now `ProfileEntry[]` not `string[]` — each entry is `{ value, factId?, confidence?, recordedAt? }`. **Breaking change to watch** if KyberBot's `user-profile.ts` writes `staticFacts` as raw strings (audit suggested module #12a doesn't, but verify).

**New package `@kybernesisai/arcana-provider-libsql`:**
- First real `StructuredStore` impl over libsql (same SQLite binding KyberBot uses, version 0.5.29)
- All 9 entity tables with `CREATE TABLE IF NOT EXISTS` on `connect()` — no separate migration step
- 29 integration tests, 191 total in Arcana repo passing
- Lives at `~/dev/kybernesis/arcana/packages/arcana-provider-libsql/`

## The job for the new session

**Wire `initArcana()` into KyberBot's production orchestrator.** Arcana's default action said "swap the fake for the real provider in the orchestrator" — but `initArcana()` doesn't yet exist in production code. This is **first-wiring**, not a swap. The work:

### 1. Add the libsql provider as a `file:` dep

Edit `packages/cli/package.json` dependencies (alongside the other `@kybernesisai/arcana-*` deps):

```json
"@kybernesisai/arcana-provider-libsql": "file:../../../arcana/packages/arcana-provider-libsql"
```

The pnpm `overrides` block in the root `package.json` may already cover it via the `arcana-contracts` override. If `pnpm install` errors on `workspace:*`, add it to the overrides block. Then `pnpm install`.

### 2. Build `ClaudeLLMProvider` adapter

`createArcana()` requires an `LLMProvider` and none exists on KyberBot's side yet (only the testkit fake used by integration tests). Module #3 established the adapter pattern at `packages/cli/src/brain/providers/`. Add a third file there:

```
packages/cli/src/brain/providers/claude-llm-provider.ts
```

Shape: factory `createClaudeLLMProvider({ model? })` returning an Arcana `LLMProvider`:
- `readonly model: string` (default `'sonnet'` or `'haiku'` — pick reasonable default)
- `complete(prompt, opts?: { temperature?, maxTokens?, system? })`: wraps `getClaudeClient().complete(prompt, { model, maxTokens, ... })`. Map Arcana's `opts.system` to whatever KyberBot's client supports (it may need a system-prompt prefix concatenated to the user prompt — check `packages/cli/src/claude.ts`).

Add `claude-llm-provider.test.ts` with mocked client (same pattern as `openai-embedding-provider.test.ts`).

### 3. Wire `initArcana()` in the orchestrator

`packages/cli/src/commands/run.ts` registers services via `registerService({ name, enabled, start: async () => ServiceHandle })`. Lines 132–157 currently register ChromaDB. **Add a new service between ChromaDB and Server** — call it "Arcana":

```ts
registerService({
  name: 'Arcana',
  enabled: true,
  start: async () => {
    const { createLibsqlStructuredStore } = await import('@kybernesisai/arcana-provider-libsql');
    const { createChromaDBVectorStore } = await import('../brain/providers/chromadb-vector-store.js');
    const { createOpenAIEmbeddingProvider } = await import('../brain/providers/openai-embedding-provider.js');
    const { createClaudeLLMProvider } = await import('../brain/providers/claude-llm-provider.js');
    const { initArcana, disposeArcana } = await import('../brain/arcana-singleton.js');
    const { join } = await import('path');

    const dbPath = join(root, 'data', 'arcana.db');
    const structured = createLibsqlStructuredStore(dbPath);
    await structured.connect();

    // Collection name should match the existing ChromaDB convention (see embeddings.ts getCollectionNameForRoot)
    const identity = getIdentity();
    const collectionName = `kyberbot_${(identity.agent_name ?? 'data').toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`;

    const vector = createChromaDBVectorStore({ collectionName });
    await vector.connect();

    const embed = createOpenAIEmbeddingProvider();
    const llm = createClaudeLLMProvider();

    initArcana({ structured, vector, embed, llm });

    return {
      stop: async () => {
        await disposeArcana();
      },
      status: () => 'running' as const,
    };
  },
});
```

Order matters: register Arcana AFTER ChromaDB (which sets up the docker container) and BEFORE the Server / Heartbeat / Sleep services that may end up writing through Arcana once the mirror is live.

### 4. Verify the full test suite still passes

`pnpm typecheck && pnpm exec vitest run`. Expected: 720/720 still green. The new adapter adds tests, so it'll be slightly higher.

### 5. Smoke test — manual

Run a real KyberBot session against a fresh test agent:
- `kyberbot` from a tmp directory
- Send a channel message (or use the web UI) to fire `storeConversation`
- Check that `<root>/data/arcana.db` was created and has memory rows: `sqlite3 <root>/data/arcana.db 'SELECT count(*) FROM memories'`
- Confirm logs show "Arcana service started" and no errors

### 6. Commit + NOTE to comms

Probably **2 commits**:
1. `feat(brain): add ClaudeLLMProvider adapter` (~50 lines + tests)
2. `feat(cli): wire initArcana() in production orchestrator` (the run.ts edit + arcana-provider-libsql dep)

Then a NOTE in comms confirming the wiring landed + branch state.

## Gotchas / hidden risks

- **The ARP scopes JSON parsing**: the new libsql provider serialises JSON. If KyberBot's existing dual-write code happened to pass `undefined` rather than `null` for unset scope fields, double-check.
- **EntityProfile shape change**: module #12b is parked, but verify nothing in KyberBot writes `EntityProfile` with `staticFacts: string[]`. A grep for `staticFacts` should turn up zero hits in KyberBot.
- **Memory schema additions (`status`, `isLatest`, `supersededBy`)** — KyberBot's existing mirror calls to `ingest.storeMemory` don't pass these. Arcana defaults them (`status: 'active'`, `isLatest: true`, no `supersededBy`). Should "just work" but verify the integration tests still pass.
- **VectorStore `connect()`**: `createChromaDBVectorStore` requires `connect()` before use. ChromaDB Docker may not be up yet if the user runs the agent without `--chromadb-skip`. Wrap the vector store init in try/catch and substitute a stub-throwing VectorStore on failure (same defensive shape as `createMissingScheduler` in arcana-core) so the rest of Arcana keeps working without semantic search.
- **No real consumer of `LLMProvider` exists in the current kernel methods.** ClaudeLLMProvider is being added now for completeness, but exercising it end-to-end may not happen until Arcana grows fact-extraction inside `ingest.storeMemory` or sleep-pipeline kernel methods. The unit tests are the only validation.
- **Don't forget `await structured.connect()`** — without it, every Arcana write will throw at runtime.

## Comms protocol reminder

`~/dev/kybernesis/.comms/arcana-kyberbot.md`. Read it fresh before responding to anything the user reports from Arcana — pasted excerpts are pointers, not truth.

## Branch reference

```
0c3cd8e test(brain): add baseline tests for messages (module #13)
e3f8fb9 test(brain): add baseline tests for user-profile (module #12a)
d2c6cb6 refactor(brain): mirror supersede + contradiction writes to Arcana (module #11)
97ac62f feat(brain): mirror full conversation text as Arcana Memory (module #10)
26a898d test(brain): add baseline tests for fact-retrieval (module #8)
b5af8c9 test(brain): add baseline tests for fact-contradiction (module #6)
1baeb39 test(brain): add baseline tests for store-conversation + fact-temporal (module #5 batch)
c0f9c84 test(brain): add baseline tests for fact-extractor (module #5)
3719700 refactor(brain): flip fact-store mirror from storeMemory to recordFact (ADR 004)
ae7e610 fix(brain): timeline mirror reuses existing Arcana memory on re-write (DVR-UT-006 / ADR 005)
686e4ee docs(reviews): capture unit-test review of arcana-adoption modules #1-#4
2fc561e refactor(brain): rewrite fact-store as Arcana dual-write wrapper (module #4)
1f23d68 test(brain): add baseline unit tests for fact-store (pre-Arcana migration)
6e1cb95 feat(brain): add OpenAI + ChromaDB provider adapters (module #3)
3c94021 feat(brain): rewrite entity-graph as Arcana dual-write wrapper (module #2)
975d0fd test(brain): add timeline ↔ Arcana dual-write integration test
c384561 docs: add operational notes for arcana-adoption branch lifecycle
fb4ba59 feat(brain): rewrite timeline as Arcana dual-write wrapper (module #1)
2da2c5e chore(deps): add Arcana file: deps + workspace override for adoption
```

Tests: 720/720. Branch: `arcana-adoption`.
