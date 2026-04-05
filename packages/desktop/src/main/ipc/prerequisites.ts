/**
 * Prerequisite detection: Docker + Claude Code.
 * Both are required before the user can proceed.
 */

import { ipcMain } from 'electron';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { IPC, PrerequisiteStatus } from '../../types/ipc.js';
import { AppStore } from '../store.js';

export function registerPrerequisiteHandlers(store: AppStore): void {
  ipcMain.handle(IPC.PREREQ_CHECK, async (): Promise<PrerequisiteStatus> => {
    const docker = checkDocker();
    const claude = checkClaude();
    const agentRoot = checkAgentRoot(store);
    return { docker, claude, agentRoot };
  });
}

function checkDocker(): PrerequisiteStatus['docker'] {
  try {
    const version = execSync('docker --version', { encoding: 'utf-8', timeout: 5000 }).trim();
    // Check if Docker daemon is running
    try {
      execSync('docker info', { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' });
      return { installed: true, running: true, version };
    } catch {
      return { installed: true, running: false, version };
    }
  } catch {
    return { installed: false, running: false, version: null };
  }
}

function checkClaude(): PrerequisiteStatus['claude'] {
  try {
    const version = execSync('claude --version', { encoding: 'utf-8', timeout: 5000 }).trim();
    return { installed: true, version };
  } catch {
    return { installed: false, version: null };
  }
}

function checkAgentRoot(store: AppStore): PrerequisiteStatus['agentRoot'] {
  const path = store.getAgentRoot();
  if (!path) return { configured: false, path: null, hasIdentity: false };

  const hasIdentity = existsSync(join(path, 'identity.yaml'));
  return { configured: true, path, hasIdentity };
}
