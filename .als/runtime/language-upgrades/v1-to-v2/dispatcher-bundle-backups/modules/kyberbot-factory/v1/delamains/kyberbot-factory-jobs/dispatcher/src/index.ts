import "./preflight.js";
import { existsSync } from "fs";
import { writeFileSync, unlinkSync } from "fs";
import { resolve as resolvePath, dirname, join } from "path";
import { resolve, dispatch, type DispatchEntry } from "./dispatcher.js";
import {
  buildConcurrencySnapshot,
  evaluateDispatchConcurrency,
  reserveDispatchConcurrency,
  type DispatchConcurrencySuppression,
} from "./concurrency.js";
import {
  DispatcherRuntime,
  type BlockedDirtyRetryResult,
  type DispatcherRuntimeHeartbeat,
} from "./dispatcher-runtime.js";
import type { RuntimeDispatchSummary } from "./runtime-state.js";
import { formatDispatcherVersionLine, loadDispatcherVersionInfo } from "./dispatcher-version.js";
import { appendTelemetryEvent, DISPATCH_TELEMETRY_SCHEMA } from "./telemetry.js";
import { scan } from "./watcher.js";

function findSystemRoot(start: string): string {
  let dir = start;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, ".als", "system.ts"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("No .als/system.ts found in parent directories");
}

const SYSTEM_ROOT = process.env["SYSTEM_ROOT"]
  ? resolvePath(process.env["SYSTEM_ROOT"])
  : findSystemRoot(resolvePath(import.meta.dir));
const BUNDLE_ROOT = dirname(dirname(resolvePath(import.meta.dir)));

const POLL_MS = parseInt(process.env["POLL_MS"] ?? "30000", 10);

try {
  console.log(formatDispatcherVersionLine(await loadDispatcherVersionInfo(BUNDLE_ROOT)));
} catch (error) {
  console.error(`[dispatcher] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const config = await resolve(BUNDLE_ROOT, SYSTEM_ROOT);
const runtime = new DispatcherRuntime({
  bundleRoot: BUNDLE_ROOT,
  systemRoot: SYSTEM_ROOT,
  delamainName: config.delamainName,
  statusField: config.statusField,
  pollMs: POLL_MS,
  submodules: config.submodules,
});

console.log(`[dispatcher] system: ${SYSTEM_ROOT}`);
console.log(`[dispatcher] bundle: ${BUNDLE_ROOT}`);
console.log(`[dispatcher] module: ${config.moduleId}`);
console.log(`[dispatcher] delamain: ${config.delamainName}`);
console.log(`[dispatcher] status field: ${config.statusField}`);
console.log(`[dispatcher] entity: ${config.entityName}`);
console.log(`[dispatcher] entity path: ${config.entityPath}`);
console.log(`[dispatcher] module root: ${config.moduleRoot}`);
console.log(
  `[dispatcher] limits: maxTurns=${config.maxTurns} / maxBudgetUsdByProvider={anthropic:${config.maxBudgetUsdByProvider.anthropic}, openai:${config.maxBudgetUsdByProvider.openai}}`,
);
if (config.submodules.length > 0) {
  console.log(`[dispatcher] mounted submodules: ${config.submodules.join(", ")}`);
}
if (config.discriminatorField) {
  console.log(`[dispatcher] discriminator: ${config.discriminatorField}=${config.discriminatorValue}`);
}
console.log(`[dispatcher] states: ${config.allStates.join(", ")}`);
console.log(`[dispatcher] watching: ${config.dispatchTable.map((e) => e.state).join(", ")}`);
console.log(`[dispatcher] polling every ${POLL_MS}ms`);

const STATUS_FILE = join(
  SYSTEM_ROOT,
  ".claude",
  "delamains",
  config.delamainName,
  "status.json",
);
const DRAIN_REQUEST_FILE = join(
  SYSTEM_ROOT,
  ".claude",
  "delamains",
  config.delamainName,
  "dispatcher",
  "control",
  "drain-request.json",
);

type DispatcherLifecycleMode = "running" | "draining";

let lastItemsScanned = 0;
let lastRuntimeHeartbeat: DispatcherRuntimeHeartbeat = {
  active_dispatches: 0,
  active_by_provider: {
    anthropic: 0,
    openai: 0,
  },
  blocked_dispatches: 0,
  orphaned_dispatches: 0,
  guarded_dispatches: 0,
};
let lifecycleMode: DispatcherLifecycleMode = "running";
let drainRequestedAt: string | null = null;

async function writeHeartbeat(itemsScanned: number) {
  lastRuntimeHeartbeat = await runtime.heartbeat();
  try {
    writeFileSync(
      STATUS_FILE,
      JSON.stringify({
        name: config.delamainName,
        pid: process.pid,
        last_tick: new Date().toISOString(),
        poll_ms: POLL_MS,
        active_dispatches: lastRuntimeHeartbeat.active_dispatches,
        active_by_provider: lastRuntimeHeartbeat.active_by_provider,
        blocked_dispatches: lastRuntimeHeartbeat.blocked_dispatches,
        orphaned_dispatches: lastRuntimeHeartbeat.orphaned_dispatches,
        guarded_dispatches: lastRuntimeHeartbeat.guarded_dispatches,
        items_scanned: itemsScanned,
        lifecycle_mode: lifecycleMode,
        drain_requested_at: drainRequestedAt,
      }) + "\n",
    );
  } catch {
    // Non-fatal — statusline just won't see us
  }
}

function clearHeartbeat() {
  try {
    unlinkSync(STATUS_FILE);
  } catch {
    // Already gone
  }
}

function clearDrainRequest() {
  try {
    unlinkSync(DRAIN_REQUEST_FILE);
  } catch {
    // Already gone
  }
}

function findRule(status: string): DispatchEntry | undefined {
  return config.dispatchTable.find((entry) => entry.state === status);
}

function logCounts(prefix: string) {
  console.log(
    `${prefix} (active=${lastRuntimeHeartbeat.active_dispatches} [anthropic=${lastRuntimeHeartbeat.active_by_provider.anthropic}, openai=${lastRuntimeHeartbeat.active_by_provider.openai}], blocked=${lastRuntimeHeartbeat.blocked_dispatches}, orphaned=${lastRuntimeHeartbeat.orphaned_dispatches})`,
  );
}

async function updateHeartbeat() {
  await writeHeartbeat(lastItemsScanned);
}

async function enterDrainingMode(): Promise<void> {
  if (lifecycleMode === "draining") {
    return;
  }

  lifecycleMode = "draining";
  drainRequestedAt = new Date().toISOString();
  console.log(
    `[dispatcher] drain requested — stopping new dispatches and waiting for ${lastRuntimeHeartbeat.active_dispatches} active dispatch(es) to finish`,
  );
  await updateHeartbeat();
}

async function maybeHandleDrainRequest(): Promise<void> {
  if (lifecycleMode === "draining") {
    return;
  }

  if (!existsSync(DRAIN_REQUEST_FILE)) {
    return;
  }

  await enterDrainingMode();
}

async function writeRetryTelemetry(result: BlockedDirtyRetryResult): Promise<void> {
  try {
    await appendTelemetryEvent(BUNDLE_ROOT, {
      schema: DISPATCH_TELEMETRY_SCHEMA,
      event_id: crypto.randomUUID(),
      event_type: result.action === "merged" ? "dispatch_merge_success" : "dispatch_merge_blocked",
      timestamp: new Date().toISOString(),
      dispatcher_name: config.delamainName,
      module_id: config.moduleId,
      dispatch_id: result.dispatchId,
      item_id: result.itemId,
      item_file: result.itemFile,
      isolated_item_file: result.isolatedItemFile,
      state: result.state,
      agent_name: result.agentName,
      sub_agent_name: null,
      provider: result.provider,
      resumable: result.resumable,
      resume_requested: false,
      session_field: result.sessionField,
      runtime_session_id: result.sessionId,
      resume_session_id: null,
      worker_session_id: result.sessionId,
      worktree_path: result.worktreePath,
      branch_name: result.branchName,
      mounted_submodules: result.mountedSubmodules,
      worktree_commit: result.worktreeCommit,
      integrated_commit: result.integratedCommit,
      merge_outcome: result.mergeOutcome,
      incident_kind: result.incidentKind,
      transition_targets: result.transitionTargets,
      duration_ms: result.durationMs,
      num_turns: result.numTurns,
      cost_usd: result.costUsd,
      error: result.action === "merged" ? null : result.incidentMessage,
    });
  } catch (error) {
    console.warn(
      `[dispatcher] ${result.itemId} retry telemetry write failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function logCompletion(
  itemId: string,
  provider: DispatchEntry["provider"],
  result: { success: boolean; blocked: boolean },
) {
  console.log(
    `[dispatcher] ${itemId} finished provider=${provider} (success=${result.success}, blocked=${result.blocked}, active=${lastRuntimeHeartbeat.active_dispatches}, blocked_total=${lastRuntimeHeartbeat.blocked_dispatches}, anthropic=${lastRuntimeHeartbeat.active_by_provider.anthropic}, openai=${lastRuntimeHeartbeat.active_by_provider.openai})`,
  );
}

function logRetry(result: BlockedDirtyRetryResult) {
  console.log(
    `[dispatcher] mergeBack retry #${result.attempt} dispatch=${result.dispatchId} item=${result.itemId} incident=${result.previousIncidentKind} tree=${result.treeState} outcome=${result.action} next_incident=${result.incidentKind ?? "none"}`,
  );
}

function logSweep(prefix: string, summary: Awaited<ReturnType<typeof runtime.sweepOrphans>>) {
  if (
    summary.staleLocksReleased === 0
    && summary.pristineOrphansPruned === 0
    && summary.dirtyOrphansPreserved === 0
  ) {
    return;
  }

  console.log(
    `${prefix} stale_locks=${summary.staleLocksReleased} pristine_orphans=${summary.pristineOrphansPruned} dirty_orphans=${summary.dirtyOrphansPreserved}`,
  );
}

function buildOpenRecordItemIdSet(summary: RuntimeDispatchSummary): Set<string> {
  return new Set([
    ...summary.active,
    ...summary.blocked,
    ...summary.guarded,
    ...summary.orphaned,
  ].map((record) => record.item_id));
}

async function writeConcurrencySuppressionTelemetry(
  item: { id: string; filePath: string },
  rule: DispatchEntry,
  suppression: DispatchConcurrencySuppression,
): Promise<void> {
  try {
    await appendTelemetryEvent(BUNDLE_ROOT, {
      schema: DISPATCH_TELEMETRY_SCHEMA,
      event_id: crypto.randomUUID(),
      event_type: "dispatch_suppressed_concurrency",
      timestamp: new Date().toISOString(),
      dispatcher_name: config.delamainName,
      module_id: config.moduleId,
      dispatch_id: null,
      item_id: item.id,
      item_file: item.filePath,
      isolated_item_file: null,
      state: rule.state,
      agent_name: rule.agentName,
      sub_agent_name: rule.subAgentName ?? null,
      provider: rule.provider,
      resumable: rule.resumable,
      resume_requested: false,
      session_field: rule.sessionField ?? null,
      runtime_session_id: null,
      resume_session_id: null,
      worker_session_id: null,
      worktree_path: null,
      branch_name: null,
      worktree_commit: null,
      integrated_commit: null,
      merge_outcome: null,
      incident_kind: null,
      blocked_by: suppression.blockedBy,
      current_count: suppression.currentCount,
      concurrency_limit: suppression.concurrencyLimit,
      ...(suppression.blockedBy === "pool"
        ? {
          pool_id: suppression.poolId,
          pool_states: suppression.poolStates,
          pool_holders: suppression.poolHolders,
        }
        : {}),
      transition_targets: rule.transitions.map((transition) => transition.to),
      duration_ms: null,
      num_turns: null,
      cost_usd: null,
      error: null,
    });
  } catch (error) {
    console.warn(
      `[dispatcher] ${item.id} concurrency telemetry write failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

process.on("beforeExit", (code) => {
  console.log(
    `[dispatcher] beforeExit fired (code=${code}, active=${lastRuntimeHeartbeat.active_dispatches}, blocked=${lastRuntimeHeartbeat.blocked_dispatches})`,
  );
});

process.on("exit", (code) => {
  console.log(
    `[dispatcher] exit code=${code} active=${lastRuntimeHeartbeat.active_dispatches} blocked=${lastRuntimeHeartbeat.blocked_dispatches}`,
  );
});

process.on("uncaughtException", (err) => {
  console.error("[dispatcher] uncaughtException:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[dispatcher] unhandledRejection:", reason);
});

let tickCount = 0;

async function tick() {
  tickCount += 1;
  logCounts(`[dispatcher] tick #${tickCount}`);

  const sweep = await runtime.sweepOrphans();
  logSweep("[dispatcher] orphan sweep", sweep);
  await maybeHandleDrainRequest();

  if (lifecycleMode === "draining") {
    await updateHeartbeat();
    if (lastRuntimeHeartbeat.active_dispatches === 0) {
      console.log("[dispatcher] drain complete — exiting cleanly");
      clearDrainRequest();
      clearRuntimeAndExit(0);
    }
    return;
  }

  const items = await scan(
    config.moduleRoot,
    config.entityPath,
    config.statusField,
    config.discriminatorField,
    config.discriminatorValue,
  );
  lastItemsScanned = items.length;

  const releases = await runtime.reconcileObservedItems(items);
  for (const release of releases) {
    console.log(
      `[dispatcher] release ${release.itemId} after status change ${release.previousStatus} -> ${release.nextStatus} (${release.previousRecordStatus})`,
    );
  }

  const retries = await runtime.retryBlockedDirtyDispatches();
  for (const retry of retries) {
    logRetry(retry);
    await writeRetryTelemetry(retry);
  }

  const openSummary = await runtime.openDispatchSummary();
  const openItemIds = buildOpenRecordItemIdSet(openSummary);
  const concurrencySnapshot = buildConcurrencySnapshot(openSummary, config.dispatchTable);

  for (const item of items) {
    const rule = findRule(item.status);
    if (!rule) continue;
    if (openItemIds.has(item.id)) continue;

    const suppression = evaluateDispatchConcurrency(rule, concurrencySnapshot);
    if (suppression) {
      await writeConcurrencySuppressionTelemetry(item, rule, suppression);
      continue;
    }

    const prepared = await runtime.prepareDispatch(item.id, item.filePath, rule);
    if (!prepared) {
      console.log(`[dispatcher] ${item.id} skipped: runtime registry already owns this item`);
      continue;
    }

    openItemIds.add(item.id);
    reserveDispatchConcurrency(rule, concurrencySnapshot, rule.pool
      ? {
        dispatch_id: prepared.dispatchId,
        item_id: item.id,
        state: rule.state,
        status: "active",
      }
      : undefined);

    console.log(`[dispatcher] dispatch ${item.id} -> ${item.status}`);
    void dispatch(
      item.id,
      item.filePath,
      rule,
      config.agents,
      config,
      BUNDLE_ROOT,
      runtime,
      prepared,
    )
      .then(async (result) => {
        await updateHeartbeat();
        logCompletion(item.id, rule.provider, result);
      })
      .catch(async (error) => {
        console.error(`[dispatcher] ${item.id} dispatch error:`, error);
        await updateHeartbeat();
      });
  }

  await updateHeartbeat();
}

const bootSweep = await runtime.sweepOrphans();
logSweep("[dispatcher] startup orphan sweep", bootSweep);
await updateHeartbeat();
await tick();
const interval = setInterval(() => {
  void tick().catch((error) => {
    console.error("[dispatcher] tick failed:", error);
  });
}, POLL_MS);

const keepalive = Bun.serve({
  port: 0,
  fetch: () => new Response("dispatcher alive"),
});
console.log(`[dispatcher] keepalive on port ${keepalive.port}`);

let forceShutdownRequested = false;

function clearRuntimeAndExit(code: number) {
  clearInterval(interval);
  keepalive.stop();
  clearDrainRequest();
  clearHeartbeat();
  process.exit(code);
}

const stop = (signal: string) => {
  if (lastRuntimeHeartbeat.active_dispatches > 0) {
    console.log(
      `[dispatcher] ${signal} ignored while ${lastRuntimeHeartbeat.active_dispatches} active dispatch(es) are running`,
    );
    return false;
  }

  console.log(
    `[dispatcher] ${signal} received, shutting down (active=${lastRuntimeHeartbeat.active_dispatches}, blocked=${lastRuntimeHeartbeat.blocked_dispatches}, anthropic=${lastRuntimeHeartbeat.active_by_provider.anthropic}, openai=${lastRuntimeHeartbeat.active_by_provider.openai})`,
  );
  clearRuntimeAndExit(0);
  return true;
};

process.on("SIGTERM", () => {
  console.log(
    `[dispatcher] SIGTERM ignored (active=${lastRuntimeHeartbeat.active_dispatches}, blocked=${lastRuntimeHeartbeat.blocked_dispatches}, ticks=${tickCount})`,
  );
});

process.on("SIGINT", () => {
  if (forceShutdownRequested) {
    console.log("[dispatcher] second SIGINT - force quit");
    clearRuntimeAndExit(1);
    return;
  }

  forceShutdownRequested = true;
  if (!stop("SIGINT")) return;
});
