/**
 * KyberBot — Orchestration REST API
 *
 * Express Router for the orchestration layer. Mounted at /fleet/orch
 * in fleet-manager.ts. Used by the desktop app and CLI.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../logger.js';

/** Extract a route param that is guaranteed to be a single string. */
function param(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? v[0] : v;
}

import {
  getCompany, updateCompany,
  listProjects, getProject, createProject, updateProject, deleteProject,
  getOrgChart, getOrgNode, setOrgNode, removeOrgNode, getCeoAgent, getDirectReports,
  listGoals, getGoal, createGoal, updateGoal, deleteGoal, upsertKPI, getKPIsForGoal,
  listIssues, getIssue, createIssue, updateIssue, transitionIssue, checkoutIssue, releaseCheckout,
  addComment, getComments,
  listInbox, getInboxItem, createInboxItem, acknowledgeInboxItem, resolveInboxItem, getPendingInboxCount,
  getActivityLog,
  listRuns, getRun, readRunLog,
  getOrchestrationSettings, updateOrchestrationSettings,
  recoverStuckIssues, recoverStuckRuns,
  queueWorkerHeartbeat, queueCeoHeartbeat,
  setMentionTrigger,
} from '../orchestration/index.js';
import { runCeoHeartbeat } from '../orchestration/ceo-heartbeat.js';
import { runWorkerHeartbeat } from '../orchestration/worker-heartbeat.js';

const logger = createLogger('orch-api');

export interface AgentIdentity {
  name: string;
  description: string;
  root: string;
}

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export function createOrchestrationRouter(
  agentIdentities?: Map<string, AgentIdentity>,
): Router {
  const router = Router();

  // Recover from crashes on startup
  try {
    const stuckIssues = recoverStuckIssues();
    const stuckRuns = recoverStuckRuns();
    if (stuckIssues > 0 || stuckRuns > 0) {
      logger.info('Startup recovery', { stuckIssues, stuckRuns });
    }
  } catch { /* DB might not be initialized yet */ }

  // Wire up @mention trigger — when any addComment() detects @agentname,
  // queue that agent's heartbeat. Works for comments from API AND from
  // internal code (worker heartbeat, CEO heartbeat).
  if (agentIdentities) {
    setMentionTrigger((mentionedName: string) => {
      const lower = mentionedName.toLowerCase();
      let identity: AgentIdentity | undefined;
      for (const [k, v] of agentIdentities.entries()) {
        if (k.toLowerCase() === lower) { identity = v; break; }
      }
      if (!identity) return;
      const orgNode = getOrgChart().find(n => n.agent_name.toLowerCase() === lower);
      if (!orgNode) return;
      if (orgNode.is_ceo) {
        queueCeoHeartbeat(identity.root, orgNode.agent_name, runCeoHeartbeat);
      } else {
        queueWorkerHeartbeat(identity.root, orgNode.agent_name, orgNode.role, orgNode.title || orgNode.agent_name);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Dashboard (aggregate)
  // ─────────────────────────────────────────────────────────────────

  router.get('/dashboard', (_req, res) => {
    try {
      const org = getOrgChart();
      const goals = listGoals();
      const activeGoals = goals.filter(g => g.status === 'active');
      const issues = listIssues();
      const inboxCount = getPendingInboxCount();

      const issueCounts: Record<string, number> = {};
      for (const issue of issues) {
        issueCounts[issue.status] = (issueCounts[issue.status] || 0) + 1;
      }

      const recentActivity = getActivityLog({ limit: 10 });

      const projects = listProjects({ status: 'active' });

      // Find agents currently executing (have a 'running' heartbeat run)
      const runningRuns = listRuns({ limit: 20 });
      const activeAgents = runningRuns
        .filter(r => r.status === 'running')
        .map(r => r.agent_name);

      res.json({
        company: getCompany(),
        projects,
        activeAgents,
        org,
        goals: {
          total: goals.length,
          active: activeGoals.length,
          completed: goals.filter(g => g.status === 'completed').length,
          items: activeGoals,
        },
        issues: {
          total: issues.length,
          counts: issueCounts,
          recent: issues.slice(0, 10),
        },
        inbox: {
          pending: inboxCount,
        },
        activity: recentActivity,
      });
    } catch (err) {
      logger.error('Dashboard error', { error: String(err) });
      res.status(500).json({ error: 'Failed to load dashboard' });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // Agent Identities (from identity.yaml + SOUL.md)
  // ─────────────────────────────────────────────────────────────────

  router.get('/agents', (_req, res) => {
    if (!agentIdentities || agentIdentities.size === 0) {
      return res.json({ agents: [] });
    }
    const agents = [];
    for (const [key, info] of agentIdentities) {
      // Read SOUL.md for richer context (first 500 chars)
      let soul = '';
      try {
        const soulPath = join(info.root, 'SOUL.md');
        soul = readFileSync(soulPath, 'utf-8').slice(0, 2000);
      } catch { /* no SOUL.md */ }

      agents.push({
        key,                    // registry key (lowercase)
        name: info.name,        // display name from identity.yaml
        description: info.description,
        soul,
      });
    }
    res.json({ agents });
  });

  // ─────────────────────────────────────────────────────────────────
  // Company Settings
  // ─────────────────────────────────────────────────────────────────

  router.get('/company', (_req, res) => {
    res.json({ company: getCompany() });
  });

  router.put('/company', asyncHandler(async (req, res) => {
    const company = updateCompany(req.body);
    res.json({ company });
  }));

  // ─────────────────────────────────────────────────────────────────
  // Projects
  // ─────────────────────────────────────────────────────────────────

  router.get('/projects', (req, res) => {
    const filters: Record<string, unknown> = {};
    if (req.query.status) filters.status = req.query.status;
    res.json({ projects: listProjects(filters as any) });
  });

  router.post('/projects', asyncHandler(async (req, res) => {
    const { name, description } = req.body;
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }
    const project = createProject({ name, description });
    res.status(201).json({ project });
  }));

  router.get('/projects/:id', (req, res) => {
    const project = getProject(Number(param(req, 'id')));
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ project });
  });

  router.put('/projects/:id', asyncHandler(async (req, res) => {
    const project = updateProject(Number(param(req, 'id')), req.body);
    res.json({ project });
  }));

  router.delete('/projects/:id', (req, res) => {
    deleteProject(Number(param(req, 'id')));
    res.json({ ok: true });
  });

  // ─────────────────────────────────────────────────────────────────
  // Org Chart
  // ─────────────────────────────────────────────────────────────────

  router.get('/org', (_req, res) => {
    res.json({ nodes: getOrgChart(), ceo: getCeoAgent() });
  });

  router.get('/org/:agent', (req, res) => {
    const node = getOrgNode(param(req, 'agent'));
    if (!node) return res.status(404).json({ error: 'Agent not found in org chart' });
    const reports = getDirectReports(param(req, 'agent'));
    res.json({ node, reports });
  });

  router.put('/org/:agent', asyncHandler(async (req, res) => {
    const agentKey = param(req, 'agent');
    let { role, title, reports_to, is_ceo, department } = req.body;
    if (!role) {
      res.status(400).json({ error: 'role is required' });
      return;
    }
    // Always try to fill in the real description from agentIdentities.
    // Try exact match first, then case-insensitive.
    let identity = agentIdentities?.get(agentKey);
    if (!identity) {
      // Case-insensitive lookup
      const lower = agentKey.toLowerCase();
      for (const [k, v] of agentIdentities?.entries() ?? []) {
        if (k.toLowerCase() === lower) { identity = v; break; }
      }
    }
    if (identity) {
      // If role is missing, matches the agent name, or is a generic fallback — use the real description
      if (!role || role === agentKey || role === identity.name || role === 'Agent' || role === 'CEO'
          || role.toLowerCase() === agentKey.toLowerCase()) {
        role = identity.description || role;
      }
      if (!title || title === agentKey || title.toLowerCase() === agentKey.toLowerCase()) {
        title = identity.name || title;
      }
    }
    const node = setOrgNode({
      agent_name: agentKey,
      role,
      title: title ?? null,
      reports_to: reports_to ?? null,
      is_ceo: is_ceo ?? false,
      department: department ?? null,
    });
    res.json({ node });
  }));

  router.delete('/org/:agent', (req, res) => {
    removeOrgNode(param(req, 'agent'));
    res.json({ ok: true });
  });

  // ─────────────────────────────────────────────────────────────────
  // Goals
  // ─────────────────────────────────────────────────────────────────

  router.get('/goals', (req, res) => {
    const filters: Record<string, unknown> = {};
    if (req.query.level) filters.level = req.query.level;
    if (req.query.owner_agent) filters.owner_agent = req.query.owner_agent;
    if (req.query.status) filters.status = req.query.status;
    if (req.query.parent_goal_id) filters.parent_goal_id = Number(req.query.parent_goal_id);
    res.json({ goals: listGoals(filters as any) });
  });

  router.post('/goals', asyncHandler(async (req, res) => {
    const { title, description, level, owner_agent, parent_goal_id, due_date } = req.body;
    if (!title || !level) {
      res.status(400).json({ error: 'title and level are required' });
      return;
    }
    const goal = createGoal({ title, description, level, owner_agent, parent_goal_id, due_date });
    res.status(201).json({ goal });
  }));

  router.get('/goals/:id', (req, res) => {
    const goal = getGoal(Number(param(req, 'id')));
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    const kpis = getKPIsForGoal(goal.id);
    const children = listGoals({ parent_goal_id: goal.id });
    res.json({ goal, kpis, children });
  });

  router.put('/goals/:id', asyncHandler(async (req, res) => {
    const goal = updateGoal(Number(param(req, 'id')), req.body);
    res.json({ goal });
  }));

  router.delete('/goals/:id', (req, res) => {
    deleteGoal(Number(param(req, 'id')));
    res.json({ ok: true });
  });

  router.get('/goals/:id/kpis', (req, res) => {
    res.json({ kpis: getKPIsForGoal(Number(param(req, 'id'))) });
  });

  router.put('/goals/:id/kpis', asyncHandler(async (req, res) => {
    const { name, target_value, current_value, unit } = req.body;
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const kpi = upsertKPI(Number(param(req, 'id')), { name, target_value, current_value, unit });
    res.json({ kpi });
  }));

  // ─────────────────────────────────────────────────────────────────
  // Issues
  // ─────────────────────────────────────────────────────────────────

  router.get('/issues', (req, res) => {
    const filters: Record<string, unknown> = {};
    if (req.query.assigned_to) filters.assigned_to = req.query.assigned_to;
    if (req.query.status) {
      const s = req.query.status as string;
      filters.status = s.includes(',') ? s.split(',') : s;
    }
    if (req.query.goal_id) filters.goal_id = Number(req.query.goal_id);
    if (req.query.priority) filters.priority = req.query.priority;
    if (req.query.limit) filters.limit = Number(req.query.limit);
    res.json({ issues: listIssues(filters as any) });
  });

  router.post('/issues', asyncHandler(async (req, res) => {
    const { title, description, goal_id, parent_id, assigned_to, created_by, status, priority, labels, due_date } = req.body;
    if (!title) {
      res.status(400).json({ error: 'title is required' });
      return;
    }
    const issue = createIssue({
      title, description, goal_id, parent_id, assigned_to,
      created_by: created_by || 'human',
      status, priority, labels, due_date,
    });
    res.status(201).json({ issue });
  }));

  router.get('/issues/:id', (req, res) => {
    const issue = getIssue(Number(param(req, 'id')));
    if (!issue) return res.status(404).json({ error: 'Issue not found' });
    const comments = getComments(issue.id);
    res.json({ issue, comments });
  });

  router.put('/issues/:id', asyncHandler(async (req, res) => {
    const issue = updateIssue(Number(param(req, 'id')), req.body);
    res.json({ issue });
  }));

  router.post('/issues/:id/transition', asyncHandler(async (req, res) => {
    const { status, actor } = req.body;
    if (!status) {
      res.status(400).json({ error: 'status is required' });
      return;
    }
    try {
      const issue = transitionIssue(Number(param(req, 'id')), status, actor || 'human');

      // When an issue moves to todo/in_progress and has an assignee, trigger that agent (fire-and-forget)
      if ((status === 'todo' || status === 'in_progress') && issue.assigned_to && agentIdentities) {
        const assigneeLower = issue.assigned_to.toLowerCase();
        let assigneeIdentity: AgentIdentity | undefined;
        for (const [k, v] of agentIdentities.entries()) {
          if (k.toLowerCase() === assigneeLower) { assigneeIdentity = v; break; }
        }
        if (assigneeIdentity) {
          const assigneeRoot = assigneeIdentity.root;
          const assigneeName = issue.assigned_to;
          logger.info(`Issue #${issue.id} moved to ${status}, triggering assignee: ${assigneeName}`);

          // Fire-and-forget via serial queue (prevents parallel subprocess crashes)
          const orgNode = getOrgChart().find(n => n.agent_name.toLowerCase() === assigneeLower);
          if (orgNode?.is_ceo) {
            queueCeoHeartbeat(assigneeRoot, orgNode.agent_name, runCeoHeartbeat);
          } else if (orgNode) {
            queueWorkerHeartbeat(
              assigneeRoot,
              orgNode.agent_name,
              orgNode.role,
              orgNode.title || orgNode.agent_name,
            );
          }
        }
      }

      res.json({ issue });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }));

  router.post('/issues/:id/checkout', asyncHandler(async (req, res) => {
    const { agent } = req.body;
    if (!agent) {
      res.status(400).json({ error: 'agent is required' });
      return;
    }
    try {
      const issue = checkoutIssue(Number(param(req, 'id')), agent);
      res.json({ issue });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  }));

  router.post('/issues/:id/release', (req, res) => {
    releaseCheckout(Number(param(req, 'id')));
    res.json({ ok: true });
  });

  router.get('/issues/:id/comments', (req, res) => {
    const comments = getComments(Number(param(req, 'id')));
    res.json({ comments });
  });

  router.post('/issues/:id/comments', asyncHandler(async (req, res) => {
    const { author, content } = req.body;
    if (!content) {
      res.status(400).json({ error: 'content is required' });
      return;
    }
    // addComment() internally detects @mentions and triggers agent heartbeats
    const comment = addComment(Number(param(req, 'id')), author || 'human', content);

    res.status(201).json({ comment });
  }));

  // ─────────────────────────────────────────────────────────────────
  // Inbox
  // ─────────────────────────────────────────────────────────────────

  router.get('/inbox', (req, res) => {
    const filters: Record<string, unknown> = {};
    if (req.query.status) filters.status = req.query.status;
    if (req.query.urgency) filters.urgency = req.query.urgency;
    if (req.query.countOnly === 'true') {
      return res.json({ count: getPendingInboxCount() });
    }
    res.json({ items: listInbox(filters as any) });
  });

  router.post('/inbox', asyncHandler(async (req, res) => {
    const { source_agent, title, body, urgency, related_issue_id } = req.body;
    if (!source_agent || !title) {
      res.status(400).json({ error: 'source_agent and title are required' });
      return;
    }
    const item = createInboxItem({ source_agent, title, body, urgency, related_issue_id });
    res.status(201).json({ item });
  }));

  router.get('/inbox/:id', (req, res) => {
    const item = getInboxItem(Number(param(req, 'id')));
    if (!item) return res.status(404).json({ error: 'Inbox item not found' });
    res.json({ item });
  });

  router.post('/inbox/:id/acknowledge', (req, res) => {
    acknowledgeInboxItem(Number(param(req, 'id')));
    res.json({ ok: true });
  });

  router.post('/inbox/:id/resolve', (req, res) => {
    const { resolved_by } = req.body;
    resolveInboxItem(Number(param(req, 'id')), resolved_by || 'human');
    res.json({ ok: true });
  });

  // ─────────────────────────────────────────────────────────────────
  // Activity Log
  // ─────────────────────────────────────────────────────────────────

  router.get('/activity', (req, res) => {
    const filters: Record<string, unknown> = {};
    if (req.query.actor) filters.actor = req.query.actor;
    if (req.query.entity_type) filters.entity_type = req.query.entity_type;
    if (req.query.entity_id) filters.entity_id = req.query.entity_id;
    if (req.query.limit) filters.limit = Number(req.query.limit);
    if (req.query.after) filters.after = req.query.after;
    res.json({ entries: getActivityLog(filters as any) });
  });

  // ─────────────────────────────────────────────────────────────────
  // Heartbeat Runs
  // ─────────────────────────────────────────────────────────────────

  router.get('/runs', (req, res) => {
    const filters: Record<string, unknown> = {};
    if (req.query.agent_name) filters.agent_name = req.query.agent_name;
    if (req.query.type) filters.type = req.query.type;
    if (req.query.limit) filters.limit = Number(req.query.limit);
    res.json({ runs: listRuns(filters as any) });
  });

  router.get('/runs/:id', (req, res) => {
    const run = getRun(Number(param(req, 'id')));
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json({ run });
  });

  // Stream run log with offset support for live viewing
  router.get('/runs/:id/log', (req, res) => {
    const offset = Math.max(0, parseInt(req.query.offset as string, 10) || 0);
    const { content, totalBytes } = readRunLog(Number(param(req, 'id')), offset);
    res.json({ content, totalBytes, offset });
  });

  // ─────────────────────────────────────────────────────────────────
  // Manual Heartbeat Trigger
  // ─────────────────────────────────────────────────────────────────

  router.post('/heartbeat/:agent', asyncHandler(async (req, res) => {
    const agentKey = param(req, 'agent');

    // Case-insensitive org node lookup
    let orgNode = getOrgNode(agentKey);
    if (!orgNode) {
      const allNodes = getOrgChart();
      orgNode = allNodes.find(n => n.agent_name.toLowerCase() === agentKey.toLowerCase()) || null;
    }
    if (!orgNode) {
      res.status(404).json({ error: `Agent "${agentKey}" not found in org chart` });
      return;
    }

    // Case-insensitive identity lookup
    let identity = agentIdentities?.get(agentKey);
    if (!identity) {
      for (const [k, v] of agentIdentities?.entries() ?? []) {
        if (k.toLowerCase() === agentKey.toLowerCase()) { identity = v; break; }
      }
    }
    if (!identity) {
      res.status(400).json({ error: `No identity found for agent "${agentKey}". Agent must be registered in the fleet.` });
      return;
    }

    try {
      if (orgNode.is_ceo) {
        const result = await runCeoHeartbeat(identity.root, orgNode.agent_name);
        res.json({ ok: true, result });
      } else {
        const result = await runWorkerHeartbeat(
          identity.root,
          orgNode.agent_name,
          orgNode.role,
          orgNode.title || orgNode.agent_name,
        );
        res.json({ ok: true, result });
      }
    } catch (err) {
      logger.error('Manual heartbeat trigger failed', { agent: agentKey, error: String(err) });
      res.status(500).json({ error: (err as Error).message });
    }
  }));

  // ─────────────────────────────────────────────────────────────────
  // Orchestration Settings
  // ─────────────────────────────────────────────────────────────────

  router.get('/settings', (_req, res) => {
    res.json({ settings: getOrchestrationSettings() });
  });

  router.put('/settings', asyncHandler(async (req, res) => {
    const settings = updateOrchestrationSettings(req.body);
    res.json({ settings });
  }));

  return router;
}
