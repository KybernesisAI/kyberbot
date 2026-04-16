/**
 * KyberBot — Heartbeat Run History
 *
 * Tracks every CEO and worker heartbeat execution: when it started,
 * whether it succeeded or failed, which tool calls were made, and
 * a summary of the result. Used for observability and the desktop
 * app's run history view.
 */

import { getOrchDb } from './db.js';
import type { HeartbeatRun, HeartbeatRunType } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// WRITE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record the start of a heartbeat run. Returns the new run ID.
 */
export function createRun(agentName: string, type: HeartbeatRunType): number {
  const db = getOrchDb();
  const result = db.prepare(`
    INSERT INTO heartbeat_runs (agent_name, type, status)
    VALUES (?, ?, 'running')
  `).run(agentName, type);

  return Number(result.lastInsertRowid);
}

/**
 * Mark a run as successfully completed.
 */
export function completeRun(
  id: number,
  data: { result_summary?: string; tool_calls_json?: string; log_output?: string },
): void {
  const db = getOrchDb();
  db.prepare(`
    UPDATE heartbeat_runs
    SET status = 'completed',
        finished_at = datetime('now'),
        result_summary = ?,
        tool_calls_json = ?,
        log_output = ?
    WHERE id = ?
  `).run(
    data.result_summary ?? null,
    data.tool_calls_json ?? null,
    data.log_output ?? null,
    id,
  );
}

/**
 * Mark a run as failed with an error message.
 */
export function failRun(id: number, error: string): void {
  const db = getOrchDb();
  db.prepare(`
    UPDATE heartbeat_runs
    SET status = 'failed',
        finished_at = datetime('now'),
        error = ?
    WHERE id = ?
  `).run(error, id);
}

// ═══════════════════════════════════════════════════════════════════════════════
// READ
// ═══════════════════════════════════════════════════════════════════════════════

export interface RunFilters {
  agent_name?: string;
  type?: HeartbeatRunType;
  limit?: number;
}

/**
 * List recent heartbeat runs, newest first.
 */
export function listRuns(filters: RunFilters = {}): HeartbeatRun[] {
  const db = getOrchDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.agent_name) {
    conditions.push('agent_name = ?');
    params.push(filters.agent_name);
  }
  if (filters.type) {
    conditions.push('type = ?');
    params.push(filters.type);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit || 50;

  return db.prepare(
    `SELECT id, agent_name, type, status, started_at, finished_at, prompt_summary, result_summary, tool_calls_json, error FROM heartbeat_runs ${where} ORDER BY started_at DESC LIMIT ?`
  ).all(...params, limit) as HeartbeatRun[];
}

/**
 * Get a single run by ID.
 */
export function getRun(id: number): HeartbeatRun | null {
  const db = getOrchDb();
  return db.prepare('SELECT * FROM heartbeat_runs WHERE id = ?').get(id) as HeartbeatRun | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECOVERY — startup crash recovery
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Mark any runs stuck in 'running' status as failed after a fleet restart.
 */
export function recoverStuckRuns(): number {
  const db = getOrchDb();
  const result = db.prepare(
    "UPDATE heartbeat_runs SET status='failed', error='Fleet restarted during execution', finished_at=datetime('now') WHERE status='running'"
  ).run();
  return result.changes;
}
