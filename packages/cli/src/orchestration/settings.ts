/**
 * KyberBot — Orchestration Settings
 *
 * Persistent settings for the orchestration engine, stored in
 * the orchestration_settings table (singleton row).
 */

import { getOrchDb } from './db.js';
import type { OrchestrationSettings } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// READ
// ═══════════════════════════════════════════════════════════════════════════════

export function getOrchestrationSettings(): OrchestrationSettings {
  const db = getOrchDb();
  interface SettingsRow {
    orchestration_enabled: number;
    heartbeat_interval: string;
    active_hours_start: string | null;
    active_hours_end: string | null;
  }
  const row = db.prepare(
    'SELECT orchestration_enabled, heartbeat_interval, active_hours_start, active_hours_end FROM orchestration_settings WHERE id = 1'
  ).get() as SettingsRow;

  return {
    orchestration_enabled: row.orchestration_enabled === 1,
    heartbeat_interval: row.heartbeat_interval,
    active_hours: row.active_hours_start && row.active_hours_end
      ? { start: row.active_hours_start, end: row.active_hours_end }
      : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// WRITE
// ═══════════════════════════════════════════════════════════════════════════════

export function updateOrchestrationSettings(updates: Partial<OrchestrationSettings>): OrchestrationSettings {
  const db = getOrchDb();
  const fields: string[] = [];
  const params: (string | number | null)[] = [];

  if (updates.orchestration_enabled !== undefined) {
    fields.push('orchestration_enabled = ?');
    params.push(updates.orchestration_enabled ? 1 : 0);
  }
  if (updates.heartbeat_interval !== undefined) {
    fields.push('heartbeat_interval = ?');
    params.push(updates.heartbeat_interval);
  }
  if (updates.active_hours !== undefined) {
    if (updates.active_hours === null) {
      fields.push('active_hours_start = NULL');
      fields.push('active_hours_end = NULL');
    } else {
      fields.push('active_hours_start = ?');
      params.push(updates.active_hours.start);
      fields.push('active_hours_end = ?');
      params.push(updates.active_hours.end);
    }
  }

  if (fields.length > 0) {
    fields.push('updated_at = datetime(\'now\')');
    db.prepare(`UPDATE orchestration_settings SET ${fields.join(', ')} WHERE id = 1`).run(...params);
  }

  return getOrchestrationSettings();
}
