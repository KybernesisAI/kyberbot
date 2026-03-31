/**
 * KyberBot — Real-Time Fact Extraction
 *
 * Lightweight inline fact extraction that runs immediately after a
 * conversation is stored, so facts are available right away instead
 * of waiting for the next sleep cycle.
 *
 * Uses Claude Haiku for cheap, fast extraction — capped at 3 facts
 * per conversation to keep latency low.
 */

import { getClaudeClient } from '../claude.js';
import { storeFact, ensureFactsTable, getFactById, type FactInput, type FactCategory, VALID_CATEGORIES } from './fact-store.js';
import { detectContradictions } from './fact-contradiction.js';
import { markFactSuperseded } from './fact-store.js';
import { detectTemporalExpiry } from './fact-temporal.js';
import { createContradiction, getEntityGraphDb } from './entity-graph.js';
import { createLogger } from '../logger.js';
import { SOURCE_CONFIDENCE } from './store-conversation.js';

const logger = createLogger('fact-extractor');

const REALTIME_FACT_PROMPT = `Extract 1-3 concrete facts about specific people, companies, or projects from this conversation. Only clear, verifiable facts — skip vague observations, greetings, and meta-commentary.

Each fact object has:
- "content": The fact statement (8-25 words, include names not pronouns)
- "category": One of: biographical, preference, event, relationship, temporal, opinion, plan, general
- "confidence": 0.5-0.9 (how confident you are)
- "entities": Array of person/entity names

Return a JSON array, or [] if no concrete facts.

Conversation:
`;

/**
 * Extract facts from a conversation in real-time (best-effort).
 * Called after entity graph storage in storeConversation().
 * Never throws — all errors are caught and logged.
 */
export async function extractFactsRealtime(
  root: string,
  text: string,
  entities: string[],
  sourcePath: string,
  conversationId: string,
  timestamp: string,
  sourceType: string = 'chat'
): Promise<number> {
  // Guard: skip short conversations or those with no entities
  if (text.length < 50 || entities.length === 0) {
    return 0;
  }

  await ensureFactsTable(root);

  let factsCreated = 0;

  try {
    const client = getClaudeClient();
    const content = text.slice(0, 2000); // Cap input to keep Haiku fast

    const response = await client.complete(
      REALTIME_FACT_PROMPT + content,
      {
        model: 'haiku',
        maxTokens: 256,
        maxTurns: 1,
        subprocess: true,
      }
    );

    // Parse JSON array from response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return 0;

    let rawFacts: Array<{
      content: string;
      category: string;
      confidence: number;
      entities: string[];
    }>;

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return 0;
      rawFacts = parsed;
    } catch {
      return 0;
    }

    // Validate and store up to 3 facts
    const parentId = sourcePath.replace('channel://', '');
    const maxConfidence = SOURCE_CONFIDENCE[sourceType] ?? 0.85;

    for (const [i, fact] of rawFacts.slice(0, 3).entries()) {
      // Validate
      if (!fact.content || fact.content.length < 10 || fact.content.length > 200) continue;
      if (!fact.entities || fact.entities.length === 0) continue;
      const category = VALID_CATEGORIES.has(fact.category) ? fact.category : 'general';
      // Cap confidence: AI-extracted facts shouldn't exceed source confidence
      const confidence = Math.min(fact.confidence || 0.6, maxConfidence, 0.60);

      const factInput: FactInput = {
        content: fact.content,
        source_path: `realtime://${parentId}/${i}`,
        source_conversation_id: parentId,
        entities: fact.entities,
        timestamp,
        confidence,
        category: category as FactCategory,
        source_type: 'ai-extraction',
      };

      // Detect temporal expressions and set automatic expiry
      const temporal = detectTemporalExpiry(fact.content, timestamp);
      if (temporal.expires_at) {
        factInput.expires_at = temporal.expires_at;
      }

      try {
        const storedId = await storeFact(root, factInput);
        factsCreated++;

        // Check for contradictions with existing facts
        try {
          const contradictions = await detectContradictions(root, {
            content: fact.content,
            entities: fact.entities,
            category,
          });

          for (const c of contradictions.contradictions) {
            if (c.relationship === 'updates') {
              const oldFact = await getFactById(root, c.oldFactId);
              const confidenceGap = oldFact
                ? Math.abs(confidence - oldFact.confidence)
                : 1;

              if (confidenceGap > 0.3 || !oldFact) {
                await markFactSuperseded(root, c.oldFactId, storedId);
              } else {
                // Close confidence — record as contradiction
                try {
                  const entityDb = await getEntityGraphDb(root);
                  const entityName = (fact.entities[0] || '').toLowerCase();
                  const entityRow = entityDb.prepare(
                    'SELECT id FROM entities WHERE LOWER(name) = ? OR LOWER(normalized_name) = ? LIMIT 1'
                  ).get(entityName, entityName) as { id: number } | undefined;
                  if (entityRow) {
                    await createContradiction(root, entityRow.id, c.oldFactId, storedId, oldFact.content, fact.content, c.rationale);
                  }
                } catch { /* best-effort */ }
              }
            }
          }
        } catch {
          // Contradiction detection is best-effort
        }
      } catch {
        // Individual fact storage is best-effort
      }
    }

    if (factsCreated > 0) {
      logger.debug('Real-time facts extracted', {
        conversationId,
        factsCreated,
        sourceType,
      });
    }
  } catch (err) {
    logger.debug('Real-time fact extraction skipped', { error: String(err) });
  }

  return factsCreated;
}
