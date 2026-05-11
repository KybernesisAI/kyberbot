import { readFile } from "fs/promises";
import { basename, join } from "path";
import { parse as parseYaml } from "yaml";
import {
  getAgentProvider,
  type LoadedAgentPrompt as AgentDef,
  type ProviderDispatchResult,
} from "./agent-providers.js";
import { resolveDispatchLimits } from "./dispatch-limits.js";
import {
  DispatcherRuntime,
  type PreparedDispatch,
} from "./dispatcher-runtime.js";
import { parseMd, readFrontmatterField, setFrontmatterField } from "./frontmatter.js";
import type { AgentProvider } from "./provider.js";
import { buildSessionRuntimeState, shouldPersistDispatcherSession } from "./session-runtime.js";
import { recoverFreshDispatchAfterMissingResumeSession } from "./resume-recovery.js";
import { loadRuntimeManifest } from "./runtime-manifest.js";
import {
  appendTelemetryEvent,
  DISPATCH_TELEMETRY_SCHEMA,
  type DispatchTelemetryEvent,
} from "./telemetry.js";

interface Transition {
  class: string;
  from: string | string[];
  to: string;
}

interface StateDef {
  phase: string;
  initial?: boolean;
  terminal?: boolean;
  actor?: string;
  provider?: AgentProvider;
  path?: string;
  resumable?: boolean;
  concurrency?: number;
  "session-field"?: string;
  "sub-agent"?: string;
}

interface ConcurrencyPoolDef {
  states: string[];
  capacity: number;
}

interface DelamainConfig {
  phases: string[];
  states: Record<string, StateDef>;
  concurrency_pools?: Record<string, ConcurrencyPoolDef>;
  transitions: Transition[];
}

export interface ResolvedConcurrencyPool {
  id: string;
  states: string[];
  capacity: number;
}

export interface DispatchEntry {
  state: string;
  agentName: string;
  subAgentName?: string;
  provider: AgentProvider;
  resumable: boolean;
  concurrency?: number;
  pool?: ResolvedConcurrencyPool;
  sessionField?: string;
  transitions: Array<Pick<Transition, "class" | "to">>;
}

export interface ResolvedConfig {
  systemRoot: string;
  moduleId: string;
  moduleRoot: string;
  entityName: string;
  entityPath: string;
  statusField: string;
  delamainName: string;
  submodules: string[];
  maxTurns: number;
  maxBudgetUsdByProvider: Record<AgentProvider, number>;
  discriminatorField?: string;
  discriminatorValue?: string;
  agents: Record<string, AgentDef>;
  allStates: string[];
  concurrencyPools: Record<string, ResolvedConcurrencyPool>;
  dispatchTable: DispatchEntry[];
}

export async function resolve(
  bundleRoot: string,
  systemRoot: string,
): Promise<ResolvedConfig> {
  const manifest = await loadRuntimeManifest(bundleRoot);
  const effectiveLimits = resolveDispatchLimits(manifest.limits);
  const moduleRoot = join(systemRoot, manifest.module_mount_path);
  const delamain = parseYaml(
    await readFile(join(bundleRoot, "delamain.yaml"), "utf-8"),
  ) as DelamainConfig;

  const agents: Record<string, AgentDef> = {};

  async function loadAgent(agentKey: string, agentPath: string) {
    try {
      const { meta, body } = parseMd(
        await readFile(join(bundleRoot, agentPath), "utf-8"),
      );
      if (!body) return;

      const def: AgentDef = {
        description: meta["description"] ?? "",
        prompt: body,
      };
      if (typeof meta["tools"] === "string" && meta["tools"].trim().length > 0) {
        def.tools = meta["tools"].split(",").map((tool) => tool.trim());
      }
      if (typeof meta["model"] === "string" && meta["model"].trim().length > 0) {
        def.model = meta["model"];
      }
      if (
        typeof meta["reasoning-effort"] === "string"
        && ["low", "medium", "high", "xhigh"].includes(meta["reasoning-effort"])
      ) {
        def.reasoningEffort = meta["reasoning-effort"] as AgentDef["reasoningEffort"];
      }
      if (
        typeof meta["sandbox-mode"] === "string"
        && ["read-only", "workspace-write", "danger-full-access"].includes(meta["sandbox-mode"])
      ) {
        def.sandboxMode = meta["sandbox-mode"] as AgentDef["sandboxMode"];
      }
      if (
        typeof meta["approval-policy"] === "string"
        && ["untrusted", "on-request", "on-failure", "never"].includes(meta["approval-policy"])
      ) {
        def.approvalPolicy = meta["approval-policy"] as AgentDef["approvalPolicy"];
      }
      if (meta["approvals-reviewer"] === "auto_review" || meta["approvals-reviewer"] === "off") {
        def.approvalsReviewer = meta["approvals-reviewer"] as AgentDef["approvalsReviewer"];
      } else if (meta["approvals-reviewer"] === "null") {
        def.approvalsReviewer = null;
      }
      if (typeof meta["network-enabled"] === "boolean") {
        def.networkEnabled = meta["network-enabled"];
      }

      agents[agentKey] = def;
    } catch (error) {
      console.warn(
        `[dispatcher] skipping agent '${agentKey}' at '${agentPath}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const [stateId, state] of Object.entries(delamain.states)) {
    if (state.actor !== "agent" || !state.path) continue;
    await loadAgent(stateId, state.path);

    const subAgentPath = state["sub-agent"];
    if (subAgentPath) {
      const subAgentName = basename(subAgentPath, ".md");
      if (!agents[subAgentName]) {
        await loadAgent(subAgentName, subAgentPath);
      }
    }
  }

  const dispatchTable: DispatchEntry[] = [];
  const concurrencyPools = Object.fromEntries(
    Object.entries(delamain.concurrency_pools ?? {}).map(([poolId, pool]) => [
      poolId,
      {
        id: poolId,
        states: [...pool.states],
        capacity: pool.capacity,
      } satisfies ResolvedConcurrencyPool,
    ]),
  );
  const poolByState = new Map<string, ResolvedConcurrencyPool>();
  for (const pool of Object.values(concurrencyPools)) {
    for (const stateName of pool.states) {
      poolByState.set(stateName, pool);
    }
  }

  for (const [stateId, state] of Object.entries(delamain.states)) {
    if (state.actor !== "agent" || !state.path || !agents[stateId]) continue;

    const transitions = delamain.transitions
      .filter((transition) => {
        const sources = Array.isArray(transition.from) ? transition.from : [transition.from];
        return sources.includes(stateId);
      })
      .map((transition) => ({ class: transition.class, to: transition.to }));

    const subAgentPath = state["sub-agent"];
    const provider = state.provider ?? manifest.state_providers[stateId];
    if (!provider) {
      throw new Error(
        `Delamain state '${stateId}' in '${bundleRoot}' is missing projected provider metadata. Redeploy after ALS-025 provider migration.`,
      );
    }

    dispatchTable.push({
      state: stateId,
      agentName: stateId,
      subAgentName: subAgentPath ? basename(subAgentPath, ".md") : undefined,
      provider,
      resumable: state.resumable === true,
      concurrency: state.concurrency,
      pool: poolByState.get(stateId),
      sessionField: state.resumable ? state["session-field"] : undefined,
      transitions,
    });
  }

  return {
    systemRoot,
    moduleId: manifest.module_id,
    moduleRoot,
    entityName: manifest.entity_name,
    entityPath: manifest.entity_path,
    statusField: manifest.status_field,
    delamainName: manifest.delamain_name,
    submodules: manifest.submodules,
    maxTurns: effectiveLimits.maxTurns,
    maxBudgetUsdByProvider: effectiveLimits.maxBudgetUsdByProvider,
    discriminatorField: manifest.discriminator_field ?? undefined,
    discriminatorValue: manifest.discriminator_value ?? undefined,
    agents,
    allStates: Object.keys(delamain.states),
    concurrencyPools,
    dispatchTable,
  };
}

const sdkEnv: Record<string, string | undefined> = { ...process.env };
delete sdkEnv["ANTHROPIC_API_KEY"];
sdkEnv["DELAMAIN_SESSION"] = "1";

const today = () => new Date().toISOString().slice(0, 10);

export async function dispatch(
  itemId: string,
  itemFile: string,
  entry: DispatchEntry,
  agents: Record<string, AgentDef>,
  config: Pick<ResolvedConfig, "moduleId" | "delamainName" | "maxTurns" | "maxBudgetUsdByProvider">,
  bundleRoot: string,
  runtime: DispatcherRuntime,
  preparedInput?: PreparedDispatch,
): Promise<{ success: boolean; blocked: boolean; sessionId?: string; dispatchId?: string }> {
  const agent = agents[entry.agentName]!;
  const prepared = preparedInput ?? await runtime.prepareDispatch(itemId, itemFile, entry);
  if (!prepared) {
    console.log(`[dispatcher] ${itemId} skipped: runtime registry already owns this item`);
    return { success: false, blocked: true };
  }
  const isolatedItemFile = prepared.isolatedItemFile;

  const providerMaxBudgetUsd = config.maxBudgetUsdByProvider[entry.provider];

  let storedSessionId: string | null = null;
  if (entry.sessionField) {
    try {
      storedSessionId = await readFrontmatterField(isolatedItemFile, entry.sessionField);
    } catch (error) {
      await runtime.finalizeDispatch({
        prepared,
        entry,
        sessionId: null,
        durationMs: 0,
        numTurns: null,
        costUsd: null,
        success: false,
      });
      console.error(
        `[dispatcher] ${itemId} failed reading session metadata from ${entry.sessionField}:`,
        error instanceof Error ? error.message : error,
      );
      return { success: false, blocked: false, dispatchId: prepared.dispatchId };
    }
  }

  let sessionState = buildSessionRuntimeState(entry, storedSessionId);
  if (sessionState.ignoredInvalidSessionId) {
    console.log(
      `[dispatcher] ${itemId} ignoring invalid session ID: ${sessionState.ignoredInvalidSessionId}`,
    );
  }

  const transitionLines = entry.transitions.map(
    (transition) => `- ${transition.class} → ${transition.to}`,
  );
  const sessionContext: string[] = [];
  if (sessionState.includeRuntimeKeys) {
    sessionContext.push(`session_field: ${sessionState.runtimeSessionField ?? "null"}`);
    sessionContext.push(`session_id: ${sessionState.runtimeSessionId ?? "null"}`);
  }

  const prompt = [
    agent.prompt,
    "",
    "---",
    "",
    "## Runtime Context",
    "",
    `item_id: ${itemId}`,
    `item_file: ${isolatedItemFile}`,
    `current_state: ${entry.state}`,
    `date: ${today()}`,
    `resume: ${sessionState.resume}`,
    `worktree_path: ${prepared.worktreePath}`,
    `worktree_branch: ${prepared.branchName}`,
    ...sessionContext,
    "",
    "legal_transitions:",
    ...transitionLines,
  ].join("\n");

  const tools = [...(agent.tools ?? ["Read", "Edit"])];
  let subAgents: Record<string, AgentDef> | undefined;
  if (entry.subAgentName && agents[entry.subAgentName]) {
    if (!tools.includes("Agent")) tools.push("Agent");
    subAgents = { [entry.subAgentName]: agents[entry.subAgentName]! };
  }

  console.log(
    `[dispatcher] ${itemId} @ current state: ${entry.state} provider=${entry.provider}`
      + (sessionState.resumeSessionId
        ? ` (resume: ${sessionState.resumeSessionId.slice(0, 8)}...)`
        : "")
      + ` (worktree: ${prepared.branchName})`
      + (entry.subAgentName ? ` (+ sub-agent: ${entry.subAgentName})` : ""),
  );

  let sessionId: string | undefined;
  let resultSummary: ProviderDispatchResult | null = null;
  const startedAt = Date.now();
  const baseEvent = {
    schema: DISPATCH_TELEMETRY_SCHEMA,
    dispatcher_name: config.delamainName,
    module_id: config.moduleId,
    dispatch_id: prepared.dispatchId,
    item_id: itemId,
    item_file: itemFile,
    isolated_item_file: isolatedItemFile,
    state: entry.state,
    agent_name: entry.agentName,
    sub_agent_name: entry.subAgentName ?? null,
    provider: entry.provider,
    resumable: entry.resumable,
    resume_requested: sessionState.resume === "yes",
    session_field: entry.sessionField ?? null,
    runtime_session_id: sessionState.runtimeSessionId ?? null,
    resume_session_id: sessionState.resumeSessionId ?? null,
    worktree_path: prepared.worktreePath,
    branch_name: prepared.branchName,
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
    merge_outcome: null,
    incident_kind: null,
    transition_targets: entry.transitions.map((transition) => transition.to),
  } satisfies Omit<
    DispatchTelemetryEvent,
    "event_id"
      | "event_type"
      | "timestamp"
      | "worker_session_id"
      | "duration_ms"
      | "num_turns"
      | "cost_usd"
      | "error"
  >;
  const heartbeat = setInterval(() => {
    void runtime.touchDispatch(prepared.dispatchId).catch((error) => {
      console.warn(
        `[dispatcher] ${itemId} heartbeat update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, 10_000);

  try {
    await writeTelemetry({
      ...baseEvent,
      event_id: crypto.randomUUID(),
      event_type: "dispatch_start",
      timestamp: new Date(startedAt).toISOString(),
      worker_session_id: null,
      duration_ms: null,
      num_turns: null,
      cost_usd: null,
      error: null,
    });
    await writeTelemetry({
      ...baseEvent,
      event_id: crypto.randomUUID(),
      event_type: "dispatch_prepare",
      timestamp: new Date(startedAt).toISOString(),
      worker_session_id: null,
      duration_ms: null,
      num_turns: null,
      cost_usd: null,
      error: null,
    });

    resultSummary = await runProviderDispatch(sessionState);
    const recoveredState = await recoverFreshDispatchAfterMissingResumeSession({
      itemId,
      isolatedItemFile,
      entry,
      sessionState,
      resultSummary,
      log: console.log,
    });
    if (recoveredState !== sessionState) {
      sessionState = recoveredState;
      resultSummary = await runProviderDispatch(sessionState);
    }
    sessionId = resultSummary.sessionId;

    const cost = resultSummary.totalCostUsd === null
      ? resultSummary.subtype
      : resultSummary.subtype === "success"
        ? `$${resultSummary.totalCostUsd.toFixed(4)}`
        : resultSummary.subtype;
    const secs = Math.round(resultSummary.durationMs / 1000);
    console.log(
      `[dispatcher] ${itemId} done provider=${entry.provider} (${cost}, ${secs}s, ${resultSummary.numTurns} turns)`,
    );

    const dispatchSucceeded = resultSummary
      ? resultSummary.subtype === "success"
      : true;

    if (
      entry.resumable
      && entry.sessionField
      && sessionState.resume === "no"
      && !sessionId
    ) {
      console.warn(
        `[dispatcher] ${itemId} completed without SDK session id; skipping persistence for ${entry.sessionField}`,
      );
    }

    if (shouldPersistDispatcherSession(entry, sessionId, sessionState)) {
      const persisted = await setFrontmatterField(
        isolatedItemFile,
        entry.sessionField!,
        sessionId!,
      );
      if (persisted) {
        console.log(
          `[dispatcher] ${itemId} session persisted → ${entry.sessionField}`,
        );
      }
    }

    const finalized = await runtime.finalizeDispatch({
      prepared,
      entry,
      sessionId: sessionId ?? null,
      durationMs: resultSummary?.durationMs ?? Date.now() - startedAt,
      numTurns: resultSummary?.numTurns ?? null,
      costUsd: resultSummary?.totalCostUsd ?? null,
      success: dispatchSucceeded,
    });

    if (finalized.mergeOutcome === "merged") {
      await writeTelemetry({
        ...baseEvent,
        event_id: crypto.randomUUID(),
        event_type: "dispatch_merge_success",
        timestamp: new Date().toISOString(),
        worker_session_id: sessionId ?? null,
        mounted_submodules: finalized.mountedSubmodules,
        worktree_commit: finalized.worktreeCommit,
        integrated_commit: finalized.integratedCommit,
        merge_outcome: finalized.mergeOutcome,
        incident_kind: null,
        duration_ms: resultSummary?.durationMs ?? Date.now() - startedAt,
        num_turns: resultSummary?.numTurns ?? null,
        cost_usd: resultSummary?.totalCostUsd ?? null,
        error: null,
      });
    } else if (finalized.blocked) {
      await writeTelemetry({
        ...baseEvent,
        event_id: crypto.randomUUID(),
        event_type: "dispatch_merge_blocked",
        timestamp: new Date().toISOString(),
        worker_session_id: sessionId ?? null,
        mounted_submodules: finalized.mountedSubmodules,
        worktree_commit: finalized.worktreeCommit,
        integrated_commit: finalized.integratedCommit,
        merge_outcome: finalized.mergeOutcome,
        incident_kind: finalized.incidentKind,
        duration_ms: resultSummary?.durationMs ?? Date.now() - startedAt,
        num_turns: resultSummary?.numTurns ?? null,
        cost_usd: resultSummary?.totalCostUsd ?? null,
        error: finalized.incidentMessage,
      });
    }

    if (!finalized.blocked) {
      await writeTelemetry({
        ...baseEvent,
        event_id: crypto.randomUUID(),
        event_type: "dispatch_cleanup",
        timestamp: new Date().toISOString(),
        worker_session_id: sessionId ?? null,
        mounted_submodules: finalized.mountedSubmodules,
        worktree_commit: finalized.worktreeCommit,
        integrated_commit: finalized.integratedCommit,
        merge_outcome: finalized.mergeOutcome,
        incident_kind: null,
        duration_ms: resultSummary?.durationMs ?? Date.now() - startedAt,
        num_turns: resultSummary?.numTurns ?? null,
        cost_usd: resultSummary?.totalCostUsd ?? null,
        error: null,
      });
    }

    const overallSuccess = dispatchSucceeded && !finalized.blocked;
    await writeTelemetry({
      ...baseEvent,
      event_id: crypto.randomUUID(),
      event_type: overallSuccess ? "dispatch_finish" : "dispatch_failure",
      timestamp: new Date().toISOString(),
      worker_session_id: sessionId ?? null,
      mounted_submodules: finalized.mountedSubmodules,
      worktree_commit: finalized.worktreeCommit,
      integrated_commit: finalized.integratedCommit,
      merge_outcome: finalized.mergeOutcome,
      incident_kind: finalized.incidentKind,
      duration_ms: resultSummary?.durationMs ?? Date.now() - startedAt,
      num_turns: resultSummary?.numTurns ?? null,
      cost_usd: resultSummary?.totalCostUsd ?? null,
      error:
        finalized.incidentMessage
        ?? (
          dispatchSucceeded
            ? null
            : describeDispatchFailure(resultSummary?.subtype, entry.provider, providerMaxBudgetUsd)
        ),
    });

    return {
      success: overallSuccess,
      blocked: finalized.blocked,
      sessionId,
      dispatchId: prepared.dispatchId,
    };
  } catch (error) {
    const finalized = await runtime.finalizeDispatch({
      prepared,
      entry,
      sessionId: sessionId ?? null,
      durationMs: Date.now() - startedAt,
      numTurns: resultSummary?.numTurns ?? null,
      costUsd: resultSummary?.totalCostUsd ?? null,
      success: false,
    });

    await writeTelemetry({
      ...baseEvent,
      event_id: crypto.randomUUID(),
      event_type: "dispatch_failure",
      timestamp: new Date().toISOString(),
      worker_session_id: sessionId ?? null,
      mounted_submodules: finalized.mountedSubmodules,
      worktree_commit: finalized.worktreeCommit,
      integrated_commit: finalized.integratedCommit,
      merge_outcome: finalized.mergeOutcome,
      incident_kind: finalized.incidentKind,
      duration_ms: Date.now() - startedAt,
      num_turns: resultSummary?.numTurns ?? null,
      cost_usd: resultSummary?.totalCostUsd ?? null,
      error: finalized.incidentMessage ?? (error instanceof Error ? error.message : String(error)),
    });
    console.error(
      `[dispatcher] ${itemId} failed:`,
      error instanceof Error ? error.message : error,
    );
    return {
      success: false,
      blocked: finalized.blocked,
      dispatchId: prepared.dispatchId,
    };
  } finally {
    clearInterval(heartbeat);
  }

  async function writeTelemetry(event: DispatchTelemetryEvent): Promise<void> {
    try {
      await appendTelemetryEvent(bundleRoot, event);
    } catch (error) {
      console.warn(
        `[dispatcher] ${itemId} telemetry write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function runProviderDispatch(
    state: typeof sessionState,
  ): Promise<ProviderDispatchResult> {
    return getAgentProvider(entry.provider).dispatch({
      itemId,
      prompt,
      cwd: prepared.worktreePath,
      agent: {
        ...agent,
        ...(entry.provider === "anthropic" ? { tools } : {}),
      },
      maxTurns: config.maxTurns,
      maxBudgetUsd: providerMaxBudgetUsd,
      resumeSessionId: state.resumeSessionId,
      env: sdkEnv,
      ...(subAgents ? { subAgents } : {}),
      onToolUse: (detail) => {
        console.log(`[dispatcher]   ${itemId} provider=${entry.provider} | ${detail}`);
      },
      onDebugLog: (detail) => {
        console.log(`[dispatcher] ${itemId} ${detail}`);
      },
    });
  }
}

function describeDispatchFailure(
  subtype: string | undefined,
  provider: AgentProvider,
  maxBudgetUsd: number,
): string {
  if (provider === "openai" && subtype === "max_budget_exceeded") {
    return `result:max_budget_exceeded provider=openai maxBudgetUsd=${maxBudgetUsd}`;
  }
  if (provider === "anthropic" && subtype === "error_max_budget_usd") {
    return `result:error_max_budget_usd provider=anthropic maxBudgetUsd=${maxBudgetUsd}`;
  }

  return `result:${subtype ?? "unknown"}`;
}
