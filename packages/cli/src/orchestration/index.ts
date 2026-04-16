/**
 * KyberBot — Orchestration Layer
 *
 * Barrel exports for the orchestration module.
 */

// Database
export { getOrchDb, resetOrchDb } from './db.js';

// Types
export type {
  Company, Project, OrgNode, Goal, GoalKPI, GoalLevel, GoalStatus,
  Issue, IssueStatus, IssuePriority, IssueComment,
  InboxItem, InboxUrgency, InboxStatus,
  ActivityEntry,
  HeartbeatRun, HeartbeatRunType, HeartbeatRunStatus,
  OrchestrationSettings,
} from './types.js';

// State machine
export { isValidTransition, getValidTargets, isTerminal } from './state-machine.js';

// Company
export { getCompany, updateCompany } from './org.js';

// Projects
export { createProject, updateProject, deleteProject, getProject, listProjects } from './projects.js';

// Org chart
export { setOrgNode, getOrgNode, getOrgChart, getDirectReports, getCeoAgent, removeOrgNode } from './org.js';

// Goals
export { createGoal, updateGoal, getGoal, listGoals, deleteGoal, upsertKPI, getKPIsForGoal } from './goals.js';

// Issues
export {
  createIssue, updateIssue, getIssue, listIssues,
  transitionIssue, checkoutIssue, releaseCheckout,
  addComment, getComments,
  recoverStuckIssues,
} from './issues.js';

// Inbox
export { createInboxItem, listInbox, acknowledgeInboxItem, resolveInboxItem, getInboxItem, getPendingInboxCount } from './inbox.js';

// Activity
export { logActivity, getActivityLog } from './activity.js';

// Heartbeat Runs
export { createRun, completeRun, failRun, listRuns, getRun, recoverStuckRuns, appendRunLog, readRunLog } from './runs.js';

// Heartbeat Queue
export { queueWorkerHeartbeat, queueCeoHeartbeat } from './worker-heartbeat.js';

// Orchestration Settings
export { getOrchestrationSettings, updateOrchestrationSettings } from './settings.js';
