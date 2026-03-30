/**
 * KyberBot — Fact Contradiction Detection
 *
 * When new facts are stored, this module checks if they contradict
 * existing facts about the same entities. Contradicted facts are
 * marked as superseded (is_latest=0) so retrieval returns only
 * current truth.
 *
 * Uses Claude Haiku for semantic comparison — pure keyword matching
 * would miss paraphrased contradictions like "lives in NYC" vs
 * "moved to Brooklyn".
 */

import { getFactsForEntity, type FactCategory, type StoredFact } from './fact-store.js';
import { getClaudeClient } from '../claude.js';
import { createLogger } from '../logger.js';

const logger = createLogger('fact-contradiction');

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ContradictionResult {
  contradictions: Array<{
    oldFactId: number;
    relationship: 'updates' | 'extends';
    rationale: string;
  }>;
  checked: number; // how many existing facts were compared
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY MATCHING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Determine which categories are related enough to potentially contradict
 * each other. For example, a "biographical" fact can only contradict another
 * "biographical" fact, but "general" can contradict anything.
 */
const RELATED_CATEGORIES: Record<string, ReadonlySet<string>> = {
  biographical: new Set(['biographical']),
  preference: new Set(['preference']),
  event: new Set(['event', 'temporal']),
  relationship: new Set(['relationship']),
  temporal: new Set(['event', 'temporal']),
  opinion: new Set(['opinion']),
  plan: new Set(['plan']),
  general: new Set([
    'biographical', 'preference', 'event', 'relationship',
    'temporal', 'opinion', 'plan', 'general',
  ]),
};

function areCategoriesRelated(a: string, b: string): boolean {
  const related = RELATED_CATEGORIES[a];
  if (!related) return true; // unknown category — be safe, compare
  return related.has(b);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect contradictions between a new fact and existing facts about the same
 * entities. Returns which existing facts are updated or extended by the new one.
 */
export async function detectContradictions(
  root: string,
  newFact: { content: string; entities: string[]; category: string }
): Promise<ContradictionResult> {
  if (!newFact.entities || newFact.entities.length === 0) {
    return { contradictions: [], checked: 0 };
  }

  // 1. Gather existing facts for all entities mentioned in the new fact
  const candidateMap = new Map<number, StoredFact>();

  for (const entity of newFact.entities) {
    try {
      const facts = await getFactsForEntity(root, entity, {
        latestOnly: true,
        limit: 20,
      });

      for (const fact of facts) {
        candidateMap.set(fact.id, fact);
      }
    } catch (err) {
      logger.debug(`Failed to fetch facts for entity "${entity}": ${err}`);
    }
  }

  // 2. Filter to related categories
  const candidates = Array.from(candidateMap.values()).filter(
    f => areCategoriesRelated(newFact.category, f.category)
  );

  if (candidates.length === 0) {
    return { contradictions: [], checked: 0 };
  }

  // 3. Limit to 10 candidates for cost control
  const toCheck = candidates.slice(0, 10);

  // 4. Call Haiku to detect semantic contradictions
  try {
    const client = getClaudeClient();

    const existingList = toCheck
      .map((f, i) => `${i + 1}. "${f.content}" (id=${f.id})`)
      .join('\n');

    const prompt = `Given a NEW fact and a list of EXISTING facts about the same person/entity, determine if the new fact contradicts (updates/replaces) any existing fact.

NEW FACT: "${newFact.content}"

EXISTING FACTS:
${existingList}

For each existing fact, determine:
- "updates" — the new fact replaces this (e.g., "favorite color is green" updates "favorite color is blue")
- "extends" — the new fact adds detail without contradicting (e.g., "lives in Brooklyn" extends "lives in NYC")
- "none" — no relationship

Return JSON array:
[{"id": 42, "relationship": "updates", "rationale": "favorite color changed"}]

Only include facts with "updates" or "extends" relationship. Return [] if no relationships found.`;

    const response = await client.complete(prompt, {
      model: 'haiku',
      maxTokens: 512,
      maxTurns: 1,
      subprocess: true,
    });

    // 5. Parse response
    const jsonMatch = response.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) {
      return { contradictions: [], checked: toCheck.length };
    }

    let parsed: unknown[];
    try {
      parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) {
        return { contradictions: [], checked: toCheck.length };
      }
    } catch {
      logger.debug('Failed to parse contradiction detection JSON');
      return { contradictions: [], checked: toCheck.length };
    }

    // 6. Validate and return
    const validIds = new Set(toCheck.map(f => f.id));
    const contradictions = parsed
      .filter((item): item is { id: number; relationship: string; rationale: string } => {
        if (!item || typeof item !== 'object') return false;
        const obj = item as Record<string, unknown>;
        return (
          typeof obj.id === 'number' &&
          validIds.has(obj.id) &&
          (obj.relationship === 'updates' || obj.relationship === 'extends') &&
          typeof obj.rationale === 'string'
        );
      })
      .map(item => ({
        oldFactId: item.id,
        relationship: item.relationship as 'updates' | 'extends',
        rationale: item.rationale,
      }));

    if (contradictions.length > 0) {
      logger.debug('Contradictions detected', {
        newFact: newFact.content.slice(0, 60),
        count: contradictions.length,
      });
    }

    return { contradictions, checked: toCheck.length };
  } catch (err) {
    // Haiku call failed — non-fatal, return empty
    logger.debug(`Contradiction detection failed: ${err}`);
    return { contradictions: [], checked: toCheck.length };
  }
}
