import { setFrontmatterField } from "./frontmatter.js";
import {
  buildSessionRuntimeState,
  type SessionDispatchEntry,
  type SessionRuntimeState,
} from "./session-runtime.js";
import type { ProviderDispatchResult } from "./agent-providers.js";

interface ResumeRecoveryInput {
  itemId: string;
  isolatedItemFile: string;
  entry: SessionDispatchEntry;
  sessionState: SessionRuntimeState;
  resultSummary: ProviderDispatchResult;
  log: (message: string) => void;
}

export async function recoverFreshDispatchAfterMissingResumeSession(
  input: ResumeRecoveryInput,
): Promise<SessionRuntimeState> {
  if (
    !input.resultSummary.resumeRecovery
    || !input.entry.sessionField
    || input.sessionState.resume !== "yes"
  ) {
    return input.sessionState;
  }

  input.log(`[dispatcher] ${input.itemId} ${input.resultSummary.resumeRecovery.logMessage}`);
  const cleared = await setFrontmatterField(
    input.isolatedItemFile,
    input.entry.sessionField,
    null,
  );
  if (cleared) {
    input.log(`[dispatcher] ${input.itemId} cleared stale session -> ${input.entry.sessionField}`);
  }

  return buildSessionRuntimeState(input.entry, null);
}
