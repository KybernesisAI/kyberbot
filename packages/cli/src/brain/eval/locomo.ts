/**
 * KyberBot -- LoCoMo Long-Term Memory Benchmark
 *
 * Evaluates KyberBot's memory pipeline against the LoCoMo dataset:
 *   1. Ingest each conversation via direct DB + REST API operations
 *   2. Extract observations via inline Haiku calls
 *   3. Query using ChromaDB REST API + timeline FTS
 *   4. Score answers using token-level F1 with Porter stemming
 *   5. Report per-category and overall accuracy
 *
 * This harness is self-contained — it avoids importing any module that
 * transitively depends on the `chromadb` npm package (which loads a 4-8GB
 * ONNX runtime and OOMs). Instead it talks to ChromaDB via its REST API
 * and uses the OpenAI SDK directly for embeddings.
 *
 * Reference: https://arxiv.org/abs/2402.07375
 *
 * Usage (from eval command):
 *   const result = await runLoCoMoBenchmark({
 *     dataPath: 'packages/cli/src/brain/eval/data/locomo10.json',
 *     maxConversations: 3,
 *     categories: [1, 2],
 *     verbose: true,
 *   });
 */

import { readFileSync, writeFileSync } from 'fs';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import OpenAI from 'openai';
import { getClaudeClient } from '../../claude.js';
import { createLogger } from '../../logger.js';
import { resetConfig } from '../../config.js';
import { resetTimelineDb, getTimelineDb, addConversationToTimeline } from '../timeline.js';
import {
  resetEntityGraphDb,
  findOrCreateEntity,
  addEntityMention,
  linkEntitiesWithType,
} from '../entity-graph.js';
import { resetSleepDb } from '../sleep/db.js';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';

const logger = createLogger('eval');

// ═══════════════════════════════════════════════════════════════════════════════
// CHROMADB REST API (bypasses the `chromadb` npm package entirely)
// ═══════════════════════════════════════════════════════════════════════════════

const CHROMA_URL = process.env.CHROMA_URL || 'http://localhost:8001';
const CHROMA_TENANT = 'default_tenant';
const CHROMA_DB = 'default_database';

async function chromaCreateCollection(name: string): Promise<string> {
  // Delete existing collection if it exists (leftover from previous failed run)
  try { await chromaDeleteCollection(name); } catch { /* ignore */ }

  const resp = await fetch(
    `${CHROMA_URL}/api/v2/tenants/${CHROMA_TENANT}/databases/${CHROMA_DB}/collections`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, configuration: { hnsw: { space: 'cosine' } } }),
    }
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ChromaDB create collection failed (${resp.status}): ${text}`);
  }
  const data = (await resp.json()) as { id: string };
  return data.id;
}

async function chromaDeleteCollection(name: string): Promise<void> {
  await fetch(
    `${CHROMA_URL}/api/v2/tenants/${CHROMA_TENANT}/databases/${CHROMA_DB}/collections/${name}`,
    { method: 'DELETE' }
  );
}

async function chromaAdd(
  collectionId: string,
  ids: string[],
  documents: string[],
  embeddings: number[][],
  metadatas: Record<string, any>[]
): Promise<void> {
  const resp = await fetch(
    `${CHROMA_URL}/api/v2/tenants/${CHROMA_TENANT}/databases/${CHROMA_DB}/collections/${collectionId}/add`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, documents, embeddings, metadatas }),
    }
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ChromaDB add failed (${resp.status}): ${text}`);
  }
}

async function chromaQuery(
  collectionId: string,
  queryEmbedding: number[],
  nResults: number
): Promise<{
  ids: string[][];
  documents: string[][];
  metadatas: any[][];
  distances: number[][];
}> {
  const resp = await fetch(
    `${CHROMA_URL}/api/v2/tenants/${CHROMA_TENANT}/databases/${CHROMA_DB}/collections/${collectionId}/query`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query_embeddings: [queryEmbedding],
        n_results: nResults,
        include: ['documents', 'metadatas', 'distances'],
      }),
    }
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ChromaDB query failed (${resp.status}): ${text}`);
  }
  return (await resp.json()) as {
    ids: string[][];
    documents: string[][];
    metadatas: any[][];
    distances: number[][];
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// OPENAI EMBEDDINGS (direct, no chromadb npm dependency)
// ═══════════════════════════════════════════════════════════════════════════════

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function embed(texts: string[]): Promise<number[][]> {
  // Batch in chunks of 100 (OpenAI limit is 2048 but we keep it reasonable)
  const allEmbeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100);
    const resp = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: batch,
    });
    for (const item of resp.data) {
      allEmbeddings.push(item.embedding);
    }
  }
  return allEmbeddings;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTITY EXTRACTION (inline, avoids importing relationship-extractor which
// is safe but we inline for consistency — keeps all AI calls in one place)
// ═══════════════════════════════════════════════════════════════════════════════

const ENTITY_EXTRACTION_PROMPT = `You are an entity relationship extractor. Analyze the conversation text and extract:

1. **Entities**: People, companies, projects, places, and topics mentioned
2. **Relationships**: Explicit relationships between entities

## Entity Types
- person: Individual people (e.g., "John", "Dr. Smith", "my brother")
- company: Companies, organizations (e.g., "Google", "Acme Corp")
- project: Specific named projects, products, or apps
- place: Locations (e.g., "New York", "the office", "Thailand")
- topic: Topics, concepts, technologies (e.g., "AI", "funding", "TypeScript")

## Relationship Types (only use these exact values)
- founded, works_at, invested_in, met_with, created, manages,
  partners_with, located_in, discussed, related_to, reports_to,
  uses, depends_on, part_of

## Rules
- Only extract relationships that are EXPLICITLY stated or strongly implied
- Set confidence 0.8-0.95 for explicit statements, 0.5-0.7 for implied
- Provide brief rationale

Respond with JSON only:
{
  "entities": [{ "name": "...", "type": "..." }],
  "relationships": [{
    "source": { "name": "...", "type": "..." },
    "target": { "name": "...", "type": "..." },
    "relationship": "...",
    "confidence": 0.9,
    "rationale": "..."
  }]
}`;

interface ExtractedEntity {
  name: string;
  type: string;
}

interface ExtractedRelationship {
  source: ExtractedEntity;
  target: ExtractedEntity;
  relationship: string;
  confidence: number;
  rationale: string;
}

async function extractEntitiesAndRelationships(
  text: string
): Promise<{ entities: ExtractedEntity[]; relationships: ExtractedRelationship[] }> {
  const client = getClaudeClient();
  try {
    const truncated = text.length > 4000 ? text.slice(0, 4000) + '\n[truncated]' : text;
    const response = await client.complete(
      `Extract entities and relationships from this conversation:\n\n${truncated}`,
      { model: 'haiku', system: ENTITY_EXTRACTION_PROMPT, maxTokens: 1024, maxTurns: 1 }
    );
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { entities: [], relationships: [] };
    const result = JSON.parse(jsonMatch[0]);
    return {
      entities: (result.entities || []).filter((e: any) => e.name && e.type),
      relationships: (result.relationships || []).filter(
        (r: any) => r.source?.name && r.target?.name && r.relationship
      ),
    };
  } catch {
    return { entities: [], relationships: [] };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// OBSERVATION EXTRACTION (inline, avoids importing observe.ts -> embeddings.ts)
// ═══════════════════════════════════════════════════════════════════════════════

const OBSERVATION_PROMPT = `Extract key facts from this conversation as a JSON array of short, self-contained statements. Each fact should be independently understandable without context.

Rules:
- Include: names, relationships, dates, places, preferences, events, decisions, feelings, plans
- Each fact should be a single sentence, 5-20 words
- Use specific names, not pronouns
- Include temporal context when mentioned (dates, "last year", etc.)
- Do NOT include greetings, small talk, or meta-commentary
- Return 3-15 facts depending on conversation length

Example output:
["Caroline is originally from Sweden", "Melanie has two kids who like dinosaurs", "The charity race raised awareness for mental health", "Caroline wants to pursue counseling as a career"]

Conversation:
`;

async function extractObservations(text: string): Promise<string[]> {
  const client = getClaudeClient();
  try {
    const content = text.slice(0, 4000);
    const response = await client.complete(OBSERVATION_PROMPT + content, {
      model: 'haiku',
      maxTokens: 1024,
      maxTurns: 1,
    });
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const facts = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(facts)) return [];
    return facts.filter(
      (f: any) => typeof f === 'string' && f.length >= 10 && f.length <= 200
    );
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEGMENT SPLITTING (matches production segmentText from store-conversation.ts)
// ═══════════════════════════════════════════════════════════════════════════════

function segmentText(
  text: string,
  segmentSize: number = 250,
  overlap: number = 50
): Array<{ text: string; index: number }> {
  if (text.length <= segmentSize) {
    return [{ text, index: 0 }];
  }

  const segments: Array<{ text: string; index: number }> = [];
  let start = 0;
  let index = 0;

  while (start < text.length) {
    let end = start + segmentSize;

    if (end < text.length) {
      const slice = text.slice(start, end + 50);
      const breakPoint = slice.lastIndexOf('\n');
      const sentenceBreak = slice.search(/[.!?]\s+[A-Z]/);
      if (breakPoint > segmentSize * 0.6) {
        end = start + breakPoint + 1;
      } else if (sentenceBreak > segmentSize * 0.6) {
        end = start + sentenceBreak + 2;
      }
    } else {
      end = text.length;
    }

    segments.push({ text: text.slice(start, end).trim(), index });
    index++;
    // Ensure start always advances by at least half the segment size
    const nextStart = end - overlap;
    start = Math.max(nextStart, start + Math.floor(segmentSize / 2));
    if (start >= text.length) break;
  }

  return segments;
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOISE ENTITY FILTERING (matches production filterNoiseEntities)
// ═══════════════════════════════════════════════════════════════════════════════

const NOISE_ENTITY_PATTERNS: RegExp[] = [
  /^(curl|wget|bash|sh|zsh|npm|pnpm|yarn|pip|git|docker|node|python|make|gcc)$/i,
  /^(BLOCKED|ERROR|FAIL|OK|SUCCESS|null|undefined|true|false|none|N\/A)$/i,
  /^(max\s+turns?\s+limit|rate\s+limit|timeout|sandbox|retry|fallback|skip)$/i,
  /^(settings|config|permissions?|terminal|shell|command|script)$/i,
  /^(stdout|stderr|stdin|exit code|error|warning)$/i,
  /\.(json|yaml|yml|md|ts|js|py|sh|env|toml|lock|log|txt|csv|db)$/i,
  /^[./~].*\//,
  /^\d+$/,
  /^.{1,2}$/,
  /^(the|this|that|it|they|we|i|you|he|she|my|our)$/i,
  /^[a-f0-9-]{36}$/i,
  /^(http|https|localhost|127\.0\.0\.1|0\.0\.0\.0)/i,
];

function filterNoiseEntities(
  entities: ExtractedEntity[]
): ExtractedEntity[] {
  return entities.filter((e) => {
    const name = e.name.trim();
    if (NOISE_ENTITY_PATTERNS.some((p) => p.test(name))) return false;
    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface Turn {
  speaker: string;
  dia_id?: string;
  text?: string;
  query?: string;
  blip_caption?: string;
  img_url?: string[];
}

interface QAItem {
  question: string;
  answer?: string | number;
  adversarial_answer?: string;
  evidence: string[];
  category: 1 | 2 | 3 | 4 | 5;
}

interface LoCoMoConversation {
  sample_id: string;
  conversation: {
    speaker_a: string;
    speaker_b: string;
    [key: string]: any;
  };
  qa: QAItem[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

export interface LoCoMoOptions {
  dataPath: string;
  maxConversations?: number;
  categories?: number[];
  verbose?: boolean;
}

export interface LoCoMoResult {
  overall: { accuracy: number; count: number };
  byCategory: Record<number, { accuracy: number; count: number }>;
  byConversation: Record<string, { accuracy: number; count: number }>;
  details?: Array<{
    sampleId: string;
    question: string;
    predicted: string;
    expected: string;
    category: number;
    f1: number;
  }>;
}

/**
 * Run the LoCoMo benchmark using direct DB + REST API operations.
 * Does NOT import the `chromadb` npm package — avoids the 4-8GB ONNX OOM.
 */
export async function runLoCoMoBenchmark(
  options: LoCoMoOptions
): Promise<LoCoMoResult> {
  const {
    dataPath,
    maxConversations,
    categories = [1, 2, 3, 4, 5],
    verbose = false,
  } = options;

  const categorySet = new Set(categories);

  // Verify ChromaDB is reachable via REST
  try {
    const healthResp = await fetch(`${CHROMA_URL}/api/v2/heartbeat`);
    if (!healthResp.ok) throw new Error(`ChromaDB health check failed: ${healthResp.status}`);
    logger.info('ChromaDB reachable via REST API');
  } catch (err) {
    throw new Error(
      `ChromaDB is required for LoCoMo benchmark. Start with: docker-compose up -d\n${err}`,
      { cause: err }
    );
  }

  // Load dataset
  const raw = readFileSync(dataPath, 'utf-8');
  let conversations: LoCoMoConversation[] = JSON.parse(raw);

  if (maxConversations && maxConversations < conversations.length) {
    conversations = conversations.slice(0, maxConversations);
  }

  logger.info(
    `LoCoMo benchmark: ${conversations.length} conversations, categories [${categories.join(',')}]`
  );

  const allDetails: LoCoMoResult['details'] = [];
  const categoryScores: Record<number, { total: number; sum: number }> = {};
  const conversationScores: Record<string, { total: number; sum: number }> = {};

  for (const cat of categories) {
    categoryScores[cat] = { total: 0, sum: 0 };
  }

  // Save original env so we can restore it after the benchmark
  const originalRoot = process.env.KYBERBOT_ROOT;

  for (const conv of conversations) {
    const sampleId = conv.sample_id;
    conversationScores[sampleId] = { total: 0, sum: 0 };

    // Filter QA items by category
    const qaItems = conv.qa.filter((q) => categorySet.has(q.category));
    logger.info(`Evaluating ${sampleId}: ${qaItems.length} questions`);

    // Create isolated temporary brain for this conversation
    const tempRoot = mkdtempSync(join(tmpdir(), `kyberbot-locomo-${sampleId}-`));
    mkdirSync(join(tempRoot, 'data'), { recursive: true });

    // Write minimal identity.yaml for the production pipeline
    writeFileSync(
      join(tempRoot, 'identity.yaml'),
      'agent_name: LoCoMo Benchmark\ntimezone: UTC\nheartbeat_interval: 30m\n'
    );

    // Create ChromaDB collection for this conversation
    const chromaCollectionName = `locomo_${sampleId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    let chromaCollectionId: string | null = null;

    try {
      // Reset all production singletons to point at this temp root
      resetConfig();
      resetTimelineDb();
      resetEntityGraphDb();
      resetSleepDb();
      process.env.KYBERBOT_ROOT = tempRoot;

      // Create ChromaDB collection via REST
      chromaCollectionId = await chromaCreateCollection(chromaCollectionName);
      logger.debug(`Created ChromaDB collection: ${chromaCollectionName} (${chromaCollectionId})`);

      // Phase 1: Ingest conversation sessions
      const speakerA = conv.conversation.speaker_a;
      const speakerB = conv.conversation.speaker_b;
      const processed = await ingestConversation(
        tempRoot,
        conv,
        speakerA,
        speakerB,
        chromaCollectionId
      );
      logger.info(`  Indexed ${processed} sessions`);

      // Phase 1.5: Run observation extraction
      try {
        const obsCount = await runObservations(tempRoot, chromaCollectionId);
        logger.info(`  Extracted ${obsCount} observations`);
      } catch (err) {
        logger.warn(`  Observation extraction failed (non-fatal)`, {
          error: String(err),
        });
      }

      // Phase 2: Query and score each QA item
      for (let i = 0; i < qaItems.length; i++) {
        const qa = qaItems[i];
        try {
          const predicted = await answerQuestion(
            tempRoot,
            qa,
            speakerA,
            speakerB,
            chromaCollectionId
          );
          const groundTruth = getGroundTruth(qa);
          const f1 = scoreAnswer(predicted, groundTruth, qa.category);

          categoryScores[qa.category].total++;
          categoryScores[qa.category].sum += f1;
          conversationScores[sampleId].total++;
          conversationScores[sampleId].sum += f1;

          if (verbose) {
            allDetails.push({
              sampleId,
              question: qa.question,
              predicted,
              expected: groundTruth,
              category: qa.category,
              f1,
            });
          }

          if ((i + 1) % 50 === 0) {
            logger.info(
              `  ${sampleId}: ${i + 1}/${qaItems.length} questions processed`
            );
          }
        } catch (err) {
          logger.warn(
            `  Failed on question: "${qa.question.slice(0, 60)}..."`,
            { error: String(err) }
          );
          // Count as zero F1 but don't break the run
          categoryScores[qa.category].total++;
          conversationScores[sampleId].total++;

          if (verbose) {
            allDetails.push({
              sampleId,
              question: qa.question,
              predicted: `[ERROR: ${String(err).slice(0, 100)}]`,
              expected: getGroundTruth(qa),
              category: qa.category,
              f1: 0,
            });
          }
        }
      }

      const convAcc =
        conversationScores[sampleId].total > 0
          ? conversationScores[sampleId].sum /
            conversationScores[sampleId].total
          : 0;
      logger.info(
        `  ${sampleId}: ${convAcc.toFixed(3)} avg F1 (${conversationScores[sampleId].total} questions)`
      );
    } finally {
      // Clean up ChromaDB collection via REST
      try {
        await chromaDeleteCollection(chromaCollectionName);
      } catch {
        logger.warn(`Failed to clean up ChromaDB collection: ${chromaCollectionName}`);
      }

      // Reset singletons before next conversation
      resetTimelineDb();
      resetEntityGraphDb();
      resetSleepDb();

      // Clean up temp directory
      try {
        rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        logger.warn(`Failed to clean up temp directory: ${tempRoot}`);
      }
    }
  }

  // Restore original env
  if (originalRoot) {
    process.env.KYBERBOT_ROOT = originalRoot;
  } else {
    delete process.env.KYBERBOT_ROOT;
  }
  resetConfig();

  // Build results
  const byCategory: Record<number, { accuracy: number; count: number }> = {};
  for (const cat of categories) {
    const s = categoryScores[cat];
    byCategory[cat] = {
      accuracy: s.total > 0 ? s.sum / s.total : 0,
      count: s.total,
    };
  }

  const byConversation: Record<string, { accuracy: number; count: number }> =
    {};
  let overallSum = 0;
  let overallCount = 0;
  for (const [id, s] of Object.entries(conversationScores)) {
    byConversation[id] = {
      accuracy: s.total > 0 ? s.sum / s.total : 0,
      count: s.total,
    };
    overallSum += s.sum;
    overallCount += s.total;
  }

  const result: LoCoMoResult = {
    overall: {
      accuracy: overallCount > 0 ? overallSum / overallCount : 0,
      count: overallCount,
    },
    byCategory,
    byConversation,
  };

  if (verbose) {
    result.details = allDetails;
  }

  // Print summary
  logger.info('=== LoCoMo Benchmark Results ===');
  logger.info(
    `Overall: ${result.overall.accuracy.toFixed(3)} F1 (${result.overall.count} questions)`
  );
  for (const cat of categories) {
    const c = byCategory[cat];
    const label = CATEGORY_LABELS[cat] || `cat-${cat}`;
    logger.info(`  ${label}: ${c.accuracy.toFixed(3)} F1 (${c.count} questions)`);
  }

  return result;
}

const CATEGORY_LABELS: Record<number, string> = {
  1: 'Single-hop',
  2: 'Temporal',
  3: 'Open-domain',
  4: 'Multi-hop',
  5: 'Adversarial',
};

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1: INGESTION (direct DB + ChromaDB REST API)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ingest all sessions from a LoCoMo conversation.
 * - Segments are stored in timeline FTS (SQLite)
 * - Segments are embedded via OpenAI and stored in ChromaDB via REST
 * - Entities are extracted via Haiku and stored in the entity graph
 */
async function ingestConversation(
  root: string,
  conv: LoCoMoConversation,
  speakerA: string,
  speakerB: string,
  chromaCollectionId: string
): Promise<number> {
  const conversation = conv.conversation;

  // Find all sessions with actual turns
  const sessions: Array<{ num: number; dateTime: string; turns: Turn[] }> = [];

  for (const key of Object.keys(conversation)) {
    const match = key.match(/^session_(\d+)$/);
    if (!match) continue;

    const num = parseInt(match[1], 10);
    const turns = conversation[key] as Turn[];
    const dateTimeKey = `session_${num}_date_time`;
    const dateTime = conversation[dateTimeKey] as string | undefined;

    if (Array.isArray(turns) && turns.length > 0 && dateTime) {
      sessions.push({ num, dateTime, turns });
    }
  }

  // Sort by session number for chronological ingestion
  sessions.sort((a, b) => a.num - b.num);

  logger.debug(
    `  Ingesting ${sessions.length} sessions for ${conv.sample_id}`
  );

  for (const session of sessions) {
    const sessionTimestamp = parseLocomoDateTime(session.dateTime);
    const transcript = buildTranscript(session.turns, speakerA, speakerB);
    const fullText = `DATE: ${session.dateTime}\n${transcript}`;
    const conversationId = randomUUID();
    const sourcePath = `channel://locomo/${conversationId}`;

    // ── Step 1: Extract entities via Haiku ──────────────────────────────
    let entities: ExtractedEntity[] = [];
    let relationships: ExtractedRelationship[] = [];
    try {
      const extraction = await extractEntitiesAndRelationships(fullText);
      entities = filterNoiseEntities(extraction.entities);
      // Filter relationships to only reference kept entities
      const entityNameSet = new Set(entities.map((e) => e.name.toLowerCase()));
      relationships = extraction.relationships.filter(
        (r) =>
          entityNameSet.has(r.source.name.toLowerCase()) &&
          entityNameSet.has(r.target.name.toLowerCase())
      );
    } catch {
      // Entity extraction is best-effort
    }

    const entityNames = entities.map((e) => e.name);
    const topicNames = entities.filter((e) => e.type === 'topic').map((e) => e.name);

    // ── Step 2: Timeline (parent entry) ─────────────────────────────────
    const title = fullText.length > 100 ? fullText.slice(0, 97) + '...' : fullText;
    const fullTitle = `[locomo] ${title}`;

    try {
      await addConversationToTimeline(
        root, conversationId, sourcePath, sessionTimestamp, undefined,
        fullTitle,
        fullText.slice(0, 2000),
        entityNames, topicNames
      );
    } catch (err) {
      logger.warn('Timeline storage failed', { error: String(err) });
    }

    // ── Step 3: Segment-level indexing ───────────────────────────────────
    const segments = segmentText(fullText, 250, 50);
    const segIds: string[] = [];
    const segTexts: string[] = [];
    const segMetadatas: Record<string, any>[] = [];

    for (const seg of segments) {
      const segPath = `${sourcePath}/seg_${seg.index}`;
      const segId = `${conversationId}_seg_${seg.index}`;

      // Store segment in timeline FTS
      try {
        await addConversationToTimeline(
          root, segId, segPath, sessionTimestamp, undefined,
          fullTitle, seg.text, entityNames, topicNames
        );
      } catch {
        // Best-effort
      }

      segIds.push(segId);
      segTexts.push(seg.text);
      segMetadatas.push({
        type: 'conversation',
        source_path: segPath,
        title: fullTitle,
        timestamp: sessionTimestamp,
      });
    }

    // Embed all segments in one batch and add to ChromaDB
    if (segTexts.length > 0) {
      try {
        const segEmbeddings = await embed(segTexts);
        await chromaAdd(chromaCollectionId, segIds, segTexts, segEmbeddings, segMetadatas);
      } catch (err) {
        logger.warn('ChromaDB segment indexing failed', { error: String(err) });
      }
    }

    // ── Step 4: Entity graph ────────────────────────────────────────────
    try {
      const entityMap = new Map<string, number>();

      for (const entity of entities) {
        try {
          const dbEntity = await findOrCreateEntity(
            root, entity.name, entity.type as any, sessionTimestamp
          );
          entityMap.set(entity.name, dbEntity.id);
          await addEntityMention(
            root, dbEntity.id, conversationId, sourcePath,
            fullText.slice(0, 200), sessionTimestamp
          );
        } catch {
          // Best-effort
        }
      }

      for (const rel of relationships) {
        try {
          const sourceId = entityMap.get(rel.source.name);
          const targetId = entityMap.get(rel.target.name);
          if (sourceId && targetId && sourceId !== targetId) {
            await linkEntitiesWithType(root, sourceId, targetId, {
              relationship: rel.relationship as any,
              confidence: rel.confidence,
              rationale: rel.rationale,
            });
          }
        } catch {
          // Best-effort
        }
      }
    } catch {
      // Entity graph is best-effort
    }
  }

  return sessions.length;
}

/**
 * Build a human-readable transcript from conversation turns.
 */
function buildTranscript(
  turns: Turn[],
  speakerA: string,
  speakerB: string
): string {
  const lines: string[] = [];

  for (const turn of turns) {
    const speaker = turn.speaker || 'Unknown';
    let content = turn.text || '';

    // Include image descriptions as contextual information
    if (turn.blip_caption) {
      content += content
        ? ` [Image: ${turn.blip_caption}]`
        : `[Image: ${turn.blip_caption}]`;
    }

    if (content) {
      lines.push(`${speaker}: ${content}`);
    }
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1.5: OBSERVATION EXTRACTION (inline, no transitive chromadb import)
// ═══════════════════════════════════════════════════════════════════════════════

/**
/**
 * Create facts table + FTS5 in timeline.db (inline, no chromadb dependency).
 */
function ensureFactsTableInline(db: any): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_conversation_id TEXT,
        entities_json TEXT DEFAULT '[]',
        entity_ids_json TEXT DEFAULT '[]',
        timestamp TEXT NOT NULL,
        confidence REAL DEFAULT 0.7,
        category TEXT NOT NULL DEFAULT 'general',
        is_latest INTEGER DEFAULT 1,
        superseded_by INTEGER,
        supersedes INTEGER,
        expires_at TEXT,
        access_count INTEGER DEFAULT 0,
        last_accessed TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_facts_is_latest ON facts(is_latest);
      CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source_path);
      CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
      CREATE INDEX IF NOT EXISTS idx_facts_timestamp ON facts(timestamp DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
        content,
        entities,
        category,
        content=facts,
        content_rowid=id
      );

      CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
        INSERT INTO facts_fts(rowid, content, entities, category)
        VALUES (new.id, new.content, new.entities_json, new.category);
      END;

      CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, content, entities, category)
        VALUES ('delete', old.id, old.content, old.entities_json, old.category);
      END;

      CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, content, entities, category)
        VALUES ('delete', old.id, old.content, old.entities_json, old.category);
        INSERT INTO facts_fts(rowid, content, entities, category)
        VALUES (new.id, new.content, new.entities_json, new.category);
      END;
    `);
  } catch {
    // Already exists, ignore
  }
}

/**
 * Extract observations from ingested conversations and store them as
 * structured facts in the facts table + ChromaDB (via REST API).
 */
async function runObservations(
  root: string,
  chromaCollectionId: string
): Promise<number> {
  const timeline = await getTimelineDb(root);
  let observationsCreated = 0;

  // Ensure facts table exists
  ensureFactsTableInline(timeline);

  // Find conversation events that don't have observations/facts yet
  const unobserved = timeline.prepare(`
    SELECT te.id, te.source_path, te.title, te.summary, te.timestamp,
           te.entities_json, te.topics_json
    FROM timeline_events te
    WHERE te.type = 'conversation'
      AND te.summary IS NOT NULL
      AND LENGTH(te.summary) > 50
      AND NOT EXISTS (
        SELECT 1 FROM timeline_events obs
        WHERE obs.source_path LIKE 'observation://' || REPLACE(te.source_path, 'channel://', '') || '/%'
      )
      AND NOT EXISTS (
        SELECT 1 FROM facts f
        WHERE f.source_path LIKE 'fact://' || REPLACE(te.source_path, 'channel://', '') || '/%'
      )
    ORDER BY te.timestamp DESC
    LIMIT 100
  `).all() as Array<{
    id: number;
    source_path: string;
    title: string;
    summary: string;
    timestamp: string;
    entities_json: string | null;
    topics_json: string | null;
  }>;

  if (unobserved.length === 0) return 0;

  for (const event of unobserved) {
    try {
      const facts = await extractObservations(event.summary);
      if (facts.length === 0) continue;

      const parentId = event.source_path.replace('channel://', '');
      const obsIds: string[] = [];
      const obsTexts: string[] = [];
      const obsMetadatas: Record<string, any>[] = [];

      for (const [i, fact] of facts.entries()) {
        const factPath = `fact://${parentId}/${i}`;
        const obsId = `fact_${parentId.replace(/[^a-zA-Z0-9]/g, '_')}_${i}`;

        // Store in facts table
        try {
          timeline.prepare(`
            INSERT OR REPLACE INTO facts
            (content, source_path, source_conversation_id, entities_json, entity_ids_json,
             timestamp, confidence, category, is_latest)
            VALUES (?, ?, ?, ?, '[]', ?, 0.8, 'general', 1)
          `).run(
            fact,
            factPath,
            parentId,
            event.entities_json || '[]',
            event.timestamp
          );
        } catch {
          // Skip duplicates
        }

        // Also store in timeline FTS for backwards compat
        try {
          timeline.prepare(`
            INSERT OR REPLACE INTO timeline_events
            (type, timestamp, title, summary, source_path, entities_json, topics_json, priority, tier)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0.7, 'hot')
          `).run(
            'note',
            event.timestamp,
            `[observation] ${fact.slice(0, 97)}`,
            fact,
            `observation://${parentId}/${i}`,
            event.entities_json || '[]',
            event.topics_json || '[]'
          );
        } catch {
          // Skip duplicates
        }

        obsIds.push(obsId);
        obsTexts.push(fact);
        obsMetadatas.push({
          type: 'note',
          source_path: factPath,
          title: `[general] ${fact.slice(0, 80)}`,
          timestamp: event.timestamp,
        });

        observationsCreated++;
      }

      // Embed and add observations to ChromaDB in batch
      if (obsTexts.length > 0) {
        try {
          const obsEmbeddings = await embed(obsTexts);
          await chromaAdd(chromaCollectionId, obsIds, obsTexts, obsEmbeddings, obsMetadatas);
        } catch {
          // Embedding is best-effort
        }
      }
    } catch {
      // Per-event observation extraction is best-effort
    }
  }

  return observationsCreated;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2: QUERY (ChromaDB REST API + timeline FTS)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Answer a single QA item using ChromaDB semantic search + timeline FTS.
 */
async function answerQuestion(
  root: string,
  qa: QAItem,
  speakerA: string,
  speakerB: string,
  chromaCollectionId: string
): Promise<string> {
  const timeline = await getTimelineDb(root);
  ensureFactsTableInline(timeline);
  const factParts: string[] = [];
  const supportParts: string[] = [];
  const seenContent = new Set<string>();

  const stopwords = new Set(['the', 'and', 'for', 'was', 'are', 'what', 'who', 'how',
    'did', 'does', 'has', 'have', 'when', 'where', 'which', 'that', 'this', 'with']);
  const ftsQuery = qa.question
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopwords.has(w.toLowerCase()))
    .slice(0, 5)
    .join(' OR ');

  // ── Layer 1: Search facts (FTS + semantic) ──────────────────────────
  try {
    if (ftsQuery) {
      const ftsFactResults = timeline.prepare(`
        SELECT f.content, f.category, f.confidence, f.timestamp, f.entities_json
        FROM facts f
        WHERE f.id IN (SELECT rowid FROM facts_fts WHERE facts_fts MATCH ?)
        AND f.is_latest = 1
        AND (f.expires_at IS NULL OR f.expires_at > datetime('now'))
        ORDER BY f.confidence DESC
        LIMIT 15
      `).all(ftsQuery) as Array<{ content: string; category: string; confidence: number; timestamp: string }>;

      for (const f of ftsFactResults) {
        const key = f.content.slice(0, 80);
        if (!seenContent.has(key)) {
          seenContent.add(key);
          factParts.push(`- [${f.category}] ${f.content}`);
        }
      }
    }
  } catch { /* FTS best-effort */ }

  // Semantic search over ChromaDB
  try {
    const queryEmbeddings = await embed([qa.question]);
    const chromaResults = await chromaQuery(chromaCollectionId, queryEmbeddings[0], 20);

    if (chromaResults.documents?.[0]) {
      for (let i = 0; i < chromaResults.documents[0].length; i++) {
        const doc = chromaResults.documents[0][i];
        const meta = chromaResults.metadatas?.[0]?.[i] || {};
        const sourcePath = (meta.source_path as string) || '';
        const key = doc?.slice(0, 80) || '';
        if (!key || seenContent.has(key)) continue;
        seenContent.add(key);

        if (sourcePath.startsWith('fact://')) {
          const category = (meta.title as string)?.match(/^\[(\w+)\]/)?.[1] || 'general';
          factParts.push(`- [${category}] ${doc}`);
        } else {
          const ts = (meta.timestamp as string) || '';
          const dateLabel = ts ? new Date(ts).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
          supportParts.push(`[${dateLabel}] ${doc}`);
        }
      }
    }
  } catch { /* semantic best-effort */ }

  // ── Layer 2: Entity expansion ───────────────────────────────────────
  try {
    const entityDb = new Database(join(root, 'data', 'entity-graph.db'), { readonly: true });
    const queryLower = qa.question.toLowerCase();
    const allEntities = entityDb.prepare(
      'SELECT id, name FROM entities ORDER BY mention_count DESC LIMIT 100'
    ).all() as Array<{ id: number; name: string }>;

    const matched = allEntities.filter(e => e.name.length >= 3 && queryLower.includes(e.name.toLowerCase())).slice(0, 3);
    for (const entity of matched) {
      try {
        const entityFacts = timeline.prepare(`
          SELECT content, category FROM facts
          WHERE LOWER(entities_json) LIKE ? AND is_latest = 1
          AND (expires_at IS NULL OR expires_at > datetime('now'))
          ORDER BY confidence DESC LIMIT 10
        `).all(`%${entity.name.toLowerCase()}%`) as Array<{ content: string; category: string }>;

        for (const f of entityFacts) {
          const key = f.content.slice(0, 80);
          if (!seenContent.has(key)) {
            seenContent.add(key);
            factParts.push(`- [${f.category}] ${f.content}`);
          }
        }
      } catch { /* skip */ }
    }
    entityDb.close();
  } catch { /* entity expansion best-effort */ }

  // ── Layer 3: Supporting conversation context ────────────────────────
  try {
    if (ftsQuery && supportParts.length < 10) {
      const ftsResults = timeline.prepare(`
        SELECT te.summary, te.timestamp FROM timeline_events te
        WHERE te.id IN (SELECT rowid FROM timeline_fts WHERE timeline_fts MATCH ?)
        AND te.type = 'conversation'
        ORDER BY te.timestamp DESC LIMIT 10
      `).all(ftsQuery) as Array<{ summary: string; timestamp: string }>;

      for (const r of ftsResults) {
        const key = r.summary?.slice(0, 80) || '';
        if (key && !seenContent.has(key)) {
          seenContent.add(key);
          const dateLabel = r.timestamp ? new Date(r.timestamp).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
          supportParts.push(`[${dateLabel}] ${r.summary}`);
        }
      }
    }
  } catch { /* FTS best-effort */ }

  // ── Layer 4: Assemble context ───────────────────────────────────────
  let context = '';
  if (factParts.length > 0) context += '## Known Facts\n' + factParts.slice(0, 15).join('\n') + '\n\n';
  if (supportParts.length > 0) context += '## Supporting Context\n' + supportParts.slice(0, 10).join('\n---\n');
  if (!context) context = '(No relevant memories found)';

  const prompt = buildPrompt(qa, context, speakerA, speakerB);

  const client = getClaudeClient();
  const answer = await client.complete(prompt, {
    model: 'haiku',
    maxTokens: 100,
    maxTurns: 1,
  });

  return cleanAnswer(answer);
}

/**
 * Strip common LLM formatting artifacts and normalize numbers.
 */
function cleanAnswer(answer: string): string {
  let cleaned = answer
    .replace(/^#+\s*(Short\s+)?[Aa]nswer:?\s*/i, '')
    .replace(/^(Short\s+)?[Aa]nswer:?\s*/i, '')
    .replace(/\*\*/g, '')
    .replace(/^["']|["']$/g, '') // strip surrounding quotes
    .replace(/\s*\(.*?\)\s*$/g, '') // strip trailing parenthetical notes
    .replace(/\.\s*$/, '') // strip trailing period
    .trim();

  // Normalize number words to digits for F1 matching
  const numberWords: Record<string, string> = {
    once: '1',
    twice: '2',
    thrice: '3',
    one: '1',
    two: '2',
    three: '3',
    four: '4',
    five: '5',
    six: '6',
    seven: '7',
    eight: '8',
    nine: '9',
    ten: '10',
  };
  // Only replace standalone number words
  cleaned = cleaned.replace(
    /\b(once|twice|thrice|one|two|three|four|five|six|seven|eight|nine|ten)\b/gi,
    (match) => {
      return numberWords[match.toLowerCase()] || match;
    }
  );

  return cleaned;
}

/**
 * Build prompt for the QA item with retrieved context.
 */
function buildPrompt(
  qa: QAItem,
  context: string,
  speakerA: string,
  speakerB: string
): string {
  const preamble =
    `The following are excerpts from past conversations between ${speakerA} and ${speakerB}, ` +
    `retrieved from memory. The date of each excerpt is shown.\n\n` +
    context +
    '\n\n';

  switch (qa.category) {
    case 1: // Multi-hop
      return (
        preamble +
        'Based on the above context, write an answer in the form of a short phrase for the following question. ' +
        'Answer with exact words from the context whenever possible. ' +
        'If the question asks for a list, include ONLY items explicitly mentioned, separated by commas. ' +
        'Use digits for numbers (e.g., "2" not "two"). No explanations.\n\n' +
        `Question: ${qa.question}\nShort answer:`
      );

    case 2: // Temporal
      return (
        preamble +
        'Based on the above context, write an answer in the form of a short phrase for the following question. ' +
        'Use DATE of CONVERSATION to answer with an approximate date. ' +
        'IMPORTANT: When someone says "last year" in a 2023 conversation, the answer is 2022. ' +
        'When someone says "yesterday" in a session dated "15 May 2023", the answer involves 14 May 2023. ' +
        'Give just the date or time period, no explanation.\n\n' +
        `Question: ${qa.question}\nShort answer:`
      );

    case 3: // Open-domain
      return (
        preamble +
        'Based on the above context, write an answer in the form of a short phrase for the following question. ' +
        'If yes/no: start with "Yes" or "Likely no" then a brief reason. ' +
        'For traits/personality: list 2-4 adjectives. Keep answer under 10 words.\n\n' +
        `Question: ${qa.question}\nShort answer:`
      );

    case 4: // Single-hop
      return (
        preamble +
        'Based on the above context, write an answer in the form of a short phrase for the following question. ' +
        'Answer with exact words from the context whenever possible. ' +
        'Use digits for numbers. No explanations, just the answer.\n\n' +
        `Question: ${qa.question}\nShort answer:`
      );

    case 5: // Adversarial
      return (
        preamble +
        'Based on the above context, answer the following question.\n' +
        `IMPORTANT: The question asks about a SPECIFIC person. ${speakerA} and ${speakerB} are different people. ` +
        'If the information asked about belongs to the OTHER person or is not mentioned at all, ' +
        'answer with "Not mentioned in the conversation".\n\n' +
        `Question: ${qa.question}\nShort answer:`
      );

    default:
      return (
        preamble +
        'Based on the above context, write an answer in the form of a short phrase for the following question. ' +
        'Answer with exact words from the context whenever possible.\n\n' +
        `Question: ${qa.question}\nShort answer:`
      );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3: SCORING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the ground truth answer for a QA item.
 */
function getGroundTruth(qa: QAItem): string {
  if (qa.category === 5) {
    // Category 5 uses adversarial_answer as a distractor;
    // the correct behavior is to say "not mentioned"
    return 'not mentioned';
  }
  return String(qa.answer ?? '');
}

/**
 * Score a predicted answer against the ground truth, using category-specific logic.
 */
function scoreAnswer(
  prediction: string,
  groundTruth: string,
  category: number
): number {
  switch (category) {
    case 1: // Multi-hop: split by comma, partial F1 for each sub-answer, average
      return scoreMultiHop(prediction, groundTruth);
    case 2: // Temporal: straight F1
      return f1Score(prediction, groundTruth);
    case 3: // Open-domain: truncate at first semicolon, then F1
      return scoreOpenDomain(prediction, groundTruth);
    case 4: // Single-hop: straight F1
      return f1Score(prediction, groundTruth);
    case 5: // Adversarial: binary check
      return scoreAdversarial(prediction);
    default:
      return f1Score(prediction, groundTruth);
  }
}

/**
 * Category 1 (multi-hop): Split ground truth by comma, compute F1 for each
 * sub-answer against the full prediction, then average.
 */
function scoreMultiHop(prediction: string, groundTruth: string): number {
  const subAnswers = groundTruth
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (subAnswers.length === 0) return 0;

  const scores = subAnswers.map((sub) => f1Score(prediction, sub));
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/**
 * Category 3 (open-domain): Truncate ground truth at first semicolon, then F1.
 */
function scoreOpenDomain(prediction: string, groundTruth: string): number {
  const truncated = groundTruth.split(';')[0].trim();
  return f1Score(prediction, truncated);
}

/**
 * Category 5 (adversarial): Binary -- 1.0 if the prediction indicates
 * the information is not available.
 */
function scoreAdversarial(prediction: string): number {
  const lower = prediction.toLowerCase();
  if (
    lower.includes('not mentioned') ||
    lower.includes('no information available') ||
    lower.includes('not available') ||
    lower.includes('not found') ||
    lower.includes('no mention') ||
    lower.includes('not discussed') ||
    lower.includes('no relevant')
  ) {
    return 1.0;
  }
  return 0.0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// F1 SCORING UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalize an answer string for scoring: lowercase, remove punctuation,
 * remove articles, collapse whitespace.
 */
function normalizeAnswer(s: string): string {
  s = s.replace(/,/g, '');
  s = s.toLowerCase();
  s = s.replace(/[^\w\s]/g, '');
  s = s.replace(/\b(a|an|the|and)\b/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Compute token-level F1 between prediction and ground truth,
 * with Porter stemming applied to each token.
 */
function f1Score(prediction: string, groundTruth: string): number {
  const predTokens = normalizeAnswer(prediction)
    .split(' ')
    .filter(Boolean)
    .map(porterStem);
  const gtTokens = normalizeAnswer(groundTruth)
    .split(' ')
    .filter(Boolean)
    .map(porterStem);

  if (predTokens.length === 0 && gtTokens.length === 0) return 1.0;
  if (predTokens.length === 0 || gtTokens.length === 0) return 0.0;

  // Count common tokens (multiset intersection)
  const gtCounts = new Map<string, number>();
  for (const t of gtTokens) {
    gtCounts.set(t, (gtCounts.get(t) || 0) + 1);
  }

  let common = 0;
  const gtCountsCopy = new Map(gtCounts);
  for (const t of predTokens) {
    const count = gtCountsCopy.get(t) || 0;
    if (count > 0) {
      common++;
      gtCountsCopy.set(t, count - 1);
    }
  }

  if (common === 0) return 0.0;

  const precision = common / predTokens.length;
  const recall = common / gtTokens.length;

  return (2 * precision * recall) / (precision + recall);
}

/**
 * Simple Porter stemmer approximation.
 *
 * Handles common English suffixes for token matching purposes.
 * This is intentionally simple -- the LoCoMo benchmark only uses stemming
 * to normalize surface-level morphological variation for F1 computation.
 */
function porterStem(word: string): string {
  if (word.length <= 3) return word;

  let stem = word;

  // Step 1: Plurals and past participles
  if (stem.endsWith('sses')) {
    stem = stem.slice(0, -2);
  } else if (stem.endsWith('ies') && stem.length > 4) {
    stem = stem.slice(0, -2);
  } else if (stem.endsWith('ness')) {
    stem = stem.slice(0, -4);
  } else if (stem.endsWith('ment')) {
    stem = stem.slice(0, -4);
  } else if (stem.endsWith('tion')) {
    stem = stem.slice(0, -3);
  } else if (stem.endsWith('sion')) {
    stem = stem.slice(0, -3);
  } else if (stem.endsWith('ible')) {
    stem = stem.slice(0, -4);
  } else if (stem.endsWith('able')) {
    stem = stem.slice(0, -4);
  } else if (stem.endsWith('ing') && stem.length > 5) {
    stem = stem.slice(0, -3);
    // Handle doubling: running -> runn -> run
    if (
      stem.length >= 2 &&
      stem[stem.length - 1] === stem[stem.length - 2] &&
      'bdfgmnprst'.includes(stem[stem.length - 1])
    ) {
      stem = stem.slice(0, -1);
    }
  } else if (stem.endsWith('ed') && stem.length > 4) {
    stem = stem.slice(0, -2);
    // Handle doubling: stopped -> stopp -> stop
    if (
      stem.length >= 2 &&
      stem[stem.length - 1] === stem[stem.length - 2] &&
      'bdfgmnprst'.includes(stem[stem.length - 1])
    ) {
      stem = stem.slice(0, -1);
    }
  } else if (stem.endsWith('ly') && stem.length > 4) {
    stem = stem.slice(0, -2);
  } else if (stem.endsWith('es') && stem.length > 4) {
    stem = stem.slice(0, -2);
  } else if (stem.endsWith('s') && !stem.endsWith('ss') && stem.length > 3) {
    stem = stem.slice(0, -1);
  }

  return stem;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse LoCoMo datetime strings like "1:56 pm on 8 May, 2023" into ISO 8601.
 */
function parseLocomoDateTime(dt: string): string {
  // Format: "H:MM am/pm on D Month, YYYY"
  const match = dt.match(
    /(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+(\w+),?\s+(\d{4})/i
  );

  if (!match) {
    // Fallback: try as a general date
    const fallback = new Date(dt);
    if (!isNaN(fallback.getTime())) {
      return fallback.toISOString();
    }
    return new Date().toISOString();
  }

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const ampm = match[3].toLowerCase();
  const day = parseInt(match[4], 10);
  const monthStr = match[5];
  const year = parseInt(match[6], 10);

  // Convert 12-hour to 24-hour
  if (ampm === 'pm' && hours !== 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;

  const months: Record<string, number> = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
  };

  const month = months[monthStr.toLowerCase()];
  if (month === undefined) {
    return new Date().toISOString();
  }

  const date = new Date(year, month, day, hours, minutes, 0, 0);
  return date.toISOString();
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS FOR TESTING
// ═══════════════════════════════════════════════════════════════════════════════

export {
  normalizeAnswer as _normalizeAnswer,
  f1Score as _f1Score,
  porterStem as _porterStem,
  scoreAnswer as _scoreAnswer,
  parseLocomoDateTime as _parseLocomoDateTime,
  buildTranscript as _buildTranscript,
};
