/**
 * KyberBot — Shared Types
 *
 * Core type definitions used across the application.
 */

export interface ServiceStatus {
  name: string;
  status: 'running' | 'starting' | 'stopped' | 'error' | 'disabled';
  extra?: string;
}

export interface ServiceHandle {
  stop: () => Promise<void>;
  status: () => ServiceStatus['status'];
}

export interface ServiceConfig {
  name: string;
  enabled: boolean;
  start: () => Promise<ServiceHandle>;
}

export interface IdentityConfig {
  agent_name: string;
  agent_description?: string;
  kyberbot_version?: string;
  timezone: string;
  locale?: string;
  heartbeat_interval: string;
  heartbeat_active_hours?: {
    start: string;
    end: string;
    timezone?: string;
  };
  server?: {
    port: number;
    host?: string;
  };
  channels?: {
    telegram?: {
      bot_token: string;
      owner_chat_id?: number;
    };
    whatsapp?: { enabled: boolean };
  };
  kybernesis?: {
    agent_id: string;
    workspace_id: string;
  };
  tunnel?: {
    enabled: boolean;
    provider?: string;
  };
  claude?: {
    mode: 'subscription' | 'sdk';
    model?: string;
  };
}
