/**
 * KyberBot — Channel Interface
 *
 * Defines the contract for messaging channel bridges.
 */

export interface ChannelMessage {
  id: string;
  channelType: string;
  from: string;
  text: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface ChannelConfig {
  enabled: boolean;
  [key: string]: unknown;
}

export interface Channel {
  /** Channel identifier (e.g., 'telegram', 'whatsapp') */
  readonly name: string;

  /** Initialize the channel connection */
  start(): Promise<void>;

  /** Gracefully shut down the channel */
  stop(): Promise<void>;

  /** Send a message through the channel */
  send(to: string, message: string): Promise<void>;

  /** Whether the channel is currently connected */
  isConnected(): boolean;

  /** Register a handler for incoming messages */
  onMessage(handler: (message: ChannelMessage) => Promise<void>): void;
}
