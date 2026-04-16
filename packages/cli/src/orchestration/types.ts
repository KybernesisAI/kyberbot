/**
 * KyberBot — Orchestration Types
 *
 * Domain interfaces for the orchestration layer: org chart, goals,
 * issues, comments, inbox, and activity log.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// COMPANY
// ═══════════════════════════════════════════════════════════════════════════════

export interface Company {
  name: string;
  description: string | null;
  updated_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORG CHART
// ═══════════════════════════════════════════════════════════════════════════════

export interface OrgNode {
  agent_name: string;
  role: string;
  title: string | null;
  reports_to: string | null;
  is_ceo: boolean;
  department: string | null;
  created_at: string;
  updated_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECTS
// ═══════════════════════════════════════════════════════════════════════════════

export interface Project {
  id: number;
  name: string;
  description: string | null;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GOALS
// ═══════════════════════════════════════════════════════════════════════════════

export type GoalLevel = 'company' | 'team' | 'agent';
export type GoalStatus = 'active' | 'paused' | 'completed' | 'cancelled';

export interface Goal {
  id: number;
  title: string;
  description: string | null;
  level: GoalLevel;
  owner_agent: string | null;
  parent_goal_id: number | null;
  project_id: number | null;
  status: GoalStatus;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface GoalKPI {
  id: number;
  goal_id: number;
  name: string;
  target_value: number | null;
  current_value: number;
  unit: string | null;
  updated_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ISSUES
// ═══════════════════════════════════════════════════════════════════════════════

export type IssueStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'blocked'
  | 'cancelled';

export type IssuePriority = 'critical' | 'high' | 'medium' | 'low';

export interface Issue {
  id: number;
  title: string;
  description: string | null;
  goal_id: number | null;
  parent_id: number | null;
  project_id: number | null;
  assigned_to: string | null;
  created_by: string;
  status: IssueStatus;
  priority: IssuePriority;
  labels: string | null;
  checkout_by: string | null;
  checkout_at: string | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface IssueComment {
  id: number;
  issue_id: number;
  author_agent: string;
  content: string;
  created_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INBOX
// ═══════════════════════════════════════════════════════════════════════════════

export type InboxUrgency = 'high' | 'normal' | 'low';
export type InboxStatus = 'pending' | 'acknowledged' | 'resolved';

export interface InboxItem {
  id: number;
  source_agent: string;
  title: string;
  body: string | null;
  urgency: InboxUrgency;
  status: InboxStatus;
  related_issue_id: number | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTIVITY LOG
// ═══════════════════════════════════════════════════════════════════════════════

export interface ActivityEntry {
  id: number;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: string | null;
  created_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEARTBEAT RUNS
// ═══════════════════════════════════════════════════════════════════════════════

export type HeartbeatRunType = 'orchestration' | 'worker';
export type HeartbeatRunStatus = 'running' | 'completed' | 'failed';

export interface HeartbeatRun {
  id: number;
  agent_name: string;
  type: HeartbeatRunType;
  status: HeartbeatRunStatus;
  started_at: string;
  finished_at: string | null;
  prompt_summary: string | null;
  result_summary: string | null;
  tool_calls_json: string | null;
  error: string | null;
  log_output: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORCHESTRATION SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

export interface OrchestrationSettings {
  orchestration_enabled: boolean;
  heartbeat_interval: string;
  active_hours: { start: string; end: string } | null;
}
