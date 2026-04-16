/**
 * KyberBot — Orchestration Goals
 *
 * CRUD for hierarchical goals and KPI tracking.
 * Goals cascade: company → team → agent, each with measurable KPIs.
 */

import { getOrchDb } from './db.js';
import { logActivity } from './activity.js';
import type { Goal, GoalKPI, GoalLevel, GoalStatus } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// GOALS — WRITE
// ═══════════════════════════════════════════════════════════════════════════════

export function createGoal(goal: {
  title: string;
  description?: string | null;
  level: GoalLevel;
  owner_agent?: string | null;
  parent_goal_id?: number | null;
  project_id?: number | null;
  status?: GoalStatus;
  due_date?: string | null;
}): Goal {
  const db = getOrchDb();
  const result = db.prepare(`
    INSERT INTO goals (title, description, level, owner_agent, parent_goal_id, project_id, status, due_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    goal.title,
    goal.description ?? null,
    goal.level,
    goal.owner_agent ?? null,
    goal.parent_goal_id ?? null,
    goal.project_id ?? null,
    goal.status ?? 'active',
    goal.due_date ?? null,
  );

  const id = Number(result.lastInsertRowid);

  logActivity({
    actor: goal.owner_agent ?? 'system',
    action: 'goal.created',
    entity_type: 'goal',
    entity_id: String(id),
    details: JSON.stringify({ title: goal.title, level: goal.level }),
  });

  return getGoal(id)!;
}

export function updateGoal(id: number, updates: Partial<Pick<Goal, 'title' | 'description' | 'status' | 'due_date' | 'owner_agent' | 'level'>>): Goal {
  const db = getOrchDb();
  const fields: string[] = [];
  const params: (string | number | null)[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      params.push(value ?? null);
    }
  }

  if (fields.length === 0) return getGoal(id)!;

  fields.push('updated_at = datetime(\'now\')');
  params.push(id);

  db.prepare(`UPDATE goals SET ${fields.join(', ')} WHERE id = ?`).run(...params);

  logActivity({
    actor: 'system',
    action: 'goal.updated',
    entity_type: 'goal',
    entity_id: String(id),
    details: JSON.stringify(updates),
  });

  return getGoal(id)!;
}

export function deleteGoal(id: number): void {
  const db = getOrchDb();
  // Unlink issues and child goals before deleting
  db.prepare('UPDATE issues SET goal_id = NULL WHERE goal_id = ?').run(id);
  db.prepare('UPDATE goals SET parent_goal_id = NULL WHERE parent_goal_id = ?').run(id);
  db.prepare('DELETE FROM goal_kpis WHERE goal_id = ?').run(id);
  db.prepare('DELETE FROM goals WHERE id = ?').run(id);

  logActivity({
    actor: 'human',
    action: 'goal.deleted',
    entity_type: 'goal',
    entity_id: String(id),
    details: null,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// GOALS — READ
// ═══════════════════════════════════════════════════════════════════════════════

export function getGoal(id: number): Goal | null {
  const db = getOrchDb();
  return db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as Goal | null;
}

export function listGoals(filters: {
  level?: GoalLevel;
  owner_agent?: string;
  status?: GoalStatus;
  parent_goal_id?: number | null;
  project_id?: number | null;
} = {}): Goal[] {
  const db = getOrchDb();
  const conditions: string[] = [];
  const params: (string | number | null)[] = [];

  if (filters.level) {
    conditions.push('level = ?');
    params.push(filters.level);
  }
  if (filters.owner_agent) {
    conditions.push('owner_agent = ?');
    params.push(filters.owner_agent);
  }
  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }
  if (filters.parent_goal_id !== undefined) {
    if (filters.parent_goal_id === null) {
      conditions.push('parent_goal_id IS NULL');
    } else {
      conditions.push('parent_goal_id = ?');
      params.push(filters.parent_goal_id);
    }
  }
  if (filters.project_id !== undefined) {
    if (filters.project_id === null) {
      conditions.push('project_id IS NULL');
    } else {
      conditions.push('project_id = ?');
      params.push(filters.project_id);
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM goals ${where} ORDER BY created_at DESC`).all(...params) as Goal[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// KPIs
// ═══════════════════════════════════════════════════════════════════════════════

export function upsertKPI(goalId: number, kpi: {
  name: string;
  target_value?: number | null;
  current_value?: number;
  unit?: string | null;
}): GoalKPI {
  const db = getOrchDb();

  db.prepare(`
    INSERT INTO goal_kpis (goal_id, name, target_value, current_value, unit)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(goal_id, name) DO UPDATE SET
      target_value = COALESCE(excluded.target_value, goal_kpis.target_value),
      current_value = excluded.current_value,
      unit = COALESCE(excluded.unit, goal_kpis.unit),
      updated_at = datetime('now')
  `).run(
    goalId,
    kpi.name,
    kpi.target_value ?? null,
    kpi.current_value ?? 0,
    kpi.unit ?? null,
  );

  logActivity({
    actor: 'system',
    action: 'kpi.updated',
    entity_type: 'kpi',
    entity_id: `${goalId}:${kpi.name}`,
    details: JSON.stringify(kpi),
  });

  return db.prepare(
    'SELECT * FROM goal_kpis WHERE goal_id = ? AND name = ?'
  ).get(goalId, kpi.name) as GoalKPI;
}

export function getKPIsForGoal(goalId: number): GoalKPI[] {
  const db = getOrchDb();
  return db.prepare('SELECT * FROM goal_kpis WHERE goal_id = ? ORDER BY name').all(goalId) as GoalKPI[];
}
