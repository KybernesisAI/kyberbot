/**
 * KyberBot — Sleep Agent Configuration
 */

export interface SleepConfig {
  intervalMinutes: number;
  initialDelayMinutes: number;

  batchSize: number;
  maxTagsPerRun: number;
  maxLinksPerRun: number;
  maxSummariesPerRun: number;

  decayRatePerHour: number;
  maxDecay: number;

  minConfidenceForLink: number;
  maxEdgesPerMemory: number;

  hotPriorityThreshold: number;
  warmPriorityThreshold: number;
  hotDecayThreshold: number;
  hotAccessDays: number;
  warmAccessDays: number;
  hotEdgeCount: number;
  warmEdgeCount: number;

  tagStaleDays: number;

  hotWarmSummarySentences: number;
  archiveSummarySentences: number;

  enableTagging: boolean;
  enableRewriting: boolean;

  enableEntityHygiene: boolean;
  maxMergesPerRun: number;
  hygieneConfidenceThreshold: number;
  pruneMinAgeDays: number;

  enableConsolidation: boolean;
  consolidationTitleThreshold: number;
  repetitiveDecayMultiplier: number;

  enableObservations: boolean;
  maxObservationsPerRun: number;

  enableFactExtraction: boolean;
  maxFactsPerRun: number;

  enableContradictionDetection: boolean;
  maxContradictionChecksPerRun: number;

  enableUserProfile: boolean;
  profileRefreshMinutes: number;

  enableReasoning: boolean;
  maxReasoningPerRun: number;
}

export const DEFAULT_CONFIG: SleepConfig = {
  // Run sleep maintenance every 3 hours by default. Each cycle does
  // multiple Claude (Haiku) calls per agent — running every hour on an
  // idle fleet was burning tokens for almost no new memory input.
  intervalMinutes: 180,
  initialDelayMinutes: 5,

  batchSize: 50,
  maxTagsPerRun: 5,
  maxLinksPerRun: 100,
  maxSummariesPerRun: 5,

  decayRatePerHour: 0.002,
  maxDecay: 1.0,

  minConfidenceForLink: 0.15,
  maxEdgesPerMemory: 5,

  hotPriorityThreshold: 0.65,
  warmPriorityThreshold: 0.3,
  hotDecayThreshold: 0.25,
  hotAccessDays: 3,
  warmAccessDays: 21,
  hotEdgeCount: 6,
  warmEdgeCount: 3,

  tagStaleDays: 7,

  hotWarmSummarySentences: 5,
  archiveSummarySentences: 3,

  enableTagging: true,
  enableRewriting: false,

  enableEntityHygiene: true,
  maxMergesPerRun: 3,
  hygieneConfidenceThreshold: 0.8,
  pruneMinAgeDays: 30,

  enableConsolidation: true,
  consolidationTitleThreshold: 3,
  repetitiveDecayMultiplier: 3.0,

  enableObservations: true,
  maxObservationsPerRun: 10,

  enableFactExtraction: true,
  maxFactsPerRun: 5,  // Keep low to avoid subprocess OOM in long-running servers

  enableContradictionDetection: true,
  maxContradictionChecksPerRun: 5,  // Each check spawns a Haiku subprocess

  enableUserProfile: true,
  profileRefreshMinutes: 60,

  enableReasoning: true,
  maxReasoningPerRun: 5,  // Process up to 5 entities per sleep cycle
};
