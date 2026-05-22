/**
 * Stable fact fixtures for the Arcana factRetrieval parity harness.
 *
 * Both sides of the harness (KB fact-retrieval baseline + Arcana
 * factRetrieval candidate) seed from this same array so any divergence
 * in retrieval ordering reflects implementation difference, not data drift.
 *
 * Design notes:
 * - 32 facts spanning all 8 KB FactCategory values (≥3 per category).
 * - Entities deliberately reused across facts so entity-expansion and
 *   graph-bridge layers have structure to bite on (e.g. Alice ↔ Acme ↔ Bob).
 * - Two clusters: a "work" cluster (Alice, Bob, Acme, Postgres, Kubernetes)
 *   and a "personal" cluster (Alice, hiking, Yosemite). Alice bridges them
 *   so cross-cluster expansion is observable.
 * - Timestamps are deterministic — fixed 2026-04-01 .. 2026-04-30 spread.
 * - `id` is the stable suffix used to mint `source_path` + conversation_id;
 *   the harness uses it to address rows post-insertion.
 *
 * Related: docs/plans/2026-05-22-arcana-fact-retrieval-parity-harness.md
 */

import type { FactCategory } from '../fact-store.js';

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
