/**
 * KyberBot — Sleep Agent: Observation Extraction Step
 *
 * Extracts structured facts/observations from conversations and stores
 * them as separate searchable documents. This dramatically improves
 * retrieval quality — searching for "Where is Caroline from?" matches
 * the observation "Caroline is originally from Sweden" much better than
 * it matches the raw conversation text.
 *
 * Runs between summarize and entity-hygiene steps.
 */

import { createLogger } from '../../../logger.js';
import { getTimelineDb } from '../../timeline.js';
import { indexDocument, isChromaAvailable } from '../../embeddings.js';
import { getClaudeClient } from '../../../claude.js';
import type { SleepConfig } from '../config.js';

const logger = createLogger('sleep:observe');

export interface ObserveResult {
  count: number;
  processed: number;
  errors?: string[];
}

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

export async function runObserveStep(
  root: string,
  config: SleepConfig
): Promise<ObserveResult> {
  if (!config.enableObservations) {
    return { count: 0, processed: 0 };
  }

  const timeline = await getTimelineDb(root);
  let observationsCreated = 0;
  let processed = 0;
  const errors: string[] = [];
  const maxPerRun = config.maxObservationsPerRun || 10;

  try {
    // Find conversation events that don't have observations yet
    // An event has been observed if there exist observation:// events linking to it
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

    if (unobserved.length === 0) {
      logger.debug('No conversations need observation extraction');
      return { count: 0, processed: 0 };
    }

    const client = getClaudeClient();

    for (const event of unobserved) {
      processed++;

      try {
        // Use summary (which contains the conversation text) for extraction
        const content = event.summary.slice(0, 4000);

        const response = await client.complete(
          OBSERVATION_PROMPT + content,
          {
            model: 'haiku',
            maxTokens: 1024,
            maxTurns: 1,
          }
        );

        // Parse JSON array from response
        const jsonMatch = response.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
          logger.debug(`No JSON array found in observation response for ${event.source_path}`);
          continue;
        }

        let facts: string[];
        try {
          facts = JSON.parse(jsonMatch[0]);
          if (!Array.isArray(facts)) continue;
          facts = facts.filter(f => typeof f === 'string' && f.length >= 10 && f.length <= 200);
        } catch {
          logger.debug(`Failed to parse observation JSON for ${event.source_path}`);
          continue;
        }

        // Store each fact as a separate searchable document
        const parentId = event.source_path.replace('channel://', '');
        const entities = safeParseArray(event.entities_json);
        const topics = safeParseArray(event.topics_json);

        for (const [i, fact] of facts.entries()) {
          const obsPath = `observation://${parentId}/${i}`;
          const obsId = `obs_${parentId.replace(/[^a-zA-Z0-9]/g, '_')}_${i}`;

          // Store in timeline (for FTS search)
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
              obsPath,
              event.entities_json || '[]',
              event.topics_json || '[]'
            );
          } catch {
            // Skip duplicate observations
            continue;
          }

          // Store in ChromaDB (for semantic search)
          try {
            if (isChromaAvailable()) {
              await indexDocument(obsId, fact, {
                type: 'note',
                source_path: obsPath,
                title: `[observation] ${fact.slice(0, 80)}`,
                timestamp: event.timestamp,
                entities,
                topics,
                summary: fact,
              });
            }
          } catch {
            // Embedding is best-effort
          }

          observationsCreated++;
        }

        logger.debug(`Extracted ${facts.length} observations from ${event.source_path}`);
      } catch (err) {
        errors.push(`Failed to observe ${event.source_path}: ${err}`);
      }
    }

    if (observationsCreated > 0) {
      logger.info('Observation extraction complete', { observations: observationsCreated, conversations: processed });
    }
  } catch (err) {
    errors.push(`Observe step failed: ${err}`);
  }

  return { count: observationsCreated, processed, errors: errors.length > 0 ? errors : undefined };
}

function safeParseArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
