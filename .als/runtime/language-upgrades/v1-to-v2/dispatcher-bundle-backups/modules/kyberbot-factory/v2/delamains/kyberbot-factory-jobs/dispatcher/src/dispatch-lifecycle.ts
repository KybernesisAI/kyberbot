import {
  emptyProviderDispatchCounts,
  incrementProviderDispatchCount,
  type AgentProvider,
  type ProviderDispatchCounts,
} from "./provider.js";

export interface ObservedDispatchItem {
  id: string;
  status: string;
}

export interface GuardedDispatchHeartbeatItem {
  item_id: string;
  state: string;
  provider: AgentProvider;
  guarded_at: string;
}

export interface DispatcherHeartbeatState {
  active_dispatches: number;
  active_by_provider: ProviderDispatchCounts;
  guarded_dispatches: number;
  guarded_items: GuardedDispatchHeartbeatItem[];
}

export interface StatusChangeRelease {
  itemId: string;
  previousStatus: string;
  nextStatus: string;
  releasedActive: boolean;
  releasedGuarded: boolean;
}

export interface DispatchCompletion {
  itemId: string;
  state: string;
  success: boolean;
  provider: AgentProvider;
  guardedAtMs?: number;
}

export type DispatchCompletionDisposition =
  | "released_after_failure"
  | "guarded"
  | "ignored_stale";

interface DispatchOwnershipState {
  state: string;
  provider: AgentProvider;
  guardedAtMs: number;
}

export class DispatchLifecycle {
  private readonly lastSeen = new Map<string, string>();
  private readonly active = new Map<string, DispatchOwnershipState>();
  private readonly guarded = new Map<string, DispatchOwnershipState>();

  reconcile(items: ReadonlyArray<ObservedDispatchItem>): StatusChangeRelease[] {
    const releases: StatusChangeRelease[] = [];

    for (const item of items) {
      const previousStatus = this.lastSeen.get(item.id);
      if (previousStatus && previousStatus !== item.status) {
        const released = this.release(item.id);
        releases.push({
          itemId: item.id,
          previousStatus,
          nextStatus: item.status,
          ...released,
        });
      }

      this.lastSeen.set(item.id, item.status);
    }

    return releases;
  }

  isGuarded(itemId: string): boolean {
    return this.active.has(itemId) || this.guarded.has(itemId);
  }

  markDispatchStarted(itemId: string, state: string, provider: AgentProvider): void {
    this.active.set(itemId, {
      state,
      provider,
      guardedAtMs: Date.now(),
    });
  }

  completeDispatch({
    itemId,
    state,
    success,
    provider,
    guardedAtMs = Date.now(),
  }: DispatchCompletion): DispatchCompletionDisposition {
    if (!success) {
      this.active.delete(itemId);
      return "released_after_failure";
    }

    const activeState = this.active.get(itemId);
    const currentStatus = this.lastSeen.get(itemId);

    if (!activeState || activeState.state !== state || (currentStatus && currentStatus !== state)) {
      this.release(itemId);
      return "ignored_stale";
    }

    this.active.delete(itemId);
    this.guarded.set(itemId, {
      state,
      provider,
      guardedAtMs,
    });
    return "guarded";
  }

  counts(): { active: number; guarded: number } {
    return {
      active: this.active.size,
      guarded: this.guarded.size,
    };
  }

  activeItemIds(): string[] {
    return [...this.active.keys()].sort();
  }

  heartbeat(): DispatcherHeartbeatState {
    const activeByProvider = emptyProviderDispatchCounts();
    for (const record of this.active.values()) {
      incrementProviderDispatchCount(activeByProvider, record.provider);
    }

    const guardedItems = [...this.guarded.entries()]
      .sort((a, b) => {
        const [itemA, stateA] = a;
        const [itemB, stateB] = b;
        if (stateA.guardedAtMs !== stateB.guardedAtMs) {
          return stateA.guardedAtMs - stateB.guardedAtMs;
        }
        return itemA.localeCompare(itemB);
      })
      .map(([itemId, state]) => ({
        item_id: itemId,
        state: state.state,
        provider: state.provider,
        guarded_at: new Date(state.guardedAtMs).toISOString(),
      }));

    return {
      active_dispatches: this.active.size,
      active_by_provider: activeByProvider,
      guarded_dispatches: guardedItems.length,
      guarded_items: guardedItems,
    };
  }

  private release(itemId: string): { releasedActive: boolean; releasedGuarded: boolean } {
    const releasedActive = this.active.delete(itemId);
    const releasedGuarded = this.guarded.delete(itemId);

    return { releasedActive, releasedGuarded };
  }
}
