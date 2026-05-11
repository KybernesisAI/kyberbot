import type { AgentProvider } from "./provider.js";

export interface SessionDispatchEntry {
  provider: AgentProvider;
  resumable: boolean;
  sessionField?: string;
}

export interface SessionRuntimeNoResumeState {
  /**
   * True when the dispatcher should append `session_field` / `session_id`
   * to Runtime Context. Delegated states keep this true even when both
   * runtime values are null.
   */
  includeRuntimeKeys: boolean;
  runtimeSessionField: string | null;
  runtimeSessionId: string | null;
  resume: "no";
  resumeSessionId?: undefined;
}

export interface SessionRuntimeResumeState {
  includeRuntimeKeys: true;
  runtimeSessionField: string;
  runtimeSessionId: string;
  resume: "yes";
  resumeSessionId: string;
}

export type SessionRuntimeState =
  | SessionRuntimeNoResumeState
  | SessionRuntimeResumeState;

export function buildSessionRuntimeState(
  entry: SessionDispatchEntry,
  storedSessionId: string | null,
): SessionRuntimeState {
  if (!entry.resumable || !entry.sessionField) {
    return {
      includeRuntimeKeys: false,
      runtimeSessionField: null,
      runtimeSessionId: null,
      resume: "no",
    };
  }

  if (!storedSessionId) {
    return {
      includeRuntimeKeys: true,
      runtimeSessionField: entry.sessionField,
      runtimeSessionId: null,
      resume: "no",
    };
  }

  return {
    includeRuntimeKeys: true,
    runtimeSessionField: entry.sessionField,
    runtimeSessionId: storedSessionId,
    resume: "yes",
    resumeSessionId: storedSessionId,
  };
}

export function shouldPersistDispatcherSession(
  entry: SessionDispatchEntry,
  sessionId: string | undefined,
  sessionState: SessionRuntimeState,
): boolean {
  return Boolean(
    entry.resumable
    && entry.sessionField
    && sessionId
    && sessionState.resume === "no",
  );
}
