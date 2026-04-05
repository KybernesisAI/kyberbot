"use strict";
const electron = require("electron");
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const child_process = require("child_process");
const yaml = require("js-yaml");
const events = require("events");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const yaml__namespace = /* @__PURE__ */ _interopNamespaceDefault(yaml);
const IPC = {
  // Window controls (fire-and-forget)
  WINDOW_MINIMIZE: "window:minimize",
  WINDOW_MAXIMIZE: "window:maximize",
  WINDOW_CLOSE: "window:close",
  // Prerequisites (invoke/handle)
  PREREQ_CHECK: "prerequisites:check",
  // Services (invoke/handle + push)
  SERVICES_START: "services:start",
  SERVICES_STOP: "services:stop",
  SERVICES_STATUS: "services:status",
  SERVICES_HEALTH_UPDATE: "services:health-update",
  // Config (invoke/handle)
  CONFIG_GET_AGENT_ROOT: "config:getAgentRoot",
  CONFIG_SET_AGENT_ROOT: "config:setAgentRoot",
  CONFIG_GET_API_TOKEN: "config:getApiToken",
  CONFIG_GET_SERVER_URL: "config:getServerUrl",
  CONFIG_READ_IDENTITY: "config:readIdentity",
  CONFIG_WRITE_IDENTITY: "config:writeIdentity",
  CONFIG_READ_ENV: "config:readEnv",
  CONFIG_WRITE_ENV: "config:writeEnv",
  // Logs (push from main)
  LOGS_LINE: "logs:line",
  // Onboarding (invoke/handle)
  ONBOARD_CREATE: "onboard:create"
};
function registerPrerequisiteHandlers(store2) {
  electron.ipcMain.handle(IPC.PREREQ_CHECK, async () => {
    const docker = checkDocker();
    const claude = checkClaude();
    const agentRoot2 = checkAgentRoot(store2);
    return { docker, claude, agentRoot: agentRoot2 };
  });
}
function checkDocker() {
  try {
    const version = child_process.execSync("docker --version", { encoding: "utf-8", timeout: 5e3 }).trim();
    try {
      child_process.execSync("docker info", { encoding: "utf-8", timeout: 1e4, stdio: "pipe" });
      return { installed: true, running: true, version };
    } catch {
      return { installed: true, running: false, version };
    }
  } catch {
    return { installed: false, running: false, version: null };
  }
}
function checkClaude() {
  try {
    const version = child_process.execSync("claude --version", { encoding: "utf-8", timeout: 5e3 }).trim();
    return { installed: true, version };
  } catch {
    return { installed: false, version: null };
  }
}
function checkAgentRoot(store2) {
  const path$1 = store2.getAgentRoot();
  if (!path$1) return { configured: false, path: null, hasIdentity: false };
  const hasIdentity = fs.existsSync(path.join(path$1, "identity.yaml"));
  return { configured: true, path: path$1, hasIdentity };
}
function registerServiceHandlers(lifecycle2) {
  electron.ipcMain.handle(IPC.SERVICES_START, async () => {
    await lifecycle2.startCli();
    return { ok: true };
  });
  electron.ipcMain.handle(IPC.SERVICES_STOP, async () => {
    await lifecycle2.stopCli();
    return { ok: true };
  });
  electron.ipcMain.handle(IPC.SERVICES_STATUS, () => {
    return {
      status: lifecycle2.status,
      health: lifecycle2.getHealth()
    };
  });
}
function registerConfigHandlers(store2) {
  electron.ipcMain.handle("config:selectAgentRoot", async (event) => {
    const win = electron.BrowserWindow.fromWebContents(event.sender);
    const result = await electron.dialog.showOpenDialog(win, {
      title: "Select Agent Directory",
      message: "Choose the directory containing your KyberBot agent (must have identity.yaml)",
      properties: ["openDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const dir = result.filePaths[0];
    const hasIdentity = fs.existsSync(path.join(dir, "identity.yaml"));
    if (hasIdentity) {
      store2.setAgentRoot(dir);
    }
    return { path: dir, hasIdentity };
  });
  electron.ipcMain.handle(IPC.CONFIG_GET_AGENT_ROOT, () => {
    return store2.getAgentRoot();
  });
  electron.ipcMain.handle(IPC.CONFIG_SET_AGENT_ROOT, (_event, path2) => {
    store2.setAgentRoot(path2);
    return { ok: true };
  });
  electron.ipcMain.handle(IPC.CONFIG_GET_API_TOKEN, () => {
    const root = store2.getAgentRoot();
    if (!root) return null;
    const envPath = path.join(root, ".env");
    if (!fs.existsSync(envPath)) return null;
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("KYBERBOT_API_TOKEN=")) {
        let value = trimmed.slice("KYBERBOT_API_TOKEN=".length).trim();
        if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
          value = value.slice(1, -1);
        }
        return value;
      }
    }
    return process.env.KYBERBOT_API_TOKEN ?? null;
  });
  electron.ipcMain.handle(IPC.CONFIG_GET_SERVER_URL, () => {
    const root = store2.getAgentRoot();
    let port = 3456;
    if (root) {
      try {
        const identityPath = path.join(root, "identity.yaml");
        const identity = yaml__namespace.load(fs.readFileSync(identityPath, "utf-8"));
        port = identity?.server?.port ?? 3456;
      } catch {
      }
    }
    return `http://localhost:${port}`;
  });
  electron.ipcMain.handle(IPC.CONFIG_READ_IDENTITY, () => {
    const root = store2.getAgentRoot();
    if (!root) return null;
    try {
      const identityPath = path.join(root, "identity.yaml");
      return yaml__namespace.load(fs.readFileSync(identityPath, "utf-8"));
    } catch {
      return null;
    }
  });
  electron.ipcMain.handle(IPC.CONFIG_WRITE_IDENTITY, (_event, changes) => {
    const root = store2.getAgentRoot();
    if (!root) throw new Error("Agent root not configured");
    const identityPath = path.join(root, "identity.yaml");
    const current = yaml__namespace.load(fs.readFileSync(identityPath, "utf-8"));
    Object.assign(current, changes);
    fs.writeFileSync(identityPath, yaml__namespace.dump(current, { lineWidth: 120 }), "utf-8");
    return { ok: true };
  });
  electron.ipcMain.handle(IPC.CONFIG_READ_ENV, () => {
    const root = store2.getAgentRoot();
    if (!root) return {};
    const envPath = path.join(root, ".env");
    if (!fs.existsSync(envPath)) return {};
    const content = fs.readFileSync(envPath, "utf-8");
    const result = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
          value = value.slice(1, -1);
        }
        result[key] = value;
      }
    }
    return result;
  });
  electron.ipcMain.handle(IPC.CONFIG_WRITE_ENV, (_event, env) => {
    const root = store2.getAgentRoot();
    if (!root) throw new Error("Agent root not configured");
    const envPath = path.join(root, ".env");
    const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf-8");
    return { ok: true };
  });
}
function registerLogHandlers(lifecycle2, getMainWindow) {
  lifecycle2.on("log-line", (line) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.LOGS_LINE, line);
    }
  });
}
function registerOnboardingHandlers(store2) {
  electron.ipcMain.handle(IPC.ONBOARD_CREATE, async (_event, data) => {
    const { agentRoot: agentRoot2, agentName, agentDescription, userName, timezone, claudeMode, apiKey } = data;
    const dirs = [
      "",
      "data",
      "brain",
      "skills",
      "logs",
      "scripts",
      ".claude",
      ".claude/agents",
      ".claude/skills",
      ".claude/skills/templates"
    ];
    for (const dir of dirs) {
      const fullPath = path.join(agentRoot2, dir);
      if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
    }
    const identity = {
      agent_name: agentName,
      agent_description: agentDescription,
      timezone,
      heartbeat_interval: "30m",
      server: { port: 3456 },
      claude: {
        mode: claudeMode,
        model: "opus"
      }
    };
    fs.writeFileSync(path.join(agentRoot2, "identity.yaml"), yaml__namespace.dump(identity, { lineWidth: 120 }), "utf-8");
    fs.writeFileSync(path.join(agentRoot2, "SOUL.md"), `# ${agentName}

${agentDescription}
`, "utf-8");
    fs.writeFileSync(path.join(agentRoot2, "USER.md"), `# About the User

Name: ${userName}
Timezone: ${timezone}
`, "utf-8");
    fs.writeFileSync(path.join(agentRoot2, "HEARTBEAT.md"), `# HEARTBEAT.md

*My standing instructions. Every 30 minutes I check this file
and act on whatever is most overdue.*

---

## Tasks

<!-- Add tasks here -->
`, "utf-8");
    const envLines = [];
    if (apiKey) envLines.push(`ANTHROPIC_API_KEY=${apiKey}`);
    envLines.push(`KYBERBOT_API_TOKEN=kb_${randomHex(32)}`);
    fs.writeFileSync(path.join(agentRoot2, ".env"), envLines.join("\n") + "\n", "utf-8");
    store2.setAgentRoot(agentRoot2);
    return { ok: true, path: agentRoot2 };
  });
}
function randomHex(length) {
  const bytes = new Uint8Array(length / 2);
  require("crypto").randomFillSync(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function setupIpcHandlers(lifecycle2, store2, getMainWindow) {
  electron.ipcMain.on(IPC.WINDOW_MINIMIZE, (event) => {
    electron.BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  electron.ipcMain.on(IPC.WINDOW_MAXIMIZE, (event) => {
    const win = electron.BrowserWindow.fromWebContents(event.sender);
    win?.isMaximized() ? win.unmaximize() : win?.maximize();
  });
  electron.ipcMain.on(IPC.WINDOW_CLOSE, (event) => {
    electron.BrowserWindow.fromWebContents(event.sender)?.close();
  });
  registerPrerequisiteHandlers(store2);
  registerServiceHandlers(lifecycle2);
  registerConfigHandlers(store2);
  registerLogHandlers(lifecycle2, getMainWindow);
  registerOnboardingHandlers(store2);
}
class LifecycleManager extends events.EventEmitter {
  store;
  process = null;
  _status = "stopped";
  healthTimer = null;
  lastHealth = null;
  logStream = null;
  stdoutBuffer = [];
  MAX_BUFFER_LINES = 1e3;
  restartCount = 0;
  MAX_RESTARTS = 10;
  constructor(store2) {
    super();
    this.store = store2;
  }
  get status() {
    return this._status;
  }
  getHealth() {
    return this.lastHealth;
  }
  isRunning() {
    return this._status === "running" || this._status === "starting";
  }
  getRecentLogs() {
    return [...this.stdoutBuffer];
  }
  async startCli() {
    if (this.process) return;
    try {
      const port = this.getServerPort();
      const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2e3) });
      if (res.ok) {
        console.log("[lifecycle] Server already running on port", port, "— attaching");
        this._status = "running";
        this.emit("status-change", this._status);
        this.startHealthPolling();
        return;
      }
    } catch {
    }
    this.restartCount = 0;
    this.spawnProcess();
  }
  async stopCli() {
    if (!this.process) return;
    this._status = "stopping";
    this.emit("status-change", this._status);
    this.stopHealthPolling();
    this.process.kill("SIGTERM");
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) this.process.kill("SIGKILL");
        resolve();
      }, 1e4);
      this.process?.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.process = null;
    this.logStream?.end();
    this.logStream = null;
    this._status = "stopped";
    this.emit("status-change", this._status);
  }
  spawnProcess() {
    const agentRoot2 = this.store.getAgentRoot();
    if (!agentRoot2) throw new Error("Agent root not configured");
    this._status = "starting";
    this.emit("status-change", this._status);
    const cliPath = this.resolveCliPath();
    const logDir = path.join(agentRoot2, "logs");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, "desktop-cli.log");
    this.logStream = fs.createWriteStream(logPath, { flags: "a" });
    this.process = child_process.spawn(cliPath, ["run"], {
      cwd: agentRoot2,
      env: {
        ...process.env,
        KYBERBOT_ROOT: agentRoot2,
        KYBERBOT_CHILD: "1",
        // Disables CLI's built-in watchdog (run.ts:64)
        NODE_ENV: "production",
        PATH: process.env.PATH
        // Ensure node is on PATH for the shebang
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });
    this.process.stdout?.on("data", (data) => {
      const lines = data.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        this.pushLogLine(line);
        this.logStream?.write(line + "\n");
      }
    });
    this.process.stderr?.on("data", (data) => {
      const lines = data.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        this.pushLogLine(`[stderr] ${line}`);
        this.logStream?.write(`[stderr] ${line}
`);
      }
    });
    this.process.on("error", (error) => {
      this._status = "crashed";
      this.emit("status-change", this._status);
      this.emit("error", error.message);
    });
    this.process.on("exit", (code) => {
      this.process = null;
      this.logStream?.end();
      this.logStream = null;
      if (this._status === "stopping") {
        this._status = "stopped";
        this.emit("status-change", this._status);
        return;
      }
      this._status = "crashed";
      this.emit("status-change", this._status);
      this.emit("error", `CLI exited with code ${code}`);
      if (code !== 0 && this.restartCount < this.MAX_RESTARTS) {
        this.restartCount++;
        const delay = this.restartCount > 3 ? 1e4 : 2e3;
        setTimeout(() => this.spawnProcess(), delay);
      }
    });
    setTimeout(() => this.startHealthPolling(), 3e3);
  }
  startHealthPolling() {
    this.stopHealthPolling();
    const poll = async () => {
      try {
        const port = this.getServerPort();
        const response = await fetch(`http://localhost:${port}/health`, {
          signal: AbortSignal.timeout(5e3)
        });
        const data = await response.json();
        this.lastHealth = data;
        if (this._status === "starting") {
          this._status = "running";
          this.emit("status-change", this._status);
        }
        this.emit("health-update", data);
      } catch {
        if (this._status === "running") {
          const offlineHealth = {
            status: "offline",
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            uptime: "0s",
            channels: [],
            services: [],
            errors: 0,
            memory: {},
            pid: 0,
            node_version: ""
          };
          this.lastHealth = offlineHealth;
          this.emit("health-update", offlineHealth);
        }
      }
    };
    poll();
    this.healthTimer = setInterval(poll, 5e3);
  }
  stopHealthPolling() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }
  getServerPort() {
    const agentRoot2 = this.store.getAgentRoot();
    if (!agentRoot2) return 3456;
    try {
      const yaml2 = require("js-yaml");
      const fs2 = require("fs");
      const identity = yaml2.load(fs2.readFileSync(path.join(agentRoot2, "identity.yaml"), "utf-8"));
      return identity?.server?.port ?? 3456;
    } catch {
      return 3456;
    }
  }
  resolveCliPath() {
    try {
      const globalPath = child_process.execSync("which kyberbot", { encoding: "utf-8" }).trim();
      if (globalPath) return globalPath;
    } catch {
    }
    const agentRoot2 = this.store.getAgentRoot();
    const localCli = path.join(agentRoot2, "node_modules", "@kyberbot", "cli", "dist", "index.js");
    if (fs.existsSync(localCli)) return localCli;
    throw new Error("kyberbot CLI not found. Install with: npm install -g @kyberbot/cli");
  }
  pushLogLine(line) {
    this.stdoutBuffer.push(line);
    if (this.stdoutBuffer.length > this.MAX_BUFFER_LINES) {
      this.stdoutBuffer.shift();
    }
    this.emit("log-line", line);
  }
}
const DEFAULTS = {
  agentRoot: null,
  windowBounds: {},
  autoStart: true
};
class AppStore {
  data;
  filePath;
  constructor() {
    const userDataPath = electron.app.getPath("userData");
    if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
    this.filePath = path.join(userDataPath, "settings.json");
    try {
      this.data = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
    } catch {
      this.data = { ...DEFAULTS };
    }
  }
  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
  }
  getAgentRoot() {
    return this.data.agentRoot ?? null;
  }
  setAgentRoot(path2) {
    this.data.agentRoot = path2;
    this.save();
  }
  getWindowBounds(name) {
    return this.data.windowBounds?.[name];
  }
  setWindowBounds(name, rect) {
    if (!this.data.windowBounds) this.data.windowBounds = {};
    this.data.windowBounds[name] = rect;
    this.save();
  }
  getAutoStart() {
    return this.data.autoStart ?? true;
  }
  setAutoStart(value) {
    this.data.autoStart = value;
    this.save();
  }
}
let tray = null;
function createTray(lifecycle2, getMainWindow) {
  const iconPath = path.join(__dirname, "../../resources/tray-icon.png");
  let icon;
  try {
    icon = electron.nativeImage.createFromPath(iconPath);
    icon = icon.resize({ width: 16, height: 16 });
    icon.setTemplateImage(true);
  } catch {
    icon = electron.nativeImage.createEmpty();
  }
  tray = new electron.Tray(icon);
  tray.setToolTip("KyberBot Desktop");
  const buildMenu = () => {
    const isRunning = lifecycle2.isRunning();
    return electron.Menu.buildFromTemplate([
      {
        label: "Show Window",
        click: () => {
          const win = getMainWindow();
          if (win) {
            win.show();
            win.focus();
          }
        }
      },
      { type: "separator" },
      {
        label: isRunning ? "Stop KyberBot" : "Start KyberBot",
        click: async () => {
          if (isRunning) {
            await lifecycle2.stopCli();
          } else {
            await lifecycle2.startCli();
          }
          tray?.setContextMenu(buildMenu());
        }
      },
      { type: "separator" },
      {
        label: "Quit",
        click: async () => {
          await lifecycle2.stopCli();
          const { app } = require("electron");
          app.quit();
        }
      }
    ]);
  };
  tray.setContextMenu(buildMenu());
  lifecycle2.on("status-change", () => {
    tray?.setContextMenu(buildMenu());
  });
  tray.on("click", () => {
    const win = getMainWindow();
    if (win) {
      win.show();
      win.focus();
    }
  });
}
function updateTrayStatus(status) {
  if (!tray) return;
  const statusLabel = status === "ok" ? "Running" : status === "degraded" ? "Degraded" : "Offline";
  tray.setToolTip(`KyberBot Desktop — ${statusLabel}`);
}
const store = new AppStore();
const lifecycle = new LifecycleManager(store);
const agentRoot = store.getAgentRoot();
if (agentRoot) {
  dotenv.config({ path: path.join(agentRoot, ".env") });
}
let mainWindow = null;
function createWindow() {
  const bounds = store.getWindowBounds("main");
  mainWindow = new electron.BrowserWindow({
    width: bounds?.width ?? 1100,
    height: bounds?.height ?? 750,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 800,
    minHeight: 500,
    frame: false,
    titleBarStyle: "hiddenInset",
    transparent: false,
    backgroundColor: "#0a0a0a",
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false
      // Allow renderer to fetch from localhost:3456 (local server)
    }
  });
  if (process.env.NODE_ENV === "development" || process.env.ELECTRON_RENDERER_URL) {
    const url = process.env.ELECTRON_RENDERER_URL || "http://localhost:5173";
    mainWindow.loadURL(url);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  }
  mainWindow.on("close", (e) => {
    if (mainWindow) {
      store.setWindowBounds("main", mainWindow.getBounds());
      if (process.platform === "darwin" && !electron.app.isQuitting) {
        e.preventDefault();
        mainWindow.hide();
      }
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    electron.shell.openExternal(url);
    return { action: "deny" };
  });
}
const gotTheLock = electron.app.requestSingleInstanceLock();
if (!gotTheLock) {
  electron.app.quit();
} else {
  electron.app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
electron.app.whenReady().then(async () => {
  setupIpcHandlers(lifecycle, store, () => mainWindow);
  createWindow();
  createTray(lifecycle, () => mainWindow);
  lifecycle.on("error", (message) => {
    console.error("[lifecycle] Error:", message);
  });
  lifecycle.on("status-change", (status) => {
    console.log("[lifecycle] Status:", status);
  });
  lifecycle.on("health-update", (health) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.SERVICES_HEALTH_UPDATE, health);
    }
    updateTrayStatus(health.status);
  });
  if (agentRoot && fs.existsSync(path.join(agentRoot, "identity.yaml"))) {
    await lifecycle.startCli();
  }
  electron.app.on("activate", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    lifecycle.stopCli().then(() => electron.app.quit());
  }
});
electron.app.on("before-quit", () => {
  electron.app.isQuitting = true;
  lifecycle.stopCli();
});
