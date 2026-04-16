/**
 * KyberBot — Heartbeat Run History
 *
 * Tracks every CEO and worker heartbeat execution: when it started,
 * whether it succeeded or failed, which tool calls were made, and
 * a summary of the result. Used for observability and the desktop
 * app's run history view.
 */

import { getOrchDb } from './db.js';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync, appendFileSync, readFileSync, statSync } from 'fs';
import type { HeartbeatRun, HeartbeatRunType } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// WRITE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the log directory for run output files.
 */
function getLogDir(): string {
  const dir = join(homedir(), '.kyberbot', 'run-logs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Record the start of a heartbeat run. Creates a log file for streaming output.
 * Returns the new run ID.
 */
export function createRun(agentName: string, type: HeartbeatRunType): number {
  const db = getOrchDb();
  const logRef = join(getLogDir(), `run-${Date.now()}-${agentName}.log`);
  const result = db.prepare(`
    INSERT INTO heartbeat_runs (agent_name, type, status, log_ref)
    VALUES (?, ?, 'running', ?)
  `).run(agentName, type, logRef);

  // Create empty log file
  appendFileSync(logRef, '');

  return Number(result.lastInsertRowid);
}

/**
 * Append text to a run's log file for live streaming.
 */
export function appendRunLog(id: number, text: string): void {
  const run = getRun(id);
  if (!run?.log_ref) return;
  try {
    appendFileSync(run.log_ref, text);
  } catch { /* ignore */ }
}

/**
 * Read a run's log file with optional offset for incremental reading.
 */
export function readRunLog(id: number, offset: number = 0): { content: string; totalBytes: number } {
  const run = getRun(id);
  if (!run?.log_ref || !existsSync(run.log_ref)) {
    return { content: run?.log_output || '', totalBytes: 0 };
  }
  try {
    const stats = statSync(run.log_ref);
    const totalBytes = stats.size;
    if (offset >= totalBytes) return { content: '', totalBytes };
    const buf = readFileSync(run.log_ref, 'utf-8');
    return { content: buf.slice(offset), totalBytes };
  } catch {
    return { content: '', totalBytes: 0 };
  }
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
