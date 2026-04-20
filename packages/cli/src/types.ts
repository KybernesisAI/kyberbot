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
  /**
   * Model used for heartbeat and orchestration (CEO/worker) Claude calls.
   * Defaults to 'sonnet' if unset — heartbeat is tool-use orchestration,
   * not deep reasoning, so running Opus there is wasteful. The agent's
   * main chat still uses `claude.model` (Opus by default).
   */
  heartbeat_model?: 'haiku' | 'sonnet' | 'opus';
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
  backup?: {
    enabled: boolean;
    remote_url: string;
    schedule: string;
    branch?: string;
  };
  claude?: {
    mode: 'subscription' | 'sdk';
    model?: string;
  };
  memory?: {
    entity_stoplist?: string[];
  };
  subscriptions?: Array<{
    from: string;
    topic: string;
  }>;
  watched_folders?: Array<{
    path: string;
    label?: string;
    enabled?: boolean;
    extensions?: string[];
  }>;
}
