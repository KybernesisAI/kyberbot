/**
 * System tray icon and menu.
 */

import { Tray, Menu, nativeImage, BrowserWindow } from 'electron';
import { join } from 'path';
import { LifecycleManager } from './lifecycle.js';

let tray: Tray | null = null;

export function createTray(
  lifecycle: LifecycleManager,
  getMainWindow: () => BrowserWindow | null,
): void {
  // Use a template image for macOS menu bar
  const iconPath = join(__dirname, '../../resources/tray-icon.png');
  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath);
    icon = icon.resize({ width: 16, height: 16 });
    icon.setTemplateImage(true);
  } catch {
    // Fallback: create a simple icon
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('KyberBot Desktop');

  const buildMenu = () => {
    const isRunning = lifecycle.isRunning();
    return Menu.buildFromTemplate([
      {
        label: 'Show Window',
        click: () => {
          const win = getMainWindow();
          if (win) {
            win.show();
            win.focus();
          }
        },
      },
      { type: 'separator' },
      {
        label: isRunning ? 'Stop KyberBot' : 'Start KyberBot',
        click: async () => {
          if (isRunning) {
            await lifecycle.stopCli();
          } else {
            await lifecycle.startCli();
          }
          tray?.setContextMenu(buildMenu());
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: async () => {
          await lifecycle.stopCli();
          const { app } = require('electron');
          app.quit();
        },
      },
    ]);
  };

  tray.setContextMenu(buildMenu());

  // Rebuild menu when status changes
  lifecycle.on('status-change', () => {
    tray?.setContextMenu(buildMenu());
  });

  // Click to show window
  tray.on('click', () => {
    const win = getMainWindow();
    if (win) {
      win.show();
      win.focus();
    }
  });
}

export function updateTrayStatus(status: string): void {
  if (!tray) return;
  const statusLabel = status === 'ok' ? 'Running' : status === 'degraded' ? 'Degraded' : 'Offline';
  tray.setToolTip(`KyberBot Desktop — ${statusLabel}`);
}
