/**
 * Entity Hygiene Step
 *
 * Cleans the entity graph by:
 * 1. Removing transcription artifacts (Speaker 0, Speaker 1, etc.)
 * 2. AI-merging same-name-different-type duplicates (e.g., "Acme" project + company)
 * 3. AI-merging variant names (e.g., "Dr. Smith" + "Smith", "Bob" + "Robert")
 * 4. Pruning low-value noise (1-mention topics with no relations, older than N days)
 *
 * Uses Claude Haiku for cheap AI assessments.
 */

import { getClaudeClient } from '../../../claude.js';
import { createLogger } from '../../../logger.js';
import { SleepConfig } from '../config.js';
import { getEntityGraphDb, mergeEntities, deleteEntity, normalizeEntityName } from '../../entity-graph.js';
import { withRetry } from '../../../utils/retry.js';

const logger = createLogger('sleep:entity-hygiene');

export interface EntityHygieneResult {
  count: number;
  artifactsCleaned: number;
  merged: number;
  pruned: number;
  assessed: number;
  processed: number;
  errors?: string[];
}

interface EntityProfile {
  id: number;
  name: string;
  type: string;
  mentions: number;
  sampleContexts: string[];
  relatedEntities: string[];  // names of co-occurring entities
}

interface CandidatePair {
  keep: EntityProfile;
  remove: EntityProfile;
  matchReason: string;
}

interface AIDecision {
  action: 'MERGE' | 'DIFFERENT' | 'UNSURE';
  confidence: number;
  rationale: string;
  keepId?: number;
  suggestedType?: string;
}

// Artifact patterns to auto-delete
const ARTIFACT_PATTERNS = [
  /^speaker\s*\d*$/i,
  /^unknown$/i,
  /^person\s*\d+$/i,
  /^user$/i,
  /^narrator$/i,
  // Shell commands and CLI tools
  /^(curl|wget|bash|sh|zsh|npm|pnpm|yarn|pip|git|docker|node|python|make|gcc)$/i,
  // File paths and extensions
  /^[./~].*\//,
  /\.(json|yaml|yml|md|ts|js|py|sh|env|toml|lock|log|txt|csv|db)$/i,
  // Error states and operational terms
  /^(BLOCKED|ERROR|FAIL|OK|SUCCESS|null|undefined|true|false|none|N\/A)$/i,
  /^(max\s+turns?\s+limit|rate\s+limit|timeout|sandbox|retry|fallback)$/i,
  /^(settings|config|permissions?|terminal|shell|command|script)$/i,
  /^(stdout|stderr|stdin|exit code|error|warning)$/i,
  // Bare numbers and very short
  /^\d+$/,
  /^.{1,2}$/,
];

// Suffixes to strip for variant matching
const STRIP_SUFFIXES = /\s+(llc|inc|corp|ltd|co|company|project|app)\.?$/i;

// Common nickname -> formal name mappings (bidirectional)
const NICKNAME_MAP: Record<string, string[]> = {
  nick: ['nicholas', 'nico', 'nicky'],
  mike: ['michael', 'mikey'],
  tom: ['thomas', 'tommy'],
  bob: ['robert', 'bobby'],
  rob: ['robert', 'robby'],
  bill: ['william', 'billy'],
  will: ['william', 'willy'],
  jim: ['james', 'jimmy'],
  joe: ['joseph', 'joey'],
  dan: ['daniel', 'danny'],
  dave: ['david', 'davey'],
  ed: ['edward', 'eddie', 'edwin'],
  al: ['alan', 'albert', 'alexander'],
  alex: ['alexander', 'alexandra'],
  ben: ['benjamin', 'benny'],
  charlie: ['charles'],
  chris: ['christopher', 'christine', 'christina'],
  dick: ['richard'],
  rick: ['richard', 'ricky'],
  rich: ['richard'],
  don: ['donald', 'donny'],
  jack: ['john', 'jackson'],
  jake: ['jacob'],
  jeff: ['jeffrey', 'geoffrey'],
  jen: ['jennifer', 'jenny'],
  jerry: ['gerald', 'jeremy'],
  jon: ['jonathan', 'john'],
  josh: ['joshua'],
  matt: ['matthew', 'matty'],
  max: ['maxwell', 'maximilian'],
  pat: ['patrick', 'patricia'],
  pete: ['peter'],
  phil: ['philip', 'phillip'],
  sam: ['samuel', 'samantha'],
  steve: ['steven', 'stephen'],
  ted: ['theodore', 'edward'],
  tim: ['timothy', 'timmy'],
  tony: ['anthony'],
};

// Build reverse map too
const FORMAL_TO_NICK: Record<string, string[]> = {};
for (const [nick, formals] of Object.entries(NICKNAME_MAP)) {
  for (const formal of formals) {
    if (!FORMAL_TO_NICK[formal]) FORMAL_TO_NICK[formal] = [];
    FORMAL_TO_NICK[formal].push(nick);
  }
}

function areNicknames(a: string, b: string): boolean {
  // Direct lookup: a is nickname of b
  if (NICKNAME_MAP[a]?.includes(b)) return true;
  if (NICKNAME_MAP[b]?.includes(a)) return true;
  // Reverse: a is formal, b is a known nick for a
  if (FORMAL_TO_NICK[a]?.includes(b)) return true;
  if (FORMAL_TO_NICK[b]?.includes(a)) return true;
  return false;
}

export async function runEntityHygieneStep(
  root: string,
  config: SleepConfig
): Promise<EntityHygieneResult> {
  if (!config.enableEntityHygiene) {
    return { count: 0, artifactsCleaned: 0, merged: 0, pruned: 0, assessed: 0, processed: 0 };
  }

  const errors: string[] = [];
  let artifactsCleaned = 0;
  let merged = 0;
  let pruned = 0;
  let assessed = 0;
  let totalActions = 0;

  const db = await getEntityGraphDb(root);

  try {
    // Phase 0: Clean orphaned relations (referencing deleted entities)
    const orphanedCount = db.prepare(`
      DELETE FROM entity_relations WHERE
        source_id NOT IN (SELECT id FROM entities) OR
        target_id NOT IN (SELECT id FROM entities)
    `).run().changes;
    if (orphanedCount > 0) {
      logger.info(`Cleaned ${orphanedCount} orphaned relations`);
    }

    // Also clean orphaned mentions
    const orphanedMentions = db.prepare(`
      DELETE FROM entity_mentions WHERE
        entity_id NOT IN (SELECT id FROM entities)
    `).run().changes;
    if (orphanedMentions > 0) {
      logger.info(`Cleaned ${orphanedMentions} orphaned mentions`);
    }

    // Phase 1: Clean known artifacts (no AI needed)
    const allEntities = db.prepare('SELECT id, name, type, mention_count FROM entities').all() as Array<{
      id: number; name: string; type: string; mention_count: number;
    }>;

    for (const entity of allEntities) {
      if (totalActions >= config.maxMergesPerRun) break;
      if (ARTIFACT_PATTERNS.some(p => p.test(entity.name))) {
        try {
          await deleteEntity(root, entity.id, 'artifact-cleanup');
          artifactsCleaned++;
          totalActions++;
          logger.debug(`Cleaned artifact: "${entity.name}" (${entity.id})`);
        } catch (err) {
          errors.push(`Failed to clean artifact ${entity.name}: ${err}`);
        }
      }
    }

    if (totalActions >= config.maxMergesPerRun) {
      logger.info('Hit max actions limit after artifact cleanup', { artifactsCleaned });
      return buildResult(artifactsCleaned, merged, pruned, assessed, errors);
    }

    // AI phases require the Claude client
    const claude = getClaudeClient();

    // Phase 2: Same-name-different-type candidates
    const sameNameGroups = db.prepare(`
      SELECT normalized_name, GROUP_CONCAT(id) as ids, GROUP_CONCAT(type) as types,
             GROUP_CONCAT(name) as names, GROUP_CONCAT(mention_count) as mention_counts
      FROM entities
      GROUP BY normalized_name
      HAVING COUNT(DISTINCT type) > 1
    `).all() as Array<{
      normalized_name: string;
      ids: string;
      types: string;
      names: string;
      mention_counts: string;
    }>;

    if (sameNameGroups.length > 0) {
      const candidates = buildSameNameCandidates(db, sameNameGroups);
      const remaining = config.maxMergesPerRun - totalActions;
      const batch = candidates.slice(0, remaining);

      if (batch.length > 0) {
        const { mergeCount, assessCount, errs } = await assessAndMerge(
          claude, root, batch, config.hygieneConfidenceThreshold
        );
        merged += mergeCount;
        assessed += assessCount;
        totalActions += mergeCount;
        errors.push(...errs);
      }
    }

    if (totalActions >= config.maxMergesPerRun) {
      return buildResult(artifactsCleaned, merged, pruned, assessed, errors);
    }

    // Phase 3: Variant name candidates
    const variantCandidates = findVariantCandidates(db);
    if (variantCandidates.length > 0) {
      const remaining = config.maxMergesPerRun - totalActions;
      const batch = variantCandidates.slice(0, remaining);

      if (batch.length > 0) {
        const { mergeCount, assessCount, errs } = await assessAndMerge(
          claude, root, batch, config.hygieneConfidenceThreshold
        );
        merged += mergeCount;
        assessed += assessCount;
        totalActions += mergeCount;
        errors.push(...errs);
      }
    }

    // Phase 4: Prune low-value noise (no AI needed)
    const pruneDate = new Date(Date.now() - config.pruneMinAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const noisyEntities = db.prepare(`
      SELECT e.id, e.name, e.type, e.mention_count, e.last_seen, e.is_pinned
      FROM entities e
      WHERE e.mention_count <= 1
        AND e.type = 'topic'
        AND e.last_seen < ?
        AND (e.is_pinned IS NULL OR e.is_pinned = 0)
        AND NOT EXISTS (SELECT 1 FROM entity_relations WHERE source_id = e.id OR target_id = e.id)
    `).all(pruneDate) as Array<{
      id: number; name: string; type: string; mention_count: number;
    }>;

    for (const entity of noisyEntities) {
      if (totalActions >= config.maxMergesPerRun) break;
      try {
        await deleteEntity(root, entity.id, 'prune-low-value-noise');
        pruned++;
        totalActions++;
      } catch (err) {
        errors.push(`Failed to prune ${entity.name}: ${err}`);
      }
    }

  } catch (error) {
    logger.error('Entity hygiene step failed', { error: String(error) });
    errors.push(`Entity hygiene failed: ${error}`);
  }

  return buildResult(artifactsCleaned, merged, pruned, assessed, errors);
}

function buildResult(
  artifactsCleaned: number, merged: number, pruned: number, assessed: number, errors: string[]
): EntityHygieneResult {
  const count = artifactsCleaned + merged + pruned;
  const processed = artifactsCleaned + merged + pruned + assessed;
  logger.info('Entity hygiene completed', { artifactsCleaned, merged, pruned, assessed, count });
  return {
    count,
    artifactsCleaned,
    merged,
    pruned,
    assessed,
    processed,
    errors: errors.length > 0 ? errors : undefined,
  };
}

function buildSameNameCandidates(
  db: import('better-sqlite3').Database,
  groups: Array<{ normalized_name: string; ids: string; types: string; names: string; mention_counts: string }>
): CandidatePair[] {
  const candidates: CandidatePair[] = [];

  for (const group of groups) {
    const ids = group.ids.split(',').map(Number);
    const types = group.types.split(',');
    const names = group.names.split(',');
    const mentions = group.mention_counts.split(',').map(Number);

    // Pick the entity with most mentions as "keep" candidate
    let keepIdx = 0;
    for (let i = 1; i < ids.length; i++) {
      if (mentions[i] > mentions[keepIdx]) keepIdx = i;
    }

    for (let i = 0; i < ids.length; i++) {
      if (i === keepIdx) continue;

      const keepProfile = buildEntityProfile(db, { id: ids[keepIdx], name: names[keepIdx], type: types[keepIdx], mention_count: mentions[keepIdx] });
      const removeProfile = buildEntityProfile(db, { id: ids[i], name: names[i], type: types[i], mention_count: mentions[i] });

      candidates.push({
        keep: keepProfile,
        remove: removeProfile,
        matchReason: 'same-name-different-type',
      });
    }
  }

  return candidates;
}

function findVariantCandidates(db: import('better-sqlite3').Database): CandidatePair[] {
  const entities = db.prepare(`
    SELECT id, name, normalized_name, type, mention_count
    FROM entities
    ORDER BY mention_count DESC
  `).all() as Array<{
    id: number; name: string; normalized_name: string; type: string; mention_count: number;
  }>;

  const candidates: CandidatePair[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i];
      const b = entities[j];
      const key = `${Math.min(a.id, b.id)}-${Math.max(a.id, b.id)}`;
      if (seen.has(key)) continue;

      // Skip if same normalized name (handled by phase 2)
      if (a.normalized_name === b.normalized_name) continue;

      const matchReason = detectVariantMatch(a.normalized_name, b.normalized_name, a.type, b.type);
      if (!matchReason) continue;

      seen.add(key);

      // Higher mentions = keep
      const [keep, remove] = a.mention_count >= b.mention_count ? [a, b] : [b, a];

      candidates.push({
        keep: buildEntityProfile(db, keep),
        remove: buildEntityProfile(db, remove),
        matchReason,
      });
    }
  }

  return candidates;
}

function detectVariantMatch(nameA: string, nameB: string, typeA: string, typeB: string): string | null {
  const a = nameA.toLowerCase();
  const b = nameB.toLowerCase();

  // Strip suffixes for comparison
  const aStripped = a.replace(STRIP_SUFFIXES, '').trim();
  const bStripped = b.replace(STRIP_SUFFIXES, '').trim();

  // Suffix variant: "acme" vs "acme llc"
  if (aStripped === bStripped && a !== b) {
    return 'variant-suffix';
  }

  // Prefix/title variant: "dr. smith" vs "smith", "mr. john" vs "john"
  const titlePrefixA = a.replace(/^(dr\.?|mr\.?|mrs\.?|ms\.?|prof\.?)\s+/i, '').trim();
  const titlePrefixB = b.replace(/^(dr\.?|mr\.?|mrs\.?|ms\.?|prof\.?)\s+/i, '').trim();
  if (titlePrefixA !== a && titlePrefixA === b) return 'variant-title-prefix';
  if (titlePrefixB !== b && titlePrefixB === a) return 'variant-title-prefix';

  // Nickname/short form: short name is prefix of longer
  // e.g., "mom" vs "mommy", "nick" vs "nicholas", "mike" vs "michael"
  if (a.length >= 3 && b.length >= 3) {
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    // Only match single words (no spaces) to avoid false positives
    if (!shorter.includes(' ') && !longer.includes(' ') && longer.startsWith(shorter)) {
      return 'variant-nickname';
    }
  }

  // First-name match for person types: "nick" matches "nicholas frith"
  // Checks exact first-name match, prefix match, OR known nickname mappings
  // The AI assessment uses relational context to decide if they're actually the same person
  if (typeA === 'person' && typeB === 'person') {
    const aFirst = a.split(' ')[0];
    const bFirst = b.split(' ')[0];
    const aIsSingle = !a.includes(' ');
    const bIsSingle = !b.includes(' ');

    // "nick" (single) matches "nick chen" (first name exact)
    if (aIsSingle && bFirst === a) return 'variant-first-name';
    if (bIsSingle && aFirst === b) return 'variant-first-name';

    // "nick" matches "nicholas frith" via nickname map
    if (aIsSingle && areNicknames(a, bFirst)) return 'variant-first-name';
    if (bIsSingle && areNicknames(b, aFirst)) return 'variant-first-name';

    // Prefix match: "nick" matches first name starting with "nick" (>=3 chars)
    if (aIsSingle && a.length >= 3 && bFirst.startsWith(a)) return 'variant-first-name';
    if (bIsSingle && b.length >= 3 && aFirst.startsWith(b)) return 'variant-first-name';
  }

  // Substring variant detection (all entity types):
  // If names share a substring >= 4 chars and the shorter name is >= 40% of the longer name's length
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 4 && longer.includes(shorter) && shorter.length >= longer.length * 0.4) {
    return 'variant-substring';
  }

  // Compound variant detection (all entity types):
  // Normalize by removing dashes, underscores, and spaces, then check prefix
  const aNorm = a.replace(/[-_\s]/g, '');
  const bNorm = b.replace(/[-_\s]/g, '');
  if (aNorm.length >= 4 && bNorm.length >= 4 && aNorm !== bNorm) {
    const shorterNorm = aNorm.length <= bNorm.length ? aNorm : bNorm;
    const longerNorm = aNorm.length <= bNorm.length ? bNorm : aNorm;
    if (longerNorm.startsWith(shorterNorm)) {
      return 'variant-compound';
    }
  }

  return null;
}

function buildEntityProfile(
  db: import('better-sqlite3').Database,
  entity: { id: number; name: string; type: string; mention_count: number }
): EntityProfile {
  // Sample mention contexts for THIS entity
  const mentions = db.prepare(`
    SELECT context FROM entity_mentions
    WHERE entity_id = ? AND context IS NOT NULL AND context != ''
    ORDER BY timestamp DESC
    LIMIT 5
  `).all(entity.id) as Array<{ context: string }>;

  // Related entities (who/what this entity co-occurs with)
  const related = db.prepare(`
    SELECT DISTINCT e.name FROM entity_relations r
    JOIN entities e ON (
      (r.source_id = ? AND e.id = r.target_id) OR
      (r.target_id = ? AND e.id = r.source_id)
    )
    ORDER BY r.strength DESC
    LIMIT 10
  `).all(entity.id, entity.id) as Array<{ name: string }>;

  return {
    id: entity.id,
    name: entity.name,
    type: entity.type,
    mentions: entity.mention_count,
    sampleContexts: mentions.map(m => m.context.slice(0, 200)),
    relatedEntities: related.map(r => r.name),
  };
}

async function assessAndMerge(
  claude: ReturnType<typeof getClaudeClient>,
  root: string,
  candidates: CandidatePair[],
  confidenceThreshold: number
): Promise<{ mergeCount: number; assessCount: number; errs: string[] }> {
  let mergeCount = 0;
  let assessCount = 0;
  const errs: string[] = [];

  // Process in batches of 5
  for (let i = 0; i < candidates.length; i += 5) {
    const batch = candidates.slice(i, i + 5);

    try {
      const decisions = await assessBatch(claude, batch);
      assessCount += batch.length;

      for (let j = 0; j < decisions.length; j++) {
        const decision = decisions[j];
        const candidate = batch[j];

        if (decision.action === 'MERGE' && decision.confidence >= confidenceThreshold) {
          try {
            await mergeEntities(
              root,
              candidate.keep.id,
              candidate.remove.id,
              candidate.matchReason,
              decision.confidence,
              decision.rationale,
              'sleep:entity-hygiene'
            );
            mergeCount++;
            logger.info(`Merged "${candidate.remove.name}" into "${candidate.keep.name}"`, {
              reason: candidate.matchReason,
              confidence: decision.confidence,
            });
          } catch (err) {
            errs.push(`Failed to merge ${candidate.remove.name} -> ${candidate.keep.name}: ${err}`);
          }
        } else {
          logger.debug(`Skipped merge: "${candidate.remove.name}" + "${candidate.keep.name}"`, {
            action: decision.action,
            confidence: decision.confidence,
            rationale: decision.rationale,
          });
        }
      }
    } catch (err) {
      errs.push(`AI assessment batch failed: ${err}`);
    }
  }

  return { mergeCount, assessCount, errs };
}

async function assessBatch(
  claude: ReturnType<typeof getClaudeClient>,
  candidates: CandidatePair[]
): Promise<AIDecision[]> {
  const pairsDescription = candidates.map((c, idx) => {
    const formatProfile = (label: string, p: EntityProfile) => {
      let desc = `  ${label}: "${p.name}" (type: ${p.type}, mentions: ${p.mentions})`;
      if (p.relatedEntities.length > 0) {
        desc += `\n    Connected to: ${p.relatedEntities.join(', ')}`;
      }
      if (p.sampleContexts.length > 0) {
        desc += `\n    Mention contexts:\n${p.sampleContexts.map(ctx => `      - "${ctx}"`).join('\n')}`;
      }
      return desc;
    };

    return `Pair ${idx + 1}:
${formatProfile('A', c.keep)}
${formatProfile('B', c.remove)}
  Match reason: ${c.matchReason}`;
  }).join('\n\n');

  const responseText = await withRetry(
    () => claude.complete(
      `You are an entity graph deduplication assistant for a personal knowledge system. For each pair below, decide if they refer to the SAME real-world entity and should be merged, or are genuinely DIFFERENT entities.

USE CONTEXT TO DECIDE. Each entity includes:
- **Connected to**: Other entities they co-occur with in conversations. If two entities share the same connections (same people, projects, topics), they're likely the same. If they appear in completely different contexts, they're likely different.
- **Mention contexts**: How they're described when mentioned. Look at roles, descriptions, and surrounding topics.

${pairsDescription}

For each pair, respond with a JSON array of decisions:
[
  { "action": "MERGE" | "DIFFERENT" | "UNSURE", "confidence": 0.0-1.0, "rationale": "brief reason" },
  ...
]

Rules:
- MERGE: Same entity, different name variant or type. The entity with more mentions is kept.
- DIFFERENT: Genuinely different entities that happen to have similar names.
- UNSURE: Not enough context to decide confidently.
- confidence: How sure you are (0.0-1.0).
- KEY: A first name like "Nick" and a full name like "Nicholas Frith" ARE the same person if they share connections and context. But two people with the same first name but completely different social graphs are DIFFERENT people.
- Look at the CONNECTIONS and CONTEXTS — two entities with overlapping connections are very likely the same. Two entities with completely different social graphs are likely different people who share a name.
- A person and a company with the same name are usually DIFFERENT unless context clearly shows they refer to the same thing.

Return ONLY the JSON array, no other text.`,
      { model: 'haiku', maxTokens: 1500 }
    ),
    {
      retries: 2,
      delay: 2000,
      onRetry: (err, attempt) => {
        logger.warn(`AI assessment retry ${attempt}/2: ${err.message}`);
      },
    }
  );

  const jsonMatch = responseText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    logger.warn('AI response did not contain valid JSON array', { text: responseText.slice(0, 200) });
    return candidates.map(() => ({ action: 'UNSURE' as const, confidence: 0, rationale: 'Failed to parse AI response' }));
  }

  try {
    const decisions = JSON.parse(jsonMatch[0]) as AIDecision[];
    // Ensure we have the right number of decisions
    while (decisions.length < candidates.length) {
      decisions.push({ action: 'UNSURE', confidence: 0, rationale: 'Missing from AI response' });
    }
    return decisions.slice(0, candidates.length);
  } catch {
    logger.warn('Failed to parse AI decisions JSON', { text: responseText.slice(0, 200) });
    return candidates.map(() => ({ action: 'UNSURE' as const, confidence: 0, rationale: 'JSON parse error' }));
  }
}
