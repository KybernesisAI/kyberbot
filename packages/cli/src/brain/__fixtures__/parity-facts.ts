/**
 * Stable fixtures for Cortex read-parity harnesses.
 *
 * PARITY_FACTS — for factRetrieval (Harness 1 baseline, Harness 2 getFactsForEntity).
 * PARITY_ENTITIES — for entity-graph reads (listEntities, getNeighbors, getEntityProfile).
 * PARITY_EDGES — entity-entity edges seeded via linkEntities.
 * PARITY_MEMORIES — timeline events for hybridSearch.
 * PARITY_QUERIES — queries for factRetrieval (Harness 1).
 * PARITY_MEMORY_QUERIES — queries for hybridSearch (Harness 2).
 * PARITY_ENTITY_QUERIES — entity names for per-entity read checks (Harness 2).
 *
 * Design notes:
 * - Same two clusters: "work" (Alice, Bob, Acme, Postgres, Kubernetes) and
 *   "personal" (Alice, David, Yosemite). Alice bridges them.
 * - Entities, edges, and memories deliberately overlap with facts so
 *   entity-expansion and graph-bridge layers have structure to exercise.
 * - Timestamps deterministic — fixed 2026-04-01 .. 2026-04-30 spread.
 * - `id` is the stable suffix used to address rows post-insertion.
 *
 * Related: docs/plans/2026-05-24-data-parity-matrix.md
 */

import type { FactCategory } from '../fact-store.js';
import type { EntityType, RelationshipType } from '../entity-graph.js';
import type { EventType } from '../timeline.js';

export interface ParityFactFixture {
  id: string;
  content: string;
  entities: string[];
  category: FactCategory;
  confidence: number;
  timestamp: string;
}

export const PARITY_FACTS: ReadonlyArray<ParityFactFixture> = [
  // ── biographical (work cluster) ─────────────────────────────────────────
  { id: 'bio-1',  content: 'Alice works at Acme as the CTO',                          entities: ['Alice', 'Acme'],         category: 'biographical', confidence: 0.95, timestamp: '2026-04-01T09:00:00Z' },
  { id: 'bio-2',  content: 'Bob is a senior engineer at Acme reporting to Alice',     entities: ['Bob', 'Acme', 'Alice'],  category: 'biographical', confidence: 0.92, timestamp: '2026-04-02T09:00:00Z' },
  { id: 'bio-3',  content: 'Carol joined Acme as VP of Marketing in March 2026',       entities: ['Carol', 'Acme'],         category: 'biographical', confidence: 0.88, timestamp: '2026-04-03T09:00:00Z' },
  { id: 'bio-4',  content: 'Alice lives in Berkeley California',                       entities: ['Alice', 'Berkeley'],     category: 'biographical', confidence: 0.85, timestamp: '2026-04-04T09:00:00Z' },

  // ── preference ──────────────────────────────────────────────────────────
  { id: 'pref-1', content: 'Alice prefers Postgres over MySQL for analytical workloads', entities: ['Alice', 'Postgres', 'MySQL'], category: 'preference', confidence: 0.80, timestamp: '2026-04-05T09:00:00Z' },
  { id: 'pref-2', content: 'Bob prefers Kubernetes for production deployments',          entities: ['Bob', 'Kubernetes'],          category: 'preference', confidence: 0.78, timestamp: '2026-04-06T09:00:00Z' },
  { id: 'pref-3', content: 'Carol likes data-driven roadmaps with quarterly OKRs',       entities: ['Carol'],                      category: 'preference', confidence: 0.72, timestamp: '2026-04-07T09:00:00Z' },
  { id: 'pref-4', content: 'Alice prefers hiking trails with elevation gain over flat walks', entities: ['Alice'],                category: 'preference', confidence: 0.70, timestamp: '2026-04-08T09:00:00Z' },

  // ── event ───────────────────────────────────────────────────────────────
  { id: 'evt-1',  content: 'Acme shipped the v3 release on April 10 2026',              entities: ['Acme'],                  category: 'event', confidence: 0.95, timestamp: '2026-04-10T09:00:00Z' },
  { id: 'evt-2',  content: 'Kubernetes cluster outage took down checkout for 23 minutes', entities: ['Kubernetes', 'Acme'],  category: 'event', confidence: 0.93, timestamp: '2026-04-11T14:00:00Z' },
  { id: 'evt-3',  content: 'Alice presented the architecture review on April 15',       entities: ['Alice'],                 category: 'event', confidence: 0.90, timestamp: '2026-04-15T09:00:00Z' },
  { id: 'evt-4',  content: 'Bob deployed the Postgres major-version upgrade',           entities: ['Bob', 'Postgres'],       category: 'event', confidence: 0.88, timestamp: '2026-04-16T09:00:00Z' },

  // ── relationship ────────────────────────────────────────────────────────
  { id: 'rel-1',  content: 'Alice is married to David since 2018',                       entities: ['Alice', 'David'],        category: 'relationship', confidence: 0.95, timestamp: '2026-04-17T09:00:00Z' },
  { id: 'rel-2',  content: 'Bob and Carol collaborated on the launch playbook',         entities: ['Bob', 'Carol'],          category: 'relationship', confidence: 0.82, timestamp: '2026-04-18T09:00:00Z' },
  { id: 'rel-3',  content: 'Alice mentors three junior engineers on the platform team', entities: ['Alice'],                 category: 'relationship', confidence: 0.78, timestamp: '2026-04-19T09:00:00Z' },

  // ── temporal ────────────────────────────────────────────────────────────
  { id: 'tmp-1',  content: 'Alice will travel to Tokyo for the Q3 offsite',              entities: ['Alice', 'Tokyo'],        category: 'temporal', confidence: 0.85, timestamp: '2026-04-20T09:00:00Z' },
  { id: 'tmp-2',  content: 'The Postgres maintenance window is scheduled for Sunday 2am UTC', entities: ['Postgres'],         category: 'temporal', confidence: 0.90, timestamp: '2026-04-21T09:00:00Z' },
  { id: 'tmp-3',  content: 'Carols probation period ends in June 2026',                 entities: ['Carol'],                 category: 'temporal', confidence: 0.80, timestamp: '2026-04-22T09:00:00Z' },

  // ── opinion ─────────────────────────────────────────────────────────────
  { id: 'opn-1',  content: 'Alice thinks the new pricing model is too aggressive',      entities: ['Alice'],                 category: 'opinion', confidence: 0.65, timestamp: '2026-04-23T09:00:00Z' },
  { id: 'opn-2',  content: 'Bob believes Kubernetes is overkill for the staging cluster', entities: ['Bob', 'Kubernetes'],   category: 'opinion', confidence: 0.62, timestamp: '2026-04-24T09:00:00Z' },
  { id: 'opn-3',  content: 'Carol feels the marketing site needs a full redesign',      entities: ['Carol'],                 category: 'opinion', confidence: 0.60, timestamp: '2026-04-25T09:00:00Z' },

  // ── plan ────────────────────────────────────────────────────────────────
  { id: 'pln-1',  content: 'Acme plans to migrate analytics from MySQL to Postgres by EOY', entities: ['Acme', 'MySQL', 'Postgres'], category: 'plan', confidence: 0.85, timestamp: '2026-04-26T09:00:00Z' },
  { id: 'pln-2',  content: 'Alice plans to hike Half Dome in Yosemite this summer',      entities: ['Alice', 'Yosemite'],     category: 'plan', confidence: 0.75, timestamp: '2026-04-27T09:00:00Z' },
  { id: 'pln-3',  content: 'Bob plans to write a post-mortem on the Kubernetes outage', entities: ['Bob', 'Kubernetes'],     category: 'plan', confidence: 0.78, timestamp: '2026-04-28T09:00:00Z' },

  // ── general (catch-all + personal cluster) ──────────────────────────────
  { id: 'gen-1',  content: 'Yosemite National Park has over 800 miles of hiking trails', entities: ['Yosemite'],             category: 'general', confidence: 0.92, timestamp: '2026-04-12T09:00:00Z' },
  { id: 'gen-2',  content: 'Postgres 16 introduced parallel apply for logical replication', entities: ['Postgres'],          category: 'general', confidence: 0.90, timestamp: '2026-04-13T09:00:00Z' },
  { id: 'gen-3',  content: 'Berkeley has a vibrant hiking community in the East Bay hills', entities: ['Berkeley'],          category: 'general', confidence: 0.78, timestamp: '2026-04-14T09:00:00Z' },
  { id: 'gen-4',  content: 'Kubernetes 1.30 added native sidecar container support',     entities: ['Kubernetes'],            category: 'general', confidence: 0.88, timestamp: '2026-04-09T09:00:00Z' },
  { id: 'gen-5',  content: 'Acme runs its main workloads in us-west-2',                  entities: ['Acme'],                  category: 'general', confidence: 0.85, timestamp: '2026-04-29T09:00:00Z' },
  { id: 'gen-6',  content: 'Tokyo is nine hours ahead of Pacific Time',                  entities: ['Tokyo'],                 category: 'general', confidence: 0.95, timestamp: '2026-04-30T09:00:00Z' },
  { id: 'gen-7',  content: 'David and Alice hike together most weekends',                entities: ['David', 'Alice'],        category: 'general', confidence: 0.80, timestamp: '2026-04-05T18:00:00Z' },
];

export interface ParityQueryFixture {
  id: string;
  query: string;
  /** Hand-curated category filter for Layer 0 (optional). */
  category?: FactCategory;
}

export const PARITY_QUERIES: ReadonlyArray<ParityQueryFixture> = [
  { id: 'q-alice',         query: 'What do we know about Alice' },
  { id: 'q-acme-postgres', query: 'Acme Postgres migration plans' },
  { id: 'q-kube-outage',   query: 'Kubernetes outage post-mortem' },
  { id: 'q-hiking',        query: 'Alice hiking plans' },
  { id: 'q-bob-prefs',     query: 'What does Bob prefer for infra' },
  { id: 'q-events-april',  query: 'What events happened at Acme in April' },
  { id: 'q-carol-role',    query: 'Carol marketing role and timeline' },
];

// ── Harness 2 fixtures — entity graph + memory reads ────────────────────────

export interface ParityEntityFixture {
  id: string;
  name: string;
  type: EntityType;
  timestamp: string;
}

export const PARITY_ENTITIES: ReadonlyArray<ParityEntityFixture> = [
  { id: 'ent-alice',      name: 'Alice',      type: 'person',  timestamp: '2026-04-01T09:00:00Z' },
  { id: 'ent-bob',        name: 'Bob',        type: 'person',  timestamp: '2026-04-01T09:00:00Z' },
  { id: 'ent-carol',      name: 'Carol',      type: 'person',  timestamp: '2026-04-01T09:00:00Z' },
  { id: 'ent-david',      name: 'David',      type: 'person',  timestamp: '2026-04-01T09:00:00Z' },
  { id: 'ent-acme',       name: 'Acme',       type: 'company', timestamp: '2026-04-01T09:00:00Z' },
  { id: 'ent-postgres',   name: 'Postgres',   type: 'topic',   timestamp: '2026-04-01T09:00:00Z' },
  { id: 'ent-kubernetes', name: 'Kubernetes', type: 'topic',   timestamp: '2026-04-01T09:00:00Z' },
  { id: 'ent-yosemite',   name: 'Yosemite',   type: 'place',   timestamp: '2026-04-01T09:00:00Z' },
];

export interface ParityEdgeFixture {
  id: string;
  sourceFixtureId: string;
  targetFixtureId: string;
  relationship: RelationshipType;
}

export const PARITY_EDGES: ReadonlyArray<ParityEdgeFixture> = [
  { id: 'edge-alice-acme',       sourceFixtureId: 'ent-alice',      targetFixtureId: 'ent-acme',       relationship: 'works_at'     },
  { id: 'edge-bob-acme',         sourceFixtureId: 'ent-bob',        targetFixtureId: 'ent-acme',       relationship: 'works_at'     },
  { id: 'edge-carol-acme',       sourceFixtureId: 'ent-carol',      targetFixtureId: 'ent-acme',       relationship: 'works_at'     },
  { id: 'edge-bob-alice',        sourceFixtureId: 'ent-bob',        targetFixtureId: 'ent-alice',      relationship: 'reports_to'   },
  { id: 'edge-alice-david',      sourceFixtureId: 'ent-alice',      targetFixtureId: 'ent-david',      relationship: 'related_to'   },
  { id: 'edge-bob-carol',        sourceFixtureId: 'ent-bob',        targetFixtureId: 'ent-carol',      relationship: 'partners_with' },
  { id: 'edge-acme-kubernetes',  sourceFixtureId: 'ent-acme',       targetFixtureId: 'ent-kubernetes', relationship: 'uses'         },
  { id: 'edge-bob-kubernetes',   sourceFixtureId: 'ent-bob',        targetFixtureId: 'ent-kubernetes', relationship: 'uses'         },
];

export interface ParityMemoryFixture {
  id: string;
  title: string;
  summary: string;
  type: EventType;
  timestamp: string;
  entities: string[];
  topics: string[];
}

export const PARITY_MEMORIES: ReadonlyArray<ParityMemoryFixture> = [
  {
    id: 'mem-1', type: 'conversation', timestamp: '2026-04-05T14:00:00Z',
    title: 'Postgres migration planning',
    summary: 'Alice led a planning session on migrating Acme analytics workloads from MySQL to Postgres before end of year. Agreed on phased cutover.',
    entities: ['Alice', 'Acme', 'Postgres', 'MySQL'], topics: ['migration', 'database'],
  },
  {
    id: 'mem-2', type: 'conversation', timestamp: '2026-04-11T16:00:00Z',
    title: 'Kubernetes outage post-mortem',
    summary: 'Bob and Alice conducted the post-mortem on the Kubernetes cluster outage. Root cause was a misconfigured node pool autoscaler. Checkout was down 23 minutes.',
    entities: ['Bob', 'Alice', 'Kubernetes', 'Acme'], topics: ['incident', 'post-mortem'],
  },
  {
    id: 'mem-3', type: 'conversation', timestamp: '2026-04-14T10:00:00Z',
    title: 'Weekend hiking trip discussion',
    summary: 'David and Alice are planning a Half Dome hike in Yosemite this summer. Discussed gear, trail permits, and logistics for the overnight trip.',
    entities: ['Alice', 'David', 'Yosemite'], topics: ['hiking', 'travel'],
  },
  {
    id: 'mem-4', type: 'note', timestamp: '2026-04-17T09:00:00Z',
    title: 'Q3 planning offsite notes',
    summary: 'Alice and Carol ran the Q3 planning offsite for Acme. Key themes: Postgres migration, Kubernetes reliability, Carol marketing roadmap with OKR targets.',
    entities: ['Alice', 'Carol', 'Acme', 'Postgres', 'Kubernetes'], topics: ['planning', 'strategy'],
  },
  {
    id: 'mem-5', type: 'conversation', timestamp: '2026-04-03T13:00:00Z',
    title: 'Carol marketing kickoff',
    summary: 'Carol held her first marketing all-hands at Acme. Introduced a data-driven roadmap approach with quarterly OKRs. Team is six people.',
    entities: ['Carol', 'Acme'], topics: ['marketing', 'onboarding'],
  },
  {
    id: 'mem-6', type: 'note', timestamp: '2026-04-15T11:00:00Z',
    title: 'Architecture review session notes',
    summary: 'Alice presented the platform architecture review. Covered the Postgres vs MySQL trade-offs for analytical workloads and the Kubernetes multi-cluster proposal.',
    entities: ['Alice', 'Acme', 'Postgres', 'Kubernetes'], topics: ['architecture'],
  },
  {
    id: 'mem-7', type: 'note', timestamp: '2026-04-20T09:00:00Z',
    title: 'Kubernetes cluster upgrade plan',
    summary: 'Bob documented the plan to upgrade the Kubernetes cluster to 1.30 to use native sidecar containers. Includes a maintenance window and rollback procedure.',
    entities: ['Bob', 'Kubernetes'], topics: ['infrastructure', 'upgrade'],
  },
  {
    id: 'mem-8', type: 'conversation', timestamp: '2026-04-22T18:00:00Z',
    title: 'Yosemite trip logistics',
    summary: 'Alice and David finalised logistics for the Yosemite hiking trip: permits, gear list, and camping spots. Trip planned for late July.',
    entities: ['Alice', 'David', 'Yosemite'], topics: ['hiking', 'travel'],
  },
  {
    id: 'mem-9', type: 'note', timestamp: '2026-04-18T10:00:00Z',
    title: 'Bob and Carol launch playbook',
    summary: 'Bob and Carol collaborated on the v3 release launch playbook for Acme. Carol owns demand gen; Bob owns deploy runbook.',
    entities: ['Bob', 'Carol', 'Acme'], topics: ['launch', 'collaboration'],
  },
  {
    id: 'mem-10', type: 'conversation', timestamp: '2026-04-16T15:00:00Z',
    title: 'Database performance review',
    summary: 'Alice and Bob reviewed Postgres query performance after the major-version upgrade. Index bloat was the main issue. Bob will run VACUUM ANALYZE on the analytics schema.',
    entities: ['Alice', 'Bob', 'Postgres'], topics: ['database', 'performance'],
  },
];

export interface ParityMemoryQueryFixture {
  id: string;
  query: string;
}

export const PARITY_MEMORY_QUERIES: ReadonlyArray<ParityMemoryQueryFixture> = [
  { id: 'mq-postgres',    query: 'Postgres database migration planning' },
  { id: 'mq-kube',        query: 'Kubernetes outage cluster incident' },
  { id: 'mq-hiking',      query: 'hiking Yosemite Alice David weekend' },
  { id: 'mq-planning',    query: 'Acme Q3 planning Carol strategy' },
  { id: 'mq-arch-review', query: 'architecture review platform notes' },
];

export interface ParityEntityQueryFixture {
  id: string;
  entityName: string;
}

export const PARITY_ENTITY_QUERIES: ReadonlyArray<ParityEntityQueryFixture> = [
  { id: 'eq-alice',      entityName: 'Alice'      },
  { id: 'eq-bob',        entityName: 'Bob'        },
  { id: 'eq-acme',       entityName: 'Acme'       },
  { id: 'eq-kubernetes', entityName: 'Kubernetes' },
];
