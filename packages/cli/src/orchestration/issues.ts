/**
 * KyberBot — Orchestration Issues
 *
 * Issue lifecycle management with atomic checkout, state machine
 * transitions, and comment threads. Issues are the unit of work
 * in the orchestration system.
 */

import { getOrchDb } from './db.js';
import { logActivity } from './activity.js';
import { isValidTransition, getTransitionSideEffects } from './state-machine.js';
import type { Issue, IssueStatus, IssuePriority, IssueComment } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// ISSUES — WRITE
// ═══════════════════════════════════════════════════════════════════════════════

export function createIssue(issue: {
  title: string;
  description?: string | null;
  goal_id?: number | null;
  parent_id?: number | null;
  project_id?: number | null;
  assigned_to?: string | null;
  created_by: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  labels?: string | null;
  due_date?: string | null;
}): Issue {
  const db = getOrchDb();
  const result = db.prepare(`
    INSERT INTO issues (title, description, goal_id, parent_id, project_id, assigned_to, created_by, status, priority, labels, due_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    issue.title,
    issue.description ?? null,
    issue.goal_id ?? null,
    issue.parent_id ?? null,
    issue.project_id ?? null,
    issue.assigned_to ?? null,
    issue.created_by,
    issue.status ?? 'backlog',
    issue.priority ?? 'medium',
    issue.labels ?? null,
    issue.due_date ?? null,
  );

  const id = Number(result.lastInsertRowid);

  logActivity({
    actor: issue.created_by,
    action: 'issue.created',
    entity_type: 'issue',
    entity_id: String(id),
    details: JSON.stringify({ title: issue.title, assigned_to: issue.assigned_to }),
  });

  return getIssue(id)!;
}

export function updateIssue(id: number, updates: Partial<Pick<Issue, 'title' | 'description' | 'assigned_to' | 'priority' | 'labels' | 'due_date' | 'goal_id' | 'parent_id'>>): Issue {
  const db = getOrchDb();
  const fields: string[] = [];
  const params: (string | number | null)[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      params.push(value ?? null);
    }
  }

  if (fields.length === 0) return getIssue(id)!;

  fields.push('updated_at = datetime(\'now\')');
  params.push(id);

  db.prepare(`UPDATE issues SET ${fields.join(', ')} WHERE id = ?`).run(...params);

  logActivity({
    actor: 'system',
    action: 'issue.updated',
    entity_type: 'issue',
    entity_id: String(id),
    details: JSON.stringify(updates),
  });

  return getIssue(id)!;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATUS TRANSITIONS
// ═══════════════════════════════════════════════════════════════════════════════

export function transitionIssue(id: number, newStatus: IssueStatus, actor: string): Issue {
  const db = getOrchDb();
  const issue = getIssue(id);
  if (!issue) throw new Error(`Issue ${id} not found`);

  if (!isValidTransition(issue.status, newStatus)) {
    throw new Error(
      `Invalid transition: ${issue.status} → ${newStatus} for issue #${id}`
    );
  }

  const effects = getTransitionSideEffects(issue.status, newStatus);

  // Apply transition and side effects in a transaction
  const txn = db.transaction(() => {
    // Update status
    db.prepare('UPDATE issues SET status = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(newStatus, id);

    for (const effect of effects) {
      switch (effect.type) {
        case 'auto_checkout':
          if (issue.assigned_to && !issue.checkout_by) {
            db.prepare('UPDATE issues SET checkout_by = ?, checkout_at = datetime(\'now\') WHERE id = ?')
              .run(issue.assigned_to, id);
          }
          break;

        case 'release_checkout':
          db.prepare('UPDATE issues SET checkout_by = NULL, checkout_at = NULL WHERE id = ?')
            .run(id);
          break;

        case 'clear_assignee':
          db.prepare('UPDATE issues SET assigned_to = NULL WHERE id = ?')
            .run(id);
          break;

        case 'log_activity':
          logActivity({
            actor,
            action: effect.action,
            entity_type: 'issue',
            entity_id: String(id),
            details: JSON.stringify({ from: issue.status, to: newStatus }),
          });
          break;
      }
    }
  });

  txn();
  return getIssue(id)!;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ATOMIC CHECKOUT
// ═══════════════════════════════════════════════════════════════════════════════

export function checkoutIssue(id: number, agentName: string): Issue {
  const db = getOrchDb();

  const txn = db.transaction(() => {
    const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as Issue | undefined;
    if (!issue) throw new Error(`Issue ${id} not found`);

    // Already checked out by this agent — idempotent success
    if (issue.checkout_by?.toLowerCase() === agentName.toLowerCase()) return;

    // Checked out by another agent — conflict
    if (issue.checkout_by && issue.checkout_by.toLowerCase() !== agentName.toLowerCase()) {
      throw new Error(
        `Issue #${id} is already checked out by ${issue.checkout_by}`
      );
    }

    // Transition to in_progress if still in todo
    if (issue.status === 'todo') {
      db.prepare('UPDATE issues SET status = \'in_progress\', updated_at = datetime(\'now\') WHERE id = ?')
        .run(id);
    }

    db.prepare('UPDATE issues SET checkout_by = ?, checkout_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?')
      .run(agentName, id);

    logActivity({
      actor: agentName,
      action: 'issue.checked_out',
      entity_type: 'issue',
      entity_id: String(id),
      details: null,
    });
  });

  txn();
  return getIssue(id)!;
}

export function releaseCheckout(id: number): void {
  const db = getOrchDb();
  db.prepare('UPDATE issues SET checkout_by = NULL, checkout_at = NULL, updated_at = datetime(\'now\') WHERE id = ?')
    .run(id);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ISSUES — READ
// ═══════════════════════════════════════════════════════════════════════════════

export function getIssue(id: number): Issue | null {
  const db = getOrchDb();
  return db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as Issue | null;
}

export function listIssues(filters: {
  assigned_to?: string;
  status?: IssueStatus | IssueStatus[];
  goal_id?: number;
  project_id?: number;
  parent_id?: number | null;
  priority?: IssuePriority;
  limit?: number;
} = {}): Issue[] {
  const db = getOrchDb();
  const conditions: string[] = [];
  const params: (string | number | null)[] = [];

  if (filters.assigned_to) {
    conditions.push('LOWER(assigned_to) = LOWER(?)');
    params.push(filters.assigned_to);
  }
  if (filters.status) {
    if (Array.isArray(filters.status)) {
      conditions.push(`status IN (${filters.status.map(() => '?').join(', ')})`);
      params.push(...filters.status);
    } else {
      conditions.push('status = ?');
      params.push(filters.status);
    }
  }
  if (filters.goal_id) {
    conditions.push('goal_id = ?');
    params.push(filters.goal_id);
  }
  if (filters.project_id) {
    conditions.push('project_id = ?');
    params.push(filters.project_id);
  }
  if (filters.parent_id !== undefined) {
    if (filters.parent_id === null) {
      conditions.push('parent_id IS NULL');
    } else {
      conditions.push('parent_id = ?');
      params.push(filters.parent_id);
    }
  }
  if (filters.priority) {
    conditions.push('priority = ?');
    params.push(filters.priority);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit || 200;

  return db.prepare(
    `SELECT * FROM issues ${where} ORDER BY
      CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
      created_at DESC
    LIMIT ?`
  ).all(...params, limit) as Issue[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMENTS
// ═══════════════════════════════════════════════════════════════════════════════

export function addComment(issueId: number, authorAgent: string, content: string): IssueComment {
  const db = getOrchDb();

  // Verify issue exists
  const issue = getIssue(issueId);
  if (!issue) throw new Error(`Issue ${issueId} not found`);

  // Auto-fix agent mentions: "Atlas —" or "Atlas," at the start → "@Atlas —" or "@Atlas,"
  // Also fix "**Atlas**" → "**@Atlas**" patterns
  const orgNodes = db.prepare('SELECT agent_name, title FROM org_nodes').all() as Array<{ agent_name: string; title: string | null }>;
  let fixedContent = content;
  for (const node of orgNodes) {
    const names = [node.agent_name, node.title].filter(Boolean) as string[];
    for (const name of names) {
      // Fix "Name —" or "Name," or "Name:" at start of comment (without @)
      const startPattern = new RegExp(`^(\\*\\*)?${name}(\\*\\*)?\\s*[—,:\\-]`, 'i');
      if (startPattern.test(fixedContent) && !fixedContent.startsWith(`@${name}`) && !fixedContent.startsWith(`**@${name}`)) {
        fixedContent = fixedContent.replace(startPattern, `@${name.toLowerCase()} —`);
      }
      // Fix "Name" mentions in the middle of text (only if preceded by whitespace/newline and followed by punctuation/space)
      const midPattern = new RegExp(`(?<=\\s|^|\\n)(\\*\\*)?${name}(\\*\\*)?(?=\\s*[—,:\\-\\.])`, 'gi');
      fixedContent = fixedContent.replace(midPattern, `@${name.toLowerCase()}`);
    }
  }

  const result = db.prepare(`
    INSERT INTO issue_comments (issue_id, author_agent, content)
    VALUES (?, ?, ?)
  `).run(issueId, authorAgent, fixedContent);

  // Update issue timestamp
  db.prepare('UPDATE issues SET updated_at = datetime(\'now\') WHERE id = ?').run(issueId);

  logActivity({
    actor: authorAgent,
    action: 'comment.added',
    entity_type: 'issue',
    entity_id: String(issueId),
    details: JSON.stringify({ preview: content.slice(0, 100) }),
  });

  const id = Number(result.lastInsertRowid);
  return db.prepare('SELECT * FROM issue_comments WHERE id = ?').get(id) as IssueComment;
}

export function getComments(issueId: number): IssueComment[] {
  const db = getOrchDb();
  return db.prepare(
    'SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at ASC'
  ).all(issueId) as IssueComment[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// STUCK ISSUES — issues stale beyond thresholds
// ═══════════════════════════════════════════════════════════════════════════════

export function getStuckIssues(): { staleInProgress: Issue[]; staleBlocked: Issue[] } {
  const db = getOrchDb();
  const staleInProgress = db.prepare(
    "SELECT * FROM issues WHERE status='in_progress' AND updated_at < datetime('now', '-24 hours')"
  ).all() as Issue[];
  const staleBlocked = db.prepare(
    "SELECT * FROM issues WHERE status='blocked' AND updated_at < datetime('now', '-48 hours')"
  ).all() as Issue[];
  return { staleInProgress, staleBlocked };
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECOVERY — startup crash recovery
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Recover issues stuck in in_progress with a checkout after a fleet restart.
 * Moves them back to todo so they can be retried.
 */
export function recoverStuckIssues(): number {
  const db = getOrchDb();
  const stuck = db.prepare(
    "SELECT id FROM issues WHERE status='in_progress' AND checkout_by IS NOT NULL"
  ).all();

  if (stuck.length === 0) return 0;

  db.prepare(
    "UPDATE issues SET status='todo', checkout_by=NULL, checkout_at=NULL, updated_at=datetime('now') WHERE status='in_progress' AND checkout_by IS NOT NULL"
  ).run();

  for (const row of stuck) {
    logActivity({
      actor: 'system',
      action: 'issue.recovered',
      entity_type: 'issue',
      entity_id: String((row as any).id),
      details: 'Moved back to todo after fleet restart',
    });
  }

  return stuck.length;
}
