/**
 * Shared IPC channel names and payload types.
 * Used by main process, preload, and renderer.
 */

export const IPC = {
  // Window controls (fire-and-forget)
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',

  // Prerequisites (invoke/handle)
  PREREQ_CHECK: 'prerequisites:check',

  // Services (invoke/handle + push)
  SERVICES_START: 'services:start',
  SERVICES_STOP: 'services:stop',
  SERVICES_STATUS: 'services:status',
  SERVICES_HEALTH_UPDATE: 'services:health-update',

  // Config (invoke/handle)
  CONFIG_GET_AGENT_ROOT: 'config:getAgentRoot',
  CONFIG_SET_AGENT_ROOT: 'config:setAgentRoot',
  CONFIG_GET_API_TOKEN: 'config:getApiToken',
  CONFIG_GET_SERVER_URL: 'config:getServerUrl',
  CONFIG_READ_IDENTITY: 'config:readIdentity',
  CONFIG_WRITE_IDENTITY: 'config:writeIdentity',
  CONFIG_READ_ENV: 'config:readEnv',
  CONFIG_WRITE_ENV: 'config:writeEnv',

  // Logs (push from main)
  LOGS_LINE: 'logs:line',
  LOGS_START: 'logs:start',
  LOGS_STOP: 'logs:stop',

  // Onboarding (invoke/handle)
  ONBOARD_CREATE: 'onboard:create',
  ONBOARD_STATUS: 'onboard:status',
} as const;

// ── Payload Types ──

export interface PrerequisiteStatus {
  docker: { installed: boolean; running: boolean; version: string | null };
  claude: { installed: boolean; version: string | null };
  agentRoot: { configured: boolean; path: string | null; hasIdentity: boolean };
}

export interface HealthData {
  status: 'ok' | 'degraded' | 'offline';
  timestamp: string;
  uptime: string;
  channels: Array<{ name: string; connected: boolean }>;
  services: Array<{ name: string; status: string }>;
  errors: number;
  memory: Record<string, unknown>;
  pid: number;
  node_version: string;
}

export interface IdentityConfig {
  agent_name: string;
  agent_description?: string;
  timezone: string;
  heartbeat_interval: string;
  heartbeat_active_hours?: { start: string; end: string; timezone?: string };
  server?: { port: number };
  channels?: {
    telegram?: { bot_token: string; owner_chat_id?: number };
    whatsapp?: { enabled: boolean };
  };
  claude?: { mode: 'subscription' | 'sdk'; model?: string };
  tunnel?: { enabled: boolean };
  backup?: { enabled: boolean; remote_url: string; schedule: string; branch?: string };
}

export interface EnvConfig {
  [key: string]: string;
}
