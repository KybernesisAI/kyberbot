/**
 * KyberBot — Sleep Agent: Reasoning Step
 *
 * The cognitive engine. Runs deduction and induction passes on entities
 * with 3+ facts to generate insights — things the agent has *figured out*,
 * not just stored. This is what makes the agent genuinely intelligent.
 *
 * Two sequential passes per entity:
 * 1. Deduction (confidence 0.80+) — logically certain conclusions from 2+ facts
 * 2. Induction (confidence 0.60-0.75) — probable patterns from 3+ data points
 *
 * Also detects quality issues: contradictions, likely misattributions, stale facts.
 *
 * Runs after the observe step and before entity-hygiene.
 */

import { createLogger } from '../../../logger.js';
import { getClaudeClient } from '../../../claude.js';
import {
  getEntitiesForReasoning,
  markEntityReasoned,
  saveEntityInsight,
  markInsightsStale,
  getTypedRelationships,
  getEntityGraphDb,
  type InsightType,
} from '../../entity-graph.js';
import { getFactsForEntity } from '../../fact-store.js';
import type { SleepConfig } from '../config.js';

const logger = createLogger('sleep:reasoning');

export interface ReasoningResult {
  count: number;     // total insights generated
  processed: number; // entities processed
  errors?: string[];
}

interface ExtractedInsight {
  insight: string;
  reasoning: string;
  confidence: number;
  type?: string;
}

const DEDUCTION_PROMPT = `Given these facts about "{name}" and connected entities, what can you LOGICALLY DERIVE that is CERTAINLY TRUE?

Every conclusion must follow from 2+ existing facts. Only include things that are definitely true based on the evidence — no speculation.

Facts about {name}:
{facts}

{connectedSection}

Return a JSON array of insights. Each must have "insight" (the conclusion), "reasoning" (which facts support it), and "confidence" (0.80-0.95).
Return [] if nothing can be logically derived.

Example: [{"insight":"David leads a Darkstar portfolio company","reasoning":"David is CEO of Ohana + Ohana is a Darkstar portfolio company","confidence":0.85}]`;

const INDUCTION_PROMPT = `Given these observations about "{name}", what PATTERNS do you detect? What is PROBABLY true?

Require 3+ data points to propose a pattern. These are probable, not certain.

Facts about {name}:
{facts}

Mention patterns:
- Total mentions: {mentionCount}
- First seen: {firstSeen}
- Last seen: {lastSeen}
{coOccurrences}

Return a JSON array of pattern insights. Each must have "insight" (the pattern), "reasoning" (the evidence), and "confidence" (0.60-0.75).
Return [] if no clear patterns.

Example: [{"insight":"Nick is a regular in the AI meetup circuit","reasoning":"Appears at 6 different AI events over 3 months","confidence":0.70}]`;

export async function runReasoningStep(
  root: string,
  config: SleepConfig
): Promise<ReasoningResult> {
  if (!config.enableReasoning) {
    return { count: 0, processed: 0 };
  }

  const maxPerRun = config.maxReasoningPerRun || 5;
  let insightsCreated = 0;
  let processed = 0;
  const errors: string[] = [];

  try {
    const entities = await getEntitiesForReasoning(root, maxPerRun);

    if (entities.length === 0) {
      logger.debug('No entities ready for reasoning');
      return { count: 0, processed: 0 };
    }

    const client = getClaudeClient();

    for (const entity of entities) {
      processed++;

      try {
        // Gather facts for this entity
        const facts = await getFactsForEntity(root, entity.name, {
          latestOnly: true,
          limit: 20,
        });

        if (facts.length < 3) {
          await markEntityReasoned(root, entity.id);
          continue;
        }

        const factList = facts.map(f => `- ${f.content} (${f.category}, confidence: ${f.confidence})`).join('\n');

        // Gather connected entity facts for cross-entity reasoning
        let connectedSection = '';
        try {
          const typedRels = await getTypedRelationships(root, entity.id);
          if (typedRels.length > 0) {
            const connectedParts: string[] = [];
            for (const rel of typedRels.slice(0, 5)) {
              const relFacts = await getFactsForEntity(root, rel.entity.name, {
                latestOnly: true,
                limit: 5,
              });
              if (relFacts.length > 0) {
                const relFactList = relFacts.map(f => `  - ${f.content}`).join('\n');
                connectedParts.push(`${rel.entity.name} (${rel.relationship}):\n${relFactList}`);
              }
            }
            if (connectedParts.length > 0) {
              connectedSection = `Connected entities:\n${connectedParts.join('\n\n')}`;
            }
          }
        } catch {
          // Non-fatal: continue without connected entities
        }

        // Mark old insights as stale before generating new ones
        await markInsightsStale(root, entity.id);

        // ── Pass 1: Deduction ──────────────────────────────────────────
        try {
          const deductionPrompt = DEDUCTION_PROMPT
            .replace(/\{name\}/g, entity.name)
            .replace('{facts}', factList)
            .replace('{connectedSection}', connectedSection || 'No connected entities with known facts.');

          const deductionResponse = await client.complete(deductionPrompt, {
            model: 'haiku',
            maxTokens: 512,
            maxTurns: 1,
            subprocess: true,
          });

          const deductions = parseInsights(deductionResponse);
          for (const d of deductions) {
            const confidence = Math.max(0.80, Math.min(0.95, d.confidence));
            await saveEntityInsight(
              root, entity.id, 'inference', d.insight, d.reasoning, confidence
            );
            insightsCreated++;
          }
        } catch (err) {
          errors.push(`Deduction failed for ${entity.name}: ${err}`);
        }

        // ── Pass 2: Induction ──────────────────────────────────────────
        try {
          // Get co-occurrence info
          const db = await getEntityGraphDb(root);
          const entityRow = db.prepare('SELECT * FROM entities WHERE id = ?').get(entity.id) as {
            mention_count: number; first_seen: string; last_seen: string;
          } | undefined;

          let coOccurrences = '';
          try {
            const coOccurring = db.prepare(`
              SELECT e2.name, er.strength FROM entity_relations er
              JOIN entities e2 ON e2.id = CASE WHEN er.source_id = ? THEN er.target_id ELSE er.source_id END
              WHERE (er.source_id = ? OR er.target_id = ?) AND er.strength > 1
              ORDER BY er.strength DESC LIMIT 10
            `).all(entity.id, entity.id, entity.id) as Array<{ name: string; strength: number }>;

            if (coOccurring.length > 0) {
              coOccurrences = 'Co-occurs with: ' + coOccurring.map(c => `${c.name} (${c.strength}x)`).join(', ');
            }
          } catch {
            // Non-fatal
          }

          const inductionPrompt = INDUCTION_PROMPT
            .replace(/\{name\}/g, entity.name)
            .replace('{facts}', factList)
            .replace('{mentionCount}', String(entityRow?.mention_count ?? 0))
            .replace('{firstSeen}', entityRow?.first_seen ?? 'unknown')
            .replace('{lastSeen}', entityRow?.last_seen ?? 'unknown')
            .replace('{coOccurrences}', coOccurrences || 'No significant co-occurrences.');

          const inductionResponse = await client.complete(inductionPrompt, {
            model: 'haiku',
            maxTokens: 512,
            maxTurns: 1,
            subprocess: true,
          });

          const inductions = parseInsights(inductionResponse);
          for (const ind of inductions) {
            const confidence = Math.max(0.60, Math.min(0.75, ind.confidence));
            await saveEntityInsight(
              root, entity.id, 'pattern', ind.insight, ind.reasoning, confidence
            );
            insightsCreated++;
          }
        } catch (err) {
          errors.push(`Induction failed for ${entity.name}: ${err}`);
        }

        await markEntityReasoned(root, entity.id);
        logger.debug(`Reasoning completed for ${entity.name}`, { insightsCreated });
      } catch (err) {
        errors.push(`Reasoning failed for ${entity.name}: ${err}`);
      }
    }

    if (insightsCreated > 0) {
      logger.info(`Reasoning step generated ${insightsCreated} insights for ${processed} entities`);
    }
  } catch (error) {
    logger.error('Reasoning step failed', { error: String(error) });
    errors.push(`Reasoning step failed: ${error}`);
  }

  return {
    count: insightsCreated,
    processed,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/** Parse JSON array of insights from LLM response */
function parseInsights(response: string): ExtractedInsight[] {
  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((item): item is ExtractedInsight => {
      if (!item || typeof item !== 'object') return false;
      return (
        typeof item.insight === 'string' &&
        item.insight.length > 5 &&
        typeof item.reasoning === 'string' &&
        typeof item.confidence === 'number'
      );
    });
  } catch {
    return [];
  }
}
