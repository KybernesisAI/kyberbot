/**
 * KyberBot — Orchestration Tool Definitions
 *
 * Claude tool definitions for CEO and worker agent heartbeats.
 * Tools are described in the system prompt. Claude outputs structured
 * JSON tool calls which executeTool() dispatches to CRUD functions.
 */

import { createLogger } from '../logger.js';
import {
  createGoal, updateGoal, listGoals,
  createIssue, updateIssue, listIssues, transitionIssue, checkoutIssue,
  addComment, getComments,
  upsertKPI,
  setOrgNode,
  createInboxItem,
} from './index.js';
import type { IssueStatus, GoalLevel } from './types.js';

const logger = createLogger('orch-tools');

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS (injected into system prompt)
// ═══════════════════════════════════════════════════════════════════════════════

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean; enum?: string[] }>;
}

const WORKER_TOOLS: ToolDef[] = [
  {
    name: 'list_my_issues',
    description: 'List issues assigned to you, optionally filtered by status',
    parameters: {
      status: { type: 'string', description: 'Filter by status (comma-separated)', required: false },
    },
  },
  {
    name: 'checkout_issue',
    description: 'Atomically claim a task for work. Transitions it to in_progress.',
    parameters: {
      id: { type: 'number', description: 'Issue ID', required: true },
    },
  },
  {
    name: 'transition_issue',
    description: 'Move an issue to a new status',
    parameters: {
      id: { type: 'number', description: 'Issue ID', required: true },
      status: { type: 'string', description: 'New status', required: true, enum: ['todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'] },
    },
  },
  {
    name: 'add_comment',
    description: 'Add a comment to an issue to report progress, ask questions, or communicate',
    parameters: {
      issue_id: { type: 'number', description: 'Issue ID', required: true },
      content: { type: 'string', description: 'Comment text (markdown)', required: true },
    },
  },
  {
    name: 'update_kpi',
    description: 'Update a KPI value for a goal',
    parameters: {
      goal_id: { type: 'number', description: 'Goal ID', required: true },
      kpi_name: { type: 'string', description: 'KPI name', required: true },
      current_value: { type: 'number', description: 'Current value', required: true },
    },
  },
  {
    name: 'escalate_to_human',
    description: 'Create an inbox item for the human operator when you are blocked or need a decision',
    parameters: {
      title: { type: 'string', description: 'Short title', required: true },
      body: { type: 'string', description: 'Detailed explanation', required: false },
      urgency: { type: 'string', description: 'Urgency level', required: false, enum: ['high', 'normal', 'low'] },
      related_issue_id: { type: 'number', description: 'Related issue ID', required: false },
    },
  },
];

const CEO_ONLY_TOOLS: ToolDef[] = [
  {
    name: 'create_goal',
    description: 'Create a new company, team, or agent goal',
    parameters: {
      title: { type: 'string', description: 'Goal title', required: true },
      description: { type: 'string', description: 'Goal description', required: false },
      level: { type: 'string', description: 'Goal level', required: true, enum: ['company', 'team', 'agent'] },
      owner_agent: { type: 'string', description: 'Agent who owns this goal', required: false },
      parent_goal_id: { type: 'number', description: 'Parent goal ID for sub-goals', required: false },
      project_id: { type: 'number', description: 'Link to project ID', required: false },
      due_date: { type: 'string', description: 'Due date (YYYY-MM-DD)', required: false },
    },
  },
  {
    name: 'update_goal',
    description: 'Update an existing goal',
    parameters: {
      id: { type: 'number', description: 'Goal ID', required: true },
      title: { type: 'string', description: 'New title', required: false },
      description: { type: 'string', description: 'New description', required: false },
      status: { type: 'string', description: 'New status', required: false, enum: ['active', 'paused', 'completed', 'cancelled'] },
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new task/issue',
    parameters: {
      title: { type: 'string', description: 'Issue title', required: true },
      description: { type: 'string', description: 'Issue description', required: false },
      assigned_to: { type: 'string', description: 'Agent to assign to', required: false },
      priority: { type: 'string', description: 'Priority level', required: false, enum: ['critical', 'high', 'medium', 'low'] },
      goal_id: { type: 'number', description: 'Link to goal ID', required: false },
      project_id: { type: 'number', description: 'Link to project ID', required: false },
      parent_id: { type: 'number', description: 'Parent issue ID for subtasks', required: false },
      labels: { type: 'string', description: 'Comma-separated labels', required: false },
      status: { type: 'string', description: 'Initial status — use backlog by default, only use todo for immediately actionable items', required: false, enum: ['backlog', 'todo'] },
    },
  },
  {
    name: 'assign_issue',
    description: 'Assign an issue to an agent',
    parameters: {
      id: { type: 'number', description: 'Issue ID', required: true },
      assigned_to: { type: 'string', description: 'Agent name', required: true },
    },
  },
];

export function getCeoToolDefs(): ToolDef[] {
  return [...WORKER_TOOLS, ...CEO_ONLY_TOOLS];
}

export function getWorkerToolDefs(): ToolDef[] {
  return WORKER_TOOLS;
}

/**
 * Format tool definitions for injection into a system prompt.
 */
export function formatToolsForPrompt(tools: ToolDef[]): string {
  const lines = ['## Available Tools', '', 'Call tools by outputting a JSON block in this format:', '```', '<tool_call>{"name": "tool_name", "params": {"key": "value"}}</tool_call>', '```', '', 'Available tools:', ''];
  for (const tool of tools) {
    lines.push(`### ${tool.name}`);
    lines.push(tool.description);
    lines.push('Parameters:');
    for (const [name, spec] of Object.entries(tool.parameters)) {
      const req = spec.required ? ' (required)' : ' (optional)';
      const enums = spec.enum ? ` — one of: ${spec.enum.join(', ')}` : '';
      lines.push(`  - ${name}: ${spec.type}${req} — ${spec.description}${enums}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse tool calls from Claude's response text.
 * Looks for <tool_call>{"name": "...", "params": {...}}</tool_call> blocks.
 */
export function parseToolCalls(text: string): Array<{ name: string; params: Record<string, unknown> }> {
  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const regex = /<tool_call>(.*?)<\/tool_call>/gs;
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.name && typeof parsed.params === 'object') {
        calls.push(parsed);
      }
    } catch (e) {
      logger.warn('Failed to parse tool call', { raw: match[1] });
    }
  }
  return calls;
}

// Rate limiting: max issues/goals created per heartbeat session
const SESSION_LIMITS = { issues: 0, goals: 0 };
const MAX_ISSUES_PER_HEARTBEAT = 5;
const MAX_GOALS_PER_HEARTBEAT = 3;

/** Reset session limits — call at the start of each heartbeat. */
export function resetSessionLimits(): void {
  SESSION_LIMITS.issues = 0;
  SESSION_LIMITS.goals = 0;
}

/**
 * Execute a single tool call and return the result.
 */
export function executeTool(
  name: string,
  params: Record<string, unknown>,
  actor: string,
): unknown {
  logger.info(`Executing tool: ${name}`, { actor, params });

  switch (name) {
    // Worker tools
    case 'list_my_issues': {
      const statusFilter = params.status as string | undefined;
      const statuses = statusFilter?.split(',').map(s => s.trim()) as IssueStatus[] | undefined;
      return listIssues({ assigned_to: actor, status: statuses || ['todo', 'in_progress', 'blocked'] });
    }
    case 'checkout_issue':
      return checkoutIssue(Number(params.id), actor);
    case 'transition_issue':
      return transitionIssue(Number(params.id), params.status as IssueStatus, actor);
    case 'add_comment':
      return addComment(Number(params.issue_id), actor, params.content as string);
    case 'update_kpi':
      return upsertKPI(Number(params.goal_id), {
        name: params.kpi_name as string,
        current_value: Number(params.current_value),
      });
    case 'escalate_to_human':
      return createInboxItem({
        source_agent: actor,
        title: params.title as string,
        body: params.body as string | undefined,
        urgency: (params.urgency as any) || 'normal',
        related_issue_id: params.related_issue_id ? Number(params.related_issue_id) : undefined,
      });

    // CEO tools
    case 'create_goal':
      if (SESSION_LIMITS.goals >= MAX_GOALS_PER_HEARTBEAT) {
        return { error: `Rate limited: max ${MAX_GOALS_PER_HEARTBEAT} goals per heartbeat. Wait for next heartbeat.` };
      }
      SESSION_LIMITS.goals++;
      return createGoal({
        title: params.title as string,
        description: params.description as string | undefined,
        level: (params.level as GoalLevel) || 'company',
        owner_agent: params.owner_agent as string | undefined,
        parent_goal_id: params.parent_goal_id ? Number(params.parent_goal_id) : undefined,
        project_id: params.project_id ? Number(params.project_id) : undefined,
        due_date: params.due_date as string | undefined,
      });
    case 'update_goal':
      return updateGoal(Number(params.id), {
        title: params.title as string | undefined,
        description: params.description as string | undefined,
        status: params.status as any,
      });
    case 'create_issue':
      if (SESSION_LIMITS.issues >= MAX_ISSUES_PER_HEARTBEAT) {
        return { error: `Rate limited: max ${MAX_ISSUES_PER_HEARTBEAT} issues per heartbeat. Wait for next heartbeat.` };
      }
      SESSION_LIMITS.issues++;
      return createIssue({
        title: params.title as string,
        description: params.description as string | undefined,
        assigned_to: params.assigned_to ? (params.assigned_to as string).toLowerCase() : undefined,
        priority: (params.priority as any) || 'medium',
        goal_id: params.goal_id ? Number(params.goal_id) : undefined,
        project_id: params.project_id ? Number(params.project_id) : undefined,
        parent_id: params.parent_id ? Number(params.parent_id) : undefined,
        labels: params.labels as string | undefined,
        status: (params.status as any) || 'todo',
        created_by: actor,
      });
    case 'assign_issue':
      return updateIssue(Number(params.id), { assigned_to: (params.assigned_to as string).toLowerCase() });

    default:
      logger.warn(`Unknown tool: ${name}`);
      return { error: `Unknown tool: ${name}` };
  }
}
