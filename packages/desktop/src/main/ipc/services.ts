/**
 * Service lifecycle IPC handlers.
 * Proxies to the LifecycleManager for start/stop/status.
 */

import { ipcMain } from 'electron';
import { IPC } from '../../types/ipc.js';
import { LifecycleManager } from '../lifecycle.js';

export function registerServiceHandlers(lifecycle: LifecycleManager): void {
  ipcMain.handle(IPC.SERVICES_START, async () => {
    await lifecycle.startCli();
    return { ok: true };
  });

  ipcMain.handle(IPC.SERVICES_STOP, async () => {
    await lifecycle.stopCli();
    return { ok: true };
  });

  ipcMain.handle(IPC.SERVICES_STATUS, () => {
    return {
      status: lifecycle.status,
      health: lifecycle.getHealth(),
    };
  });
}
