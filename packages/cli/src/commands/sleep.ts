/**
 * Sleep Command
 *
 * Manage the sleep agent and view maintenance status.
 *
 * Usage:
 *   kyberbot sleep status    # Show recent runs and queue stats
 *   kyberbot sleep run       # Trigger immediate sleep cycle
 *   kyberbot sleep edges     # Show memory relationships
 *   kyberbot sleep health    # Check sleep agent health
 *   kyberbot sleep merges    # Show entity merge audit trail
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { getSleepDb, initializeSleepDb } from '../brain/sleep/db.js';
import { runSleepCycleNow } from '../brain/sleep/index.js';
import { getRoot } from '../config.js';

function countConsecutiveFailures(statuses: Array<{ status: string }>): number {
  let count = 0;
  for (const s of statuses) {
    if (s.status === 'failed') count++;
    else break;
  }
  return count;
}

export function createSleepCommand(): Command {
  const cmd = new Command('sleep')
    .description('Manage sleep agent and knowledge maintenance');

  cmd
    .command('status')
    .description('Show sleep agent status and recent runs')
    .action(async () => {
      const root = getRoot();
      await initializeSleepDb(root);
      const db = getSleepDb(root);

      const runs = db.prepare(`
        SELECT * FROM sleep_runs
        ORDER BY started_at DESC
        LIMIT 5
      `).all() as Array<{
        id: number;
        started_at: string;
        completed_at: string | null;
        status: string;
        metrics: string | null;
        error_message: string | null;
      }>;

      console.log(chalk.cyan.bold('\nSleep Agent Status\n'));

      // Check for consecutive failures
      const recentStatuses = db.prepare(`
        SELECT status FROM sleep_runs ORDER BY started_at DESC LIMIT 5
      `).all() as Array<{ status: string }>;
      const consecutiveFailures = countConsecutiveFailures(recentStatuses);
      if (consecutiveFailures >= 3) {
        console.log(chalk.red.bold(`  WARNING: ${consecutiveFailures} consecutive failures detected!`));
        console.log(chalk.red(`  The sleep agent may need attention.\n`));
      }

      if (runs.length === 0) {
        console.log(chalk.yellow('No sleep runs recorded yet.'));
        console.log(chalk.dim('Run `kyberbot sleep run` to trigger a cycle.\n'));
        return;
      }

      console.log(chalk.dim('Recent runs:'));
      for (const run of runs) {
        const status = run.status === 'completed'
          ? chalk.green('[done]')
          : run.status === 'failed'
            ? chalk.red('[fail]')
            : chalk.yellow('[....]');

        const metrics = run.metrics ? JSON.parse(run.metrics) : null;
        const duration = metrics?.totalDurationMs
          ? `${(metrics.totalDurationMs / 1000).toFixed(1)}s`
          : '-';

        console.log(`  ${status} ${run.started_at} (${duration})`);
        if (metrics) {
          console.log(chalk.dim(`        decay:${metrics.decay?.count || 0} tag:${metrics.tag?.count || 0} link:${metrics.link?.count || 0} tier:${metrics.tier?.count || 0} sum:${metrics.summarize?.count || 0} hyg:${metrics.entityHygiene?.count || 0}`));
        }
        if (run.error_message) {
          console.log(chalk.red(`        Error: ${run.error_message.slice(0, 80)}`));
        }
      }

      // Queue stats
      const queueStats = db.prepare(`
        SELECT task, COUNT(*) as count
        FROM maintenance_queue
        WHERE processed_at IS NULL
        GROUP BY task
      `).all() as Array<{ task: string; count: number }>;

      if (queueStats.length > 0) {
        console.log(chalk.dim('\nPending maintenance:'));
        for (const stat of queueStats) {
          console.log(`  ${stat.task}: ${stat.count}`);
        }
      }

      // Edge count
      const edgeCount = db.prepare(`SELECT COUNT(*) as count FROM memory_edges`).get() as { count: number };
      console.log(chalk.dim(`\nMemory relationships: ${edgeCount?.count || 0}`));
      console.log('');
    });

  cmd
    .command('run')
    .description('Run sleep cycle immediately')
    .action(async () => {
      const root = getRoot();
      console.log(chalk.cyan('Running sleep cycle...\n'));

      try {
        const metrics = await runSleepCycleNow(root);

        console.log(chalk.green('Sleep cycle completed:'));
        console.log(`  Decayed: ${metrics.decay.count} (${(metrics.decay.durationMs / 1000).toFixed(1)}s)`);
        console.log(`  Tagged:  ${metrics.tag.count} (${(metrics.tag.durationMs / 1000).toFixed(1)}s)`);
        console.log(`  Linked:  ${metrics.link.count} (${(metrics.link.durationMs / 1000).toFixed(1)}s)`);
        console.log(`  Tiered:  ${metrics.tier.count} (${(metrics.tier.durationMs / 1000).toFixed(1)}s)`);
        console.log(`  Summary: ${metrics.summarize.count} (${(metrics.summarize.durationMs / 1000).toFixed(1)}s)`);
        if (metrics.entityHygiene) {
          const h = metrics.entityHygiene;
          console.log(`  Hygiene: ${h.count} (${(h.durationMs / 1000).toFixed(1)}s) [artifacts:${h.artifactsCleaned} merged:${h.merged} pruned:${h.pruned}]`);
        }
        console.log(`  Total:   ${(metrics.totalDurationMs / 1000).toFixed(1)}s`);
        console.log('');
      } catch (error) {
        console.error(chalk.red(`Sleep cycle failed: ${error}`));
        process.exit(1);
      }
    });

  cmd
    .command('edges')
    .description('Show memory relationships')
    .option('-l, --limit <n>', 'Number of edges to show', '20')
    .action(async (options) => {
      const root = getRoot();
      await initializeSleepDb(root);
      const db = getSleepDb(root);

      const edges = db.prepare(`
        SELECT from_path, to_path, relation, confidence, shared_tags
        FROM memory_edges
        ORDER BY confidence DESC
        LIMIT ?
      `).all(parseInt(options.limit)) as Array<{
        from_path: string;
        to_path: string;
        relation: string;
        confidence: number;
        shared_tags: string | null;
      }>;

      console.log(chalk.cyan.bold('\nMemory Relationships\n'));

      if (edges.length === 0) {
        console.log(chalk.yellow('No relationships found yet.'));
        console.log(chalk.dim('Run `kyberbot sleep run` to build relationships.\n'));
        return;
      }

      for (const edge of edges) {
        const fromName = edge.from_path.split('/').pop() || edge.from_path;
        const toName = edge.to_path.split('/').pop() || edge.to_path;
        const confidence = (edge.confidence * 100).toFixed(0);
        const tags = JSON.parse(edge.shared_tags || '[]').slice(0, 3).join(', ');

        console.log(`  ${chalk.white(fromName)}`);
        console.log(chalk.dim(`    <-> ${toName} (${confidence}%${tags ? ': ' + tags : ''})`));
        console.log('');
      }
    });

  cmd
    .command('health')
    .description('Check sleep agent health (for monitoring)')
    .option('--json', 'Output as JSON', false)
    .action(async (options) => {
      const root = getRoot();
      await initializeSleepDb(root);
      const db = getSleepDb(root);

      const lastCompleted = db.prepare(`
        SELECT started_at, completed_at, metrics
        FROM sleep_runs
        WHERE status = 'completed'
        ORDER BY started_at DESC
        LIMIT 1
      `).get() as { started_at: string; completed_at: string; metrics: string | null } | undefined;

      const lastRun = db.prepare(`
        SELECT started_at, status, error_message
        FROM sleep_runs
        ORDER BY started_at DESC
        LIMIT 1
      `).get() as { started_at: string; status: string; error_message: string | null } | undefined;

      const recentStatuses = db.prepare(`
        SELECT status FROM sleep_runs ORDER BY started_at DESC LIMIT 5
      `).all() as Array<{ status: string }>;

      const consecutiveFailures = countConsecutiveFailures(recentStatuses);
      const totalRuns = (db.prepare(`SELECT COUNT(*) as count FROM sleep_runs`).get() as { count: number }).count;
      const totalFailed = (db.prepare(`SELECT COUNT(*) as count FROM sleep_runs WHERE status = 'failed'`).get() as { count: number }).count;
      const edgeCount = (db.prepare(`SELECT COUNT(*) as count FROM memory_edges`).get() as { count: number }).count;
      const pendingQueue = (db.prepare(`SELECT COUNT(*) as count FROM maintenance_queue WHERE processed_at IS NULL`).get() as { count: number }).count;

      let minutesSinceSuccess: number | null = null;
      let overdue = false;
      if (lastCompleted) {
        minutesSinceSuccess = Math.round((Date.now() - new Date(lastCompleted.completed_at).getTime()) / 60000);
        overdue = minutesSinceSuccess > 90;
      }

      const health = {
        status: consecutiveFailures >= 3 ? 'unhealthy' : overdue ? 'degraded' : 'healthy',
        lastSuccessfulRun: lastCompleted?.completed_at || null,
        minutesSinceSuccess,
        overdue,
        consecutiveFailures,
        lastRunStatus: lastRun?.status || null,
        lastError: lastRun?.status === 'failed' ? lastRun.error_message : null,
        totalRuns,
        totalFailed,
        edgeCount,
        pendingQueue,
      };

      if (options.json) {
        console.log(JSON.stringify(health, null, 2));
        return;
      }

      const statusIcon = health.status === 'healthy'
        ? chalk.green('[healthy]')
        : health.status === 'degraded'
          ? chalk.yellow('[degraded]')
          : chalk.red('[unhealthy]');

      console.log(`\nSleep Agent Health: ${statusIcon}\n`);

      if (health.lastSuccessfulRun) {
        const agoStr = health.minutesSinceSuccess! < 60
          ? `${health.minutesSinceSuccess}m ago`
          : `${(health.minutesSinceSuccess! / 60).toFixed(1)}h ago`;
        console.log(`  Last success: ${health.lastSuccessfulRun} (${agoStr})`);
      } else {
        console.log(chalk.yellow('  No successful runs recorded.'));
      }

      if (health.overdue) {
        console.log(chalk.yellow(`  OVERDUE: Expected run within 90 minutes, last was ${health.minutesSinceSuccess}m ago`));
      }

      if (health.consecutiveFailures > 0) {
        const failColor = health.consecutiveFailures >= 3 ? chalk.red : chalk.yellow;
        console.log(failColor(`  Consecutive failures: ${health.consecutiveFailures}`));
      }

      if (health.lastError) {
        console.log(chalk.red(`  Last error: ${health.lastError.slice(0, 100)}`));
      }

      console.log(chalk.dim(`  Total runs: ${health.totalRuns} (${health.totalFailed} failed)`));
      console.log(chalk.dim(`  Edges: ${health.edgeCount} | Queue: ${health.pendingQueue}`));
      console.log('');
    });

  cmd
    .command('merges')
    .description('Show entity merge/cleanup audit trail')
    .option('-l, --limit <n>', 'Number of entries to show', '20')
    .action(async (options) => {
      const root = getRoot();
      const { getEntityGraphDb } = await import('../brain/entity-graph.js');
      const db = await getEntityGraphDb(root);

      const tableExists = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='entity_merges'`
      ).get();

      if (!tableExists) {
        console.log(chalk.yellow('No entity merges table yet. Run `kyberbot sleep run` first.\n'));
        return;
      }

      const merges = db.prepare(`
        SELECT * FROM entity_merges
        ORDER BY merged_at DESC
        LIMIT ?
      `).all(parseInt(options.limit)) as Array<{
        id: number;
        keep_id: number;
        remove_id: number;
        keep_name: string | null;
        remove_name: string | null;
        keep_type: string | null;
        remove_type: string | null;
        reason: string;
        confidence: number | null;
        ai_rationale: string | null;
        mentions_moved: number;
        relations_moved: number;
        merged_at: string;
        merged_by: string;
      }>;

      console.log(chalk.cyan.bold('\nEntity Merge Audit Trail\n'));

      if (merges.length === 0) {
        console.log(chalk.yellow('No merges recorded yet.\n'));
        return;
      }

      for (const m of merges) {
        const isDelete = m.keep_id === 0;
        const action = isDelete
          ? chalk.red('DELETE')
          : chalk.green('MERGE');

        const conf = m.confidence != null ? ` (${(m.confidence * 100).toFixed(0)}%)` : '';

        if (isDelete) {
          console.log(`  ${action} "${m.remove_name}" [${m.remove_type}]${conf}`);
        } else {
          console.log(`  ${action} "${m.remove_name}" [${m.remove_type}] -> "${m.keep_name}" [${m.keep_type}]${conf}`);
        }

        console.log(chalk.dim(`    reason: ${m.reason} | mentions: ${m.mentions_moved} | relations: ${m.relations_moved}`));
        if (m.ai_rationale) {
          console.log(chalk.dim(`    ai: ${m.ai_rationale.slice(0, 80)}`));
        }
        console.log(chalk.dim(`    at: ${m.merged_at} by: ${m.merged_by}`));
        console.log('');
      }
    });

  return cmd;
}
