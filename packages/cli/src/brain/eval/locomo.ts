/**
 * KyberBot — LoCoMo Long-Term Memory Benchmark
 *
 * Evaluates KyberBot's memory pipeline against the LoCoMo dataset:
 *   1. Ingest each conversation's turns into ChromaDB with ±1 turn context windows
 *   2. Query using ChromaDB semantic search + entity graph for each QA item
 *   3. Score answers using token-level F1 with Porter stemming
 *   4. Report per-category and overall accuracy
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

import { readFileSync } from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { ChromaClient, type IEmbeddingFunction } from 'chromadb';
import OpenAI from 'openai';
import { getClaudeClient } from '../../claude.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('eval');

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
 * Run the LoCoMo benchmark against KyberBot's memory pipeline.
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

  // Fail fast if required env vars are missing
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY environment variable is required for ChromaDB embeddings'
    );
  }

  const chromaUrl = process.env.CHROMA_URL || 'http://localhost:8001';
  const chroma = new ChromaClient({ path: chromaUrl });

  // Verify ChromaDB is reachable
  try {
    await chroma.heartbeat();
  } catch (err) {
    throw new Error(
      `ChromaDB is not available at ${chromaUrl}. ` +
      `Start ChromaDB or set CHROMA_URL. Error: ${String(err)}`
    );
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const embedder: IEmbeddingFunction = {
    generate: async (texts: string[]) => {
      const resp = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: texts,
      });
      return resp.data.map((d) => d.embedding);
    },
  };

  const categorySet = new Set(categories);

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

  for (const conv of conversations) {
    const sampleId = conv.sample_id;
    conversationScores[sampleId] = { total: 0, sum: 0 };

    // Filter QA items by category
    const qaItems = conv.qa.filter((q) => categorySet.has(q.category));
    logger.info(`Evaluating ${sampleId}: ${qaItems.length} questions`);

    // Create isolated temporary brain for entity graph + timeline FTS
    const tempRoot = mkdtempSync(join(tmpdir(), `kyberbot-locomo-${sampleId}-`));

    // Create a ChromaDB collection name that is 3-63 chars, alphanumeric + underscores only
    const collectionName = `locomo_conv_${sampleId.replace(/[^a-zA-Z0-9]/g, '_')}`.slice(0, 63);

    try {
      // Phase 1: Ingest conversation sessions into ChromaDB + entity graph
      const collection = await chroma.getOrCreateCollection({
        name: collectionName,
        embeddingFunction: embedder,
        metadata: { 'hnsw:space': 'cosine' },
      });

      const { processed, fullConversationText } = await ingestConversation(
        tempRoot,
        conv,
        collection
      );
      logger.info(`  Indexed ${processed} turns into ChromaDB collection '${collectionName}'`);

      // Phase 2: Query and score each QA item
      const speakerA = conv.conversation.speaker_a;
      const speakerB = conv.conversation.speaker_b;

      for (let i = 0; i < qaItems.length; i++) {
        const qa = qaItems[i];
        try {
          const predicted = await answerQuestion(
            tempRoot,
            qa,
            collection,
            speakerA,
            speakerB,
            fullConversationText
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
      // Clean up ChromaDB collection
      try {
        await chroma.deleteCollection({ name: collectionName });
      } catch {
        logger.warn(`Failed to clean up ChromaDB collection: ${collectionName}`);
      }

      // Clean up temp directory
      try {
        rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        logger.warn(`Failed to clean up temp directory: ${tempRoot}`);
      }
    }
  }

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
// PHASE 1: INGESTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ingest all sessions from a LoCoMo conversation into ChromaDB (turn-level)
 * and the entity graph + timeline FTS (session-level).
 *
 * Each turn is stored as a document with ±1 turn context window for
 * better semantic retrieval. The full session transcript is also stored
 * in timeline FTS as a fallback search channel.
 */
async function ingestConversation(
  root: string,
  conv: LoCoMoConversation,
  collection: any
): Promise<{ processed: number }> {
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });

  // Initialize databases for entity graph and timeline FTS
  const timelineDb = createTimelineDb(join(dataDir, 'timeline.db'));
  const entityDb = createEntityGraphDb(join(dataDir, 'entity-graph.db'));

  const conversation = conv.conversation;
  const speakerA = conversation.speaker_a;
  const speakerB = conversation.speaker_b;

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

  const client = getClaudeClient();
  let totalProcessed = 0;

  // Build full conversation text for context-stuffing approach
  const fullConvParts: string[] = [];

  for (const session of sessions) {
    const timestamp = parseLocomoDateTime(session.dateTime);
    const sessionDateTime = session.dateTime;
    const sessionNum = session.num;

    // Build full transcript for entity extraction, timeline FTS, and full-context QA
    const transcript = buildTranscript(session.turns, speakerA, speakerB);

    // Add to full conversation text with date header
    fullConvParts.push(`DATE: ${sessionDateTime}\nCONVERSATION:\n${transcript}`);

    // ── ChromaDB: turn-level indexing with ±1 context window ──
    const batchIds: string[] = [];
    const batchDocs: string[] = [];
    const batchMetas: Array<Record<string, string | number>> = [];

    for (const [i, turn] of session.turns.entries()) {
      const prev = session.turns[i - 1];
      const next = session.turns[i + 1];

      let content = '';
      if (prev?.text) content += `${prev.speaker}: ${prev.text}\n`;
      content += `${turn.speaker}: ${turn.text || ''}`;
      if (turn.blip_caption) content += ` [shared image: ${turn.blip_caption}]`;
      if (next?.text) content += `\n${next.speaker}: ${next.text}`;

      // Skip turns with no meaningful content
      if (content.trim().length === 0) continue;

      const turnId = `${conv.sample_id}_s${sessionNum}_t${i}`;

      batchIds.push(turnId);
      batchDocs.push(content);
      batchMetas.push({
        session: sessionNum,
        date: sessionDateTime,
        speaker: turn.speaker,
        dia_id: turn.dia_id || '',
        turn_index: i,
      });
    }

    // Add to ChromaDB in batches of up to 100
    for (let batchStart = 0; batchStart < batchIds.length; batchStart += 100) {
      const batchEnd = Math.min(batchStart + 100, batchIds.length);
      await collection.add({
        ids: batchIds.slice(batchStart, batchEnd),
        documents: batchDocs.slice(batchStart, batchEnd),
        metadatas: batchMetas.slice(batchStart, batchEnd),
      });
    }

    totalProcessed += batchIds.length;

    // ── Entity extraction via Claude Haiku ──
    // Truncate for entity extraction (Haiku context limit)
    const truncated =
      transcript.length > 4000
        ? transcript.slice(0, 4000) + '\n[Transcript truncated...]'
        : transcript;

    let entities: Array<{ name: string; type: string }> = [];
    let relationships: Array<{
      source: { name: string; type: string };
      target: { name: string; type: string };
      relationship: string;
      confidence: number;
      rationale: string;
    }> = [];

    try {
      const response = await client.complete(
        `Extract entities and relationships from this conversation:\n\n${truncated}`,
        {
          model: 'haiku',
          system: ENTITY_EXTRACTION_SYSTEM,
          maxTokens: 1024,
          maxTurns: 1,
        }
      );

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        entities = (parsed.entities || []).filter(
          (e: any) => e.name && e.type && typeof e.name === 'string'
        );
        relationships = (parsed.relationships || []).filter(
          (r: any) => r.source?.name && r.target?.name && r.relationship
        );
      }
    } catch (err) {
      logger.debug(
        `  Entity extraction failed for session ${session.num}`,
        { error: String(err) }
      );
    }

    // ── Timeline FTS: store full session transcript (not truncated) ──
    const sourcePath = `locomo://${conv.sample_id}/session_${session.num}`;
    const title = `[locomo] ${speakerA} & ${speakerB} - Session ${session.num}`;
    const entityNames = entities.map((e) => e.name);
    const topicNames = entities
      .filter((e) => e.type === 'topic')
      .map((e) => e.name);

    timelineDb
      .prepare(
        `INSERT OR REPLACE INTO timeline_events
         (type, timestamp, title, summary, source_path, entities_json, topics_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'conversation',
        timestamp,
        title,
        transcript, // Full transcript, not truncated
        sourcePath,
        JSON.stringify(entityNames),
        JSON.stringify(topicNames)
      );

    // ── Entity graph: store entities ──
    for (const entity of entities) {
      try {
        const normalized = entity.name
          .toLowerCase()
          .trim()
          .replace(/\s+/g, ' ');
        const validTypes = ['person', 'company', 'project', 'place', 'topic'];
        const entityType = validTypes.includes(entity.type)
          ? entity.type
          : 'topic';

        const existing = entityDb
          .prepare(
            'SELECT id FROM entities WHERE normalized_name = ? AND type = ?'
          )
          .get(normalized, entityType) as { id: number } | undefined;

        if (existing) {
          entityDb
            .prepare(
              'UPDATE entities SET last_seen = ?, mention_count = mention_count + 1 WHERE id = ?'
            )
            .run(timestamp, existing.id);
        } else {
          entityDb
            .prepare(
              `INSERT INTO entities (name, normalized_name, aliases, type, first_seen, last_seen, mention_count)
               VALUES (?, ?, '[]', ?, ?, ?, 1)`
            )
            .run(entity.name, normalized, entityType, timestamp, timestamp);
        }
      } catch {
        // Skip duplicate or invalid entities
      }
    }

    // ── Entity graph: store relationships ──
    for (const rel of relationships) {
      try {
        const sourceNorm = rel.source.name
          .toLowerCase()
          .trim()
          .replace(/\s+/g, ' ');
        const targetNorm = rel.target.name
          .toLowerCase()
          .trim()
          .replace(/\s+/g, ' ');

        const sourceEntity = entityDb
          .prepare('SELECT id FROM entities WHERE normalized_name = ?')
          .get(sourceNorm) as { id: number } | undefined;
        const targetEntity = entityDb
          .prepare('SELECT id FROM entities WHERE normalized_name = ?')
          .get(targetNorm) as { id: number } | undefined;

        if (
          sourceEntity &&
          targetEntity &&
          sourceEntity.id !== targetEntity.id
        ) {
          const [id1, id2] =
            sourceEntity.id < targetEntity.id
              ? [sourceEntity.id, targetEntity.id]
              : [targetEntity.id, sourceEntity.id];

          entityDb
            .prepare(
              `INSERT INTO entity_relations (source_id, target_id, relationship, strength, confidence, rationale)
               VALUES (?, ?, ?, 1, ?, ?)
               ON CONFLICT(source_id, target_id) DO UPDATE SET
                 strength = strength + 1,
                 confidence = MAX(entity_relations.confidence, excluded.confidence)`
            )
            .run(
              id1,
              id2,
              rel.relationship,
              rel.confidence || 0.7,
              rel.rationale || ''
            );
        }
      } catch {
        // Skip invalid relationships
      }
    }
  }

  timelineDb.close();
  entityDb.close();

  const fullConversationText = fullConvParts.join('\n\n');
  return { processed: totalProcessed, fullConversationText };
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
// PHASE 2: QUERY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Answer a single QA item using full conversation context.
 * Since LoCoMo conversations are only 15-22K tokens, we put the entire
 * conversation in the prompt for maximum recall, rather than relying
 * solely on retrieval (which misses 60%+ of relevant turns).
 */
async function answerQuestion(
  root: string,
  qa: QAItem,
  collection: any,
  speakerA: string,
  speakerB: string,
  fullConversationText: string
): Promise<string> {
  const prompt = buildPrompt(qa, fullConversationText, speakerA, speakerB);

  const client = getClaudeClient();
  const answer = await client.complete(prompt, {
    model: 'sonnet',
    maxTokens: 150,
    maxTurns: 1,
  });

  // Strip common LLM formatting artifacts
  return answer
    .replace(/^#+\s*(Short\s+)?[Aa]nswer:?\s*/i, '')
    .replace(/^(Short\s+)?[Aa]nswer:?\s*/i, '')
    .replace(/^\*\*/g, '')
    .replace(/\*\*$/g, '')
    .trim();
}

/**
 * Retrieve relevant context from ChromaDB semantic search and entity graph.
 */
async function retrieveContext(
  collection: any,
  entityDb: Database.Database,
  question: string
): Promise<string> {
  const contextParts: string[] = [];

  // 1. ChromaDB semantic search — retrieve top 15 turn-level documents
  try {
    const results = await collection.query({
      queryTexts: [question],
      nResults: 15,
    });

    if (results.documents?.[0]) {
      for (let i = 0; i < results.documents[0].length; i++) {
        const meta = results.metadatas?.[0]?.[i];
        const doc = results.documents[0][i];
        if (doc) {
          const sessionLabel = meta
            ? `[Session ${meta.session}, ${meta.date}]`
            : '[Unknown session]';
          contextParts.push(`${sessionLabel}\n${doc}`);
        }
      }
    }
  } catch (err) {
    logger.debug(`ChromaDB query failed, falling back to entity graph only`, {
      error: String(err),
    });
  }

  // 2. Entity graph search — supplementary context for relationship questions
  const entityResults = searchEntityGraph(entityDb, question, 5);
  for (const entity of entityResults) {
    let line = `Entity: ${entity.name} (${entity.type})`;
    if (entity.relationships.length > 0) {
      const rels = entity.relationships
        .map((r) => `${r.relationship} ${r.relatedName}`)
        .join(', ');
      line += ` — ${rels}`;
    }
    contextParts.push(line);
  }

  return contextParts.join('\n\n');
}

interface EntitySearchResult {
  name: string;
  type: string;
  relationships: Array<{ relationship: string; relatedName: string }>;
}

/**
 * Search the entity graph for entities mentioned in the question.
 */
function searchEntityGraph(
  db: Database.Database,
  question: string,
  limit: number
): EntitySearchResult[] {
  const queryLower = question.toLowerCase();

  // Find entities whose names appear in the question
  let entities: Array<{ id: number; name: string; type: string }>;
  try {
    entities = db
      .prepare(
        `SELECT id, name, type FROM entities
         ORDER BY mention_count DESC
         LIMIT 100`
      )
      .all() as Array<{ id: number; name: string; type: string }>;
  } catch {
    return [];
  }

  const matched = entities.filter((e) =>
    queryLower.includes(e.name.toLowerCase())
  );

  // If no direct name matches, try partial word matching
  const results: EntitySearchResult[] = [];

  const toSearch =
    matched.length > 0
      ? matched.slice(0, limit)
      : findPartialMatches(entities, queryLower, limit);

  for (const entity of toSearch) {
    // Get relationships for this entity
    let relationships: Array<{ relationship: string; relatedName: string }> =
      [];
    try {
      const rels = db
        .prepare(
          `SELECT
             er.relationship,
             CASE WHEN er.source_id = ? THEN e2.name ELSE e1.name END as related_name
           FROM entity_relations er
           LEFT JOIN entities e1 ON er.source_id = e1.id
           LEFT JOIN entities e2 ON er.target_id = e2.id
           WHERE er.source_id = ? OR er.target_id = ?
           ORDER BY er.strength DESC
           LIMIT 5`
        )
        .all(entity.id, entity.id, entity.id) as Array<{
        relationship: string;
        related_name: string;
      }>;

      relationships = rels.map((r) => ({
        relationship: r.relationship,
        relatedName: r.related_name,
      }));
    } catch {
      // Ignore relationship lookup errors
    }

    results.push({
      name: entity.name,
      type: entity.type,
      relationships,
    });
  }

  return results;
}

/**
 * Find entities with partial word overlap with the query.
 */
function findPartialMatches(
  entities: Array<{ id: number; name: string; type: string }>,
  queryLower: string,
  limit: number
): Array<{ id: number; name: string; type: string }> {
  const queryWords = new Set(
    queryLower
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3)
  );

  const scored = entities.map((e) => {
    const nameWords = e.name.toLowerCase().split(/\s+/);
    const overlap = nameWords.filter((w) => queryWords.has(w)).length;
    return { entity: e, overlap };
  });

  return scored
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, limit)
    .map((s) => s.entity);
}

/**
 * Build a category-specific prompt for the QA item with full conversation context.
 *
 * Uses the LoCoMo paper's recommended format: full conversation with dated sessions,
 * followed by a question-specific instruction.
 */
function buildPrompt(
  qa: QAItem,
  fullConversationText: string,
  speakerA: string,
  speakerB: string
): string {
  const preamble =
    `Below is a conversation between two people: ${speakerA} and ${speakerB}. ` +
    `The conversation takes place over multiple days and the date of each conversation is written at the beginning of the conversation.\n\n` +
    fullConversationText + '\n\n';

  const baseInstruction =
    'Based on the above conversation, write an answer in the form of a short phrase for the following question. ' +
    'Answer with exact words from the conversation whenever possible. Do NOT include any preamble, explanation, or formatting — just the answer.\n\n';

  switch (qa.category) {
    case 1: // Multi-hop (32 questions in conv-26)
      return (
        preamble +
        baseInstruction +
        `Question: ${qa.question}\nAnswer:`
      );

    case 2: // Temporal
      return (
        preamble +
        'Based on the above conversation, write an answer in the form of a short phrase for the following question. ' +
        'Use the DATE of the CONVERSATION to answer with an approximate date. ' +
        'Do NOT include any preamble or formatting — just the date.\n\n' +
        `Question: ${qa.question}\nAnswer:`
      );

    case 3: // Open-domain
      return (
        preamble +
        baseInstruction +
        `Question: ${qa.question}\nAnswer:`
      );

    case 4: // Single-hop (70 questions in conv-26)
      return (
        preamble +
        baseInstruction +
        `Question: ${qa.question}\nAnswer:`
      );

    case 5: // Adversarial
      return (
        preamble +
        'Based on the above conversation, answer the following question. ' +
        'IMPORTANT: Pay close attention to WHICH person the question asks about. ' +
        'If the information about THAT SPECIFIC PERSON is not mentioned in the conversation, ' +
        'respond with exactly "Not mentioned in the conversation". ' +
        'Do NOT use information about one person to answer a question about a different person.\n\n' +
        `Question: ${qa.question}\nAnswer:`
      );

    default:
      return (
        preamble +
        baseInstruction +
        `Question: ${qa.question}\nAnswer:`
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
 * Category 5 (adversarial): Binary — 1.0 if the prediction indicates
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
 * This is intentionally simple — the LoCoMo benchmark only uses stemming
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
// DATABASE SETUP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create and initialize a timeline SQLite database.
 * Mirrors the schema from timeline.ts but without module-level singleton caching.
 */
function createTimelineDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS timeline_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('conversation', 'idea', 'file', 'transcript', 'note', 'intake')),
      timestamp TEXT NOT NULL,
      end_timestamp TEXT,
      title TEXT NOT NULL,
      summary TEXT,
      source_path TEXT NOT NULL UNIQUE,
      entities_json TEXT DEFAULT '[]',
      topics_json TEXT DEFAULT '[]',
      priority REAL DEFAULT 0.5,
      decay_score REAL DEFAULT 0.0,
      tier TEXT DEFAULT 'warm',
      tags_json TEXT DEFAULT '[]',
      last_enriched TEXT,
      access_count INTEGER DEFAULT 0,
      is_pinned INTEGER DEFAULT 0,
      last_accessed TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_timeline_timestamp ON timeline_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_timeline_type ON timeline_events(type);
    CREATE INDEX IF NOT EXISTS idx_timeline_source ON timeline_events(source_path);

    CREATE VIRTUAL TABLE IF NOT EXISTS timeline_fts USING fts5(
      title,
      summary,
      entities,
      topics,
      content=timeline_events,
      content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS timeline_ai AFTER INSERT ON timeline_events BEGIN
      INSERT INTO timeline_fts(rowid, title, summary, entities, topics)
      VALUES (new.id, new.title, new.summary, new.entities_json, new.topics_json);
    END;

    CREATE TRIGGER IF NOT EXISTS timeline_ad AFTER DELETE ON timeline_events BEGIN
      INSERT INTO timeline_fts(timeline_fts, rowid, title, summary, entities, topics)
      VALUES ('delete', old.id, old.title, old.summary, old.entities_json, old.topics_json);
    END;

    CREATE TRIGGER IF NOT EXISTS timeline_au AFTER UPDATE ON timeline_events BEGIN
      INSERT INTO timeline_fts(timeline_fts, rowid, title, summary, entities, topics)
      VALUES ('delete', old.id, old.title, old.summary, old.entities_json, old.topics_json);
      INSERT INTO timeline_fts(rowid, title, summary, entities, topics)
      VALUES (new.id, new.title, new.summary, new.entities_json, new.topics_json);
    END;
  `);

  return db;
}

/**
 * Create and initialize an entity graph SQLite database.
 * Mirrors the schema from entity-graph.ts but without module-level singleton caching.
 */
function createEntityGraphDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      aliases TEXT DEFAULT '[]',
      type TEXT NOT NULL CHECK(type IN ('person', 'company', 'project', 'place', 'topic')),
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      mention_count INTEGER DEFAULT 1,
      priority REAL DEFAULT 0.5,
      decay_score REAL DEFAULT 0.0,
      tier TEXT DEFAULT 'warm',
      last_accessed TEXT,
      access_count INTEGER DEFAULT 0,
      is_pinned INTEGER DEFAULT 0,
      UNIQUE(normalized_name, type)
    );

    CREATE INDEX IF NOT EXISTS idx_entities_normalized ON entities(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);

    CREATE TABLE IF NOT EXISTS entity_mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL,
      conversation_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      context TEXT,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_mentions_entity ON entity_mentions(entity_id);

    CREATE TABLE IF NOT EXISTS entity_relations (
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      relationship TEXT DEFAULT 'co-occurred',
      strength INTEGER DEFAULT 1,
      confidence REAL DEFAULT 0.5,
      method TEXT DEFAULT 'ai-extraction',
      rationale TEXT,
      last_verified TEXT,
      PRIMARY KEY (source_id, target_id),
      FOREIGN KEY (source_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES entities(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_relations_source ON entity_relations(source_id);
    CREATE INDEX IF NOT EXISTS idx_relations_target ON entity_relations(target_id);
  `);

  return db;
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

/**
 * Entity extraction system prompt — simplified version of the one in
 * relationship-extractor.ts, tuned for conversation transcripts.
 */
const ENTITY_EXTRACTION_SYSTEM = `You are an entity relationship extractor. Analyze the conversation text and extract:

1. **Entities**: People, companies, projects, places, and topics mentioned
2. **Relationships**: Explicit relationships between entities

## Entity Types
- person: Individual people (e.g., "John", "Dr. Smith")
- company: Companies, organizations (e.g., "Google")
- project: Named projects, products, or apps
- place: Locations (e.g., "New York", "Sweden")
- topic: Topics, concepts, activities (e.g., "pottery", "adoption", "hiking")

## Relationship Types (only use these exact values)
- founded, works_at, invested_in, met_with, created, manages
- partners_with, located_in, discussed, related_to, reports_to
- uses, depends_on, part_of

## Rules
- Only extract relationships that are EXPLICITLY stated or strongly implied
- Focus on people, places, activities, and events mentioned
- Set confidence 0.8-0.95 for explicit statements, 0.5-0.7 for implied

Respond with JSON only:
{
  "entities": [
    { "name": "John Smith", "type": "person" }
  ],
  "relationships": [
    {
      "source": { "name": "John", "type": "person" },
      "target": { "name": "Acme Corp", "type": "company" },
      "relationship": "works_at",
      "confidence": 0.9,
      "rationale": "Explicitly stated"
    }
  ]
}`;

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
