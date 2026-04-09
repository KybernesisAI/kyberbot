/**
 * Eval Command
 *
 * Evaluates the quality of an agent's long-term memory system.
 * Runs 6 benchmarks against the entity graph, timeline, sleep agent,
 * and memory edges — outputs a scorecard with grades and issues.
 *
 * Usage:
 *   kyberbot eval                          # Eval current agent
 *   kyberbot eval --root /path/to/agent    # Eval a different agent
 *   kyberbot eval --json                   # Output as JSON
 */

import { Command } from 'commander';
import { Database } from '../database.js';
import { join, resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import { getRoot } from '../config.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface EvalResult {
  name: string;
  score: number;
  maxScore: number;
  grade: string;
  details: string[];
  issues: string[];
}

interface EvalReport {
  agent: string;
  timestamp: string;
  results: EvalResult[];
  totalScore: number;
  totalMax: number;
  overallGrade: string;
  overallPct: number;
}

interface Entity {
  id: number;
  name: string;
  normalized_name: string;
  type: string;
  mention_count: number;
  aliases: string;
  first_seen: string;
  last_seen: string;
  is_pinned: number | null;
}

interface TimelineEvent {
  id: number;
  type: string;
  title: string;
  summary: string;
  source_path: string;
  tier: string;
  priority: number;
  decay_score: number;
  tags_json: string;
  topics_json: string;
  access_count: number;
  timestamp: string;
}

interface MemoryEdge {
  from_path: string;
  to_path: string;
  relation: string;
  confidence: number;
  shared_tags: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOISE & MISCLASSIFICATION DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

const NOISE_ENTITY_PATTERNS = [
  /^(curl|bash|zsh|sh|npm|pnpm|yarn|pip|git|docker|make|gcc|node)$/i,
  /^(stdout|stderr|stdin|exit code|error|warning|undefined|null|true|false)$/i,
  /\.(json|yaml|yml|ts|js|md|txt|db|log|sh|env|toml|cfg)$/i,
  /^(settings|config|permissions?|sandbox|terminal|shell|command|script)$/i,
  /^(max turns? limit|timeout|retry|fallback|blocked|skip|BLOCKED)$/i,
  /^(http|https|localhost|127\.0\.0\.1|0\.0\.0\.0)/i,
  /^\d+$/,
  /^[a-f0-9-]{36}$/i,
];

function isNoiseEntity(name: string): boolean {
  return NOISE_ENTITY_PATTERNS.some((p) => p.test(name.trim()));
}

const TECHNOLOGY_NAMES = new Set([
  'typescript', 'javascript', 'node.js', 'react', 'express', 'next.js',
  'next.js 14', 'postgres', 'postgresql', 'sqlite', 'chromadb', 'docker',
  'pnpm', 'npm', 'yarn', 'drizzle', 'better-auth', 'jwt', 'aes-256-gcm',
  'cloudflare workers', 'vercel', 'render', 'convex', 'sentry', 'posthog',
  'claude code', 'mcp server', 'mcp', 'redis', 'mongodb', 'prisma',
  'tailwind', 'vue', 'angular', 'svelte', 'graphql', 'rest',
]);

// ═══════════════════════════════════════════════════════════════════════════════
// FRAGMENTATION DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

function detectFragmentation(entities: Entity[]): Array<{ group: string[]; reason: string }> {
  const fragments: Array<{ group: string[]; reason: string }> = [];
  const names = entities.map((e) => e.normalized_name);
  const seen = new Set<string>();

  for (let i = 0; i < names.length; i++) {
    if (names[i].length < 4 || entities[i].mention_count < 3) continue;

    const matches: string[] = [];
    for (let j = 0; j < names.length; j++) {
      if (i === j) continue;

      // Must be a word-boundary substring, not a coincidental overlap
      // e.g., "Ian" inside "Chiang Mai" is NOT fragmentation
      const shorter = names[i];
      const longer = names[j];
      if (!longer.includes(shorter)) continue;

      // Check word boundary: shorter must appear at start of a word in longer
      const idx = longer.indexOf(shorter);
      const atWordStart = idx === 0 || /[\s\-_]/.test(longer[idx - 1]);
      if (!atWordStart) continue;

      // Skip if the longer name is a different product/subtype
      // (e.g., "Cloudflare" vs "Cloudflare Workers" — different entities)
      const suffix = longer.slice(idx + shorter.length).trim();
      if (suffix.length > 0 && entities[i].type !== entities[j].type) continue;

      matches.push(entities[j].name);
    }

    if (matches.length > 0) {
      const group = [entities[i].name, ...matches];
      const key = group.sort().join('|');
      if (!seen.has(key)) {
        seen.add(key);
        fragments.push({
          group,
          reason: `"${entities[i].name}" is a substring of ${matches.length} other entities`,
        });
      }
    }
  }

  return fragments;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GRADING
// ═══════════════════════════════════════════════════════════════════════════════

function grade(score: number, max: number): string {
  const pct = score / max;
  if (pct >= 0.8) return 'A';
  if (pct >= 0.6) return 'B';
  if (pct >= 0.4) return 'C';
  if (pct >= 0.2) return 'D';
  return 'F';
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVAL 1: ENTITY GRAPH QUALITY
// ═══════════════════════════════════════════════════════════════════════════════

function evalEntityQuality(entityDb: Database): EvalResult {
  const result: EvalResult = {
    name: 'Entity Graph Quality',
    score: 0,
    maxScore: 100,
    grade: 'F',
    details: [],
    issues: [],
  };

  const entities = entityDb.prepare('SELECT * FROM entities').all() as Entity[];
  const total = entities.length;

  if (total === 0) {
    result.issues.push('No entities found — brain is empty');
    result.grade = grade(0, 100);
    return result;
  }

  result.details.push(`Total entities: ${total}`);

  // Noise entities
  const noiseEntities = entities.filter((e) => isNoiseEntity(e.name));
  const noiseRatio = noiseEntities.length / total;
  const noiseScore = Math.max(0, 25 - noiseRatio * 100);
  result.details.push(`Noise entities: ${noiseEntities.length}/${total} (${(noiseRatio * 100).toFixed(1)}%)`);
  if (noiseEntities.length > 0) {
    result.issues.push(
      `Noise entities: ${noiseEntities.map((e) => `"${e.name}" (${e.type})`).join(', ')}`
    );
  }

  // Type misclassification
  const misclassified = entities.filter(
    (e) => e.type === 'project' && TECHNOLOGY_NAMES.has(e.normalized_name)
  );
  const misclassRatio = misclassified.length / total;
  const typeScore = Math.max(0, 25 - misclassRatio * 200);
  result.details.push(`Type misclassifications: ${misclassified.length}`);
  if (misclassified.length > 0) {
    result.issues.push(
      `Technologies classified as "project" instead of "topic": ${misclassified.map((e) => e.name).join(', ')}`
    );
  }

  // Fragmentation
  const fragments = detectFragmentation(entities);
  const fragScore = Math.max(0, 25 - fragments.length * 5);
  result.details.push(`Fragmented entity groups: ${fragments.length}`);
  for (const frag of fragments.slice(0, 5)) {
    result.issues.push(`Fragment: [${frag.group.join(', ')}] — ${frag.reason}`);
  }

  // Type distribution
  const byType: Record<string, number> = {};
  for (const e of entities) {
    byType[e.type] = (byType[e.type] || 0) + 1;
  }
  const meaningfulRatio = ((byType['person'] || 0) + (byType['company'] || 0)) / total;
  const distributionScore = Math.min(25, meaningfulRatio * 100);
  result.details.push(
    `Type distribution: person=${byType['person'] || 0}, company=${byType['company'] || 0}, project=${byType['project'] || 0}, topic=${byType['topic'] || 0}, place=${byType['place'] || 0}`
  );
  if ((byType['topic'] || 0) + (byType['project'] || 0) > total * 0.8) {
    result.issues.push('Graph dominated by topics/projects — few meaningful person/company entities');
  }

  // Relationship confidence diversity
  const relations = entityDb
    .prepare('SELECT confidence FROM entity_relations WHERE confidence IS NOT NULL')
    .all() as Array<{ confidence: number }>;
  if (relations.length > 0) {
    const uniqueConf = new Set(relations.map((r) => r.confidence.toFixed(2)));
    result.details.push(
      `Relationship confidence values: ${uniqueConf.size} unique out of ${relations.length} relations`
    );
    if (uniqueConf.size <= 3) {
      result.issues.push(
        `All relationships have near-identical confidence — no signal differentiation (values: ${[...uniqueConf].join(', ')})`
      );
    }
  }

  result.score = Math.round(noiseScore + typeScore + fragScore + distributionScore);
  result.grade = grade(result.score, result.maxScore);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVAL 2: CO-OCCURRENCE POLLUTION
// ═══════════════════════════════════════════════════════════════════════════════

function evalCooccurrencePollution(entityDb: Database): EvalResult {
  const result: EvalResult = {
    name: 'Co-occurrence Pollution',
    score: 0,
    maxScore: 100,
    grade: 'F',
    details: [],
    issues: [],
  };

  let typedCount = 0;
  let cooccurredCount = 0;
  try {
    typedCount = (entityDb.prepare(
      "SELECT COUNT(*) as count FROM entity_relations WHERE relationship != 'co-occurred'"
    ).get() as { count: number }).count;

    cooccurredCount = (entityDb.prepare(
      "SELECT COUNT(*) as count FROM entity_relations WHERE relationship = 'co-occurred'"
    ).get() as { count: number }).count;
  } catch {
    result.issues.push('Cannot read entity_relations');
    result.grade = grade(0, 100);
    return result;
  }

  const totalRels = typedCount + cooccurredCount;
  result.details.push(`Typed relationships: ${typedCount}`);
  result.details.push(`Co-occurrence links: ${cooccurredCount}`);
  result.details.push(`Total: ${totalRels}`);

  if (totalRels === 0) {
    result.issues.push('No relationships at all');
    result.grade = grade(0, 100);
    return result;
  }

  const cooccurrenceRatio = cooccurredCount / totalRels;
  result.details.push(`Co-occurrence ratio: ${(cooccurrenceRatio * 100).toFixed(1)}%`);
  const ratioScore = Math.max(0, 50 * (1 - cooccurrenceRatio));

  // Noise co-occurrences
  let noiseCooccurrences = 0;
  try {
    const noiseCo = entityDb.prepare(`
      SELECT COUNT(*) as count FROM entity_relations r
      JOIN entities e1 ON r.source_id = e1.id
      JOIN entities e2 ON r.target_id = e2.id
      WHERE r.relationship = 'co-occurred'
        AND (e1.name IN ('curl', 'bash', 'sandbox', 'sandbox permissions', 'max turns limit')
          OR e2.name IN ('curl', 'bash', 'sandbox', 'sandbox permissions', 'max turns limit'))
    `).get() as { count: number };
    noiseCooccurrences = noiseCo.count;
  } catch { /* skip */ }

  if (noiseCooccurrences > 0) {
    result.issues.push(`${noiseCooccurrences} co-occurrence links involve noise entities — polluting the graph`);
  }
  const noiseScore = Math.max(0, 50 - noiseCooccurrences);

  result.score = Math.round(ratioScore + noiseScore);
  result.grade = grade(result.score, result.maxScore);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVAL 3: TIMELINE SIGNAL/NOISE
// ═══════════════════════════════════════════════════════════════════════════════

function evalTimelineQuality(timelineDb: Database): EvalResult {
  const result: EvalResult = {
    name: 'Timeline Signal/Noise',
    score: 0,
    maxScore: 100,
    grade: 'F',
    details: [],
    issues: [],
  };

  const events = timelineDb.prepare('SELECT * FROM timeline_events').all() as TimelineEvent[];

  if (events.length === 0) {
    result.issues.push('Timeline is empty');
    result.grade = grade(0, 100);
    return result;
  }

  // Channel diversity
  const byChannel: Record<string, number> = {};
  for (const e of events) {
    const channel = e.source_path.split('://')[1]?.split('/')[0] || 'unknown';
    byChannel[channel] = (byChannel[channel] || 0) + 1;
  }
  result.details.push(
    `Channel distribution: ${Object.entries(byChannel).map(([k, v]) => `${k}=${v}`).join(', ')}`
  );

  const dominantChannel = Object.entries(byChannel).sort((a, b) => b[1] - a[1])[0];
  const dominanceRatio = dominantChannel[1] / events.length;
  const diversityScore = Math.max(0, 25 * (1 - dominanceRatio + 0.3));
  if (dominanceRatio > 0.7) {
    result.issues.push(
      `Timeline dominated by "${dominantChannel[0]}" channel (${(dominanceRatio * 100).toFixed(0)}%) — knowledge from other channels underrepresented`
    );
  }

  // Repetitive content
  const titleCounts: Record<string, number> = {};
  for (const e of events) {
    const normalized = e.title.replace(/\[.*?\]\s*/, '').trim().toLowerCase();
    titleCounts[normalized] = (titleCounts[normalized] || 0) + 1;
  }
  const repetitiveGroups = Object.entries(titleCounts).filter(([, c]) => c > 3);
  const repetitiveCount = repetitiveGroups.reduce((s, [, c]) => s + c, 0);
  const repetitionScore = Math.max(0, 25 * (1 - repetitiveCount / events.length));
  result.details.push(`Repetitive entries: ${repetitiveCount}/${events.length}`);
  for (const [title, count] of repetitiveGroups) {
    result.issues.push(`"${title}" appears ${count} times — should be consolidated`);
  }

  // Summary coverage
  const withSummary = events.filter((e) => e.summary && e.summary.length > 20);
  const summaryRatio = withSummary.length / events.length;
  const summaryScore = Math.min(25, summaryRatio * 30);
  result.details.push(
    `Events with meaningful summaries: ${withSummary.length}/${events.length} (${(summaryRatio * 100).toFixed(0)}%)`
  );
  if (summaryRatio < 0.5) {
    result.issues.push('Less than 50% of events have meaningful summaries');
  }

  // Tag coverage
  const withTags = events.filter((e) => {
    try {
      const tags = JSON.parse(e.tags_json || '[]');
      return Array.isArray(tags) && tags.length > 0;
    } catch {
      return false;
    }
  });
  const tagRatio = withTags.length / events.length;
  const tagScore = Math.min(25, tagRatio * 30);
  result.details.push(`Events with tags: ${withTags.length}/${events.length} (${(tagRatio * 100).toFixed(0)}%)`);

  result.score = Math.round(diversityScore + repetitionScore + summaryScore + tagScore);
  result.grade = grade(result.score, result.maxScore);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVAL 4: MEMORY EDGE QUALITY
// ═══════════════════════════════════════════════════════════════════════════════

function evalEdgeQuality(sleepDb: Database): EvalResult {
  const result: EvalResult = {
    name: 'Memory Edge Quality',
    score: 0,
    maxScore: 100,
    grade: 'F',
    details: [],
    issues: [],
  };

  let edges: MemoryEdge[];
  try {
    edges = sleepDb.prepare('SELECT * FROM memory_edges').all() as MemoryEdge[];
  } catch {
    result.issues.push('memory_edges table not found');
    result.grade = grade(0, 100);
    return result;
  }

  if (edges.length === 0) {
    result.issues.push('No memory edges — link step may not be running');
    result.grade = grade(0, 100);
    return result;
  }

  result.details.push(`Total edges: ${edges.length}`);

  // Relation type diversity
  const relationTypes: Record<string, number> = {};
  for (const e of edges) {
    relationTypes[e.relation] = (relationTypes[e.relation] || 0) + 1;
  }
  const typeCount = Object.keys(relationTypes).length;
  const relTypeScore = Math.min(25, typeCount * 10);
  result.details.push(
    `Relation types: ${Object.entries(relationTypes).map(([k, v]) => `${k}=${v}`).join(', ')}`
  );
  if (typeCount <= 1) {
    result.issues.push('All edges are same type — no semantic variety (link step only creates "related")');
  }

  // Confidence distribution
  const confidences = edges.map((e) => e.confidence);
  const avgConf = confidences.reduce((s, c) => s + c, 0) / confidences.length;
  const maxConf = Math.max(...confidences);
  const minConf = Math.min(...confidences);
  const confRange = maxConf - minConf;
  const confDistScore = Math.min(25, confRange * 40);
  result.details.push(
    `Confidence: avg=${avgConf.toFixed(2)}, min=${minConf.toFixed(2)}, max=${maxConf.toFixed(2)}, range=${confRange.toFixed(2)}`
  );
  const saturated = confidences.filter((c) => c >= 0.95).length;
  if (saturated / edges.length > 0.3) {
    result.issues.push(
      `${((saturated / edges.length) * 100).toFixed(0)}% of edges have saturated confidence (>=0.95) — boosts stacking too aggressively`
    );
  }

  // Cross-domain connectivity
  const pathChannels = new Set<string>();
  for (const e of edges) {
    const fromCh = e.from_path.split('://')[1]?.split('/')[0] || 'unknown';
    const toCh = e.to_path.split('://')[1]?.split('/')[0] || 'unknown';
    pathChannels.add(`${fromCh}->${toCh}`);
  }
  const crossDomain = [...pathChannels].filter((p) => {
    const [from, to] = p.split('->');
    return from !== to;
  });
  const crossDomainScore = Math.min(25, crossDomain.length * 10);
  result.details.push(`Cross-domain edges: ${crossDomain.length} types (${[...pathChannels].join(', ')})`);
  if (crossDomain.length === 0) {
    result.issues.push('No cross-channel edges — memories from different channels are isolated');
  }

  // Node coverage
  const uniqueNodes = new Set<string>();
  for (const e of edges) {
    uniqueNodes.add(e.from_path);
    uniqueNodes.add(e.to_path);
  }
  const coverageScore = Math.min(25, (uniqueNodes.size / edges.length) * 50);
  result.details.push(`Unique nodes connected: ${uniqueNodes.size}`);

  result.score = Math.round(relTypeScore + confDistScore + crossDomainScore + coverageScore);
  result.grade = grade(result.score, result.maxScore);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVAL 5: TIER & DECAY EFFECTIVENESS
// ═══════════════════════════════════════════════════════════════════════════════

function evalTierDecay(timelineDb: Database): EvalResult {
  const result: EvalResult = {
    name: 'Tier & Decay Effectiveness',
    score: 0,
    maxScore: 100,
    grade: 'F',
    details: [],
    issues: [],
  };

  const events = timelineDb.prepare('SELECT * FROM timeline_events').all() as TimelineEvent[];

  if (events.length === 0) {
    result.issues.push('No events to evaluate');
    result.grade = grade(0, 100);
    return result;
  }

  // Tier distribution
  const byTier: Record<string, number> = {};
  for (const e of events) {
    byTier[e.tier || 'null'] = (byTier[e.tier || 'null'] || 0) + 1;
  }
  result.details.push(
    `Tier distribution: ${Object.entries(byTier).map(([k, v]) => `${k}=${v}`).join(', ')}`
  );
  const tierCount = Object.keys(byTier).filter((t) => t !== 'null').length;
  const tierDiversityScore = Math.min(33, tierCount * 11);
  if (!byTier['archive'] || byTier['archive'] === 0) {
    result.issues.push('No items in archive tier — decay is too slow or thresholds are wrong');
  }

  // Priority distribution
  const priorities = events.map((e) => e.priority || 0);
  const avgPriority = priorities.reduce((s, p) => s + p, 0) / priorities.length;
  const priorityRange = Math.max(...priorities) - Math.min(...priorities);
  const priorityScore = Math.min(33, priorityRange * 40);
  result.details.push(
    `Priority: avg=${avgPriority.toFixed(2)}, min=${Math.min(...priorities).toFixed(2)}, max=${Math.max(...priorities).toFixed(2)}, range=${priorityRange.toFixed(2)}`
  );
  if (priorityRange < 0.3) {
    result.issues.push('Priority range is narrow — decay not creating enough differentiation');
  }

  // Decay score effectiveness
  const decayScores = events.map((e) => e.decay_score || 0);
  const maxDecay = Math.max(...decayScores);
  const decayScore = Math.min(34, maxDecay * 50);
  result.details.push(`Decay: avg=${(decayScores.reduce((s, d) => s + d, 0) / decayScores.length).toFixed(3)}, max=${maxDecay.toFixed(3)}`);
  if (maxDecay < 0.1) {
    result.issues.push(`Max decay score is only ${maxDecay.toFixed(3)} — rate too slow to be meaningful`);
  }

  // Access tracking
  const accessed = events.filter((e) => (e.access_count || 0) > 0);
  result.details.push(
    `Events accessed via search/recall: ${accessed.length}/${events.length} (${((accessed.length / events.length) * 100).toFixed(0)}%)`
  );
  if (accessed.length / events.length < 0.2) {
    result.issues.push('Very few events accessed — search/recall underused or access tracking broken');
  }

  result.score = Math.round(tierDiversityScore + priorityScore + decayScore);
  result.grade = grade(result.score, result.maxScore);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVAL 6: SLEEP AGENT HEALTH
// ═══════════════════════════════════════════════════════════════════════════════

function evalSleepAgent(sleepDb: Database): EvalResult {
  const result: EvalResult = {
    name: 'Sleep Agent Health',
    score: 0,
    maxScore: 100,
    grade: 'F',
    details: [],
    issues: [],
  };

  // Run history
  let runs: Array<{ status: string; count: number }>;
  try {
    runs = sleepDb.prepare('SELECT status, COUNT(*) as count FROM sleep_runs GROUP BY status').all() as Array<{ status: string; count: number }>;
  } catch {
    result.issues.push('sleep_runs table not found');
    result.grade = grade(0, 100);
    return result;
  }

  const totalRuns = runs.reduce((s, r) => s + r.count, 0);
  const completedRuns = runs.find((r) => r.status === 'completed')?.count || 0;
  const failedRuns = runs.find((r) => r.status === 'failed')?.count || 0;
  const successRate = totalRuns > 0 ? completedRuns / totalRuns : 0;
  const runScore = Math.min(25, successRate * 25);
  result.details.push(
    `Sleep runs: ${totalRuns} total, ${completedRuns} completed, ${failedRuns} failed (${(successRate * 100).toFixed(0)}% success)`
  );

  // Step telemetry
  let stepStats: Array<{ step: string; count: number; avg_ms: number; total_count: number }> = [];
  try {
    stepStats = sleepDb.prepare(`
      SELECT step, COUNT(*) as count, AVG(duration_ms) as avg_ms,
             SUM(CAST(json_extract(metadata, '$.count') AS INTEGER)) as total_count
      FROM sleep_telemetry GROUP BY step
    `).all() as Array<{ step: string; count: number; avg_ms: number; total_count: number }>;
  } catch { /* table may not exist */ }

  let stepScore = 0;
  for (const step of stepStats) {
    const avgItems = (step.total_count || 0) / (step.count || 1);
    result.details.push(
      `Step "${step.step}": ${step.count} runs, avg ${step.avg_ms.toFixed(0)}ms, avg items/run: ${avgItems.toFixed(1)}`
    );
    if (avgItems < 0.1 && step.count > 10) {
      result.issues.push(`Step "${step.step}" rarely produces results (${avgItems.toFixed(2)} items/run over ${step.count} runs)`);
    } else {
      stepScore += 5;
    }
  }
  stepScore = Math.min(25, stepScore);

  // Entity hygiene
  let hygieneScore = 0;
  try {
    const hygieneMetrics = sleepDb.prepare(`
      SELECT metadata FROM sleep_telemetry
      WHERE step = 'entity-hygiene' AND metadata IS NOT NULL
      ORDER BY rowid DESC LIMIT 5
    `).all() as Array<{ metadata: string }>;

    if (hygieneMetrics.length > 0) {
      let totalMerged = 0;
      let totalPruned = 0;
      for (const m of hygieneMetrics) {
        try {
          const data = JSON.parse(m.metadata);
          totalMerged += data.merged || 0;
          totalPruned += data.pruned || 0;
        } catch { /* skip */ }
      }
      result.details.push(`Recent hygiene: ${totalMerged} merges, ${totalPruned} prunes in last 5 runs`);
      hygieneScore = totalMerged > 0 || totalPruned > 0 ? 25 : 10;
    } else {
      result.details.push('No entity hygiene telemetry found');
    }
  } catch { /* skip */ }

  // Maintenance queue
  let queueSize = 0;
  try {
    const q = sleepDb.prepare("SELECT COUNT(*) as count FROM maintenance_queue WHERE status != 'processed'").get() as { count: number } | undefined;
    queueSize = q?.count || 0;
  } catch { /* skip */ }
  result.details.push(`Pending maintenance queue items: ${queueSize}`);
  const queueScore = queueSize > 50 ? 10 : 25;
  if (queueSize > 50) {
    result.issues.push(`${queueSize} items in maintenance queue — sleep agent may be falling behind`);
  }

  result.score = Math.round(runScore + stepScore + hygieneScore + queueScore);
  result.grade = grade(result.score, result.maxScore);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVAL 7: FACT STORE QUALITY
// ═══════════════════════════════════════════════════════════════════════════════

function evalFactStore(timelineDb: Database): EvalResult {
  const result: EvalResult = {
    name: 'Fact Store Quality',
    score: 0,
    maxScore: 100,
    grade: 'F',
    details: [],
    issues: [],
  };

  // Check if facts table exists
  let totalFacts = 0;
  try {
    totalFacts = (timelineDb.prepare('SELECT COUNT(*) as c FROM facts').get() as { c: number }).c;
  } catch {
    result.issues.push('No facts table — fact extraction not set up');
    result.grade = grade(0, 100);
    return result;
  }

  if (totalFacts === 0) {
    result.issues.push('No facts extracted — run a sleep cycle to populate');
    result.grade = grade(0, 100);
    return result;
  }

  result.details.push(`Total facts: ${totalFacts}`);

  // --- Fact count score (more facts = better coverage) ---
  const countScore = Math.min(20, totalFacts); // 1 point per fact up to 20
  if (totalFacts < 10) {
    result.issues.push('Fewer than 10 facts — limited memory coverage');
  }

  // --- Category diversity (should have facts in multiple categories) ---
  const categories = timelineDb.prepare(
    'SELECT category, COUNT(*) as cnt FROM facts GROUP BY category ORDER BY cnt DESC'
  ).all() as Array<{ category: string; cnt: number }>;
  const categoryCount = categories.length;
  const categoryScore = Math.min(20, categoryCount * 3); // 3 points per category up to 20
  result.details.push(`Categories: ${categories.map(c => `${c.category}=${c.cnt}`).join(', ')}`);
  if (categoryCount < 3) {
    result.issues.push('Facts in fewer than 3 categories — extraction may be too narrow');
  }

  // --- Entity coverage (facts should mention named entities) ---
  let factsWithEntities = 0;
  try {
    factsWithEntities = (timelineDb.prepare(
      "SELECT COUNT(*) as c FROM facts WHERE entities_json != '[]' AND entities_json IS NOT NULL AND LENGTH(entities_json) > 2"
    ).get() as { c: number }).c;
  } catch { /* skip */ }
  const entityCoverageRatio = totalFacts > 0 ? factsWithEntities / totalFacts : 0;
  const entityCoverageScore = Math.min(20, Math.round(entityCoverageRatio * 25));
  result.details.push(`Facts with entities: ${factsWithEntities}/${totalFacts} (${(entityCoverageRatio * 100).toFixed(0)}%)`);
  if (entityCoverageRatio < 0.5) {
    result.issues.push('Less than 50% of facts have entity annotations');
  }

  // --- Supersession tracking (should have some contradictions detected) ---
  let supersededCount = 0;
  try {
    supersededCount = (timelineDb.prepare(
      'SELECT COUNT(*) as c FROM facts WHERE is_latest = 0'
    ).get() as { c: number }).c;
  } catch { /* skip */ }
  const latestCount = totalFacts - supersededCount;
  // Having SOME superseded facts means contradiction detection is working
  const contradictionScore = supersededCount > 0 ? 15 : (totalFacts > 20 ? 0 : 10);
  result.details.push(`Current facts: ${latestCount}, superseded: ${supersededCount}`);
  if (supersededCount === 0 && totalFacts > 20) {
    result.issues.push('No superseded facts — contradiction detection may not be running');
  }

  // --- FTS index health ---
  let ftsCount = 0;
  try {
    ftsCount = (timelineDb.prepare('SELECT COUNT(*) as c FROM facts_fts').get() as { c: number }).c;
  } catch {
    result.issues.push('Facts FTS index missing — fact search will not work');
  }
  const ftsRatio = totalFacts > 0 ? ftsCount / totalFacts : 0;
  const ftsScore = ftsRatio >= 0.9 ? 15 : Math.round(ftsRatio * 15);
  result.details.push(`FTS indexed: ${ftsCount}/${totalFacts} (${(ftsRatio * 100).toFixed(0)}%)`);
  if (ftsRatio < 0.9) {
    result.issues.push(`Only ${(ftsRatio * 100).toFixed(0)}% of facts in FTS index — run reindex`);
  }

  // --- Conversation coverage (what % of conversations have facts extracted) ---
  let convsWithFacts = 0;
  let totalConvs = 0;
  try {
    totalConvs = (timelineDb.prepare(
      "SELECT COUNT(*) as c FROM timeline_events WHERE type = 'conversation' AND source_path NOT LIKE '%/seg_%'"
    ).get() as { c: number }).c;
    convsWithFacts = (timelineDb.prepare(
      "SELECT COUNT(DISTINCT source_conversation_id) as c FROM facts"
    ).get() as { c: number }).c;
  } catch { /* skip */ }
  const convCoverageRatio = totalConvs > 0 ? convsWithFacts / totalConvs : 0;
  const convCoverageScore = Math.min(10, Math.round(convCoverageRatio * 12));
  result.details.push(`Conversations with facts: ${convsWithFacts}/${totalConvs} (${(convCoverageRatio * 100).toFixed(0)}%)`);
  if (convCoverageRatio < 0.5) {
    result.issues.push('Less than 50% of conversations have facts extracted');
  }

  result.score = Math.round(countScore + categoryScore + entityCoverageScore + contradictionScore + ftsScore + convCoverageScore);
  result.grade = grade(result.score, result.maxScore);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVAL 8: USER PROFILE
// ═══════════════════════════════════════════════════════════════════════════════

function evalUserProfile(root: string): EvalResult {
  const result: EvalResult = {
    name: 'User Profile',
    score: 0,
    maxScore: 100,
    grade: 'F',
    details: [],
    issues: [],
  };

  const profilePath = join(root, 'data', 'user-profile.json');
  if (!existsSync(profilePath)) {
    result.issues.push('No user profile generated — run a sleep cycle');
    result.grade = grade(0, 100);
    return result;
  }

  let profile: any;
  try {
    profile = JSON.parse(readFileSync(profilePath, 'utf-8'));
  } catch {
    result.issues.push('User profile is corrupted or unreadable');
    result.grade = grade(0, 100);
    return result;
  }

  // --- Profile exists ---
  const existsScore = 20;
  result.details.push(`Profile generated: ${profile.generated_at || 'unknown'}`);

  // --- Freshness (generated within last 2 hours) ---
  let freshnessScore = 0;
  if (profile.generated_at) {
    const ageMinutes = (Date.now() - new Date(profile.generated_at).getTime()) / (1000 * 60);
    freshnessScore = ageMinutes < 120 ? 20 : (ageMinutes < 1440 ? 10 : 0);
    result.details.push(`Profile age: ${Math.round(ageMinutes)} minutes`);
    if (ageMinutes > 1440) {
      result.issues.push('Profile is older than 24 hours — sleep agent may not be refreshing');
    }
  }

  // --- Section coverage ---
  const sections = profile.sections || {};
  const sectionNames = ['identity', 'preferences', 'relationships', 'current_plans', 'recent_events'];
  let populatedSections = 0;
  for (const name of sectionNames) {
    const items = sections[name] || [];
    if (items.length > 0) populatedSections++;
  }
  const sectionScore = Math.min(30, populatedSections * 6);
  result.details.push(`Populated sections: ${populatedSections}/5 (${sectionNames.filter(n => (sections[n] || []).length > 0).join(', ')})`);
  if (populatedSections < 3) {
    result.issues.push('Fewer than 3 profile sections populated — limited user context');
  }

  // --- Fact count in profile ---
  const factCount = profile.fact_count || 0;
  const factScore = Math.min(15, factCount);
  result.details.push(`Facts in profile: ${factCount}`);

  // --- Top entities ---
  const topEntities = profile.top_entities || [];
  const entityScore = Math.min(15, topEntities.length * 2);
  result.details.push(`Top entities tracked: ${topEntities.length}`);

  result.score = Math.min(100, Math.round(existsScore + freshnessScore + sectionScore + factScore + entityScore));
  result.grade = grade(result.score, result.maxScore);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

function runEval(root: string): EvalReport {
  const dataDir = join(root, 'data');
  const results: EvalResult[] = [];

  const entityDb = new Database(join(dataDir, 'entity-graph.db'), { readonly: true });
  const timelineDb = new Database(join(dataDir, 'timeline.db'), { readonly: true });
  const sleepDb = new Database(join(dataDir, 'sleep.db'), { readonly: true });

  try {
    results.push(evalEntityQuality(entityDb));
    results.push(evalCooccurrencePollution(entityDb));
    results.push(evalTimelineQuality(timelineDb));
    results.push(evalEdgeQuality(sleepDb));
    results.push(evalTierDecay(timelineDb));
    results.push(evalSleepAgent(sleepDb));
    results.push(evalFactStore(timelineDb));
    results.push(evalUserProfile(root));
  } finally {
    entityDb.close();
    timelineDb.close();
    sleepDb.close();
  }

  const totalScore = results.reduce((s, r) => s + r.score, 0);
  const totalMax = results.reduce((s, r) => s + r.maxScore, 0);
  const overallPct = Math.round((totalScore / totalMax) * 100);

  return {
    agent: root,
    timestamp: new Date().toISOString(),
    results,
    totalScore,
    totalMax,
    overallGrade: grade(totalScore, totalMax),
    overallPct,
  };
}

function printReport(report: EvalReport): void {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  KyberBot Memory System Evaluation');
  console.log(`  Agent: ${report.agent}`);
  console.log(`  Date: ${report.timestamp}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  for (const r of report.results) {
    const pct = ((r.score / r.maxScore) * 100).toFixed(0);
    const bar = '\u2588'.repeat(Math.round(r.score / 5)) + '\u2591'.repeat(Math.round((r.maxScore - r.score) / 5));

    console.log(`\u250C\u2500 ${r.name} \u2500 ${r.grade} (${r.score}/${r.maxScore} = ${pct}%)`);
    console.log(`\u2502  ${bar}`);

    for (const d of r.details) {
      console.log(`\u2502  \u00B7 ${d}`);
    }

    if (r.issues.length > 0) {
      console.log('\u2502');
      console.log('\u2502  Issues:');
      for (const issue of r.issues) {
        console.log(`\u2502  \u26A0 ${issue}`);
      }
    }

    console.log('\u2514' + '\u2500'.repeat(70));
    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  OVERALL: ${report.overallGrade} \u2014 ${report.totalScore}/${report.totalMax} (${report.overallPct}%)`);
  console.log('═══════════════════════════════════════════════════════════════');

  const allIssues = report.results.flatMap((r) => r.issues.map((i) => ({ eval: r.name, issue: i })));
  if (allIssues.length > 0) {
    console.log('');
    console.log('Top Recommendations:');
    for (const issue of allIssues.slice(0, 10)) {
      console.log(`  \u2192 [${issue.eval}] ${issue.issue}`);
    }
  }

  console.log('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND
// ═══════════════════════════════════════════════════════════════════════════════

interface EvalOptions {
  root?: string;
  json?: boolean;
  fix?: boolean;
  locomo?: string;
  conversations?: string;
  categories?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA CLEANUP (--fix)
// ═══════════════════════════════════════════════════════════════════════════════

function runDataCleanup(root: string): void {
  const dataDir = join(root, 'data');
  const entityDb = new Database(join(dataDir, 'entity-graph.db'));
  const timelineDb = new Database(join(dataDir, 'timeline.db'));

  try {
    console.log('\nRunning data cleanup...\n');

    // 1. Delete co-occurred relationships
    const cooccurredBefore = (entityDb.prepare(
      "SELECT COUNT(*) as count FROM entity_relations WHERE relationship = 'co-occurred'"
    ).get() as { count: number }).count;

    if (cooccurredBefore > 0) {
      entityDb.prepare("DELETE FROM entity_relations WHERE relationship = 'co-occurred'").run();
      console.log(`  Removed ${cooccurredBefore} co-occurrence relationships`);
    }

    // 2. Delete noise entities
    let noiseDeleted = 0;
    const entities = entityDb.prepare('SELECT id, name, type FROM entities').all() as Array<{ id: number; name: string; type: string }>;
    for (const e of entities) {
      if (isNoiseEntity(e.name)) {
        entityDb.prepare('DELETE FROM entity_mentions WHERE entity_id = ?').run(e.id);
        entityDb.prepare('DELETE FROM entity_relations WHERE source_id = ? OR target_id = ?').run(e.id, e.id);
        entityDb.prepare('DELETE FROM entities WHERE id = ?').run(e.id);
        noiseDeleted++;
      }
    }
    if (noiseDeleted > 0) {
      console.log(`  Removed ${noiseDeleted} noise entities`);
    }

    // 3. Reclassify technologies from project to topic
    let reclassified = 0;
    const techEntities = entityDb.prepare(
      "SELECT id, normalized_name FROM entities WHERE type = 'project'"
    ).all() as Array<{ id: number; normalized_name: string }>;

    for (const e of techEntities) {
      if (TECHNOLOGY_NAMES.has(e.normalized_name)) {
        // Check if a topic with the same name already exists
        const existing = entityDb.prepare(
          "SELECT id FROM entities WHERE normalized_name = ? AND type = 'topic'"
        ).get(e.normalized_name) as { id: number } | undefined;

        if (existing) {
          // Merge: move mentions and relations from project entity to existing topic entity
          entityDb.prepare('UPDATE entity_mentions SET entity_id = ? WHERE entity_id = ?').run(existing.id, e.id);
          entityDb.prepare('UPDATE entity_relations SET source_id = ? WHERE source_id = ?').run(existing.id, e.id);
          entityDb.prepare('UPDATE entity_relations SET target_id = ? WHERE target_id = ?').run(existing.id, e.id);
          // Delete self-references
          entityDb.prepare('DELETE FROM entity_relations WHERE source_id = target_id').run();
          entityDb.prepare('DELETE FROM entities WHERE id = ?').run(e.id);
        } else {
          entityDb.prepare("UPDATE entities SET type = 'topic' WHERE id = ?").run(e.id);
        }
        reclassified++;
      }
    }
    if (reclassified > 0) {
      console.log(`  Reclassified ${reclassified} technology entities from project to topic`);
    }

    // 4. Consolidate duplicate timeline entries
    let consolidated = 0;
    const titleGroups = timelineDb.prepare(`
      SELECT
        TRIM(REPLACE(
          CASE WHEN INSTR(title, '] ') > 0
            THEN SUBSTR(title, INSTR(title, '] ') + 2)
            ELSE title
          END,
          '...', ''
        )) as normalized_title,
        COUNT(*) as cnt,
        GROUP_CONCAT(id) as ids
      FROM timeline_events
      WHERE (is_pinned IS NULL OR is_pinned = 0)
      GROUP BY normalized_title
      HAVING COUNT(*) >= 3
      ORDER BY cnt DESC
    `).all() as Array<{ normalized_title: string; cnt: number; ids: string }>;

    for (const group of titleGroups) {
      const ids = group.ids.split(',').map(Number);
      if (ids.length < 2) continue;

      const keepId = ids[ids.length - 1];
      const removeIds = ids.slice(0, -1);

      timelineDb.prepare(`
        UPDATE timeline_events
        SET access_count = COALESCE(access_count, 0) + ?
        WHERE id = ?
      `).run(removeIds.length, keepId);

      timelineDb.prepare(`
        DELETE FROM timeline_events WHERE id IN (${removeIds.join(',')})
      `).run();

      consolidated += removeIds.length;
    }
    if (consolidated > 0) {
      console.log(`  Consolidated ${consolidated} duplicate timeline entries`);
    }

    // Summary
    const entitiesAfter = (entityDb.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number }).c;
    const relationsAfter = (entityDb.prepare('SELECT COUNT(*) as c FROM entity_relations').get() as { c: number }).c;
    const eventsAfter = (timelineDb.prepare('SELECT COUNT(*) as c FROM timeline_events').get() as { c: number }).c;

    console.log(`\n  After cleanup:`);
    console.log(`    Entities: ${entitiesAfter}`);
    console.log(`    Relations: ${relationsAfter}`);
    console.log(`    Timeline events: ${eventsAfter}`);
    console.log('');
  } finally {
    entityDb.close();
    timelineDb.close();
  }
}

async function handleEval(options: EvalOptions) {
  // ── LoCoMo benchmark mode ──────────────────────────────────────────
  if (options.locomo) {
    const dataPath = resolve(options.locomo);
    if (!existsSync(dataPath)) {
      console.error(`Error: LoCoMo dataset not found at ${dataPath}`);
      process.exit(1);
    }

    const { runLoCoMoBenchmark } = await import('../brain/eval/locomo.js');

    const locomoOptions: {
      dataPath: string;
      maxConversations?: number;
      categories?: number[];
      verbose: boolean;
    } = {
      dataPath,
      verbose: true,
    };

    if (options.conversations) {
      locomoOptions.maxConversations = parseInt(options.conversations);
    }
    if (options.categories) {
      locomoOptions.categories = options.categories.split(',').map(Number);
    }

    try {
      const result = await runLoCoMoBenchmark(locomoOptions);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log('');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('  LoCoMo Benchmark Results');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('');
        console.log(`  Overall: ${(result.overall.accuracy * 100).toFixed(1)}% (${result.overall.count} questions)`);
        console.log('');
        console.log('  By Category:');
        const catNames: Record<number, string> = {
          1: 'Multi-hop',
          2: 'Temporal',
          3: 'Open-domain',
          4: 'Single-hop',
          5: 'Adversarial',
        };
        for (const [cat, data] of Object.entries(result.byCategory)) {
          const name = catNames[Number(cat)] || `Cat ${cat}`;
          console.log(`    ${name} (${cat}): ${(data.accuracy * 100).toFixed(1)}% (${data.count} questions)`);
        }
        console.log('');
        console.log('  By Conversation:');
        for (const [convId, data] of Object.entries(result.byConversation)) {
          console.log(`    ${convId}: ${(data.accuracy * 100).toFixed(1)}% (${data.count} questions)`);
        }
        console.log('');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('');
      }
    } catch (error) {
      console.error(`LoCoMo benchmark failed: ${error}`);
      process.exit(1);
    }
    return;
  }

  // ── Standard eval mode ─────────────────────────────────────────────
  let root: string;

  if (options.root) {
    root = resolve(options.root);
  } else {
    try {
      root = getRoot();
    } catch {
      console.error('Error: Could not find KyberBot root. Use --root to specify an agent directory.');
      process.exit(1);
    }
  }

  const dataDir = join(root, 'data');
  if (!existsSync(join(dataDir, 'entity-graph.db'))) {
    console.error(`Error: No entity-graph.db found at ${dataDir}. Is this a KyberBot agent?`);
    process.exit(1);
  }
  if (!existsSync(join(dataDir, 'timeline.db'))) {
    console.error(`Error: No timeline.db found at ${dataDir}.`);
    process.exit(1);
  }
  if (!existsSync(join(dataDir, 'sleep.db'))) {
    console.error(`Error: No sleep.db found at ${dataDir}.`);
    process.exit(1);
  }

  try {
    if (options.fix) {
      runDataCleanup(root);
    }

    const report = runEval(root);

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
    }
  } catch (error) {
    console.error(`Error: ${error}`);
    process.exit(1);
  }
}

export function createEvalCommand(): Command {
  return new Command('eval')
    .description('Evaluate long-term memory quality (entity graph, timeline, sleep agent)')
    .option('-r, --root <path>', 'Agent directory to evaluate (default: current agent)')
    .option('--json', 'Output results as JSON', false)
    .option('--fix', 'Run retroactive data cleanup before eval', false)
    .option('--locomo <path>', 'Run LoCoMo benchmark against dataset file')
    .option('--conversations <n>', 'Limit LoCoMo to first N conversations')
    .option('--categories <list>', 'LoCoMo categories to evaluate (e.g., "1,2,4")')
    .action(handleEval);
}
