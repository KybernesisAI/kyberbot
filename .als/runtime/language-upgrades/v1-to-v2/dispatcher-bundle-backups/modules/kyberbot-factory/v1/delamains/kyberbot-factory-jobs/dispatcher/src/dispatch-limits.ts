import type { AgentProvider } from "./provider.js";

export interface DispatchLimitsInput {
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxBudgetUsdByProvider?: {
    anthropic?: number;
    openai?: number;
  };
}

export interface ResolvedDispatchLimits {
  maxTurns: number;
  maxBudgetUsdByProvider: Record<AgentProvider, number>;
}

export const DEFAULT_MAX_TURNS = 50;
export const DEFAULT_MAX_BUDGET_USD_OPENAI = 50.0;
export const DEFAULT_MAX_BUDGET_USD_ANTHROPIC = 20.0;

export function resolveDispatchLimits(limits?: DispatchLimitsInput): ResolvedDispatchLimits {
  const authoredProviderLimits = limits?.maxBudgetUsdByProvider;
  const sharedBudget = limits?.maxBudgetUsd;

  return {
    maxTurns: limits?.maxTurns ?? DEFAULT_MAX_TURNS,
    maxBudgetUsdByProvider: {
      anthropic:
        authoredProviderLimits?.anthropic
        ?? sharedBudget
        ?? DEFAULT_MAX_BUDGET_USD_ANTHROPIC,
      openai:
        authoredProviderLimits?.openai
        ?? sharedBudget
        ?? DEFAULT_MAX_BUDGET_USD_OPENAI,
    },
  };
}
