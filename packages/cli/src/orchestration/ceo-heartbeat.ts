/**
 * KyberBot — CEO Orchestration Heartbeat
 *
 * The core orchestration loop. When the CEO agent's heartbeat fires,
 * this module gathers company state, prompts Claude with orchestration
 * tools, and executes the resulting tool calls.
 */

import { join, dirname } from 'path';
import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'fs';
import { createLogger } from '../logger.js';
import { getClaudeClient } from '../claude.js';
import { getIdentityForRoot } from '../config.js';
import { loadRegistry } from '../registry.js';
import {
  getOrgChart, getCeoAgent, getDirectReports,
  listProjects,
  listGoals, getKPIsForGoal,
  listIssues,
  listInbox, getPendingInboxCount,
  getActivityLog,
  listRuns,
  getStuckIssues,
} from './index.js';
import { createRun, completeRun, failRun, appendRunLog } from './runs.js';
import { getCeoToolDefs, formatToolsForPrompt, parseToolCalls, executeTool, resetSessionLimits } from './tools.js';

const logger = createLogger('ceo-heartbeat');

// ═══════════════════════════════════════════════════════════════════════════════
// CONTEXT BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

export function buildCeoHeartbeatPrompt(agentName: string): string {
  const sections: string[] = [];

  // Identity
  sections.push(`You are ${agentName}, the CEO orchestrator of this company.`);
  sections.push('Your job is to review company state, plan work, assign tasks to agents, and drive progress toward goals.');
  sections.push('');

  // Org chart — include each agent's real role and capabilities from SOUL.md
  const org = getOrgChart();
  const registry = loadRegistry();
  sections.push('## Your Team');
  sections.push('');
  if (org.length === 0) {
    sections.push('No agents configured.');
  } else {
    for (const node of org) {
      const ceoTag = node.is_ceo ? ' (Orchestrator — you)' : '';
      const reportsTo = node.reports_to ? ` — reports to ${node.reports_to}` : '';
      sections.push(`### ${node.title || node.agent_name} — ${node.role}${ceoTag}${reportsTo}`);

      // Read SOUL.md for capability context
      const regEntry = registry.agents[node.agent_name];
      if (regEntry?.root) {
        try {
          const soulPath = join(regEntry.root, 'SOUL.md');
          if (existsSync(soulPath)) {
            const soul = readFileSync(soulPath, 'utf-8').slice(0, 1500);
            sections.push(soul);
          }
        } catch { /* no SOUL.md */ }
      }
      sections.push('');
    }
  }
  sections.push('');

  // Projects
  const projects = listProjects({ status: 'active' });
  if (projects.length > 0) {
    sections.push('## Projects');
    for (const project of projects) {
      const projectGoals = listGoals({ project_id: project.id });
      const projectIssues = listIssues({ project_id: project.id });
      const openIssues = projectIssues.filter(i => i.status !== 'done' && i.status !== 'cancelled');
      sections.push(`- **${project.name}** (${projectGoals.length} goals, ${openIssues.length} open issues)${project.description ? ` — ${project.description}` : ''}`);
    }
    sections.push('');
  }

  // Goals
  const goals = listGoals();
  const activeGoals = goals.filter(g => g.status === 'active');
  sections.push('## Company Goals');
  if (activeGoals.length === 0) {
    sections.push('No active goals. Consider creating goals based on the company\'s mission.');
  } else {
    for (const goal of activeGoals) {
      const owner = goal.owner_agent ? ` (owner: ${goal.owner_agent})` : '';
      sections.push(`### Goal #${goal.id}: ${goal.title} [${goal.level}]${owner}`);
      if (goal.description) sections.push(goal.description);

      const kpis = getKPIsForGoal(goal.id);
      if (kpis.length > 0) {
        sections.push('KPIs:');
        for (const kpi of kpis) {
          const pct = kpi.target_value ? `${Math.round((kpi.current_value / kpi.target_value) * 100)}%` : '';
          sections.push(`  - ${kpi.name}: ${kpi.current_value}${kpi.unit || ''} / ${kpi.target_value ?? '—'}${kpi.unit || ''} ${pct}`);
        }
      }

      // Issues linked to this goal
      const goalIssues = listIssues({ goal_id: goal.id });
      if (goalIssues.length > 0) {
        const done = goalIssues.filter(i => i.status === 'done').length;
        const total = goalIssues.length;
        sections.push(`Issues: ${done}/${total} done`);
      }
      sections.push('');
    }
  }

  // Issue board (capped to 50 issues for prompt size)
  const allIssues = listIssues({ limit: 50 });
  const byStatus: Record<string, typeof allIssues> = {};
  for (const issue of allIssues) {
    if (!byStatus[issue.status]) byStatus[issue.status] = [];
    byStatus[issue.status].push(issue);
  }

  sections.push('## Issue Board');
  let shownCount = 0;
  const MAX_BOARD_ISSUES = 30;
  for (const status of ['in_progress', 'todo', 'blocked', 'in_review', 'backlog']) {
    const items = byStatus[status] || [];
    if (items.length === 0) continue;
    sections.push(`### ${status.toUpperCase()} (${items.length})`);
    for (const i of items) {
      if (shownCount >= MAX_BOARD_ISSUES) break;
      const assignee = i.assigned_to || 'unassigned';
      const checkout = i.checkout_by ? ` [checked out by ${i.checkout_by}]` : '';
      sections.push(`- KYB-${i.id} [${i.priority}] ${i.title} → ${assignee}${checkout}`);
      shownCount++;
    }
    if (shownCount >= MAX_BOARD_ISSUES && items.length > 0) {
      sections.push(`_(${items.length - Math.min(items.length, MAX_BOARD_ISSUES - (shownCount - items.length))} more ${status} issues not shown)_`);
    }
    sections.push('');
  }

  // Done/cancelled issues (just count)
  const doneCount = (byStatus['done'] || []).length;
  const cancelledCount = (byStatus['cancelled'] || []).length;
  if (doneCount > 0) {
    sections.push(`### DONE: ${doneCount} issues completed`);
    sections.push('');
  }
  if (cancelledCount > 0) {
    sections.push(`### CANCELLED: ${cancelledCount} issues`);
    sections.push('');
  }

  // Stuck issues (need attention)
  const { staleInProgress, staleBlocked } = getStuckIssues();
  if (staleInProgress.length > 0 || staleBlocked.length > 0) {
    sections.push('## Stuck Issues (Need Attention)');
    if (staleInProgress.length > 0) {
      sections.push('### In Progress 24+ hours:');
      for (const i of staleInProgress) {
        sections.push(`- KYB-${i.id} [${i.priority}] ${i.title} → ${i.assigned_to || 'unassigned'} (last updated: ${i.updated_at})`);
      }
    }
    if (staleBlocked.length > 0) {
      sections.push('### Blocked 48+ hours:');
      for (const i of staleBlocked) {
        sections.push(`- KYB-${i.id} [${i.priority}] ${i.title} → ${i.assigned_to || 'unassigned'} (last updated: ${i.updated_at})`);
      }
    }
    sections.push('');
  }

  // Inbox (human responses)
  const pendingInbox = listInbox({ status: 'pending' });
  const resolvedInbox = listInbox({ status: 'resolved', limit: 5 });
  if (pendingInbox.length > 0 || resolvedInbox.length > 0) {
    sections.push('## Human Inbox');
    if (pendingInbox.length > 0) {
      sections.push(`Pending (${pendingInbox.length} items — awaiting human response):`);
      for (const item of pendingInbox) {
        sections.push(`- #${item.id} [${item.urgency}] from ${item.source_agent}: ${item.title}`);
      }
    }
    if (resolvedInbox.length > 0) {
      sections.push('Recently resolved:');
      for (const item of resolvedInbox) {
        sections.push(`- #${item.id}: ${item.title} (resolved by ${item.resolved_by})`);
      }
    }
    sections.push('');
  }

  // Failed/recent agent runs — CEO needs to know what happened
  const recentRuns = listRuns({ limit: 10 });
  const failedRuns = recentRuns.filter(r => r.status === 'failed');
  const completedWorkerRuns = recentRuns.filter(r => r.status === 'completed' && r.type === 'worker');
  if (failedRuns.length > 0 || completedWorkerRuns.length > 0) {
    sections.push('## Agent Run History');
    if (failedRuns.length > 0) {
      sections.push('### Failed Runs (need attention)');
      for (const run of failedRuns) {
        sections.push(`- **${run.agent_name}** FAILED at ${run.started_at}: ${run.error || 'unknown error'}`);
        sections.push(`  Consider: retry, reassign, or escalate to human.`);
      }
    }
    if (completedWorkerRuns.length > 0) {
      sections.push('### Completed Worker Runs');
      for (const run of completedWorkerRuns.slice(0, 5)) {
        sections.push(`- **${run.agent_name}** completed at ${run.finished_at || run.started_at}: ${(run.result_summary || '').slice(0, 200)}`);
      }
    }
    sections.push('');
  }

  // Recent activity (capped to 10 for prompt size)
  const activity = getActivityLog({ limit: 10 });
  if (activity.length > 0) {
    sections.push('## Recent Activity');
    for (const entry of activity) {
      sections.push(`- ${entry.created_at} — ${entry.actor}: ${entry.action} ${entry.entity_type}${entry.entity_id ? ` #${entry.entity_id}` : ''}`);
    }
    sections.push('');
  }

  // Workload summary per agent
  if (org.length > 0) {
    const allIssuesForWorkload = listIssues({ limit: 200 });
    sections.push('## Agent Workload');
    for (const node of org) {
      if (node.is_ceo) continue;
      const agentIssues = allIssuesForWorkload.filter(i =>
        i.assigned_to?.toLowerCase() === node.agent_name.toLowerCase()
      );
      const todo = agentIssues.filter(i => i.status === 'todo').length;
      const inProg = agentIssues.filter(i => i.status === 'in_progress').length;
      const blocked = agentIssues.filter(i => i.status === 'blocked').length;
      const done = agentIssues.filter(i => i.status === 'done').length;
      const total = agentIssues.length;

      // Check recent failures for this agent
      const agentRuns = recentRuns.filter(r => r.agent_name.toLowerCase() === node.agent_name.toLowerCase());
      const agentFailures = agentRuns.filter(r => r.status === 'failed').length;
      const failureNote = agentFailures > 0 ? ` ⚠ ${agentFailures} recent failures` : '';

      sections.push(`- **${node.title || node.agent_name}**: ${inProg} in progress, ${todo} todo, ${blocked} blocked, ${done} done (${total} total)${failureNote}`);
    }
    sections.push('');
    sections.push('Use this workload data to balance assignments. Do not overload agents who already have 2+ items in todo/in_progress. Assign to agents with capacity.');
    sections.push('');
  }

  // Error patterns
  const failedRuns = recentRuns.filter(r => r.status === 'failed');
  if (failedRuns.length >= 3) {
    // Check for patterns
    const failuresByAgent: Record<string, number> = {};
    const failureErrors: string[] = [];
    for (const run of failedRuns) {
      failuresByAgent[run.agent_name] = (failuresByAgent[run.agent_name] || 0) + 1;
      if (run.error) failureErrors.push(run.error.slice(0, 100));
    }
    sections.push('## Error Pattern Analysis');
    sections.push(`${failedRuns.length} failures detected in recent runs:`);
    for (const [agent, count] of Object.entries(failuresByAgent)) {
      if (count >= 2) sections.push(`- **${agent}**: ${count} failures — may indicate a systemic issue`);
    }
    // Check for common error messages
    const commonErrors = failureErrors.filter((e, i, arr) => arr.indexOf(e) !== i);
    if (commonErrors.length > 0) {
      sections.push(`Common error: "${commonErrors[0]}"`);
    }
    sections.push('If you see a pattern (same agent, same error), escalate to human inbox with the pattern description.');
    sections.push('');
  }

  // Tools
  sections.push(formatToolsForPrompt(getCeoToolDefs()));

  // Instructions
  sections.push('## Instructions');
  sections.push('');
  sections.push('You manage this company like a real CEO with real employees. Review the company state and take thoughtful action.');
  sections.push('');
  sections.push('### Communication rules');
  sections.push('- **ALWAYS use @agentname** when addressing an agent in comments. Example: "@atlas please review this". The @ triggers the agent to read and act. Without it, the agent will never see your message.');
  sections.push('- **Do NOT repeat yourself**. If you already commented on an issue and the status hasn\'t changed, do not comment again. Check the comment history before adding a new comment.');
  sections.push('- **Blocked issues**: If an issue is blocked and already escalated to the human inbox, leave it alone. Do not keep commenting on it. The human will respond when ready.');
  sections.push('- **Be concise**. Agents read your comments as instructions. Short, actionable directives — not essays.');
  sections.push('');
  sections.push('### Work management principles');
  sections.push('- **Backlog first**: New issues go to BACKLOG, not TODO. Only move the highest-priority, immediately-actionable items to TODO.');
  sections.push('- **Limit work in progress**: Each agent should have at most 1-2 items in TODO at a time. Do not flood agents with work. Check the Agent Workload section above before assigning.');
  sections.push('- **Dependencies matter**: Think about what must happen before other things can start. Sequence work logically.');
  sections.push('- **Trickle, don\'t dump**: Create a few high-impact issues per heartbeat, not a wall of tasks. More will come on future heartbeats as work completes.');
  sections.push('- **Review before creating**: Before creating new issues, check what already exists. Don\'t duplicate work.');
  sections.push('- **No duplicates**: Before creating an issue, check the existing issue board above. If an open issue already covers the same work, comment on it instead of creating a new one.');
  sections.push('- **Progressive planning**: Break goals into phases. Phase 1 issues go to backlog now. Phase 2+ issues get created as Phase 1 completes.');
  sections.push('');
  sections.push('### Each heartbeat');
  sections.push('1. **Assess progress** — Which issues moved? What\'s blocked? What completed?');
  sections.push('2. **Unblock** — If an issue is blocked and NOT already escalated, escalate to human. If already escalated, skip it.');
  sections.push('3. **Promote work** — Move the next highest-priority backlog items to TODO for agents that have capacity.');
  sections.push('4. **Create new work** — Only if there\'s a clear gap between goals and existing issues. Start in backlog.');
  sections.push('5. **Communicate** — Only comment if you have NEW information or direction. Do not nag agents who are already working.');
  sections.push('6. **Escalate** — Use escalate_to_human for decisions you cannot make.');
  sections.push('');
  sections.push('### Automated safeguards');
  sections.push('- **Stuck issues**: If an issue has been in_progress for 24+ hours or blocked for 48+ hours, escalate to the human inbox.');
  sections.push('- **Failed retries**: If an agent failed on a task more than 3 times (check run history), move the issue to blocked and escalate to human. Do not keep retrying the same failing task.');
  sections.push('');
  sections.push('Use the tools above to take actions. You can make multiple tool calls.');
  sections.push('If everything is on track and no action is needed, respond with: HEARTBEAT_OK');
  sections.push('');
  sections.push(`Current time: ${new Date().toISOString()}`);

  return sections.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════

export async function runCeoHeartbeat(root: string, agentName: string): Promise<string> {
  logger.info('Running CEO orchestration heartbeat', { agent: agentName });

  resetSessionLimits(); // Prevent runaway issue/goal creation
  const runId = createRun(agentName, 'orchestration');

  try {
    const prompt = buildCeoHeartbeatPrompt(agentName);

    const client = getClaudeClient();
    const result = await client.complete(prompt, {
      maxTurns: 15,
      subprocess: true,
      onChunk: (chunk) => appendRunLog(runId, chunk),
      system: [
        `You are ${agentName}, the CEO orchestrator for this company.`,
        'You coordinate a team of AI agents to achieve company goals.',
        'Use the orchestration tools provided to manage goals, issues, and communication.',
        'Be decisive and action-oriented. Create concrete tasks with clear descriptions.',
        'When assigning work, match agents to tasks based on their roles and capabilities.',
        'Keep comments concise and actionable.',
      ].join(' '),
    });

    // Parse and execute any tool calls in the response
    const toolCalls = parseToolCalls(result);
    const toolResults: string[] = [];

    for (const call of toolCalls) {
      try {
        const toolResult = executeTool(call.name, call.params, agentName);
        toolResults.push(`✓ ${call.name}: ${JSON.stringify(toolResult).slice(0, 200)}`);
        logger.info(`CEO tool call: ${call.name}`, { params: call.params });
      } catch (error) {
        toolResults.push(`✗ ${call.name}: ${(error as Error).message}`);
        logger.error(`CEO tool call failed: ${call.name}`, { error: String(error) });
      }
    }

    // Log results
    const summary = toolCalls.length > 0
      ? `CEO heartbeat: ${toolCalls.length} tool calls executed\n${toolResults.join('\n')}`
      : (result.trim() === 'HEARTBEAT_OK' ? 'CEO heartbeat: no action needed' : `CEO heartbeat: ${result.slice(0, 200)}`);

    // Record run completion
    completeRun(runId, {
      result_summary: summary.slice(0, 2000),
      tool_calls_json: toolCalls.length > 0 ? JSON.stringify(toolCalls) : undefined,
      log_output: result,
    });

    const heartbeatLog = join(root, 'logs', 'heartbeat.log');
    const logDir = dirname(heartbeatLog);
    mkdirSync(logDir, { recursive: true });
    appendFileSync(
      heartbeatLog,
      `\n--- CEO ORCHESTRATION ${new Date().toISOString()} ---\n${summary}\n${result}\n`,
      'utf-8'
    );

    logger.info('CEO orchestration heartbeat complete', {
      runId,
      toolCalls: toolCalls.length,
      heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });

    return summary;
  } catch (error) {
    failRun(runId, (error as Error).message);
    logger.error('CEO orchestration heartbeat failed', { runId, error: String(error) });
    throw error;
  }
}
