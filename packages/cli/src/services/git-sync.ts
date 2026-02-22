/**
 * KyberBot — Git Auto-Sync Service
 *
 * Periodically commits changes to the agent's repository.
 * Provides the safety net that enables autonomous operations.
 */

import { simpleGit, SimpleGit } from 'simple-git';
import { createLogger } from '../logger.js';
import { ServiceHandle } from '../types.js';

const logger = createLogger('git-sync');

let git: SimpleGit | null = null;
let intervalId: NodeJS.Timeout | null = null;
let running = false;

const COMMIT_INTERVAL_MS = (parseInt(process.env.COMMIT_INTERVAL_MINUTES || '5')) * 60 * 1000;

export async function startGitSync(root: string): Promise<ServiceHandle> {
  logger.info(`Commit interval: ${COMMIT_INTERVAL_MS / 1000 / 60} minutes`);

  git = simpleGit(root);

  try {
    await git.status();
  } catch (error) {
    logger.error('Not a git repository. Run "git init" first.');
    throw new Error('Not a git repository');
  }

  running = true;

  await commitChanges();

  intervalId = setInterval(commitChanges, COMMIT_INTERVAL_MS);

  return {
    stop: async () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      await commitChanges();
      running = false;
      git = null;
    },
    status: () => (running ? 'running' : 'stopped'),
  };
}

async function commitChanges(): Promise<void> {
  if (!git) return;

  try {
    const status = await git.status();

    if (status.files.length === 0) {
      logger.debug('No changes to commit');
      return;
    }

    const timestamp = new Date().toISOString();

    const categories = categorizeChanges(status.files);
    const summary = buildCommitSummary(categories);

    await git.add('.');
    await git.commit(`Auto-sync: ${timestamp}\n\n${summary}`);

    logger.info(`Committed ${status.files.length} changes`);
    logger.debug(summary);
  } catch (error) {
    logger.error('Failed to commit changes', { error: String(error) });
  }
}

interface ChangeCategories {
  brain: number;
  skills: number;
  identity: number;
  config: number;
  logs: number;
  other: number;
}

function categorizeChanges(files: { path: string }[]): ChangeCategories {
  const categories: ChangeCategories = {
    brain: 0,
    skills: 0,
    identity: 0,
    config: 0,
    logs: 0,
    other: 0,
  };

  for (const file of files) {
    const path = file.path;
    if (path.startsWith('brain/') || path.startsWith('data/')) {
      categories.brain++;
    } else if (path.startsWith('skills/') || path.startsWith('.claude/skills/')) {
      categories.skills++;
    } else if (['SOUL.md', 'USER.md', 'HEARTBEAT.md'].some(f => path.includes(f))) {
      categories.identity++;
    } else if (path.endsWith('.json') || path.endsWith('.yaml') || path.startsWith('.claude/')) {
      categories.config++;
    } else if (path.startsWith('logs/')) {
      categories.logs++;
    } else {
      categories.other++;
    }
  }

  return categories;
}

function buildCommitSummary(categories: ChangeCategories): string {
  const parts: string[] = [];

  if (categories.brain > 0) parts.push(`${categories.brain} brain file(s)`);
  if (categories.skills > 0) parts.push(`${categories.skills} skill(s)`);
  if (categories.identity > 0) parts.push(`${categories.identity} identity file(s)`);
  if (categories.config > 0) parts.push(`${categories.config} config change(s)`);
  if (categories.logs > 0) parts.push(`${categories.logs} log file(s)`);
  if (categories.other > 0) parts.push(`${categories.other} other file(s)`);

  return parts.join(', ');
}
