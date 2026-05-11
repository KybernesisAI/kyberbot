import { isAbsolute, resolve as resolvePath } from "node:path";
import { gitCommonDir } from "./git.js";
import type { AgentProvider } from "./provider.js";

const ANTHROPIC_MODELS = new Set(["sonnet", "opus", "haiku"]);
const OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;
const TOKENS_PER_MILLION = 1_000_000;

interface OpenAIModelPricingTier {
  inputUsdPer1M: number;
  cachedInputUsdPer1M: number;
  outputUsdPer1M: number;
}

interface OpenAIModelPricing {
  short: OpenAIModelPricingTier;
  long?: OpenAIModelPricingTier;
  longContextThresholdTokens?: number;
}

const OPENAI_MODEL_PRICING: Record<string, OpenAIModelPricing> = {
  "gpt-5.5": {
    short: { inputUsdPer1M: 5, cachedInputUsdPer1M: 0.5, outputUsdPer1M: 30 },
    long: { inputUsdPer1M: 10, cachedInputUsdPer1M: 1, outputUsdPer1M: 45 },
    longContextThresholdTokens: OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
  },
  "gpt-5.4": {
    short: { inputUsdPer1M: 2.5, cachedInputUsdPer1M: 0.25, outputUsdPer1M: 15 },
    long: { inputUsdPer1M: 5, cachedInputUsdPer1M: 0.5, outputUsdPer1M: 22.5 },
    longContextThresholdTokens: OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
  },
  "gpt-5.4-mini": {
    short: { inputUsdPer1M: 0.75, cachedInputUsdPer1M: 0.075, outputUsdPer1M: 4.5 },
  },
  "gpt-5.4-nano": {
    short: { inputUsdPer1M: 0.2, cachedInputUsdPer1M: 0.02, outputUsdPer1M: 1.25 },
  },
  "gpt-5.4-pro": {
    short: { inputUsdPer1M: 30, cachedInputUsdPer1M: 0, outputUsdPer1M: 180 },
    long: { inputUsdPer1M: 60, cachedInputUsdPer1M: 0, outputUsdPer1M: 270 },
    longContextThresholdTokens: OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
  },
  "gpt-5.3-codex": {
    short: { inputUsdPer1M: 1.75, cachedInputUsdPer1M: 0.175, outputUsdPer1M: 14 },
  },
  "gpt-5.2": {
    short: { inputUsdPer1M: 1.75, cachedInputUsdPer1M: 0.175, outputUsdPer1M: 14 },
  },
  "gpt-5.2-codex": {
    short: { inputUsdPer1M: 1.75, cachedInputUsdPer1M: 0.175, outputUsdPer1M: 14 },
  },
  "gpt-5.1-codex-max": {
    short: { inputUsdPer1M: 1.25, cachedInputUsdPer1M: 0.125, outputUsdPer1M: 10 },
  },
  "gpt-5.1-codex-mini": {
    short: { inputUsdPer1M: 0.25, cachedInputUsdPer1M: 0.025, outputUsdPer1M: 2 },
  },
  "gpt-5-codex": {
    short: { inputUsdPer1M: 1.25, cachedInputUsdPer1M: 0.125, outputUsdPer1M: 10 },
  },
};

export interface LoadedAgentPrompt {
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-request" | "on-failure" | "never";
  approvalsReviewer?: "auto_review" | "off" | null;
  networkEnabled?: boolean;
}

export interface ProviderDispatchInput {
  itemId: string;
  prompt: string;
  cwd: string;
  agent: LoadedAgentPrompt;
  maxTurns: number;
  maxBudgetUsd: number;
  resumeSessionId?: string;
  env: Record<string, string | undefined>;
  subAgents?: Record<string, LoadedAgentPrompt>;
  onToolUse: (detail: string) => void;
  onDebugLog?: (detail: string) => void;
}

export interface ProviderDispatchResult {
  sessionId?: string;
  subtype: string;
  totalCostUsd: number | null;
  durationMs: number;
  numTurns: number;
  resumeRecovery?: {
    reason: "session_missing";
    logMessage: string;
  };
}

export interface AgentProviderAdapter {
  dispatch(input: ProviderDispatchInput): Promise<ProviderDispatchResult>;
}

export interface OpenAIUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

const providers: Record<AgentProvider, AgentProviderAdapter> = {
  anthropic: {
    async dispatch(input) {
      const { getSessionInfo, query } = await loadAnthropicSdk();
      let sessionId = input.resumeSessionId;
      let resultSummary: ProviderDispatchResult | null = null;
      const startedAt = Date.now();
      let lastAnthropicErrors: string[] = [];

      if (input.resumeSessionId) {
        const sessionInfo = await getSessionInfo(input.resumeSessionId);
        input.onDebugLog?.(
          `[resume-recovery] anthropic pre-flight getSessionInfo(${shortSessionId(input.resumeSessionId)}) -> ${describeAnthropicSessionInfo(sessionInfo)}`,
        );
        if (!sessionInfo) {
          return buildAnthropicResumeRecoveryResult(sessionId, startedAt);
        }
      }

      try {
        for await (const message of query({
          prompt: input.prompt,
          options: {
            cwd: input.cwd,
            model: resolveAnthropicModel(input.agent.model),
            allowedTools: [...(input.agent.tools ?? ["Read", "Edit"])],
            ...(input.subAgents ? { agents: toAnthropicSubAgents(input.subAgents) } : {}),
            ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
            env: input.env,
            permissionMode: "acceptEdits",
            maxTurns: input.maxTurns,
            maxBudgetUsd: input.maxBudgetUsd,
          },
        })) {
          if (message.type === "system" && message.subtype === "init") {
            sessionId = message.session_id;
          }

          if (message.type === "assistant") {
            for (const block of message.message.content) {
              if (block.type === "tool_use") {
                input.onToolUse(formatToolUse(block.name, block.input as Record<string, unknown>));
              }
            }
          }

          if (message.type === "result") {
            const errors = extractAnthropicResultErrors(message);
            if (input.resumeSessionId) {
              lastAnthropicErrors = errors;
              input.onDebugLog?.(
                `[resume-recovery] anthropic post-error matcher saw errors=${errors.length}: ${summarizeErrors(errors)}`,
              );
            }
            resultSummary = {
              sessionId,
              subtype: message.subtype,
              totalCostUsd:
                typeof message.total_cost_usd === "number" ? message.total_cost_usd : null,
              durationMs: message.duration_ms,
              numTurns: message.num_turns,
              ...(input.resumeSessionId && isAnthropicMissingSessionError(errors)
                ? {
                  resumeRecovery: {
                    reason: "session_missing" as const,
                    logMessage: "resume failed (session expired), spawning fresh",
                  },
                }
                : {}),
            };
          }
        }
      } catch (error) {
        if (input.resumeSessionId) {
          const errorMessage = extractErrorMessage(error);
          input.onDebugLog?.(
            `[resume-recovery] anthropic query threw: ${truncateLogDetail(errorMessage, 240)}`,
          );
          if (
            isAnthropicMissingSessionError(lastAnthropicErrors)
            || isAnthropicMissingSessionMessage(errorMessage)
          ) {
            return withAnthropicResumeRecovery(
              resultSummary ?? buildAnthropicResumeRecoveryResult(sessionId, startedAt),
            );
          }
        }

        throw error;
      }

      return resultSummary ?? {
        sessionId,
        subtype: "success",
        totalCostUsd: null,
        durationMs: Date.now() - startedAt,
        numTurns: 0,
      };
    },
  },
  openai: {
    async dispatch(input) {
      if (input.subAgents && Object.keys(input.subAgents).length > 0) {
        throw new Error("OpenAI agent states do not support ALS sub-agent projection");
      }

      const { Codex } = await loadCodexSdk();
      const startedAt = Date.now();
      let sessionId = input.resumeSessionId;
      let numTurns = 0;
      let totalCostUsd = 0;
      let failureSubtype = "success";
      let resumeRecovery: ProviderDispatchResult["resumeRecovery"];
      const model = input.agent.model ?? "gpt-5.4";
      if (!resolveOpenAIModelPricing(model)) {
        throw new Error(
          `OpenAI dispatcher cost accounting does not recognize model '${model}'. Add pricing before using it in Delamain prompts.`,
        );
      }

      const commonDir = await gitCommonDir(input.cwd);
      const additionalDirectories = [normalizeAdditionalDirectory(input.cwd, commonDir)];
      const apiKey = asString(input.env["CODEX_API_KEY"]) ?? asString(process.env["CODEX_API_KEY"]);
      const codexConfig = buildOpenAICodexConfig(input.agent);
      const codex = new Codex({
        ...(apiKey ? { apiKey } : {}),
        env: normalizeEnv(input.env),
        ...(codexConfig ? { config: codexConfig } : {}),
      });

      const threadOptions: Record<string, unknown> = {
        model,
        workingDirectory: input.cwd,
        sandboxMode: input.agent.sandboxMode ?? "workspace-write",
        approvalPolicy: input.agent.approvalPolicy ?? "never",
        additionalDirectories,
      };

      if (input.agent.reasoningEffort) {
        threadOptions["modelReasoningEffort"] = input.agent.reasoningEffort;
      }

      if (input.agent.networkEnabled !== undefined) {
        threadOptions["networkAccessEnabled"] = input.agent.networkEnabled;
      }

      const thread = input.resumeSessionId
        ? codex.resumeThread(input.resumeSessionId, threadOptions)
        : codex.startThread(threadOptions);
      const streamed = await thread.runStreamed(input.prompt);

      try {
        for await (const event of streamed.events) {
          const type = extractCodexEventType(event);
          if (!type) continue;

          if (type === "thread.started") {
            sessionId = asString(event["thread_id"]) ?? asString(event["threadId"]) ?? sessionId;
            continue;
          }

          if (type === "turn.completed") {
            numTurns += 1;
            const usage = extractCodexUsage(event);
            if (!usage) {
              failureSubtype = "error";
              throw new Error(`OpenAI turn.completed event omitted usage for ${input.itemId}`);
            }
            totalCostUsd += estimateOpenAITurnCostUsd(model, usage) ?? 0;
            if (numTurns > input.maxTurns) {
              failureSubtype = "max_turns_exceeded";
              throw new Error(
                `OpenAI dispatch exceeded maxTurns (${input.maxTurns}) for ${input.itemId}`,
              );
            }
            if (totalCostUsd > input.maxBudgetUsd) {
              failureSubtype = "max_budget_exceeded";
              throw new Error(
                `OpenAI dispatch exceeded provider maxBudgetUsd (provider=openai, maxBudgetUsd=${input.maxBudgetUsd}) for ${input.itemId}`,
              );
            }
            continue;
          }

          if (type === "turn.failed" || type === "error") {
            failureSubtype = "error";
            if (type === "turn.failed" && input.resumeSessionId) {
              resumeRecovery = {
                reason: "session_missing",
                logMessage:
                  "codex resume turn.failed -> assuming session-gone, falling back fresh",
              };
              break;
            }
            continue;
          }

          if (type === "item.started" || type === "item.updated" || type === "item.completed") {
            for (const detail of describeCodexActions(event)) {
              input.onToolUse(detail);
            }
          }
        }
      } catch (error) {
        return {
          sessionId,
          subtype: failureSubtype === "success" ? "error" : failureSubtype,
          totalCostUsd,
          durationMs: Date.now() - startedAt,
          numTurns,
          resumeRecovery,
        };
      }

      return {
        sessionId,
        subtype: failureSubtype,
        totalCostUsd,
        durationMs: Date.now() - startedAt,
        numTurns,
        resumeRecovery,
      };
    },
  },
};

export function getAgentProvider(provider: AgentProvider): AgentProviderAdapter {
  return providers[provider];
}

export function estimateOpenAITurnCostUsd(model: string, usage: OpenAIUsage): number | null {
  const pricing = resolveOpenAIModelPricing(model);
  if (!pricing) {
    return null;
  }

  const promptInputTokens = usage.inputTokens + usage.cachedInputTokens;
  const tier = pricing.long && pricing.longContextThresholdTokens
      && promptInputTokens > pricing.longContextThresholdTokens
    ? pricing.long
    : pricing.short;

  return (
    (usage.inputTokens / TOKENS_PER_MILLION) * tier.inputUsdPer1M
    + (usage.cachedInputTokens / TOKENS_PER_MILLION) * tier.cachedInputUsdPer1M
    + (usage.outputTokens / TOKENS_PER_MILLION) * tier.outputUsdPer1M
  );
}

function resolveAnthropicModel(model: string | undefined): "sonnet" | "opus" | "haiku" {
  if (model && ANTHROPIC_MODELS.has(model)) {
    return model as "sonnet" | "opus" | "haiku";
  }

  return "sonnet";
}

function toAnthropicSubAgents(
  subAgents: Record<string, LoadedAgentPrompt>,
): Record<string, { description: string; prompt: string; tools?: string[]; model?: "sonnet" | "opus" | "haiku" }> {
  return Object.fromEntries(
    Object.entries(subAgents).map(([name, agent]) => [
      name,
      {
        description: agent.description,
        prompt: agent.prompt,
        ...(agent.tools ? { tools: agent.tools } : {}),
        ...(agent.model && ANTHROPIC_MODELS.has(agent.model)
          ? { model: agent.model as "sonnet" | "opus" | "haiku" }
          : {}),
      },
    ]),
  );
}

function normalizeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }
  return normalized;
}

function normalizeAdditionalDirectory(cwd: string, value: string): string {
  return isAbsolute(value) ? value : resolvePath(cwd, value);
}

function buildOpenAICodexConfig(
  agent: LoadedAgentPrompt,
): Record<string, string> | undefined {
  if (agent.approvalsReviewer !== "auto_review") {
    return undefined;
  }

  return {
    approvals_reviewer: "auto_review",
  };
}

async function loadCodexSdk(): Promise<{ Codex: new (options: Record<string, unknown>) => any }> {
  try {
    return await codexSdkLoader();
  } catch (error) {
    throw new Error(
      `OpenAI dispatcher integration requires '@openai/codex-sdk': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function loadAnthropicSdk(): Promise<{
  getSessionInfo: (sessionId: string) => Promise<unknown>;
  query: (input: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<any>;
}> {
  try {
    return await anthropicSdkLoader();
  } catch (error) {
    throw new Error(
      `Anthropic dispatcher integration requires '@anthropic-ai/claude-agent-sdk': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

let codexSdkLoader = () => import("@openai/codex-sdk");
let anthropicSdkLoader = () => import("@anthropic-ai/claude-agent-sdk");

export function setCodexSdkLoaderForTests(
  loader: typeof codexSdkLoader,
): void {
  codexSdkLoader = loader;
}

export function setAnthropicSdkLoaderForTests(
  loader: typeof anthropicSdkLoader,
): void {
  anthropicSdkLoader = loader;
}

export function resetProviderSdkLoadersForTests(): void {
  codexSdkLoader = () => import("@openai/codex-sdk");
  anthropicSdkLoader = () => import("@anthropic-ai/claude-agent-sdk");
}

function extractCodexEventType(event: unknown): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const value = event as Record<string, unknown>;
  return asString(value["type"]) ?? asString(value["event"]) ?? null;
}

function extractAnthropicResultErrors(message: unknown): string[] {
  const value = asRecord(message);
  const errors = value ? value["errors"] : null;
  if (!Array.isArray(errors)) {
    return [];
  }

  return errors.filter((entry): entry is string => typeof entry === "string");
}

function describeAnthropicSessionInfo(sessionInfo: unknown): string {
  const value = asRecord(sessionInfo);
  if (!value) {
    return "missing";
  }

  const summary = asString(value["summary"]) ?? "n/a";
  const cwd = asString(value["cwd"]) ?? "n/a";
  const lastModified = asNumber(value["lastModified"]);
  return `found summary=${JSON.stringify(summary)} cwd=${JSON.stringify(cwd)} lastModified=${lastModified ?? "n/a"}`;
}

function extractCodexUsage(event: unknown): OpenAIUsage | null {
  const value = asRecord(event);
  const usage = value ? asRecord(value["usage"]) : null;
  if (!usage) {
    return null;
  }

  const inputTokens = asNumber(usage["input_tokens"]) ?? 0;
  const cachedInputTokens = asNumber(usage["cached_input_tokens"]) ?? 0;
  const outputTokens = asNumber(usage["output_tokens"]) ?? 0;
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
  };
}

function describeCodexActions(event: unknown): string[] {
  const value = asRecord(event);
  const eventType = value ? extractCodexEventType(value) : null;
  const item = value ? asRecord(value["item"]) : null;
  if (!eventType || !item) {
    return [];
  }

  const itemType = asString(item["type"]) ?? asString(item["kind"]) ?? "";

  switch (itemType) {
    case "command_execution":
      return eventType === "item.started"
        ? [formatToolUse("Bash", { command: asString(item["command"]) ?? "" })]
        : [];
    case "file_change":
      return eventType === "item.completed" ? describeCodexFileChangeActions(item) : [];
    case "mcp_tool_call":
      return eventType === "item.started" ? [formatCodexMcpAction(item)] : [];
    case "web_search":
      return eventType === "item.started"
        ? [formatCodexActionDetail("WebSearch", asString(item["query"]))]
        : [];
    case "error":
      return eventType === "item.completed" ? [formatCodexErrorAction(item)] : [];
    default:
      return [];
  }
}

function describeCodexFileChangeActions(item: Record<string, unknown>): string[] {
  const changes = item["changes"];
  if (!Array.isArray(changes)) {
    return [];
  }

  return changes.flatMap((change) => {
    const value = asRecord(change);
    const path = value ? asString(value["path"]) : null;
    if (!path) {
      return [];
    }

    const kind = value ? asString(value["kind"]) : null;
    return [`${codexFileChangeVerb(kind)} ${path}`];
  });
}

function codexFileChangeVerb(kind: string | null): string {
  if (kind === "add") {
    return "Write";
  }
  if (kind === "delete") {
    return "Delete";
  }
  return "Edit";
}

function formatCodexMcpAction(item: Record<string, unknown>): string {
  const server = asString(item["server"]);
  const tool = asString(item["tool"]);
  const target = server && tool ? `${server}.${tool}` : server ?? tool;
  return target ? `MCP ${target}` : "MCP";
}

function formatCodexActionDetail(name: string, detail: string | null): string {
  if (!detail) {
    return name;
  }

  return `${name} ${truncateLogDetail(detail, 60)}`;
}

function formatCodexErrorAction(item: Record<string, unknown>): string {
  const message = asString(item["message"]);
  return message ? `Error: ${truncateLogDetail(message, 240)}` : "Error";
}

function formatToolUse(name: string, input: Record<string, unknown>): string {
  const path = asString(input["file_path"]) ?? asString(input["path"]);
  if (path) return `${name} ${path}`;

  const command = asString(input["command"]) ?? asString(input["cmd"]);
  if (command) return `${name} ${command.length > 60 ? `${command.slice(0, 57)}...` : command}`;

  const pattern = asString(input["pattern"]);
  if (pattern) return `${name} ${pattern}`;

  const description = asString(input["description"]);
  if (description) return `${name}: ${description}`;

  return name;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function resolveOpenAIModelPricing(model: string): OpenAIModelPricing | null {
  const normalized = model.trim().toLowerCase();
  const direct = OPENAI_MODEL_PRICING[normalized];
  if (direct) {
    return direct;
  }

  for (const [prefix, pricing] of Object.entries(OPENAI_MODEL_PRICING)) {
    if (normalized === prefix || normalized.startsWith(`${prefix}-`)) {
      return pricing;
    }
  }

  return null;
}

function isAnthropicMissingSessionError(errors: string[]): boolean {
  return errors.some((error) => {
    const normalized = error.trim().toLowerCase();
    return normalized.includes("no conversation found")
      || normalized.includes("session id")
      || normalized.includes("conversation no longer exists");
  });
}

function isAnthropicMissingSessionMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return normalized.includes("claude code returned an error result:")
    && (
      normalized.includes("no conversation found")
      || normalized.includes("conversation no longer exists")
      || normalized.includes("session id")
    );
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function summarizeErrors(errors: string[]): string {
  if (errors.length === 0) {
    return "<none>";
  }

  return truncateLogDetail(errors.join(" | "), 240);
}

function truncateLogDetail(detail: string, maxLength: number): string {
  return detail.length > maxLength ? `${detail.slice(0, maxLength - 3)}...` : detail;
}

function shortSessionId(sessionId: string): string {
  return sessionId.length > 8 ? `${sessionId.slice(0, 8)}...` : sessionId;
}

function buildAnthropicResumeRecoveryResult(
  sessionId: string | undefined,
  startedAt: number,
): ProviderDispatchResult {
  return {
    sessionId,
    subtype: "resume_session_missing",
    totalCostUsd: null,
    durationMs: Date.now() - startedAt,
    numTurns: 0,
    resumeRecovery: {
      reason: "session_missing",
      logMessage: "resume failed (session expired), spawning fresh",
    },
  };
}

function withAnthropicResumeRecovery(
  result: ProviderDispatchResult,
): ProviderDispatchResult {
  return {
    ...result,
    resumeRecovery: {
      reason: "session_missing",
      logMessage: "resume failed (session expired), spawning fresh",
    },
  };
}
