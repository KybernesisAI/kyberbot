# Workstream A — Paginated backfill of historical legacy data into Arcana

**Status:** approved, **awaiting Workstream B completion before starting**
**Sequenced after:** [Workstream B — constrained ingestion](./2026-05-21-arcana-parity-workstream-b-constrained-ingestion.md)
**Branch:** `arcana-adoption`

## Goal

KyberBot's legacy stores have years of pre-Arcana data: ~4,343 unmirrored facts, ~997 unmirrored memories, ~5,904 entities, plus edges/insights/profiles/contradictions. None of this is in Arcana. The current `kyberbot brain arcana-parity` inspector shows the gap clearly. We want to close it — walk the legacy backlog in small batches, write each row through to Arcana via the existing dual-write API, stamp the legacy FK column.

Critically: **run this with a human in the loop** until trust is built, then graduate to semi-autonomous, then to "autonomous loop that only halts on error".

## Scope

**In:**
- A new command: `kyberbot brain arcana-backfill <kind> --batch <n> --batches <m> --mode <manual|semi-auto|auto>`
- Three kinds, ordered by implementation simplicity: `facts` → `memories` → `entities` (entities likely requires schema change first; see Arcana dependencies)
- A "graduation mode" controlling human-in-the-loop intensity
- An LLM-equivalence verifier for semantic content comparison (counts alone are insufficient)
- Per-batch parity inspector run + comparison output

**Out:**
- Edges, insights, profiles, contradictions backfill (deferred — sleep pipeline isn't wired yet; insights/profiles will be regenerated rather than backfilled)
- Channel messages backfill (separate code path, low value)
- Modifying the dual-write code paths themselves — this command USES them, doesn't reimplement them

## Approach

### Per-row backfill pseudocode (facts as the example — cleanest case)

```
SELECT * FROM facts WHERE arcana_fact_id IS NULL ORDER BY id LIMIT ?
for each row:
  arcanaId = await arcana.command.recordFact({
    entity, attribute, value, recordedAt, source, confidence, ...
  })
  UPDATE facts SET arcana_fact_id = ? WHERE id = ?
  log { legacyId, arcanaId, ok: true }
on row failure:
  log { legacyId, error, ok: false }
  in manual/semi-auto mode: STOP and surface the error
  in auto mode: continue but record the failure
```

Memories follow the same pattern using `timeline_events.arcana_memory_id` and `arcana.ingest.storeMemory`. Entities are harder because the legacy `entities` table has no FK column today — see Arcana dependencies.

### Graduation mode

| Mode | Behaviour |
|------|-----------|
| `manual` | Process one batch, print summary + parity diff + sampled side-by-side, **wait for user to type `continue`** before next batch. Type anything else to stop. Used for early validation. |
| `semi-auto` | Run all `--batches` consecutively, but **stop immediately on any row-level error**. Print summary + parity diff per batch. Used once we trust the happy path. |
| `auto` | Run all `--batches` consecutively, **never stop for individual row errors** — accumulate errors, write them to a report file, continue. Used for closing out the last 90% of the backlog after the first 10% has proven clean. |

Default mode = `manual`. David explicitly graduates by passing `--mode`.

### Per-batch verification output

After each batch:
1. **Parity inspector counts** — should rise by exactly `--batch` on the mirrored column.
2. **Sampled side-by-side dump** — pick 2 random rows from the batch, dump legacy row + corresponding Arcana row, print both. Catches "writes succeeded but content got mangled in mapping" bugs.
3. **LLM-equivalence verifier** (see below) — runs over the sampled pairs and reports "essentially the same" or "diverged".

### LLM-equivalence verifier — load-bearing

David specifically called this out: programmatic equality won't work because the same semantic content can appear in differently-shaped storage (timestamps differ, IDs differ, array ordering differs, summarisation lossy). We need something that reads two payloads and says "these are essentially the same thing" or "these differ in meaningful ways."

Implementation sketch:
```
async function arePayloadsEquivalent(legacy, arcana, kind): Promise<{ same: boolean; why: string }> {
  const prompt = `
    These two records are supposed to represent the same ${kind}, one from the
    legacy KyberBot store and one from the Arcana mirror. Are they semantically
    equivalent? Ignore IDs, timestamps, internal ordering, and added/missing
    derived fields (like Arcana's content_hash). Focus on whether the
    factual/textual content is preserved.

    LEGACY: ${JSON.stringify(legacy, null, 2)}
    ARCANA: ${JSON.stringify(arcana, null, 2)}

    Respond with JSON: { "same": true|false, "why": "<one sentence>" }.
  `;
  const response = await getClaudeClient().complete(prompt, { model: 'haiku', subprocess: true });
  return JSON.parse(extractJson(response));
}
```

Uses KyberBot's existing `ClaudeClient` (subprocess mode, free under the Max plan). Haiku is cheap and fast enough for this. Output goes into the per-batch report.

This verifier is **its own new module** at `packages/cli/src/brain/semantic-equivalence.ts` with its own tests. Reused by Workstream B optionally, but core to Workstream A.

## Open questions

1. **Where do error reports get written?** Suggest `data/arcana-backfill-errors-<kind>-<timestamp>.jsonl`. One line per failed row.
2. **What does "the same" mean for entities?** Two entities with the same name but slightly different alias lists — same? Different? Likely "same" — the LLM can decide.
3. **Backfill order — oldest first or newest first?** Suggest oldest first. The recent stuff is already getting mirrored by live dual-write; the gap is in the historical tail.
4. **Idempotency** — if a backfill is interrupted mid-batch, re-running should pick up where it left off. The `arcana_fact_id IS NULL` filter handles this naturally, but worth a test.
5. **Rate limiting** — Arcana writes go through libsql + ChromaDB + OpenAI embeddings. The OpenAI embedding calls cost real money. Suggest a `--rate-limit-ms <n>` flag (default 100ms between rows) to avoid hitting OpenAI throughput limits on a 4000-fact batch.

## Phasing

1. **Phase 1 — Facts in manual mode** (~3 hours including tests)
   - Build `kyberbot brain arcana-backfill facts --batch 50 --batches 10 --mode manual`
   - Build the semantic-equivalence verifier
   - Run it. Validate each batch by eye.
   - Target: 500 facts mirrored, 0 semantic divergences, parity inspector counts rising as expected.

2. **Phase 2 — Facts in semi-auto** (~30 min — same command, different mode)
   - Run remaining batches in semi-auto mode
   - Target: 4,343 - 500 = 3,843 facts mirrored over ~80 batches
   - Halt on any error; resolve; resume

3. **Phase 3 — Facts in auto** (~30 min)
   - Last sweep to verify zero unmirrored facts remain
   - Generate the final error report

4. **Phase 4 — Memories backfill** (~2 hours — adapt the command)
   - Same pattern as facts, different table + Arcana API call
   - Memories has the 20-row drift the inspector found — investigate that first

5. **Phase 5 — Entities backfill** (~3+ hours — needs Arcana dependency resolved first)
   - Requires either an `arcana_entity_id` FK column on legacy.entities (KyberBot-side schema change) OR a deterministic-name-match approach that doesn't need a FK
   - **Send a comms NOTE to Arcana** before starting this phase asking which approach they prefer

## Verification approach

Each batch produces a structured report:

```
BATCH 3/10 — facts backfill
  Rows attempted:    50
  Rows written OK:   50
  Rows errored:      0
  Parity delta:      mirrored 189 → 239   (+50)
                     arcana   189 → 239   (+50)   ✓ counts match expected
  Sample comparisons (2 random pairs):
    fact #1234: ✓ semantically equivalent
    fact #2891: ✓ semantically equivalent
  Status: continue
```

In `manual` mode the command pauses here and waits. In `semi-auto` it auto-continues unless `Rows errored > 0`. In `auto` it always continues.

## Arcana-side dependencies

**Entities phase (Phase 5) needs Arcana's input:**

The legacy `entities` table has no FK column today. To track which legacy entities have been mirrored to Arcana, we have three options:

1. KyberBot-side migration: add `arcana_entity_id TEXT` column to legacy.entities. Doesn't need Arcana input but commits us to a schema change.
2. Rely on Arcana's `upsertEntity` dedup — backfill all of them, accept that Arcana will dedup-and-merge by canonical name, accept that we can't tell from the legacy side which is mirrored.
3. Cross-reference table — a separate `entity_arcana_links` table mapping legacy entity IDs to Arcana entity IDs.

**Before Phase 5 starts, send a comms NOTE to Arcana** at `~/dev/kybernesis/.comms/arcana-kyberbot.md` asking which approach they prefer. Their input matters because `upsertEntity` dedup behaviour and entity-name canonicalisation may have nuances we should know.

Facts and memories phases (1-4) require nothing from Arcana — they use existing APIs against stable schemas.

## Risks

- **Cost** — 4,000+ rows × OpenAI embedding call = ~$2-5 in OpenAI charges depending on row sizes. Modest but real.
- **Time** — at 100ms per row, 4,000 facts = ~7 minutes pure runtime, longer with embedding-API roundtrips. Memories add ~17 minutes.
- **Sleep pipeline interference** — if the live sleep agent runs during backfill, it'll see the new Arcana rows and start sleep-cycle operations on them. Either pause sleep during backfill (`kyberbot run --no-sleep`) or accept the noise. Suggest the former.
- **Memory-drift bug from the inspector** — there are 20 untracked memories in arcana already. Before running memories backfill, **investigate that drift** so we don't compound the problem.

## Definition of done

- All three kinds (facts, memories, entities) at >99% mirrored
- Inspector shows ✓ match on all "mirrored vs arcana" rows
- Semantic-equivalence verifier reports 100% equivalent on a final 100-row random sample
- Final comms NOTE to Arcana confirming "legacy is now mirrored, ready for the read sprint to start using the full dataset"
