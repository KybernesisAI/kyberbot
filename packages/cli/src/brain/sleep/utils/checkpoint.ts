/**
 * KyberBot — Checkpoint Management
 *
 * Tracks sleep agent progress through steps for crash recovery awareness.
 */

import Database from 'libsql';

export function saveCheckpoint(
  db: Database.Database,
  runId: number,
  step: string,
  data?: Record<string, unknown>
): void {
  db.prepare(`
    UPDATE sleep_runs
    SET checkpoint_step = ?,
        checkpoint_data = ?
    WHERE id = ?
  `).run(step, JSON.stringify({ timestamp: new Date().toISOString(), ...data }), runId);
}

export function getLastCheckpoint(
  db: Database.Database,
  runId: number
): { step: string; data: Record<string, unknown> } | null {
  const row = db.prepare(`
    SELECT checkpoint_step, checkpoint_data
    FROM sleep_runs
    WHERE id = ?
  `).get(runId) as { checkpoint_step: string | null; checkpoint_data: string | null } | undefined;

  if (!row || !row.checkpoint_step) return null;

  return {
    step: row.checkpoint_step,
    data: row.checkpoint_data ? JSON.parse(row.checkpoint_data) : {},
  };
}
