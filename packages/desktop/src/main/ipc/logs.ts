/**
 * Log streaming IPC handlers.
 * Subscribes to lifecycle log events and pushes to renderer.
 */

import { BrowserWindow } from 'electron';
import { IPC } from '../../types/ipc.js';
import { LifecycleManager } from '../lifecycle.js';

export function registerLogHandlers(
  lifecycle: LifecycleManager,
  getMainWindow: () => BrowserWindow | null,
): void {
  lifecycle.on('log-line', (line: string) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.LOGS_LINE, line);
    }
  });
}
