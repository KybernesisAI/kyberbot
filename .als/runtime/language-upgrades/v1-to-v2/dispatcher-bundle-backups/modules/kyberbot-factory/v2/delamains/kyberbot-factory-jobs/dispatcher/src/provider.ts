export type AgentProvider = "anthropic" | "openai";

export interface ProviderDispatchCounts {
  anthropic: number;
  openai: number;
}

export function emptyProviderDispatchCounts(): ProviderDispatchCounts {
  return {
    anthropic: 0,
    openai: 0,
  };
}

export function incrementProviderDispatchCount(
  counts: ProviderDispatchCounts,
  provider: AgentProvider,
): void {
  counts[provider] += 1;
}
