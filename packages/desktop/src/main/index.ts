/**
 * KyberBot Desktop — Main Process
 *
 * Creates the Electron window, registers IPC handlers, manages the CLI
 * child process lifecycle, and sets up the system tray.
 */

import { app, BrowserWindow, shell } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { config as dotenvConfig } from 'dotenv';
import { setupIpcHandlers } from './ipc/index.js';
import { LifecycleManager } from './lifecycle.js';
import { AppStore } from './store.js';
import { createTray, updateTrayStatus } from './tray.js';
import { IPC } from '../types/ipc.js';

const store = new AppStore();
const lifecycle = new LifecycleManager(store);

// Load .env from stored agent root
const agentRoot = store.getAgentRoot();
if (agentRoot) {
  dotenvConfig({ path: join(agentRoot, '.env') });
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const bounds = store.getWindowBounds('main');

  mainWindow = new BrowserWindow({
    width: bounds?.width ?? 1100,
    height: bounds?.height ?? 750,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 800,
    minHeight: 500,
    frame: false,
    titleBarStyle: 'hiddenInset',
    transparent: false,
    backgroundColor: '#0a0a0a',
    resizable: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Dev vs prod
  if (process.env.NODE_ENV === 'development' || process.env.ELECTRON_RENDERER_URL) {
    const url = process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173';
    mainWindow.loadURL(url);
  } else {
    mainWindow.loadFile(join(__dirname, '../../dist/index.html'));
  }

  // Persist window bounds on close
  mainWindow.on('close', (e) => {
    if (mainWindow) {
      store.setWindowBounds('main', mainWindow.getBounds());
      // On macOS, hide to tray instead of quitting
      if (process.platform === 'darwin' && !app.isQuitting) {
        e.preventDefault();
        mainWindow.hide();
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Extend app with isQuitting flag for macOS hide-to-tray
declare module 'electron' {
  interface App {
    isQuitting?: boolean;
  }
}

app.whenReady().then(async () => {
  setupIpcHandlers(lifecycle, store, () => mainWindow);
  createWindow();
  createTray(lifecycle, () => mainWindow);

  // Push health updates to renderer
  lifecycle.on('health-update', (health) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.SERVICES_HEALTH_UPDATE, health);
    }
    updateTrayStatus(health.status);
  });

  // Auto-start CLI if agent root is configured
  if (agentRoot && existsSync(join(agentRoot, 'identity.yaml'))) {
    await lifecycle.startCli();
  }

  app.on('activate', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    lifecycle.stopCli().then(() => app.quit());
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  lifecycle.stopCli();
});
