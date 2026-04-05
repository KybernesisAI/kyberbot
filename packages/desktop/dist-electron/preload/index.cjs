"use strict";
const electron = require("electron");
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
const api = {
  window: {
    minimize: () => electron.ipcRenderer.send(IPC.WINDOW_MINIMIZE),
    maximize: () => electron.ipcRenderer.send(IPC.WINDOW_MAXIMIZE),
    close: () => electron.ipcRenderer.send(IPC.WINDOW_CLOSE)
  },
  prerequisites: {
    check: () => electron.ipcRenderer.invoke(IPC.PREREQ_CHECK)
  },
  services: {
    start: () => electron.ipcRenderer.invoke(IPC.SERVICES_START),
    stop: () => electron.ipcRenderer.invoke(IPC.SERVICES_STOP),
    getStatus: () => electron.ipcRenderer.invoke(IPC.SERVICES_STATUS),
    onHealthUpdate: (callback) => {
      const handler = (_event, health) => callback(health);
      electron.ipcRenderer.on(IPC.SERVICES_HEALTH_UPDATE, handler);
      return () => electron.ipcRenderer.removeListener(IPC.SERVICES_HEALTH_UPDATE, handler);
    }
  },
  config: {
    getAgentRoot: () => electron.ipcRenderer.invoke(IPC.CONFIG_GET_AGENT_ROOT),
    setAgentRoot: (path) => electron.ipcRenderer.invoke(IPC.CONFIG_SET_AGENT_ROOT, path),
    selectAgentRoot: () => electron.ipcRenderer.invoke("config:selectAgentRoot"),
    getApiToken: () => electron.ipcRenderer.invoke(IPC.CONFIG_GET_API_TOKEN),
    getServerUrl: () => electron.ipcRenderer.invoke(IPC.CONFIG_GET_SERVER_URL),
    readIdentity: () => electron.ipcRenderer.invoke(IPC.CONFIG_READ_IDENTITY),
    writeIdentity: (changes) => electron.ipcRenderer.invoke(IPC.CONFIG_WRITE_IDENTITY, changes),
    readEnv: () => electron.ipcRenderer.invoke(IPC.CONFIG_READ_ENV),
    writeEnv: (env) => electron.ipcRenderer.invoke(IPC.CONFIG_WRITE_ENV, env)
  },
  logs: {
    onLine: (callback) => {
      const handler = (_event, line) => callback(line);
      electron.ipcRenderer.on(IPC.LOGS_LINE, handler);
      return () => electron.ipcRenderer.removeListener(IPC.LOGS_LINE, handler);
    }
  },
  onboarding: {
    create: (data) => electron.ipcRenderer.invoke(IPC.ONBOARD_CREATE, data)
  }
};
electron.contextBridge.exposeInMainWorld("kyberbot", api);
