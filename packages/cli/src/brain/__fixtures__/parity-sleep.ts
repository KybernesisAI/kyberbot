/**
 * Sleep-parity engineered fixtures (Harness 3).
 *
 * Unlike Harness 1/2 fixtures (which test reads on a steady-state corpus),
 * these are designed to *trigger* each sleep step:
 *
 *   - decay:           memories + facts backdated 120+ days, some with
 *                      expires_at in the past
 *   - tag:             memories with content the LLM should tag distinctly
 *   - consolidate:     deliberate near-duplicate memories
 *   - link:            memories sharing entity sets (link discovers cross-refs)
 *   - tier:            mix of fresh / aged / pinned memories so tier shifts fire
 *   - summarize:       a long-content memory the LLM should summarize down
 *   - observe:         conversation-type memory with extractable facts
 *   - profile:         entities with ≥3 mentions (profile threshold)
 *   - reasoning:       entities with related fact patterns
 *   - entity-hygiene:  variant-name entity pairs (Bob/Robert) to merge
 *
 * Timestamps are relative to a fixed `NOW` constant so the fixture is
 * deterministic regardless of wall clock.
 *
 * Related: docs/plans/2026-05-24-data-parity-matrix.md §Harness 3
 */

import type { FactCategory } from '../fact-store.js';
import type { EntityType, RelationshipType } from '../entity-graph.js';
import type { EventType } from '../timeline.js';

// Anchor "now" for deterministic backdating. Harness uses these timestamps
// directly; sleep steps compare them against `datetime('now')` at runtime,
// so the gap is what triggers decay/tier moves.
const DAYS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.parse('2026-05-24T12:00:00Z');
const at = (daysAgo: number) => new Date(NOW_MS - daysAgo * DAYS).toISOString();

// ── Entities (some with variant spellings for entity-hygiene merge) ─────────

export interface ParitySleepEntityFixture {
  id: string;
  name: string;
  type: EntityType;
  /** Pre-seeded mention_count to push profile / reasoning thresholds. */
  initialMentions?: number;
  /** Marks this fixture as a deliberate variant of another (for hygiene merge tests). */
  variantOf?: string;
}

export const PARITY_SLEEP_ENTITIES: ReadonlyArray<ParitySleepEntityFixture> = [
  // Core entities with enough mentions to trigger profile + reasoning
  { id: 'se-alice',   name: 'Alice',   type: 'person',  initialMentions: 6 },
  { id: 'se-bob',     name: 'Bob',     type: 'person',  initialMentions: 5 },
  { id: 'se-carol',   name: 'Carol',   type: 'person',  initialMentions: 4 },
  { id: 'se-acme',    name: 'Acme',    type: 'company', initialMentions: 7 },
  { id: 'se-postgres',name: 'Postgres',type: 'topic',   initialMentions: 4 },

  // Variant pairs for entity-hygiene merge tests
  { id: 'se-robert',  name: 'Robert',  type: 'person',  initialMentions: 2, variantOf: 'se-bob' },
  { id: 'se-bobby',   name: 'Bobby',   type: 'person',  initialMentions: 1, variantOf: 'se-bob' },

  // Single-mention entity (below profile threshold — shouldn't get a profile)
  { id: 'se-yosemite',name: 'Yosemite',type: 'place',   initialMentions: 1 },
];

// ── Edges (typed; trigger link-step refinement) ─────────────────────────────

export interface ParitySleepEdgeFixture {
  id: string;
  sourceFixtureId: string;
  targetFixtureId: string;
  relationship: RelationshipType;
}

export const PARITY_SLEEP_EDGES: ReadonlyArray<ParitySleepEdgeFixture> = [
  { id: 'sle-alice-acme',  sourceFixtureId: 'se-alice', targetFixtureId: 'se-acme', relationship: 'works_at'   },
  { id: 'sle-bob-acme',    sourceFixtureId: 'se-bob',   targetFixtureId: 'se-acme', relationship: 'works_at'   },
  { id: 'sle-carol-acme',  sourceFixtureId: 'se-carol', targetFixtureId: 'se-acme', relationship: 'works_at'   },
  { id: 'sle-bob-alice',   sourceFixtureId: 'se-bob',   targetFixtureId: 'se-alice', relationship: 'reports_to' },
];

// ── Memories (engineered to trigger each step) ──────────────────────────────

export interface ParitySleepMemoryFixture {
  id: string;
  title: string;
  summary: string;
  type: EventType;
  /** ISO timestamp — backdated values trigger decay / tier moves. */
  timestamp: string;
  entities: string[];
  topics: string[];
  /** If set, this memory is intentionally near-duplicate of another (for consolidate). */
  duplicateOf?: string;
}

export const PARITY_SLEEP_MEMORIES: ReadonlyArray<ParitySleepMemoryFixture> = [
  // ── Fresh hot-tier candidates (today, high engagement entities) ───────────
  { id: 'sm-fresh-1', type: 'conversation', timestamp: at(1),
    title: 'Today: Postgres planning at Acme',
    summary: 'Alice and Bob discussed the Postgres rollout schedule for Acme. Decision: phased cutover starting next month.',
    entities: ['Alice', 'Bob', 'Acme', 'Postgres'], topics: ['planning', 'database'] },

  { id: 'sm-fresh-2', type: 'conversation', timestamp: at(2),
    title: 'Today: Carol marketing review',
    summary: 'Carol presented the marketing roadmap. Focus on developer-led acquisition for Acme.',
    entities: ['Carol', 'Acme'], topics: ['marketing'] },

  // ── Aged memories (>120 days — should decay + tier-shift toward archive) ──
  { id: 'sm-aged-1', type: 'note', timestamp: at(150),
    title: 'Old: legacy auth migration',
    summary: 'Notes from the legacy auth migration. Alice owned the cutover. Two outages during the rollout.',
    entities: ['Alice'], topics: ['migration', 'auth'] },

  { id: 'sm-aged-2', type: 'note', timestamp: at(200),
    title: 'Old: Postgres index audit',
    summary: 'Audit of Postgres index bloat after the 2025 upgrade. Bob ran VACUUM ANALYZE across analytics schema.',
    entities: ['Bob', 'Postgres'], topics: ['database', 'performance'] },

  { id: 'sm-aged-3', type: 'note', timestamp: at(300),
    title: 'Old: original architecture decisions',
    summary: 'The original Acme platform architecture rationale. Service boundaries, deployment topology, on-call rotation.',
    entities: ['Acme', 'Alice', 'Bob'], topics: ['architecture'] },

  // ── Deliberate near-duplicates (should consolidate) ──────────────────────
  { id: 'sm-dup-1a', type: 'note', timestamp: at(10),
    title: 'Postgres maintenance window',
    summary: 'Postgres maintenance window scheduled Sunday 2am UTC. Bob owns. Expected duration 30 minutes.',
    entities: ['Bob', 'Postgres'], topics: ['maintenance'] },

  { id: 'sm-dup-1b', type: 'note', timestamp: at(10),
    title: 'Postgres maintenance window',
    summary: 'Postgres maintenance window scheduled Sunday 2am UTC. Bob owns. Expected duration 30 minutes.',
    entities: ['Bob', 'Postgres'], topics: ['maintenance'],
    duplicateOf: 'sm-dup-1a' },

  { id: 'sm-dup-2a', type: 'conversation', timestamp: at(5),
    title: 'Alice on Q3 priorities',
    summary: 'Alice flagged Q3 priorities: ship Postgres migration, finalise marketing redesign, hire two engineers.',
    entities: ['Alice', 'Postgres'], topics: ['planning'] },

  { id: 'sm-dup-2b', type: 'conversation', timestamp: at(5),
    title: 'Alice on Q3 priorities',
    summary: 'Alice flagged Q3 priorities: ship Postgres migration, finalise marketing redesign, hire two engineers.',
    entities: ['Alice', 'Postgres'], topics: ['planning'],
    duplicateOf: 'sm-dup-2a' },

  // ── Entity-rich cluster (should trigger link discovery) ───────────────────
  { id: 'sm-link-1', type: 'conversation', timestamp: at(15),
    title: 'Alice Bob Acme planning',
    summary: 'Alice and Bob met to discuss Acme platform direction. Postgres, Kubernetes, growth headcount on the table.',
    entities: ['Alice', 'Bob', 'Acme', 'Postgres'], topics: ['planning'] },

  { id: 'sm-link-2', type: 'conversation', timestamp: at(20),
    title: 'Bob Carol launch playbook',
    summary: 'Bob and Carol aligned on the v3 launch playbook. Demand-gen feeds engineering deploy schedule.',
    entities: ['Bob', 'Carol', 'Acme'], topics: ['launch'] },

  { id: 'sm-link-3', type: 'conversation', timestamp: at(25),
    title: 'Alice Carol marketing kickoff',
    summary: 'Alice and Carol launched the marketing-eng partnership. OKRs synced quarterly.',
    entities: ['Alice', 'Carol', 'Acme'], topics: ['marketing'] },

  // ── Long-content memory (should summarize) ────────────────────────────────
  { id: 'sm-long-1', type: 'note', timestamp: at(7),
    title: 'Comprehensive Q3 strategy doc',
    summary: 'The Q3 strategy ranges across product, marketing, and infrastructure. Product: ship the Postgres migration ' +
      'by end of August, finalise the Kubernetes multi-cluster topology, complete the SSO integration. Marketing: ' +
      'redesign the website landing page, launch developer-led acquisition campaigns, hire a content lead. ' +
      'Infrastructure: complete the observability rollout, finalise the on-call rotation, evaluate Postgres 16 ' +
      'logical replication for the analytics cluster. Hiring: two senior engineers, one marketing lead, one ' +
      'designer. Alice owns product, Carol owns marketing, Bob owns infrastructure. Weekly cross-team sync at ' +
      '10am Wednesdays. Quarterly OKR review end of September.',
    entities: ['Alice', 'Bob', 'Carol', 'Acme', 'Postgres'], topics: ['strategy', 'planning'] },

  // ── Conversation with extractable facts (for observe step) ────────────────
  { id: 'sm-obs-1', type: 'conversation', timestamp: at(3),
    title: 'Conversation: Bob mentioned new role',
    summary: 'In the standup, Bob mentioned he is moving from individual contributor to engineering manager next month. Carol congratulated him.',
    entities: ['Bob', 'Carol'], topics: ['career'] },
];

// ── Facts (some with past expires_at to trigger decay-expiration) ───────────

export interface ParitySleepFactFixture {
  id: string;
  content: string;
  entities: string[];
  category: FactCategory;
  confidence: number;
  timestamp: string;
  /** If set in the past, decay step will mark is_latest = 0. */
  expiresAt?: string;
}

export const PARITY_SLEEP_FACTS: ReadonlyArray<ParitySleepFactFixture> = [
  // Fresh facts (no decay action)
  { id: 'sf-1', content: 'Alice is CTO at Acme',
    entities: ['Alice', 'Acme'], category: 'biographical', confidence: 0.95, timestamp: at(2) },
  { id: 'sf-2', content: 'Bob is senior engineer at Acme',
    entities: ['Bob', 'Acme'], category: 'biographical', confidence: 0.92, timestamp: at(2) },
  { id: 'sf-3', content: 'Carol leads marketing at Acme',
    entities: ['Carol', 'Acme'], category: 'biographical', confidence: 0.90, timestamp: at(2) },

  // Aged AI-extracted facts (will get confidence decayed)
  { id: 'sf-aged-1', content: 'Acme uses Postgres for analytics',
    entities: ['Acme', 'Postgres'], category: 'general', confidence: 0.80, timestamp: at(120) },
  { id: 'sf-aged-2', content: 'Alice prefers Postgres for analytical workloads',
    entities: ['Alice', 'Postgres'], category: 'preference', confidence: 0.70, timestamp: at(150) },

  // Expired facts (will be marked is_latest = 0)
  { id: 'sf-exp-1', content: 'Quarterly OKR review on 2026-03-31',
    entities: ['Acme'], category: 'temporal', confidence: 0.95, timestamp: at(60),
    expiresAt: at(30) },
  { id: 'sf-exp-2', content: 'Bob temporary on-call coverage through 2026-04-15',
    entities: ['Bob'], category: 'temporal', confidence: 0.90, timestamp: at(50),
    expiresAt: at(40) },
];

// ── Constants for harness consumers ─────────────────────────────────────────

export const PARITY_SLEEP_NOW_ISO = new Date(NOW_MS).toISOString();
