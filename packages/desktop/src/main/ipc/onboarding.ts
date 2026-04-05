/**
 * Onboarding IPC handlers.
 * Creates the agent directory structure and initial files.
 */

import { ipcMain } from 'electron';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { IPC } from '../../types/ipc.js';
import { AppStore } from '../store.js';

interface OnboardingData {
  agentRoot: string;
  agentName: string;
  agentDescription: string;
  userName: string;
  timezone: string;
  claudeMode: 'subscription' | 'sdk';
  apiKey?: string;
}

export function registerOnboardingHandlers(store: AppStore): void {
  ipcMain.handle(IPC.ONBOARD_CREATE, async (_event, data: OnboardingData) => {
    const { agentRoot, agentName, agentDescription, userName, timezone, claudeMode, apiKey } = data;

    // Create directories
    const dirs = [
      '',
      'data',
      'brain',
      'skills',
      'logs',
      'scripts',
      '.claude',
      '.claude/agents',
      '.claude/skills',
      '.claude/skills/templates',
    ];
    for (const dir of dirs) {
      const fullPath = join(agentRoot, dir);
      if (!existsSync(fullPath)) mkdirSync(fullPath, { recursive: true });
    }

    // Write identity.yaml
    const identity = {
      agent_name: agentName,
      agent_description: agentDescription,
      timezone,
      heartbeat_interval: '30m',
      server: { port: 3456 },
      claude: {
        mode: claudeMode,
        model: 'opus',
      },
    };
    writeFileSync(join(agentRoot, 'identity.yaml'), yaml.dump(identity, { lineWidth: 120 }), 'utf-8');

    // Write SOUL.md
    writeFileSync(join(agentRoot, 'SOUL.md'), `# ${agentName}\n\n${agentDescription}\n`, 'utf-8');

    // Write USER.md
    writeFileSync(join(agentRoot, 'USER.md'), `# About the User\n\nName: ${userName}\nTimezone: ${timezone}\n`, 'utf-8');

    // Write HEARTBEAT.md
    writeFileSync(join(agentRoot, 'HEARTBEAT.md'), `# HEARTBEAT.md\n\n*My standing instructions. Every 30 minutes I check this file\nand act on whatever is most overdue.*\n\n---\n\n## Tasks\n\n<!-- Add tasks here -->\n`, 'utf-8');

    // Write .env
    const envLines = [];
    if (apiKey) envLines.push(`ANTHROPIC_API_KEY=${apiKey}`);
    envLines.push(`KYBERBOT_API_TOKEN=kb_${randomHex(32)}`);
    writeFileSync(join(agentRoot, '.env'), envLines.join('\n') + '\n', 'utf-8');

    // Store the agent root
    store.setAgentRoot(agentRoot);

    return { ok: true, path: agentRoot };
  });
}

function randomHex(length: number): string {
  const bytes = new Uint8Array(length / 2);
  require('crypto').randomFillSync(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
