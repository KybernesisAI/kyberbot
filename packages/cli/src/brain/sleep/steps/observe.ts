/**
 * KyberBot — Sleep Agent: Fact Extraction Step
 *
 * Extracts structured facts from conversations and stores them in the
 * facts table with category, confidence, and entity metadata. This
 * dramatically improves retrieval quality — searching for "Where is
 * Caroline from?" matches the fact "Caroline is originally from Sweden"
 * much better than it matches the raw conversation text.
 *
 * Runs between summarize and entity-hygiene steps.
 */

import { createLogger } from '../../../logger.js';
import { getTimelineDb } from '../../timeline.js';
import { getClaudeClient } from '../../../claude.js';
import { storeFact, ensureFactsTable, markFactSuperseded, getFactById, VALID_CATEGORIES, VALID_SPEAKER_IDS, VALID_SPEECH_TYPES, type FactInput, type FactCategory, type SpeakerId, type SpeechType } from '../../fact-store.js';
import { detectContradictions } from '../../fact-contradiction.js';
import { detectTemporalExpiry } from '../../fact-temporal.js';
import { createContradiction, getEntityGraphDb } from '../../entity-graph.js';
import type { SleepConfig } from '../config.js';

const logger = createLogger('sleep:observe');

export interface ObserveResult {
  count: number;
  processed: number;
  errors?: string[];
}

/** Shape of a single fact object returned by the LLM. */
interface ExtractedFact {
  content: string;
  category: string;
  confidence: number;
  entities: string[];
  speaker_id?: string;
  speech_type?: string;
}

const FACT_EXTRACTION_PROMPT = `Extract key facts from this conversation as a JSON array of objects.

The conversation is pre-labeled: "User:" lines are from the human or incoming agent, "Assistant:" lines are from this AI agent.

Each fact object has:
- "content": The fact statement (8-25 words, specific and verifiable)
- "category": One of: biographical, preference, event, relationship, temporal, opinion, plan, general
- "confidence": 0.7-0.95 (how confident you are this is accurate)
- "entities": Array of person/entity names mentioned in this fact
- "speaker_id": who said the thing this fact was extracted from — one of: user, agent, external_party, system
- "speech_type": what kind of utterance — one of: user_utterance, agent_utterance, quoted_external, reported_speech, hypothetical, acknowledgment, system_event

Attribution rules:
- Facts from "User:" lines → speaker_id: "user", speech_type: "user_utterance" (default)
- Facts from "Assistant:" lines → speaker_id: "agent", speech_type: "agent_utterance"
- If a fact comes from a paste, forward, or quote inside either turn → speaker_id: "external_party", speech_type: "quoted_external"
- Hypotheticals ("if X happened", "imagine if") → speech_type: "hypothetical"
- Do NOT extract facts from acknowledgment turns ("Thanks!", "Got it", "Sure") — emit speech_type: "acknowledgment" only if you must represent the turn, but skip extraction for those

Rules:
- Each fact must be SPECIFIC and verifiable — not vague
- Include the person's NAME in each fact (never use pronouns)
- Include dates, numbers, and proper nouns whenever mentioned
- Prefer: relationships, preferences, events, decisions, origins, occupations
- Skip: greetings, opinions about the conversation itself, meta-commentary
- 5-15 facts depending on conversation length

Example output:
[
  {"content": "Caroline moved from Sweden 4 years ago", "category": "biographical", "confidence": 0.9, "entities": ["Caroline"], "speaker_id": "user", "speech_type": "user_utterance"},
  {"content": "Melanie's daughter's birthday is August 13", "category": "event", "confidence": 0.85, "entities": ["Melanie"], "speaker_id": "user", "speech_type": "user_utterance"},
  {"content": "Caroline wants to pursue counseling as a career", "category": "plan", "confidence": 0.8, "entities": ["Caroline"], "speaker_id": "agent", "speech_type": "agent_utterance"}
]

Conversation:
`;

export async function runObserveStep(
  root: string,
  config: SleepConfig
): Promise<ObserveResult> {
  if (!config.enableFactExtraction) {
    return { count: 0, processed: 0 };
  }

  // Ensure the facts table exists before querying it
  await ensureFactsTable(root);

  const timeline = await getTimelineDb(root);
  let factsCreated = 0;
  let processed = 0;
  let contradictionChecks = 0;
  const errors: string[] = [];
  const maxPerRun = config.maxFactsPerRun || 20;
  const maxContradictionChecks = config.maxContradictionChecksPerRun || 30;

  try {
    // Find conversation events that don't have facts extracted yet.
    // Check both the old observation:// timeline events (backwards compat)
    // and the new facts table.
    const unprocessed = timeline.prepare(`
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
        AND NOT EXISTS (
          SELECT 1 FROM facts f
          WHERE f.source_path LIKE 'realtime://' || REPLACE(te.source_path, 'channel://', '') || '/%'
        )
      ORDER BY te.timestamp DESC
      LIMIT ?
    `).all(maxPerRun) as Array<{
      id: number;
      source_path: string;
      title: string;
      summary: string;
      timestamp: string;
      entities_json: string | null;
      topics_json: string | null;
    }>;

    if (unprocessed.length === 0) {
      logger.debug('No conversations need fact extraction');
      return { count: 0, processed: 0 };
    }

    const client = getClaudeClient();

    for (const event of unprocessed) {
      processed++;

      try {
        // Use summary (which contains the conversation text) for extraction
        const content = event.summary.slice(0, 4000);

        const response = await client.complete(
          FACT_EXTRACTION_PROMPT + content,
          {
            model: 'haiku',
            maxTokens: 1024,
            maxTurns: 1,
            subprocess: true,
            cwd: root,
          }
        );

        // Parse JSON array from response
        const jsonMatch = response.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
          logger.debug(`No JSON array found in fact extraction response for ${event.source_path}`);
          continue;
        }

        let rawFacts: ExtractedFact[];
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (!Array.isArray(parsed)) continue;
          rawFacts = parsed;
        } catch {
          logger.debug(`Failed to parse fact extraction JSON for ${event.source_path}`);
          continue;
        }

        // Validate and normalize each extracted fact
        const parentId = event.source_path.replace('channel://', '');
        const validFacts = validateFacts(rawFacts);

        for (const [i, fact] of validFacts.entries()) {
          // Skip acknowledgment turns — they carry no extractable facts
          if (fact.speech_type === 'acknowledgment') continue;

          // Validate speaker attribution — skip rather than write 'unknown' at runtime
          const speaker_id = VALID_SPEAKER_IDS.has(fact.speaker_id ?? '') ? fact.speaker_id as SpeakerId : null;
          const speech_type = VALID_SPEECH_TYPES.has(fact.speech_type ?? '') ? fact.speech_type as SpeechType : null;

          if (!speaker_id || speaker_id === 'unknown' || !speech_type || speech_type === 'unknown') {
            logger.warn('Skipping fact with unresolved speaker attribution', {
              content: fact.content.slice(0, 60),
              speaker_id: fact.speaker_id,
              speech_type: fact.speech_type,
            });
            continue;
          }

          const factInput: FactInput = {
            content: fact.content,
            source_path: `fact://${parentId}/${i}`,
            source_conversation_id: parentId,
            entities: fact.entities || [],
            timestamp: event.timestamp,
            confidence: Math.min(fact.confidence, 0.60), // AI-extracted facts capped at 0.60
            category: fact.category as FactCategory,
            speaker_id,
            speech_type,
            source_type: 'ai-extraction',
          };

          // Detect temporal expressions and set automatic expiry
          const temporal = detectTemporalExpiry(fact.content, event.timestamp);
          if (temporal.expires_at) {
            factInput.expires_at = temporal.expires_at;
          }

          try {
            const storedId = await storeFact(root, factInput);
            factsCreated++;

            // Check for contradictions with existing facts
            if (config.enableContradictionDetection && contradictionChecks < maxContradictionChecks) {
              try {
                const contradictionResult = await detectContradictions(root, {
                  content: factInput.content,
                  entities: factInput.entities,
                  category: factInput.category,
                });
                contradictionChecks++;

                for (const c of contradictionResult.contradictions) {
                  if (c.relationship === 'updates') {
                    // Check confidence gap — close confidence means we can't auto-resolve
                    const oldFact = await getFactById(root, c.oldFactId);
                    const confidenceGap = oldFact
                      ? Math.abs(factInput.confidence - oldFact.confidence)
                      : 1;

                    if (confidenceGap > 0.3 || !oldFact) {
                      // Large gap: auto-resolve (higher confidence wins)
                      await markFactSuperseded(root, c.oldFactId, storedId);
                      logger.debug(`Fact ${c.oldFactId} superseded by ${storedId}: ${c.rationale}`);
                    } else {
                      // Close confidence: create contradiction record, keep both
                      try {
                        // Find entity ID for the contradiction record
                        const entityDb = await getEntityGraphDb(root);
                        const entityName = (factInput.entities[0] || '').toLowerCase();
                        const entityRow = entityDb.prepare(
                          'SELECT id FROM entities WHERE LOWER(name) = ? OR LOWER(normalized_name) = ? LIMIT 1'
                        ).get(entityName, entityName) as { id: number } | undefined;

                        if (entityRow) {
                          await createContradiction(
                            root,
                            entityRow.id,
                            c.oldFactId,
                            storedId,
                            oldFact.content,
                            factInput.content,
                            c.rationale
                          );
                          logger.debug(`Contradiction recorded for entity ${entityName}: ${c.rationale}`);
                        }
                      } catch {
                        // Contradiction tracking is best-effort
                      }
                    }
                  }
                }
              } catch (err) {
                // Contradiction detection is non-fatal
                logger.debug(`Contradiction check failed for fact ${storedId}: ${err}`);
              }
            }
          } catch (err) {
            // Skip duplicates or storage errors for individual facts
            logger.debug(`Failed to store fact ${i} from ${event.source_path}: ${err}`);
          }
        }

        logger.debug(`Extracted ${validFacts.length} facts from ${event.source_path}`);
      } catch (err) {
        errors.push(`Failed to extract facts from ${event.source_path}: ${err}`);
      }
    }

    if (factsCreated > 0) {
      logger.info('Fact extraction complete', { facts: factsCreated, conversations: processed });
    }
  } catch (err) {
    errors.push(`Observe step failed: ${err}`);
  }

  return { count: factsCreated, processed, errors: errors.length > 0 ? errors : undefined };
}

/**
 * Validate and normalize extracted facts from the LLM response.
 *
 * Filters out facts that are too short/long, clamps confidence to a valid
 * range, defaults invalid categories, and warns on empty entities.
 */
function validateFacts(rawFacts: unknown[]): ExtractedFact[] {
  const validated: ExtractedFact[] = [];

  for (const raw of rawFacts) {
    if (!raw || typeof raw !== 'object') continue;

    const fact = raw as Record<string, unknown>;

    // Content must be a string
    if (typeof fact.content !== 'string') continue;

    const content = fact.content.trim();

    // Filter: content length must be 10-200 chars
    if (content.length < 10 || content.length > 200) continue;

    // Normalize category: default to 'general' if missing or invalid
    let category = 'general';
    if (typeof fact.category === 'string' && VALID_CATEGORIES.has(fact.category)) {
      category = fact.category;
    }

    // Normalize confidence: clamp to 0.5-1.0 range, default to 0.7
    let confidence = 0.7;
    if (typeof fact.confidence === 'number' && isFinite(fact.confidence)) {
      if (fact.confidence < 0.5 || fact.confidence > 1.0) {
        confidence = 0.7;
      } else {
        confidence = fact.confidence;
      }
    }

    // Normalize entities: must be an array of strings
    let entities: string[] = [];
    if (Array.isArray(fact.entities)) {
      entities = fact.entities.filter((e): e is string => typeof e === 'string' && e.length > 0);
    }

    if (entities.length === 0) {
      logger.debug(`Fact has no entities: "${content.slice(0, 60)}"`);
    }

    // Forward speaker attribution fields — required for the attribution guard
    // downstream. If absent here the guard will skip the fact entirely.
    const speaker_id = typeof fact.speaker_id === 'string' ? fact.speaker_id : undefined;
    const speech_type = typeof fact.speech_type === 'string' ? fact.speech_type : undefined;

    validated.push({ content, category, confidence, entities, speaker_id, speech_type });
  }

  return validated;
}
