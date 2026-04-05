/**
 * Preload — contextBridge exposing window.kyberbot
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../types/ipc.js';
import type { PrerequisiteStatus, HealthData, IdentityConfig, EnvConfig } from '../types/ipc.js';

const api = {
  window: {
    minimize: () => ipcRenderer.send(IPC.WINDOW_MINIMIZE),
    maximize: () => ipcRenderer.send(IPC.WINDOW_MAXIMIZE),
    close: () => ipcRenderer.send(IPC.WINDOW_CLOSE),
  },

  prerequisites: {
    check: (): Promise<PrerequisiteStatus> => ipcRenderer.invoke(IPC.PREREQ_CHECK),
  },

  services: {
    start: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.SERVICES_START),
    stop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.SERVICES_STOP),
    getStatus: (): Promise<{ status: string; health: HealthData | null }> =>
      ipcRenderer.invoke(IPC.SERVICES_STATUS),
    onHealthUpdate: (callback: (health: HealthData) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, health: HealthData) => callback(health);
      ipcRenderer.on(IPC.SERVICES_HEALTH_UPDATE, handler);
      return () => ipcRenderer.removeListener(IPC.SERVICES_HEALTH_UPDATE, handler);
    },
  },

  config: {
    getAgentRoot: (): Promise<string | null> => ipcRenderer.invoke(IPC.CONFIG_GET_AGENT_ROOT),
    setAgentRoot: (path: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.CONFIG_SET_AGENT_ROOT, path),
    selectAgentRoot: (): Promise<{ path: string; hasIdentity: boolean } | null> =>
      ipcRenderer.invoke('config:selectAgentRoot'),
    getApiToken: (): Promise<string | null> => ipcRenderer.invoke(IPC.CONFIG_GET_API_TOKEN),
    getServerUrl: (): Promise<string> => ipcRenderer.invoke(IPC.CONFIG_GET_SERVER_URL),
    readIdentity: (): Promise<IdentityConfig | null> => ipcRenderer.invoke(IPC.CONFIG_READ_IDENTITY),
    writeIdentity: (changes: Partial<IdentityConfig>): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.CONFIG_WRITE_IDENTITY, changes),
    readEnv: (): Promise<EnvConfig> => ipcRenderer.invoke(IPC.CONFIG_READ_ENV),
    writeEnv: (env: EnvConfig): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.CONFIG_WRITE_ENV, env),
  },

  logs: {
    onLine: (callback: (line: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, line: string) => callback(line);
      ipcRenderer.on(IPC.LOGS_LINE, handler);
      return () => ipcRenderer.removeListener(IPC.LOGS_LINE, handler);
    },
  },

  onboarding: {
    create: (data: {
      agentRoot: string;
      agentName: string;
      agentDescription: string;
      userName: string;
      timezone: string;
      claudeMode: 'subscription' | 'sdk';
      apiKey?: string;
    }): Promise<{ ok: boolean; path: string }> => ipcRenderer.invoke(IPC.ONBOARD_CREATE, data),
  },
};

contextBridge.exposeInMainWorld('kyberbot', api);

// Type declaration for renderer
export type KyberbotAPI = typeof api;
