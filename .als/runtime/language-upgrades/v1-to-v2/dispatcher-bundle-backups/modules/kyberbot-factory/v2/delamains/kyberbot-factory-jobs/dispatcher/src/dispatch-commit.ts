export interface DispatchCommitMessageInput {
  dispatchId: string;
  dispatcherName: string;
  itemId: string;
  agentName: string;
  fromState: string;
  toState: string;
  durationMs: number | null;
  numTurns: number | null;
  costUsd: number | null;
  sessionId: string | null;
}

export function buildDispatchCommitMessage(input: DispatchCommitMessageInput): string {
  return [
    `delamain: ${input.itemId} ${input.fromState} → ${input.toState} [${input.dispatcherName}]`,
    "",
    `Dispatch-Id: ${input.dispatchId}`,
    `Item-Id: ${input.itemId}`,
    `Delamain: ${input.dispatcherName}`,
    `Agent: ${input.agentName}`,
    `From-State: ${input.fromState}`,
    `To-State: ${input.toState}`,
    `Duration-Ms: ${formatInteger(input.durationMs)}`,
    `Turns: ${formatInteger(input.numTurns)}`,
    `Cost-Usd: ${formatCost(input.costUsd)}`,
    `Session-Id: ${input.sessionId ?? "n/a"}`,
  ].join("\n");
}

function formatInteger(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(Math.max(0, Math.round(value)))
    : "n/a";
}

function formatCost(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(4)
    : "n/a";
}
