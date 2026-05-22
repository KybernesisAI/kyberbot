/**
 * Arcana factRetrieval parity harness — runs KB `factFirstSearch` (baseline)
 * against `arcana.retrieve.factRetrieval` (candidate) over a shared fixture
 * set and reports per-query top-N overlap via `runParityHarness` from
 * `@kybernesis/arcana-testkit`.
 *
 * Per the 2026-05-22 11:55 ARCANA → KBOT BREAKING comms note (v1.0.0):
 * pass bar is `meanOverlap === 1` on the fact-id set. The memory-id set
 * (supportingMemories vs supporting_context) is intentionally out of scope
 * for this first pass — comparing it requires seeding a memory store on
 * both sides, which the workstream A/B plans cover separately.
 *
 * Seeding strategy: stand up a temp KB fact-store AND a temp Arcana
 * singleton in a throwaway directory, then call KB's `storeFact` for each
 * fixture. `storeFact` dual-writes — its existing `mirrorFactToArcana` path
 * lands the same fact in Arcana and stamps `facts.arcana_fact_id` on the
 * KB row, giving us the cross-store id bridge for free.
 *
 * Providers: fake embedding + fake vector + fake LLM (testkit). Real
 * libsql StructuredStore on the Arcana side, since fact-FTS — the actual
 * thing under test — lives there. Semantic isn't exercised; this is a
 * Layer 0 (direct fact-FTS) parity check.
 *
 * Plan: docs/plans/2026-05-22-arcana-fact-retrieval-parity-harness.md
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createLibsqlStructuredStore } from '@kybernesis/arcana-provider-libsql';
import {
  createFakeEmbeddingProvider,
  createFakeLLMProvider,
  createFakeVectorStore,
} from '@kybernesis/arcana-testkit';
import { runParityHarness, type ParityReport } from '@kybernesis/arcana-testkit';

import { ensureFactsTable, storeFact } from './fact-store.js';
import { getTimelineDb } from './timeline.js';
import { factFirstSearch } from './fact-retrieval.js';
import {
  initArcana,
  disposeArcana,
  getArcanaInstance,
  resetArcanaForTests,
} from './arcana-singleton.js';
import { PARITY_FACTS, PARITY_QUERIES, type ParityQueryFixture } from './__fixtures__/parity-facts.js';
import { createLogger } from '../logger.js';

const logger = createLogger('fact-retrieval-parity');

export interface FactRetrievalParityOptions {
  /** Top-N comparison depth. Default 10 (per ADR 009). */
  topN?: number;
  /** Pass threshold (0..1). Default 1.0 — exact-overlap per the v1.0.0 comms note. */
  threshold?: number;
}

export interface FactRetrievalParityRun {
  report: ParityReport<string>;
  fixtureCount: number;
  queryCount: number;
  /** Fixtures that failed to mirror to Arcana — capped at the top of the report. */
  unmirroredFixtureIds: string[];
}

export async function runFactRetrievalParity(
  opts: FactRetrievalParityOptions = {}
): Promise<FactRetrievalParityRun> {
  const topN = opts.topN ?? 10;
  const threshold = opts.threshold ?? 1.0;

  const tempRoot = await mkdtemp(join(tmpdir(), 'kyberbot-fact-parity-'));
  logger.info('parity harness — temp root', { tempRoot });

  // Stand up Arcana with fake providers but a REAL libsql structured store
  // (fact-FTS is the thing we're testing). The singleton must be empty going
  // in — anything else means another part of the process already initialised
  // production providers, which would corrupt the harness AND leak fixtures
  // into prod.
  if (getArcanaInstance()) {
    await rm(tempRoot, { recursive: true, force: true });
    throw new Error(
      'Arcana singleton already initialised — refusing to overwrite. Run the parity harness in a standalone CLI invocation.'
    );
  }

  const structured = createLibsqlStructuredStore(join(tempRoot, 'arcana.db'));
  await structured.connect();

  try {
    await initArcana({
      structured,
      vector: createFakeVectorStore(),
      embed: createFakeEmbeddingProvider(),
      llm: createFakeLLMProvider(),
    });
    const arcana = getArcanaInstance();
    if (!arcana) throw new Error('Arcana singleton failed to initialise');

    await ensureFactsTable(tempRoot);

    // ── Seed fixtures (dual-write) ─────────────────────────────────────────
    const fixtureIdToKbId = new Map<string, number>();
    const unmirroredFixtureIds: string[] = [];

    for (const f of PARITY_FACTS) {
      const kbId = await storeFact(tempRoot, {
        content: f.content,
        source_path: `/parity/${f.id}`,
        source_conversation_id: `parity-conv-${f.id}`,
        entities: [...f.entities],
        timestamp: f.timestamp,
        confidence: f.confidence,
        category: f.category,
      });
      fixtureIdToKbId.set(f.id, kbId);
    }

    // Cross-store id bridge — read arcana_fact_id back from KB rows.
    const db = await getTimelineDb(tempRoot);
    const arcanaIdToFixtureId = new Map<string, string>();
    const kbIdToFixtureId = new Map<number, string>();
    for (const [fixtureId, kbId] of fixtureIdToKbId) {
      kbIdToFixtureId.set(kbId, fixtureId);
      const row = db
        .prepare('SELECT arcana_fact_id FROM facts WHERE id = ?')
        .get(kbId) as { arcana_fact_id: string | null } | undefined;
      const arcanaId = row?.arcana_fact_id ?? null;
      if (arcanaId) {
        arcanaIdToFixtureId.set(arcanaId, fixtureId);
      } else {
        unmirroredFixtureIds.push(fixtureId);
      }
    }

    if (unmirroredFixtureIds.length === PARITY_FACTS.length) {
      throw new Error(
        'Every fixture failed to mirror to Arcana — recordFact returned no ids. ' +
          'Check the Arcana provider wiring before interpreting the parity report.'
      );
    }

    // ── Define baseline + candidate wrappers ───────────────────────────────
    type ParityOutput = { factIds: string[] };

    const baseline = async (input: unknown): Promise<ParityOutput> => {
      const q = input as ParityQueryFixture;
      const r = await factFirstSearch(q.query, tempRoot);
      const factIds: string[] = [];
      for (const f of r.facts) {
        const fid = kbIdToFixtureId.get(f.id);
        if (fid) factIds.push(fid);
      }
      return { factIds };
    };

    const candidate = async (input: unknown): Promise<ParityOutput> => {
      const q = input as ParityQueryFixture;
      const qr = await arcana.retrieve.factRetrieval({
        query: q.query,
        ...(q.category ? { category: q.category } : {}),
      });
      const factIds: string[] = [];
      for (const sf of qr.data.facts) {
        const fid = arcanaIdToFixtureId.get(sf.fact.id);
        if (fid) factIds.push(fid);
      }
      return { factIds };
    };

    const report = await runParityHarness<ParityOutput, string>({
      queries: PARITY_QUERIES.map(q => ({ id: q.id, input: q })),
      baseline,
      candidate,
      extractIds: (r) => r.factIds,
      topN,
      threshold,
    });

    return {
      report,
      fixtureCount: PARITY_FACTS.length,
      queryCount: PARITY_QUERIES.length,
      unmirroredFixtureIds,
    };
  } finally {
    await disposeArcana().catch((err) => {
      logger.warn('disposeArcana failed during parity teardown', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    resetArcanaForTests();
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export function formatFactRetrievalParityReport(run: FactRetrievalParityRun): string {
  const { report, fixtureCount, queryCount, unmirroredFixtureIds } = run;
  const lines: string[] = [];
  lines.push('Arcana factRetrieval parity report');
  lines.push('─'.repeat(60));
  lines.push(`fixtures seeded: ${fixtureCount}`);
  lines.push(`queries run:     ${queryCount}`);
  lines.push(`unmirrored:      ${unmirroredFixtureIds.length}` +
    (unmirroredFixtureIds.length > 0 ? ` (${unmirroredFixtureIds.join(', ')})` : ''));
  lines.push(`top-N:           ${report.topN}`);
  lines.push(`threshold:       ${report.threshold}`);
  lines.push(`mean overlap:    ${report.meanOverlap.toFixed(3)}`);
  lines.push(`verdict:         ${report.passes ? 'PASS' : 'FAIL'}`);
  lines.push('');
  lines.push('per-query:');
  for (const q of report.perQuery) {
    const tag = q.error ? `ERROR(${q.error.side})` : `${q.overlap.toFixed(2)}`;
    lines.push(`  ${q.queryId.padEnd(18)} ${tag}`);
    if (q.error) {
      lines.push(`    error: ${q.error.message}`);
    } else if (q.overlap < 1) {
      lines.push(`    baseline:  [${q.baselineIds.join(', ')}]`);
      lines.push(`    candidate: [${q.candidateIds.join(', ')}]`);
      if (q.missingFromCandidate.length > 0) {
        lines.push(`    missing from candidate: ${q.missingFromCandidate.join(', ')}`);
      }
      if (q.extraInCandidate.length > 0) {
        lines.push(`    extra in candidate:     ${q.extraInCandidate.join(', ')}`);
      }
    }
  }
  return lines.join('\n');
}
