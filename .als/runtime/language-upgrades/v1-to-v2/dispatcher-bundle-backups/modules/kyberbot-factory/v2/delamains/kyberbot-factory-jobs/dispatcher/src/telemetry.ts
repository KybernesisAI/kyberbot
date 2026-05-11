import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { join } from "path";
import type {
  RuntimeConcurrencyHolderRecord,
  RuntimeMountedSubmoduleRecord,
} from "./runtime-state.js";
import type { AgentProvider } from "./provider.js";

export const DISPATCH_TELEMETRY_SCHEMA = "als-delamain-telemetry-event@1";
export const DEFAULT_TELEMETRY_RETENTION = 200;

export type DispatchTelemetryEventType =
  | "dispatch_start"
  | "dispatch_prepare"
  | "dispatch_finish"
  | "dispatch_failure"
  | "dispatch_suppressed_concurrency"
  | "dispatch_merge_success"
  | "dispatch_merge_blocked"
  | "dispatch_cleanup"
  | "dispatch_orphaned";

export interface DispatchTelemetryEvent {
  schema: typeof DISPATCH_TELEMETRY_SCHEMA;
  event_id: string;
  event_type: DispatchTelemetryEventType;
  timestamp: string;
  dispatcher_name: string;
  module_id: string;
  dispatch_id: string | null;
  item_id: string;
  item_file: string;
  isolated_item_file: string | null;
  state: string;
  agent_name: string;
  sub_agent_name: string | null;
  provider: AgentProvider;
  resumable: boolean;
  resume_requested: boolean;
  session_field: string | null;
  runtime_session_id: string | null;
  resume_session_id: string | null;
  worker_session_id: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  mounted_submodules?: RuntimeMountedSubmoduleRecord[];
  worktree_commit: string | null;
  integrated_commit: string | null;
  merge_outcome: string | null;
  incident_kind: string | null;
  blocked_by?: "state" | "pool";
  current_count?: number | null;
  concurrency_limit?: number | null;
  pool_id?: string;
  pool_states?: string[];
  pool_holders?: RuntimeConcurrencyHolderRecord[];
  transition_targets: string[];
  duration_ms: number | null;
  num_turns: number | null;
  cost_usd: number | null;
  error: string | null;
}

export interface TelemetryReadResult {
  available: boolean;
  events: DispatchTelemetryEvent[];
  parse_errors: number;
}

interface TelemetryPaths {
  directory: string;
  eventsFile: string;
}

const writeQueues = new Map<string, Promise<void>>();

export function resolveTelemetryPaths(bundleRoot: string): TelemetryPaths {
  const directory = join(bundleRoot, "telemetry");
  return {
    directory,
    eventsFile: join(directory, "events.jsonl"),
  };
}

export async function readTelemetryEvents(
  bundleRoot: string,
  limit = DEFAULT_TELEMETRY_RETENTION,
): Promise<TelemetryReadResult> {
  const { eventsFile } = resolveTelemetryPaths(bundleRoot);

  let raw: string;
  try {
    raw = await readFile(eventsFile, "utf-8");
  } catch (error) {
    if (isMissing(error)) {
      return {
        available: false,
        events: [],
        parse_errors: 0,
      };
    }
    throw error;
  }

  const events: DispatchTelemetryEvent[] = [];
  let parseErrors = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line) as Partial<DispatchTelemetryEvent>;
      if (parsed.schema !== DISPATCH_TELEMETRY_SCHEMA) {
        parseErrors += 1;
        continue;
      }

      events.push(normalizeTelemetryEvent(parsed));
    } catch {
      parseErrors += 1;
    }
  }

  return {
    available: true,
    events: events.slice(-limit),
    parse_errors: parseErrors,
  };
}

export async function appendTelemetryEvent(
  bundleRoot: string,
  event: DispatchTelemetryEvent,
  retention = DEFAULT_TELEMETRY_RETENTION,
): Promise<void> {
  const { directory, eventsFile } = resolveTelemetryPaths(bundleRoot);

  const previous = writeQueues.get(eventsFile) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    await mkdir(directory, { recursive: true });
    const existing = await readTelemetryEvents(bundleRoot, retention);
    const events = [...existing.events, normalizeTelemetryEvent(event)].slice(-retention);
    const contents = events.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    const tempFile = `${eventsFile}.tmp`;
    await writeFile(tempFile, contents, "utf-8");
    await rename(tempFile, eventsFile);
  });

  writeQueues.set(eventsFile, next);
  try {
    await next;
  } finally {
    if (writeQueues.get(eventsFile) === next) {
      writeQueues.delete(eventsFile);
    }
  }
}

function normalizeTelemetryEvent(
  event: Partial<DispatchTelemetryEvent>,
): DispatchTelemetryEvent {
  return {
    schema: DISPATCH_TELEMETRY_SCHEMA,
    event_id: event.event_id ?? crypto.randomUUID(),
    event_type: event.event_type ?? "dispatch_failure",
    timestamp: event.timestamp ?? new Date().toISOString(),
    dispatcher_name: event.dispatcher_name ?? "unknown",
    module_id: event.module_id ?? "unknown",
    dispatch_id: typeof event.dispatch_id === "string" ? event.dispatch_id : null,
    item_id: event.item_id ?? "unknown",
    item_file: event.item_file ?? "unknown",
    isolated_item_file: typeof event.isolated_item_file === "string"
      ? event.isolated_item_file
      : null,
    state: event.state ?? "unknown",
    agent_name: event.agent_name ?? "unknown",
    sub_agent_name: event.sub_agent_name ?? null,
    provider: event.provider === "openai" ? "openai" : "anthropic",
    resumable: event.resumable === true,
    resume_requested: event.resume_requested === true,
    session_field: event.session_field ?? null,
    runtime_session_id: event.runtime_session_id ?? null,
    resume_session_id: event.resume_session_id ?? null,
    worker_session_id: event.worker_session_id ?? null,
    worktree_path: typeof event.worktree_path === "string" ? event.worktree_path : null,
    branch_name: typeof event.branch_name === "string" ? event.branch_name : null,
    mounted_submodules: Array.isArray(event.mounted_submodules)
      ? event.mounted_submodules.map((entry) => normalizeMountedSubmodule(entry))
      : [],
    worktree_commit: typeof event.worktree_commit === "string" ? event.worktree_commit : null,
    integrated_commit: typeof event.integrated_commit === "string"
      ? event.integrated_commit
      : null,
    merge_outcome: typeof event.merge_outcome === "string" ? event.merge_outcome : null,
    incident_kind: typeof event.incident_kind === "string" ? event.incident_kind : null,
    ...(event.blocked_by === "state" || event.blocked_by === "pool"
      ? { blocked_by: event.blocked_by }
      : {}),
    current_count: typeof event.current_count === "number" ? event.current_count : null,
    concurrency_limit: typeof event.concurrency_limit === "number" ? event.concurrency_limit : null,
    ...(typeof event.pool_id === "string" && event.pool_id.length > 0
      ? { pool_id: event.pool_id }
      : {}),
    ...(Array.isArray(event.pool_states)
      ? {
        pool_states: event.pool_states.filter(
          (value): value is string => typeof value === "string",
        ),
      }
      : {}),
    ...(Array.isArray(event.pool_holders)
      ? {
        pool_holders: event.pool_holders.map((entry) => normalizeConcurrencyHolder(entry)),
      }
      : {}),
    transition_targets: Array.isArray(event.transition_targets)
      ? event.transition_targets.filter((value): value is string => typeof value === "string")
      : [],
    duration_ms: typeof event.duration_ms === "number" ? event.duration_ms : null,
    num_turns: typeof event.num_turns === "number" ? event.num_turns : null,
    cost_usd: typeof event.cost_usd === "number" ? event.cost_usd : null,
    error: typeof event.error === "string" && event.error.length > 0 ? event.error : null,
  };
}

function normalizeConcurrencyHolder(value: unknown): RuntimeConcurrencyHolderRecord {
  const holder = value && typeof value === "object"
    ? value as Partial<RuntimeConcurrencyHolderRecord>
    : {};

  return {
    dispatch_id: typeof holder.dispatch_id === "string" && holder.dispatch_id.length > 0
      ? holder.dispatch_id
      : "unknown",
    item_id: typeof holder.item_id === "string" && holder.item_id.length > 0
      ? holder.item_id
      : "unknown",
    state: typeof holder.state === "string" && holder.state.length > 0
      ? holder.state
      : "unknown",
    status: holder.status === "blocked" ? "blocked" : "active",
  };
}

function normalizeMountedSubmodule(value: unknown): RuntimeMountedSubmoduleRecord {
  const record = value && typeof value === "object"
    ? value as Partial<RuntimeMountedSubmoduleRecord>
    : {};

  return {
    repo_path: typeof record.repo_path === "string" && record.repo_path.length > 0
      ? record.repo_path
      : "unknown",
    primary_repo_path: typeof record.primary_repo_path === "string" && record.primary_repo_path.length > 0
      ? record.primary_repo_path
      : null,
    worktree_path: typeof record.worktree_path === "string" && record.worktree_path.length > 0
      ? record.worktree_path
      : null,
    branch_name: typeof record.branch_name === "string" && record.branch_name.length > 0
      ? record.branch_name
      : null,
    base_commit: typeof record.base_commit === "string" && record.base_commit.length > 0
      ? record.base_commit
      : null,
    worktree_commit: typeof record.worktree_commit === "string" && record.worktree_commit.length > 0
      ? record.worktree_commit
      : null,
    integrated_commit: typeof record.integrated_commit === "string" && record.integrated_commit.length > 0
      ? record.integrated_commit
      : null,
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
