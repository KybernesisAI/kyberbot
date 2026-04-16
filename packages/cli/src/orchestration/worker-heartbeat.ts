/**
 * KyberBot — Worker Orchestration Heartbeat
 *
 * Runs a worker agent's assigned tasks. The worker:
 * 1. Checks out the issue (in_progress)
 * 2. Does the actual work
 * 3. Comments on the issue with results
 * 4. Transitions the issue (done/in_review/blocked)
 *
 * Steps 1, 3, and 4 are done programmatically AROUND the Claude call,
 * not as optional tool calls that Claude might skip.
 */

import { createLogger } from '../logger.js';
import {
  listIssues, getComments, checkoutIssue, transitionIssue, addComment,
} from './index.js';
import { createRun, completeRun, failRun } from './runs.js';
import { getClaudeClient } from '../claude.js';
import type { Issue } from './types.js';

const logger = createLogger('worker-heartbeat');

// ═══════════════════════════════════════════════════════════════════════════════
// SERIAL QUEUE — only one heartbeat runs at a time
// ═══════════════════════════════════════════════════════════════════════════════

const heartbeatQueue: Array<() => Promise<void>> = [];
let isProcessing = false;

async function processQueue(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;
  while (heartbeatQueue.length > 0) {
    const task = heartbeatQueue.shift()!;
    try { await task(); } catch { /* errors logged inside each task */ }
  }
  isProcessing = false;
}

/**
 * Queue a worker heartbeat for serial execution. If another heartbeat is
 * already running, the new one waits until the current one finishes.
 * Fire-and-forget — does not return a result.
 */
export function queueWorkerHeartbeat(
  root: string,
  agentName: string,
  agentRole: string,
  agentTitle: string,
): void {
  heartbeatQueue.push(() => runWorkerHeartbeat(root, agentName, agentRole, agentTitle).then(() => {}));
  processQueue();
}

/**
 * Queue a CEO heartbeat for serial execution (same queue as workers).
 */
export function queueCeoHeartbeat(
  root: string,
  agentName: string,
  runCeoFn: (root: string, agentName: string) => Promise<string>,
): void {
  heartbeatQueue.push(() => runCeoFn(root, agentName).then(() => {}));
  processQueue();
}

/**
 * Run a full worker heartbeat for the given agent.
 * Picks their highest-priority todo/in_progress issue, does the work,
 * comments with results, and transitions the issue.
 */
export async function runWorkerHeartbeat(
  root: string,
  agentName: string,
  agentRole: string,
  agentTitle: string,
): Promise<string> {
  // Find assigned issues
  const inProgress = listIssues({ assigned_to: agentName, status: 'in_progress' });
  const todo = listIssues({ assigned_to: agentName, status: 'todo' });

  // Prioritize in_progress first, then highest priority todo
  const targetIssue = inProgress[0] || todo[0];
  if (!targetIssue) {
    return 'No assigned work.';
  }

  const runId = createRun(agentName, 'worker');

  try {
    // Step 1: Check out the issue (moves to in_progress if in todo)
    try {
      checkoutIssue(targetIssue.id, agentName);
      logger.info(`Worker ${agentName} checked out issue KYB-${targetIssue.id}`);
    } catch {
      // Already checked out or in_progress — fine
    }

    // Step 2: Build prompt for the actual work
    const recentComments = getComments(targetIssue.id);
    const commentContext = recentComments.length > 0
      ? '\n\nRecent comments on this issue:\n' + recentComments.slice(-5).map(c => `${c.author_agent}: ${c.content}`).join('\n')
      : '';

    const prompt = [
      `You are ${agentTitle}, ${agentRole}.`,
      '',
      `## Your Current Task`,
      '',
      `**Issue KYB-${targetIssue.id}: ${targetIssue.title}**`,
      `Priority: ${targetIssue.priority}`,
      `Status: in_progress (checked out to you)`,
      '',
      targetIssue.description || 'No description provided.',
      commentContext,
      '',
      '## Instructions',
      '',
      'Complete this task. You are running in fully autonomous mode with unrestricted permissions. You can read, write, and modify any file. You can run any bash command. There are no permission prompts — just do the work. Do not ask for permission or say you need permission. Act.',
      '',
      'When you are done, write a concise summary of:',
      '1. What you did',
      '2. What the outcome/deliverables are',
      '3. Whether the task is DONE, needs REVIEW, or is BLOCKED (and why)',
      '',
      'Start your final summary with one of these status lines:',
      '- STATUS: DONE — if the task is fully complete',
      '- STATUS: IN_REVIEW — if it needs someone to review your work',
      '- STATUS: BLOCKED — if you hit a blocker you cannot resolve yourself (missing API key, missing permissions, need human input, dependency on another task, etc.)',
      '- STATUS: IN_PROGRESS — if you made progress but need another pass to finish',
    ].join('\n');

    // Step 3: Run Claude to do the actual work
    const client = getClaudeClient();
    const result = await client.complete(prompt, {
      maxTurns: 25,
      subprocess: true,
    });

    // Step 4: Parse the status from the result
    let newStatus: 'done' | 'in_review' | 'blocked' | 'in_progress' = 'in_progress';
    if (result.includes('STATUS: DONE')) newStatus = 'done';
    else if (result.includes('STATUS: IN_REVIEW')) newStatus = 'in_review';
    else if (result.includes('STATUS: BLOCKED')) newStatus = 'blocked';

    // Step 5: Add a comment with the results
    const commentBody = result.length > 2000
      ? result.slice(-2000) // Take the tail which has the summary
      : result;

    // Extract just the summary part if possible
    const summaryMatch = result.match(/STATUS:[\s\S]*$/);
    const summaryText = summaryMatch ? summaryMatch[0] : commentBody.slice(-1000);

    addComment(targetIssue.id, agentName, summaryText);
    logger.info(`Worker ${agentName} commented on issue KYB-${targetIssue.id}`);

    // Step 6: Transition the issue
    if (newStatus !== 'in_progress') {
      try {
        transitionIssue(targetIssue.id, newStatus, agentName);
        logger.info(`Worker ${agentName} transitioned issue KYB-${targetIssue.id} to ${newStatus}`);
      } catch (err) {
        logger.warn(`Failed to transition issue KYB-${targetIssue.id} to ${newStatus}`, { error: String(err) });
      }
    }

    const summary = `Issue KYB-${targetIssue.id}: ${newStatus}. ${summaryText.slice(0, 300)}`;
    completeRun(runId, { result_summary: summary, log_output: result });
    return summary;

  } catch (err) {
    failRun(runId, (err as Error).message);
    // Comment the failure and move issue back to todo so it can be retried
    try {
      addComment(targetIssue.id, agentName, `Heartbeat failed: ${(err as Error).message}. Moving back to todo for retry.`);
      transitionIssue(targetIssue.id, 'todo', agentName);
      logger.info(`Issue KYB-${targetIssue.id} moved back to todo after failure`);
    } catch { /* ignore transition errors */ }
    throw err;
  }
}

/**
 * Build orchestration context to inject into the standard heartbeat prompt.
 * Used when the agent runs via the regular heartbeat tick (not a direct trigger).
 * Returns empty string if the agent has no assigned work.
 */
export function getWorkerOrchestrationContext(agentName: string): string {
  const sections: string[] = [];

  const inProgress = listIssues({ assigned_to: agentName, status: 'in_progress' });
  const todo = listIssues({ assigned_to: agentName, status: 'todo' });
  const blocked = listIssues({ assigned_to: agentName, status: 'blocked' });

  const totalAssigned = inProgress.length + todo.length + blocked.length;
  if (totalAssigned === 0) return '';

  sections.push('');
  sections.push('## Your Orchestration Assignments');
  sections.push('');
  sections.push(`You have ${totalAssigned} issue(s) assigned to you.`);

  for (const issue of [...inProgress, ...todo, ...blocked]) {
    const comments = getComments(issue.id);
    sections.push(`- **KYB-${issue.id}** [${issue.status}] [${issue.priority}] ${issue.title}`);
    if (issue.description) sections.push(`  ${issue.description.slice(0, 200)}`);
    if (comments.length > 0) {
      const last = comments[comments.length - 1];
      sections.push(`  Last: ${last.author_agent}: ${last.content.slice(0, 150)}`);
    }
  }

  return sections.join('\n');
}

/**
 * Process tool calls from a worker agent's heartbeat response.
 * This is the legacy path — kept for backward compatibility with
 * standard heartbeat ticks that inject orchestration context.
 */
export function processWorkerToolCalls(responseText: string, agentName: string): void {
  // Import parseToolCalls and executeTool dynamically to avoid circular deps
  import('./tools.js').then(({ parseToolCalls, executeTool }) => {
    const toolCalls = parseToolCalls(responseText);
    if (toolCalls.length === 0) return;

    for (const call of toolCalls) {
      try {
        executeTool(call.name, call.params, agentName);
      } catch (error) {
        logger.error(`Worker tool call failed: ${call.name}`, { agent: agentName, error: String(error) });
      }
    }
    logger.info(`Worker ${agentName}: ${toolCalls.length} orchestration tool calls processed`);
  }).catch(() => {});
}
