/**
 * KyberBot — Agent Bus
 *
 * In-process message bus for inter-agent communication.
 * Agents register handlers and can send messages to each other.
 *
 * Phase 5 wires actual message handling. This stub exists from Phase 3
 * so AgentRuntime can hold a reference without rebuilds later.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { createLogger } from '../logger.js';

const logger = createLogger('agent-bus');

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface AgentMessage {
  id: string;
  from: string;
  to: string; // agent name or '*' for broadcast
  type: 'query' | 'notify' | 'delegate' | 'response';
  topic?: string;
  payload: string;
  replyTo?: string;
  timestamp: string;
}

export type AgentMessageHandler = (msg: AgentMessage) => Promise<string>;

// ═══════════════════════════════════════════════════════════════════════════════
// BUS
// ═══════════════════════════════════════════════════════════════════════════════

export class AgentBus extends EventEmitter {
  private history: AgentMessage[] = [];
  private handlers = new Map<string, AgentMessageHandler>();

  registerAgent(name: string, handler: AgentMessageHandler): void {
    this.handlers.set(name, handler);
    logger.info(`Agent "${name}" registered on bus`);
  }

  unregisterAgent(name: string): void {
    this.handlers.delete(name);
    logger.info(`Agent "${name}" unregistered from bus`);
  }

  getRegisteredAgents(): string[] {
    return [...this.handlers.keys()];
  }

  async send(message: Omit<AgentMessage, 'id' | 'timestamp'>): Promise<AgentMessage | null> {
    const msg: AgentMessage = {
      ...message,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    };

    this.history.push(msg);
    this.emit('message', msg);

    if (msg.to === '*') {
      // Broadcast — notify all agents except sender
      for (const [name, handler] of this.handlers) {
        if (name !== msg.from && name !== msg.from.toLowerCase()) {
          handler(msg).catch((err) =>
            logger.error(`Bus delivery to ${name} failed`, { error: String(err) })
          );
        }
      }
      return null;
    }

    // Direct message (case-insensitive lookup)
    const handler = this.handlers.get(msg.to) || this.handlers.get(msg.to.toLowerCase());
    if (!handler) {
      logger.warn(`Agent "${msg.to}" not found on bus`, { registered: [...this.handlers.keys()] });
      return null;
    }

    const responseText = await handler(msg);

    const response: AgentMessage = {
      id: randomUUID(),
      from: msg.to,
      to: msg.from,
      type: 'response',
      payload: responseText,
      replyTo: msg.id,
      timestamp: new Date().toISOString(),
    };

    this.history.push(response);
    this.emit('message', response);
    return response;
  }

  getHistory(limit?: number): AgentMessage[] {
    return this.history.slice(-(limit || 50));
  }
}
