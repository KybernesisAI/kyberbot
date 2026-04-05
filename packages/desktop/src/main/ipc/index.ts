/**
 * Central IPC handler registration.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { IPC } from '../../types/ipc.js';
import { LifecycleManager } from '../lifecycle.js';
import { AppStore } from '../store.js';
import { registerPrerequisiteHandlers } from './prerequisites.js';
import { registerServiceHandlers } from './services.js';
import { registerConfigHandlers } from './config.js';
import { registerLogHandlers } from './logs.js';
import { registerOnboardingHandlers } from './onboarding.js';

export function setupIpcHandlers(
  lifecycle: LifecycleManager,
  store: AppStore,
  getMainWindow: () => BrowserWindow | null,
): void {
  // Window controls (fire-and-forget)
  ipcMain.on(IPC.WINDOW_MINIMIZE, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.on(IPC.WINDOW_MAXIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.isMaximized() ? win.unmaximize() : win?.maximize();
  });
  ipcMain.on(IPC.WINDOW_CLOSE, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  // Domain handlers
  registerPrerequisiteHandlers(store);
  registerServiceHandlers(lifecycle);
  registerConfigHandlers(store);
  registerLogHandlers(lifecycle, getMainWindow);
  registerOnboardingHandlers(store);
}
