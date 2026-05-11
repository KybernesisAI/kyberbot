import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { join } from "path";
import {
  emptyProviderDispatchCounts,
  incrementProviderDispatchCount,
  type AgentProvider,
  type ProviderDispatchCounts,
} from "./provider.js";

export const DELAMAIN_RUNTIME_STATE_SCHEMA = "als-delamain-worktree-state@1";

export type RuntimeDispatchStatus =
  | "active"
  | "guarded"
  | "blocked"
  | "orphaned";

export type RuntimeMergeOutcome =
  | "pending"
  | "no_changes"
  | "merged"
  | "blocked"
  | "skipped";

export interface RuntimeDispatchIncident {
  kind: string;
  message: string;
  detected_at: string;
  retry_count: number;
}

export interface RuntimeMountedSubmoduleRecord {
  repo_path: string;
  primary_repo_path: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  base_commit: string | null;
  worktree_commit: string | null;
  integrated_commit: string | null;
}

export interface RuntimeDispatchRecord {
  dispatch_id: string;
  item_id: string;
  item_file: string;
  isolated_item_file: string | null;
  state: string;
  agent_name: string;
  dispatcher_name: string;
  provider: AgentProvider;
  resumable: boolean;
  session_field: string | null;
  status: RuntimeDispatchStatus;
  worktree_path: string | null;
  branch_name: string | null;
  base_commit: string | null;
  mounted_submodules: RuntimeMountedSubmoduleRecord[];
  worktree_commit: string | null;
  integrated_commit: string | null;
  started_at: string;
  updated_at: string;
  heartbeat_at: string | null;
  owner_pid: number | null;
  transition_targets: string[];
  merge_outcome: RuntimeMergeOutcome;
  merge_attempted_at: string | null;
  merge_message: string | null;
  latest_error: string | null;
  latest_session_id: string | null;
  latest_duration_ms: number | null;
  latest_num_turns: number | null;
  latest_cost_usd: number | null;
  incident: RuntimeDispatchIncident | null;
}

export interface RuntimeDispatchState {
  schema: typeof DELAMAIN_RUNTIME_STATE_SCHEMA;
  updated_at: string;
  records: RuntimeDispatchRecord[];
}

export interface RuntimeDispatchSummary {
  active: RuntimeDispatchRecord[];
  blocked: RuntimeDispatchRecord[];
  guarded: RuntimeDispatchRecord[];
  orphaned: RuntimeDispatchRecord[];
  activeCount: number;
  blockedCount: number;
  guardedCount: number;
  orphanedCount: number;
  activeByProvider: ProviderDispatchCounts;
}

export interface StateConcurrencyEvaluation {
  currentCount: number;
  suppressed: boolean;
}

export interface RuntimeConcurrencyHolderRecord {
  dispatch_id: string;
  item_id: string;
  state: string;
  status: "active" | "blocked";
}

export interface PoolConcurrencyEvaluation {
  currentCount: number;
  suppressed: boolean;
  holders: RuntimeConcurrencyHolderRecord[];
}

interface RuntimeStatePaths {
  directory: string;
  stateFile: string;
}

export function resolveRuntimeStatePaths(bundleRoot: string): RuntimeStatePaths {
  const directory = join(bundleRoot, "runtime");
  return {
    directory,
    stateFile: join(directory, "worktree-state.json"),
  };
}

export async function readRuntimeState(bundleRoot: string): Promise<RuntimeDispatchState> {
  const { stateFile } = resolveRuntimeStatePaths(bundleRoot);

  let raw: string;
  try {
    raw = await readFile(stateFile, "utf-8");
  } catch (error) {
    if (isMissing(error)) {
      return emptyRuntimeState();
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid runtime worktree state at '${stateFile}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid runtime worktree state at '${stateFile}': expected an object`);
  }

  const value = parsed as Partial<RuntimeDispatchState>;
  if (value.schema !== DELAMAIN_RUNTIME_STATE_SCHEMA) {
    throw new Error(
      `Invalid runtime worktree state at '${stateFile}': unsupported schema '${value.schema ?? "<missing>"}'`,
    );
  }

  return {
    schema: DELAMAIN_RUNTIME_STATE_SCHEMA,
    updated_at: asString(value.updated_at) ?? new Date().toISOString(),
    records: Array.isArray(value.records)
      ? value.records.map((record) => normalizeRecord(record))
      : [],
  };
}

export async function writeRuntimeState(
  bundleRoot: string,
  state: RuntimeDispatchState,
): Promise<void> {
  const { directory, stateFile } = resolveRuntimeStatePaths(bundleRoot);
  await mkdir(directory, { recursive: true });

  const nextState: RuntimeDispatchState = {
    schema: DELAMAIN_RUNTIME_STATE_SCHEMA,
    updated_at: state.updated_at,
    records: state.records.map((record) => normalizeRecord(record)),
  };

  const tempFile = `${stateFile}.tmp`;
  await writeFile(tempFile, JSON.stringify(nextState, null, 2) + "\n", "utf-8");
  await rename(tempFile, stateFile);
}

export function summarizeRuntimeState(state: RuntimeDispatchState): RuntimeDispatchSummary {
  const active = state.records.filter((record) => record.status === "active");
  const guarded = state.records.filter((record) => record.status === "guarded");
  const blocked = state.records.filter((record) => record.status === "blocked");
  const orphaned = state.records.filter((record) => record.status === "orphaned");
  const activeByProvider = emptyProviderDispatchCounts();

  for (const record of active) {
    incrementProviderDispatchCount(activeByProvider, record.provider);
  }

  return {
    active,
    blocked,
    guarded,
    orphaned,
    activeCount: active.length,
    blockedCount: blocked.length,
    guardedCount: guarded.length,
    orphanedCount: orphaned.length,
    activeByProvider,
  };
}

export function countStateConcurrencyOccupancy(
  summary: RuntimeDispatchSummary,
  state: string,
): number {
  return summary.active.filter((record) => record.state === state).length
    + summary.blocked.filter((record) => record.state === state).length;
}

export function listPoolConcurrencyHolders(
  summary: RuntimeDispatchSummary,
  states: ReadonlyArray<string>,
): RuntimeConcurrencyHolderRecord[] {
  const stateSet = new Set(states);
  return [...summary.active, ...summary.blocked]
    .filter((record) => stateSet.has(record.state))
    .map((record) => ({
      dispatch_id: record.dispatch_id,
      item_id: record.item_id,
      state: record.state,
      status: record.status === "blocked" ? "blocked" : "active",
    }));
}

export function countPoolConcurrencyOccupancy(
  summary: RuntimeDispatchSummary,
  states: ReadonlyArray<string>,
): number {
  return listPoolConcurrencyHolders(summary, states).length;
}

export function evaluatePoolConcurrency(
  summary: RuntimeDispatchSummary,
  input: { states: ReadonlyArray<string>; capacity: number },
): PoolConcurrencyEvaluation {
  const holders = listPoolConcurrencyHolders(summary, input.states);
  return {
    currentCount: holders.length,
    suppressed: holders.length >= input.capacity,
    holders,
  };
}

export function evaluateStateConcurrency(
  summary: RuntimeDispatchSummary,
  state: string,
  concurrency: number | undefined,
): StateConcurrencyEvaluation {
  const currentCount = countStateConcurrencyOccupancy(summary, state);
  return {
    currentCount,
    suppressed: concurrency !== undefined && currentCount >= concurrency,
  };
}

export function emptyRuntimeState(): RuntimeDispatchState {
  return {
    schema: DELAMAIN_RUNTIME_STATE_SCHEMA,
    updated_at: new Date().toISOString(),
    records: [],
  };
}

function normalizeRecord(input: unknown): RuntimeDispatchRecord {
  const value = input && typeof input === "object"
    ? input as Partial<RuntimeDispatchRecord>
    : {};

  return {
    dispatch_id: asString(value.dispatch_id) ?? "unknown",
    item_id: asString(value.item_id) ?? "unknown",
    item_file: asString(value.item_file) ?? "unknown",
    isolated_item_file: asString(value.isolated_item_file),
    state: asString(value.state) ?? "unknown",
    agent_name: asString(value.agent_name) ?? "unknown",
    dispatcher_name: asString(value.dispatcher_name) ?? "unknown",
    provider: normalizeProvider(value.provider),
    resumable: value.resumable === true,
    session_field: asString(value.session_field),
    status: normalizeStatus(value.status),
    worktree_path: asString(value.worktree_path),
    branch_name: asString(value.branch_name),
    base_commit: asString(value.base_commit),
    mounted_submodules: Array.isArray(value.mounted_submodules)
      ? value.mounted_submodules.map((entry) => normalizeMountedSubmodule(entry))
      : [],
    worktree_commit: asString(value.worktree_commit),
    integrated_commit: asString(value.integrated_commit),
    started_at: asString(value.started_at) ?? new Date().toISOString(),
    updated_at: asString(value.updated_at) ?? new Date().toISOString(),
    heartbeat_at: asString(value.heartbeat_at),
    owner_pid: asInteger(value.owner_pid),
    transition_targets: Array.isArray(value.transition_targets)
      ? value.transition_targets.filter((target): target is string => typeof target === "string")
      : [],
    merge_outcome: normalizeMergeOutcome(value.merge_outcome),
    merge_attempted_at: asString(value.merge_attempted_at),
    merge_message: asString(value.merge_message),
    latest_error: asString(value.latest_error),
    latest_session_id: asString(value.latest_session_id),
    latest_duration_ms: asInteger(value.latest_duration_ms),
    latest_num_turns: asInteger(value.latest_num_turns),
    latest_cost_usd: asNumber(value.latest_cost_usd),
    incident: normalizeIncident(value.incident),
  };
}

function normalizeMountedSubmodule(value: unknown): RuntimeMountedSubmoduleRecord {
  const record = value && typeof value === "object"
    ? value as Partial<RuntimeMountedSubmoduleRecord>
    : {};

  return {
    repo_path: asString(record.repo_path) ?? "unknown",
    primary_repo_path: asString(record.primary_repo_path),
    worktree_path: asString(record.worktree_path),
    branch_name: asString(record.branch_name),
    base_commit: asString(record.base_commit),
    worktree_commit: asString(record.worktree_commit),
    integrated_commit: asString(record.integrated_commit),
  };
}

function normalizeIncident(value: unknown): RuntimeDispatchIncident | null {
  if (!value || typeof value !== "object") return null;

  const incident = value as Partial<RuntimeDispatchIncident>;
  const kind = asString(incident.kind);
  const message = asString(incident.message);
  if (!kind || !message) return null;

  return {
    kind,
    message,
    detected_at: asString(incident.detected_at) ?? new Date().toISOString(),
    retry_count: asNonNegativeInteger(incident.retry_count) ?? 0,
  };
}

function normalizeStatus(value: unknown): RuntimeDispatchStatus {
  return value === "active"
    || value === "guarded"
    || value === "blocked"
    || value === "orphaned"
    ? value
    : "blocked";
}

function normalizeProvider(value: unknown): AgentProvider {
  return value === "openai" ? "openai" : "anthropic";
}

function normalizeMergeOutcome(value: unknown): RuntimeMergeOutcome {
  return value === "pending"
    || value === "no_changes"
    || value === "merged"
    || value === "blocked"
    || value === "skipped"
    ? value
    : "pending";
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function asNonNegativeInteger(value: unknown): number | null {
  const integer = asInteger(value);
  return integer !== null && integer >= 0 ? integer : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
