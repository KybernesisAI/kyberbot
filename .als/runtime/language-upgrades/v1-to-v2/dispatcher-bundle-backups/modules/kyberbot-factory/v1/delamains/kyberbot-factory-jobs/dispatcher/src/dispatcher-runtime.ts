import { buildDispatchCommitMessage } from "./dispatch-commit.js";
import { DispatchRegistry, type RegistryStatusRelease } from "./dispatch-registry.js";
import { readFrontmatterField } from "./frontmatter.js";
import {
  GitWorktreeIsolationStrategy,
  type IsolatedDispatch,
  type MountedSubmoduleWorktree,
} from "./git-worktree-isolation.js";
import { OrphanSweeper, type OrphanSweepSummary } from "./orphan-sweeper.js";
import { RepoMutationLock } from "./repo-mutation-lock.js";
import type {
  RuntimeDispatchRecord,
  RuntimeMountedSubmoduleRecord,
  RuntimeDispatchSummary,
} from "./runtime-state.js";
import type { ProviderDispatchCounts } from "./provider.js";
import type { DispatchEntry } from "./dispatcher.js";

export interface DispatcherRuntimeConfig {
  bundleRoot: string;
  systemRoot: string;
  delamainName: string;
  statusField: string;
  pollMs: number;
  worktreeRoot?: string;
  submodules?: string[];
}

export interface PreparedDispatch extends IsolatedDispatch {
  startedAt: string;
}

export interface FinalizeDispatchInput {
  prepared: PreparedDispatch;
  entry: DispatchEntry;
  sessionId: string | null;
  durationMs: number | null;
  numTurns: number | null;
  costUsd: number | null;
  success: boolean;
}

export interface FinalizeDispatchResult {
  success: boolean;
  blocked: boolean;
  finalState: string;
  mergeOutcome: "merged" | "blocked" | "no_changes" | "skipped";
  worktreeCommit: string | null;
  integratedCommit: string | null;
  mountedSubmodules: RuntimeMountedSubmoduleRecord[];
  incidentKind: string | null;
  incidentMessage: string | null;
}

export interface DispatcherRuntimeHeartbeat {
  active_dispatches: number;
  active_by_provider: ProviderDispatchCounts;
  blocked_dispatches: number;
  orphaned_dispatches: number;
  guarded_dispatches: number;
}

export const DIRTY_INTEGRATION_RETRY_LIMIT = 60;

const DIRTY_INTEGRATION_INCIDENT = "dirty_integration_checkout";
const PRIMARY_DIRTY_TIMEOUT_INCIDENT = "primary_dirty_timeout";

interface MergeBackPreparedDispatch {
  dispatchId: string;
  itemId: string;
  itemFile: string;
  isolatedItemFile: string;
  worktreePath: string;
  branchName: string;
  baseCommit: string;
  mountedSubmodules: MountedSubmoduleWorktree[];
}

interface MountedSubmoduleMergeMetadata {
  repoPath: string;
  worktreeCommit: string | null;
  integratedCommit: string | null;
}

interface MergeBackAttemptInput {
  prepared: MergeBackPreparedDispatch;
  entryState: string;
  finalState: string;
  sessionId: string | null;
  durationMs: number | null;
  numTurns: number | null;
  costUsd: number | null;
  commitMessage: string;
  hostWorktreeCommit: string | null;
  mountedSubmodules: MountedSubmoduleMergeMetadata[];
  dirtyRetryCount: number;
}

interface MergeBackAttemptOutcome {
  treeState: "clean" | "dirty";
  result: FinalizeDispatchResult;
}

export interface BlockedDirtyRetryResult {
  itemId: string;
  dispatchId: string;
  attempt: number;
  action: "blocked" | "timed_out" | "merged";
  previousIncidentKind: string;
  treeState: "clean" | "dirty";
  itemFile: string;
  isolatedItemFile: string | null;
  state: string;
  agentName: string;
  provider: RuntimeDispatchRecord["provider"];
  resumable: boolean;
  sessionField: string | null;
  transitionTargets: string[];
  worktreePath: string | null;
  branchName: string | null;
  sessionId: string | null;
  durationMs: number | null;
  numTurns: number | null;
  costUsd: number | null;
  mergeOutcome: FinalizeDispatchResult["mergeOutcome"];
  worktreeCommit: string | null;
  integratedCommit: string | null;
  mountedSubmodules: RuntimeMountedSubmoduleRecord[];
  incidentKind: string | null;
  incidentMessage: string | null;
}

export class DispatcherRuntime {
  private readonly registry: DispatchRegistry;
  private readonly isolation: GitWorktreeIsolationStrategy;
  private readonly repoMutationLock: RepoMutationLock;
  private readonly orphanSweeper: OrphanSweeper;
  private readonly statusField: string;
  private readonly delamainName: string;

  constructor(config: DispatcherRuntimeConfig) {
    this.registry = new DispatchRegistry(config.bundleRoot);
    this.isolation = new GitWorktreeIsolationStrategy({
      systemRoot: config.systemRoot,
      delamainName: config.delamainName,
      worktreeRoot: config.worktreeRoot,
      submodules: config.submodules ?? [],
    });
    this.repoMutationLock = new RepoMutationLock(config.systemRoot, {
      staleMs: Math.max(config.pollMs * 4, 60_000),
    });
    this.orphanSweeper = new OrphanSweeper(
      this.registry,
      this.isolation,
      this.repoMutationLock,
      {
        staleDispatchMs: Math.max(config.pollMs * 4, 60_000),
      },
    );
    this.statusField = config.statusField;
    this.delamainName = config.delamainName;
  }

  async prepareDispatch(
    itemId: string,
    itemFile: string,
    entry: DispatchEntry,
  ): Promise<PreparedDispatch | null> {
    const existing = await this.registry.getByItemId(itemId);
    if (existing) {
      return null;
    }

    const prepared = await this.isolation.prepareDispatch({
      dispatchId: buildDispatchId(),
      itemId,
      itemFile,
    });
    const record = buildActiveRecord(this.delamainName, prepared, entry);

    const claimed = await this.registry.create(record);
    if (!claimed) {
      await this.isolation.cleanupDispatch({
        worktreePath: prepared.worktreePath,
        branchName: prepared.branchName,
        mountedSubmodules: buildCleanupMountedSubmodules(prepared.mountedSubmodules),
      });
      return null;
    }

    return {
      ...prepared,
      startedAt: record.started_at,
    };
  }

  async touchDispatch(dispatchId: string): Promise<void> {
    await this.registry.touchDispatch(dispatchId);
  }

  async finalizeDispatch(input: FinalizeDispatchInput): Promise<FinalizeDispatchResult> {
    const finalState = await readFrontmatterField(
      input.prepared.isolatedItemFile,
      this.statusField,
    ) ?? input.entry.state;
    const inspection = await this.isolation.inspectWorktree({
      worktreePath: input.prepared.worktreePath,
      baseCommit: input.prepared.baseCommit,
      mountedSubmodules: input.prepared.mountedSubmodules.map((entry) => ({
        repo_path: entry.repoPath,
        worktree_path: entry.worktreePath,
        base_commit: entry.baseCommit,
      })),
    });

    if (!input.success) {
      if (inspection.pristine) {
        await this.isolation.cleanupDispatch({
          worktreePath: input.prepared.worktreePath,
          branchName: input.prepared.branchName,
          mountedSubmodules: buildCleanupMountedSubmodules(input.prepared.mountedSubmodules),
        });
        await this.registry.removeByItemId(input.prepared.itemId);
        return {
          success: false,
          blocked: false,
          finalState,
          mergeOutcome: "skipped",
          worktreeCommit: null,
          integratedCommit: null,
          mountedSubmodules: [],
          incidentKind: null,
          incidentMessage: null,
        };
      }

      const incidentMessage = "Agent run failed after mutating the isolated worktree";
      const mountedSubmodules = mergeMountedSubmoduleMetadata(
        input.prepared.mountedSubmodules,
        inspection.mountedSubmodules.map((entry) => ({
          repoPath: entry.repoPath,
          worktreeCommit: entry.headCommit,
          integratedCommit: null,
        })),
      );
      await this.registry.updateByItemId(input.prepared.itemId, (record) => ({
        ...record,
        status: "blocked",
        updated_at: new Date().toISOString(),
        latest_error: incidentMessage,
        latest_session_id: input.sessionId,
        latest_duration_ms: input.durationMs,
        latest_num_turns: input.numTurns,
        latest_cost_usd: input.costUsd,
        merge_outcome: "blocked",
        mounted_submodules: mountedSubmodules,
        incident: {
          kind: "dispatch_failed_dirty",
          message: incidentMessage,
          detected_at: new Date().toISOString(),
          retry_count: 0,
        },
      }));

      return {
        success: false,
        blocked: true,
        finalState,
        mergeOutcome: "blocked",
        worktreeCommit: inspection.headCommit,
        integratedCommit: null,
        mountedSubmodules,
        incidentKind: "dispatch_failed_dirty",
        incidentMessage,
      };
    }

    if (inspection.pristine) {
      await this.isolation.cleanupDispatch({
        worktreePath: input.prepared.worktreePath,
        branchName: input.prepared.branchName,
        mountedSubmodules: buildCleanupMountedSubmodules(input.prepared.mountedSubmodules),
      });
      await this.completeSuccessfulGuard({
        itemId: input.prepared.itemId,
        entryState: input.entry.state,
        finalState,
        sessionId: input.sessionId,
        durationMs: input.durationMs,
        numTurns: input.numTurns,
        costUsd: input.costUsd,
      }, null, null, "no_changes");
      return {
        success: true,
        blocked: false,
        finalState,
        mergeOutcome: "no_changes",
        worktreeCommit: null,
        integratedCommit: null,
        mountedSubmodules: [],
        incidentKind: null,
        incidentMessage: null,
      };
    }

    const commitMessage = buildDispatchCommitMessage({
      dispatchId: input.prepared.dispatchId,
      dispatcherName: this.delamainName,
      itemId: input.prepared.itemId,
      agentName: input.entry.agentName,
      fromState: input.entry.state,
      toState: finalState,
      durationMs: input.durationMs,
      numTurns: input.numTurns,
      costUsd: input.costUsd,
      sessionId: input.sessionId,
    });

    const mountedSubmoduleCommits: MountedSubmoduleMergeMetadata[] = [];
    for (const entry of input.prepared.mountedSubmodules) {
      const worktreeCommit = await this.isolation.commitDispatch(
        entry.worktreePath,
        entry.baseCommit,
        commitMessage,
      );
      mountedSubmoduleCommits.push({
        repoPath: entry.repoPath,
        worktreeCommit,
        integratedCommit: null,
      });
    }

    const hostWorktreeCommit = await this.isolation.commitDispatch(
      input.prepared.worktreePath,
      input.prepared.baseCommit,
      commitMessage,
    );

    return (
      await this.attemptMergeBack({
        prepared: input.prepared,
        entryState: input.entry.state,
        finalState,
        sessionId: input.sessionId,
        durationMs: input.durationMs,
        numTurns: input.numTurns,
        costUsd: input.costUsd,
        commitMessage,
        hostWorktreeCommit,
        mountedSubmodules: mountedSubmoduleCommits,
        dirtyRetryCount: 0,
      })
    ).result;
  }

  async retryBlockedDirtyDispatches(): Promise<BlockedDirtyRetryResult[]> {
    const records = await this.registry.list();
    const retryable = records.filter((record) => (
      record.status === "blocked"
      && record.incident?.kind === DIRTY_INTEGRATION_INCIDENT
    ));

    const results: BlockedDirtyRetryResult[] = [];
    for (const record of retryable) {
      results.push(await this.retryBlockedDirtyDispatch(record));
    }

    return results;
  }

  async reconcileObservedItems(
    items: ReadonlyArray<{ id: string; status: string }>,
  ): Promise<RegistryStatusRelease[]> {
    return this.registry.reconcileObservedItems(items);
  }

  async hasOpenRecord(itemId: string): Promise<boolean> {
    return (await this.registry.getByItemId(itemId)) !== null;
  }

  async openDispatchSummary(): Promise<RuntimeDispatchSummary> {
    return this.registry.summary();
  }

  async heartbeat(): Promise<DispatcherRuntimeHeartbeat> {
    const summary = await this.registry.summary();

    return {
      active_dispatches: summary.activeCount,
      active_by_provider: summary.activeByProvider,
      blocked_dispatches: summary.blockedCount,
      orphaned_dispatches: summary.orphanedCount,
      guarded_dispatches: summary.guardedCount,
    };
  }

  async sweepOrphans(): Promise<OrphanSweepSummary> {
    return this.orphanSweeper.sweep();
  }

  private async retryBlockedDirtyDispatch(
    record: RuntimeDispatchRecord,
  ): Promise<BlockedDirtyRetryResult> {
    const attempt = (record.incident?.retry_count ?? 0) + 1;

    try {
      const prepared = buildPreparedDispatchFromRecord(record);
      if (!prepared) {
        throw new Error("Blocked dispatch is missing merge-back metadata required for retry");
      }

      const finalState = await readFrontmatterField(
        prepared.isolatedItemFile,
        this.statusField,
      ) ?? record.state;
      const commitMessage = record.merge_message ?? buildDispatchCommitMessage({
        dispatchId: record.dispatch_id,
        dispatcherName: this.delamainName,
        itemId: record.item_id,
        agentName: record.agent_name,
        fromState: record.state,
        toState: finalState,
        durationMs: record.latest_duration_ms,
        numTurns: record.latest_num_turns,
        costUsd: record.latest_cost_usd,
        sessionId: record.latest_session_id,
      });

      const outcome = await this.attemptMergeBack({
        prepared,
        entryState: record.state,
        finalState,
        sessionId: record.latest_session_id,
        durationMs: record.latest_duration_ms,
        numTurns: record.latest_num_turns,
        costUsd: record.latest_cost_usd,
        commitMessage,
        hostWorktreeCommit: record.worktree_commit,
        mountedSubmodules: record.mounted_submodules.map((entry) => ({
          repoPath: entry.repo_path,
          worktreeCommit: entry.worktree_commit,
          integratedCommit: entry.integrated_commit,
        })),
        dirtyRetryCount: attempt,
      });

      return {
        itemId: record.item_id,
        dispatchId: record.dispatch_id,
        attempt,
        action: !outcome.result.blocked
          ? "merged"
          : outcome.result.incidentKind === PRIMARY_DIRTY_TIMEOUT_INCIDENT
            ? "timed_out"
            : "blocked",
        previousIncidentKind: DIRTY_INTEGRATION_INCIDENT,
        treeState: outcome.treeState,
        itemFile: record.item_file,
        isolatedItemFile: prepared.isolatedItemFile,
        state: record.state,
        agentName: record.agent_name,
        provider: record.provider,
        resumable: record.resumable,
        sessionField: record.session_field,
        transitionTargets: [...record.transition_targets],
        worktreePath: prepared.worktreePath,
        branchName: prepared.branchName,
        sessionId: record.latest_session_id,
        durationMs: record.latest_duration_ms,
        numTurns: record.latest_num_turns,
        costUsd: record.latest_cost_usd,
        mergeOutcome: outcome.result.mergeOutcome,
        worktreeCommit: outcome.result.worktreeCommit,
        integratedCommit: outcome.result.integratedCommit,
        mountedSubmodules: outcome.result.mountedSubmodules,
        incidentKind: outcome.result.incidentKind,
        incidentMessage: outcome.result.incidentMessage,
      };
    } catch (error) {
      const incidentMessage = error instanceof Error ? error.message : String(error);
      const now = new Date().toISOString();
      await this.registry.updateByItemId(record.item_id, (current) => ({
        ...current,
        status: "blocked",
        updated_at: now,
        latest_error: incidentMessage,
        merge_outcome: "blocked",
        merge_attempted_at: now,
        incident: {
          kind: "merge_back_failed",
          message: incidentMessage,
          detected_at: now,
          retry_count: 0,
        },
      }));

      return {
        itemId: record.item_id,
        dispatchId: record.dispatch_id,
        attempt,
        action: "blocked",
        previousIncidentKind: DIRTY_INTEGRATION_INCIDENT,
        treeState: "clean",
        itemFile: record.item_file,
        isolatedItemFile: record.isolated_item_file,
        state: record.state,
        agentName: record.agent_name,
        provider: record.provider,
        resumable: record.resumable,
        sessionField: record.session_field,
        transitionTargets: [...record.transition_targets],
        worktreePath: record.worktree_path,
        branchName: record.branch_name,
        sessionId: record.latest_session_id,
        durationMs: record.latest_duration_ms,
        numTurns: record.latest_num_turns,
        costUsd: record.latest_cost_usd,
        mergeOutcome: "blocked",
        worktreeCommit: record.worktree_commit,
        integratedCommit: record.integrated_commit,
        mountedSubmodules: record.mounted_submodules,
        incidentKind: "merge_back_failed",
        incidentMessage,
      };
    }
  }

  private async attemptMergeBack(
    input: MergeBackAttemptInput,
  ): Promise<MergeBackAttemptOutcome> {
    let hostWorktreeCommit = input.hostWorktreeCommit;
    let refreshedMountedSubmodules = input.mountedSubmodules;
    let treeState: "clean" | "dirty" = "clean";

    const mergeResult = await this.repoMutationLock.withLease(
      {
        dispatch_id: input.prepared.dispatchId,
        dispatcher_name: this.delamainName,
        item_id: input.prepared.itemId,
        worktree_path: input.prepared.worktreePath,
      },
      async () => {
        const refreshResult = await this.isolation.refreshMergeBack({
          prepared: input.prepared,
          hostWorktreeCommit,
          mountedSubmodules: refreshedMountedSubmodules,
          commitMessage: input.commitMessage,
        });
        hostWorktreeCommit = refreshResult.hostWorktreeCommit;
        refreshedMountedSubmodules = refreshResult.mountedSubmodules;
        treeState = refreshResult.status === "blocked"
          && refreshResult.incidentKind === DIRTY_INTEGRATION_INCIDENT
          ? "dirty"
          : "clean";

        const refreshedMetadata = mergeMountedSubmoduleMetadata(
          input.prepared.mountedSubmodules,
          refreshedMountedSubmodules,
        );
        try {
          await this.registry.updateByItemId(input.prepared.itemId, (record) => ({
            ...record,
            updated_at: new Date().toISOString(),
            base_commit: input.prepared.baseCommit,
            worktree_commit: hostWorktreeCommit,
            mounted_submodules: refreshedMetadata,
            merge_message: input.commitMessage,
          }));
        } catch (error) {
          return {
            status: "blocked",
            worktreeCommit: hostWorktreeCommit,
            integratedCommit: null,
            mountedSubmodules: refreshedMountedSubmodules,
            error: error instanceof Error ? error.message : String(error),
            incidentKind: "merge_back_failed",
          };
        }

        if (refreshResult.status !== "ready") {
          return {
            status: "blocked",
            worktreeCommit: hostWorktreeCommit,
            integratedCommit: null,
            mountedSubmodules: refreshedMountedSubmodules,
            error: refreshResult.error,
            incidentKind: refreshResult.incidentKind,
          };
        }

        return this.isolation.mergeBack({
          prepared: input.prepared,
          hostCommitMessage: input.commitMessage,
          hostWorktreeCommit,
          mountedSubmodules: refreshedMountedSubmodules,
        });
      },
    );

    const mergedMountedSubmodules = mergeMountedSubmoduleMetadata(
      input.prepared.mountedSubmodules,
      mergeResult.mountedSubmodules,
    );

    if (mergeResult.status !== "merged") {
      return {
        treeState,
        result: await this.persistBlockedMergeResult({
          itemId: input.prepared.itemId,
          finalState: input.finalState,
          sessionId: input.sessionId,
          durationMs: input.durationMs,
          numTurns: input.numTurns,
          costUsd: input.costUsd,
          commitMessage: input.commitMessage,
          mergeResult,
          mountedSubmodules: mergedMountedSubmodules,
          dirtyRetryCount: input.dirtyRetryCount,
        }),
      };
    }

    try {
      await this.isolation.cleanupDispatch({
        worktreePath: input.prepared.worktreePath,
        branchName: input.prepared.branchName,
        mountedSubmodules: buildCleanupMountedSubmodules(input.prepared.mountedSubmodules),
      });
    } catch (error) {
      const incidentMessage = error instanceof Error ? error.message : String(error);
      const now = new Date().toISOString();
      await this.registry.updateByItemId(input.prepared.itemId, (record) => ({
        ...record,
        status: "blocked",
        updated_at: now,
        latest_error: incidentMessage,
        latest_session_id: input.sessionId,
        latest_duration_ms: input.durationMs,
        latest_num_turns: input.numTurns,
        latest_cost_usd: input.costUsd,
        worktree_commit: mergeResult.worktreeCommit,
        integrated_commit: mergeResult.integratedCommit,
        mounted_submodules: mergedMountedSubmodules,
        merge_outcome: "merged",
        merge_attempted_at: now,
        merge_message: input.commitMessage,
        incident: {
          kind: "cleanup_failed",
          message: incidentMessage,
          detected_at: now,
          retry_count: 0,
        },
      }));

      return {
        treeState,
        result: {
          success: true,
          blocked: true,
          finalState: input.finalState,
          mergeOutcome: "merged",
          worktreeCommit: mergeResult.worktreeCommit,
          integratedCommit: mergeResult.integratedCommit,
          mountedSubmodules: mergedMountedSubmodules,
          incidentKind: "cleanup_failed",
          incidentMessage,
        },
      };
    }

    await this.completeSuccessfulGuard({
      itemId: input.prepared.itemId,
      entryState: input.entryState,
      finalState: input.finalState,
      sessionId: input.sessionId,
      durationMs: input.durationMs,
      numTurns: input.numTurns,
      costUsd: input.costUsd,
    }, mergeResult.worktreeCommit, mergeResult.integratedCommit, "merged");

    return {
      treeState,
      result: {
        success: true,
        blocked: false,
        finalState: input.finalState,
        mergeOutcome: "merged",
        worktreeCommit: mergeResult.worktreeCommit,
        integratedCommit: mergeResult.integratedCommit,
        mountedSubmodules: mergedMountedSubmodules,
        incidentKind: null,
        incidentMessage: null,
      },
    };
  }

  private async persistBlockedMergeResult(input: {
    itemId: string;
    finalState: string;
    sessionId: string | null;
    durationMs: number | null;
    numTurns: number | null;
    costUsd: number | null;
    commitMessage: string;
    mergeResult: {
      worktreeCommit: string | null;
      integratedCommit: string | null;
      error: string | null;
      incidentKind: string | null;
    };
    mountedSubmodules: RuntimeMountedSubmoduleRecord[];
    dirtyRetryCount: number;
  }): Promise<FinalizeDispatchResult> {
    const incidentDetectedAt = new Date().toISOString();
    const blockedIncident = buildBlockedIncident(
      input.mergeResult.incidentKind,
      input.mergeResult.error,
      input.dirtyRetryCount,
    );

    await this.registry.updateByItemId(input.itemId, (record) => ({
      ...record,
      status: "blocked",
      updated_at: incidentDetectedAt,
      latest_error: blockedIncident.message,
      latest_session_id: input.sessionId,
      latest_duration_ms: input.durationMs,
      latest_num_turns: input.numTurns,
      latest_cost_usd: input.costUsd,
      worktree_commit: input.mergeResult.worktreeCommit,
      integrated_commit: input.mergeResult.integratedCommit,
      mounted_submodules: input.mountedSubmodules,
      merge_outcome: "blocked",
      merge_attempted_at: incidentDetectedAt,
      merge_message: input.commitMessage,
      incident: {
        ...blockedIncident,
        detected_at: incidentDetectedAt,
      },
    }));

    return {
      success: false,
      blocked: true,
      finalState: input.finalState,
      mergeOutcome: "blocked",
      worktreeCommit: input.mergeResult.worktreeCommit,
      integratedCommit: input.mergeResult.integratedCommit,
      mountedSubmodules: input.mountedSubmodules,
      incidentKind: blockedIncident.kind,
      incidentMessage: blockedIncident.message,
    };
  }

  private async completeSuccessfulGuard(
    input: {
      itemId: string;
      entryState: string;
      finalState: string;
      sessionId: string | null;
      durationMs: number | null;
      numTurns: number | null;
      costUsd: number | null;
    },
    worktreeCommit: string | null,
    integratedCommit: string | null,
    mergeOutcome: "merged" | "no_changes",
  ): Promise<void> {
    const shouldPersistGuard = input.finalState === input.entryState;

    if (!shouldPersistGuard) {
      await this.registry.removeByItemId(input.itemId);
      return;
    }

    await this.registry.updateByItemId(input.itemId, (record) => ({
      ...record,
      status: "guarded",
      worktree_path: null,
      branch_name: null,
      isolated_item_file: null,
      mounted_submodules: [],
      updated_at: new Date().toISOString(),
      heartbeat_at: null,
      worktree_commit: worktreeCommit,
      integrated_commit: integratedCommit,
      merge_outcome: mergeOutcome,
      merge_attempted_at: mergeOutcome === "merged" ? new Date().toISOString() : null,
      latest_error: null,
      latest_session_id: input.sessionId,
      latest_duration_ms: input.durationMs,
      latest_num_turns: input.numTurns,
      latest_cost_usd: input.costUsd,
      incident: null,
    }));
  }
}

function buildDispatchId(): string {
  return `d-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function buildActiveRecord(
  dispatcherName: string,
  prepared: PreparedDispatch | IsolatedDispatch,
  entry: DispatchEntry,
): RuntimeDispatchRecord {
  const now = new Date().toISOString();
  return {
    dispatch_id: prepared.dispatchId,
    item_id: prepared.itemId,
    item_file: prepared.itemFile,
    isolated_item_file: prepared.isolatedItemFile,
    state: entry.state,
    agent_name: entry.agentName,
    dispatcher_name: dispatcherName,
    provider: entry.provider,
    resumable: entry.resumable,
    session_field: entry.sessionField ?? null,
    status: "active",
    worktree_path: prepared.worktreePath,
    branch_name: prepared.branchName,
    base_commit: prepared.baseCommit,
    mounted_submodules: prepared.mountedSubmodules.map((entry) => ({
      repo_path: entry.repoPath,
      primary_repo_path: entry.primaryRepoPath,
      worktree_path: entry.worktreePath,
      branch_name: entry.branchName,
      base_commit: entry.baseCommit,
      worktree_commit: null,
      integrated_commit: null,
    })),
    worktree_commit: null,
    integrated_commit: null,
    started_at: now,
    updated_at: now,
    heartbeat_at: now,
    owner_pid: process.pid,
    transition_targets: entry.transitions.map((transition) => transition.to),
    merge_outcome: "pending",
    merge_attempted_at: null,
    merge_message: null,
    latest_error: null,
    latest_session_id: null,
    latest_duration_ms: null,
    latest_num_turns: null,
    latest_cost_usd: null,
    incident: null,
  };
}

function buildPreparedDispatchFromRecord(
  record: RuntimeDispatchRecord,
): MergeBackPreparedDispatch | null {
  if (
    !record.isolated_item_file
    || !record.worktree_path
    || !record.branch_name
    || !record.base_commit
  ) {
    return null;
  }

  const mountedSubmodules: MountedSubmoduleWorktree[] = [];
  for (const entry of record.mounted_submodules) {
    if (
      !entry.primary_repo_path
      || !entry.worktree_path
      || !entry.branch_name
      || !entry.base_commit
    ) {
      return null;
    }

    mountedSubmodules.push({
      repoPath: entry.repo_path,
      primaryRepoPath: entry.primary_repo_path,
      worktreePath: entry.worktree_path,
      branchName: entry.branch_name,
      baseCommit: entry.base_commit,
    });
  }

  return {
    dispatchId: record.dispatch_id,
    itemId: record.item_id,
    itemFile: record.item_file,
    isolatedItemFile: record.isolated_item_file,
    worktreePath: record.worktree_path,
    branchName: record.branch_name,
    baseCommit: record.base_commit,
    mountedSubmodules,
  };
}

function buildCleanupMountedSubmodules(
  mountedSubmodules: ReadonlyArray<MountedSubmoduleWorktree>,
): Array<{
  repo_path: string;
  primary_repo_path: string;
  worktree_path: string;
  branch_name: string;
}> {
  return mountedSubmodules.map((entry) => ({
    repo_path: entry.repoPath,
    primary_repo_path: entry.primaryRepoPath,
    worktree_path: entry.worktreePath,
    branch_name: entry.branchName,
  }));
}

function mergeMountedSubmoduleMetadata(
  mountedSubmodules: ReadonlyArray<MountedSubmoduleWorktree>,
  updates: ReadonlyArray<MountedSubmoduleMergeMetadata>,
): RuntimeMountedSubmoduleRecord[] {
  const updatesByPath = new Map(updates.map((entry) => [entry.repoPath, entry] as const));
  return mountedSubmodules.map((entry) => {
    const update = updatesByPath.get(entry.repoPath);
    return {
      repo_path: entry.repoPath,
      primary_repo_path: entry.primaryRepoPath,
      worktree_path: entry.worktreePath,
      branch_name: entry.branchName,
      base_commit: entry.baseCommit,
      worktree_commit: update?.worktreeCommit ?? null,
      integrated_commit: update?.integratedCommit ?? null,
    };
  });
}

function buildBlockedIncident(
  incidentKind: string | null,
  incidentMessage: string | null,
  dirtyRetryCount: number,
): {
  kind: string;
  message: string;
  retry_count: number;
} {
  if (incidentKind === DIRTY_INTEGRATION_INCIDENT) {
    if (dirtyRetryCount > DIRTY_INTEGRATION_RETRY_LIMIT) {
      return {
        kind: PRIMARY_DIRTY_TIMEOUT_INCIDENT,
        message: buildPrimaryDirtyTimeoutMessage(
          incidentMessage ?? "Integration checkout is dirty",
          dirtyRetryCount,
        ),
        retry_count: dirtyRetryCount,
      };
    }

    return {
      kind: DIRTY_INTEGRATION_INCIDENT,
      message: incidentMessage ?? "Integration checkout is dirty",
      retry_count: dirtyRetryCount,
    };
  }

  return {
    kind: incidentKind ?? "merge_blocked",
    message: incidentMessage ?? "Merge back blocked",
    retry_count: 0,
  };
}

function buildPrimaryDirtyTimeoutMessage(message: string, retryCount: number): string {
  return `${message} (timed out after ${retryCount} retry checks)`;
}
