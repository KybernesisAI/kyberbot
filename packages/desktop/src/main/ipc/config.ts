/**
 * Configuration IPC handlers.
 * Reads/writes identity.yaml and .env from the agent root.
 */

import { ipcMain, dialog, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { config as dotenvParse } from 'dotenv';
import { IPC, IdentityConfig, EnvConfig } from '../../types/ipc.js';
import { AppStore } from '../store.js';

export function registerConfigHandlers(store: AppStore): void {
  // Directory picker for selecting agent root
  ipcMain.handle('config:selectAgentRoot', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win!, {
      title: 'Select Agent Directory',
      message: 'Choose the directory containing your KyberBot agent (must have identity.yaml)',
      properties: ['openDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) return null;

    const dir = result.filePaths[0];
    const hasIdentity = existsSync(join(dir, 'identity.yaml'));

    if (hasIdentity) {
      store.setAgentRoot(dir);
    }

    return { path: dir, hasIdentity };
  });
  ipcMain.handle(IPC.CONFIG_GET_AGENT_ROOT, () => {
    return store.getAgentRoot();
  });

  ipcMain.handle(IPC.CONFIG_SET_AGENT_ROOT, (_event, path: string) => {
    store.setAgentRoot(path);
    return { ok: true };
  });

  ipcMain.handle(IPC.CONFIG_GET_API_TOKEN, () => {
    const root = store.getAgentRoot();
    if (!root) return null;
    const envPath = join(root, '.env');
    if (!existsSync(envPath)) return null;
    // Parse .env file directly instead of relying on dotenv.config()
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('KYBERBOT_API_TOKEN=')) {
        let value = trimmed.slice('KYBERBOT_API_TOKEN='.length).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        return value;
      }
    }
    return process.env.KYBERBOT_API_TOKEN ?? null;
  });

  ipcMain.handle(IPC.CONFIG_GET_SERVER_URL, () => {
    const root = store.getAgentRoot();
    let port = 3456;
    if (root) {
      try {
        const identityPath = join(root, 'identity.yaml');
        const identity = yaml.load(readFileSync(identityPath, 'utf-8')) as Record<string, any>;
        port = identity?.server?.port ?? 3456;
      } catch { /* use default */ }
    }
    return `http://localhost:${port}`;
  });

  ipcMain.handle(IPC.CONFIG_READ_IDENTITY, () => {
    const root = store.getAgentRoot();
    if (!root) return null;
    try {
      const identityPath = join(root, 'identity.yaml');
      return yaml.load(readFileSync(identityPath, 'utf-8')) as IdentityConfig;
    } catch {
      return null;
    }
  });

  ipcMain.handle(IPC.CONFIG_WRITE_IDENTITY, (_event, changes: Partial<IdentityConfig>) => {
    const root = store.getAgentRoot();
    if (!root) throw new Error('Agent root not configured');
    const identityPath = join(root, 'identity.yaml');
    const current = yaml.load(readFileSync(identityPath, 'utf-8')) as Record<string, unknown>;
    Object.assign(current, changes);
    writeFileSync(identityPath, yaml.dump(current, { lineWidth: 120 }), 'utf-8');
    return { ok: true };
  });

  ipcMain.handle(IPC.CONFIG_READ_ENV, () => {
    const root = store.getAgentRoot();
    if (!root) return {};
    const envPath = join(root, '.env');
    if (!existsSync(envPath)) return {};
    const content = readFileSync(envPath, 'utf-8');
    const result: EnvConfig = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        result[key] = value;
      }
    }
    return result;
  });

  ipcMain.handle(IPC.CONFIG_WRITE_ENV, (_event, env: EnvConfig) => {
    const root = store.getAgentRoot();
    if (!root) throw new Error('Agent root not configured');
    const envPath = join(root, '.env');
    const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    writeFileSync(envPath, lines.join('\n') + '\n', 'utf-8');
    return { ok: true };
  });
}
