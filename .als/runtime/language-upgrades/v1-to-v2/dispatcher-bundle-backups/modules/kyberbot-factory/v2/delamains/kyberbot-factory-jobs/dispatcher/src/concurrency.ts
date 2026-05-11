import type { DispatchEntry } from "./dispatcher.js";
import {
  countStateConcurrencyOccupancy,
  listPoolConcurrencyHolders,
  type RuntimeConcurrencyHolderRecord,
  type RuntimeDispatchSummary,
} from "./runtime-state.js";

export interface ConcurrencySnapshot {
  stateCounts: Map<string, number>;
  poolCounts: Map<string, number>;
  poolHolders: Map<string, RuntimeConcurrencyHolderRecord[]>;
}

export type DispatchConcurrencySuppression =
  | {
    blockedBy: "state";
    currentCount: number;
    concurrencyLimit: number;
  }
  | {
    blockedBy: "pool";
    currentCount: number;
    concurrencyLimit: number;
    poolId: string;
    poolStates: string[];
    poolHolders: RuntimeConcurrencyHolderRecord[];
  };

export function buildConcurrencySnapshot(
  summary: RuntimeDispatchSummary,
  dispatchTable: ReadonlyArray<DispatchEntry>,
): ConcurrencySnapshot {
  const stateCounts = new Map<string, number>();
  const poolCounts = new Map<string, number>();
  const poolHolders = new Map<string, RuntimeConcurrencyHolderRecord[]>();

  for (const entry of dispatchTable) {
    if (entry.concurrency !== undefined && !stateCounts.has(entry.state)) {
      stateCounts.set(entry.state, countStateConcurrencyOccupancy(summary, entry.state));
    }

    if (entry.pool && !poolCounts.has(entry.pool.id)) {
      const holders = listPoolConcurrencyHolders(summary, entry.pool.states);
      poolCounts.set(entry.pool.id, holders.length);
      poolHolders.set(entry.pool.id, holders);
    }
  }

  return {
    stateCounts,
    poolCounts,
    poolHolders,
  };
}

export function evaluateDispatchConcurrency(
  rule: DispatchEntry,
  snapshot: ConcurrencySnapshot,
): DispatchConcurrencySuppression | null {
  const stateCount = snapshot.stateCounts.get(rule.state) ?? 0;
  const stateBlocked = rule.concurrency !== undefined && stateCount >= rule.concurrency;

  if (rule.pool) {
    const poolCount = snapshot.poolCounts.get(rule.pool.id) ?? 0;
    if (poolCount >= rule.pool.capacity) {
      return {
        blockedBy: "pool",
        currentCount: poolCount,
        concurrencyLimit: rule.pool.capacity,
        poolId: rule.pool.id,
        poolStates: [...rule.pool.states],
        poolHolders: [...(snapshot.poolHolders.get(rule.pool.id) ?? [])],
      };
    }
  }

  if (stateBlocked) {
    return {
      blockedBy: "state",
      currentCount: stateCount,
      concurrencyLimit: rule.concurrency!,
    };
  }

  return null;
}

export function reserveDispatchConcurrency(
  rule: DispatchEntry,
  snapshot: ConcurrencySnapshot,
  holder?: RuntimeConcurrencyHolderRecord,
): void {
  if (rule.concurrency !== undefined) {
    snapshot.stateCounts.set(
      rule.state,
      (snapshot.stateCounts.get(rule.state) ?? 0) + 1,
    );
  }

  if (!rule.pool) {
    return;
  }

  snapshot.poolCounts.set(
    rule.pool.id,
    (snapshot.poolCounts.get(rule.pool.id) ?? 0) + 1,
  );

  if (!holder) {
    return;
  }

  const holders = snapshot.poolHolders.get(rule.pool.id) ?? [];
  holders.push(holder);
  snapshot.poolHolders.set(rule.pool.id, holders);
}
