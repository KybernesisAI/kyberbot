/**
 * KyberBot — Telegram Channel Bridge
 *
 * Uses grammy to connect to Telegram Bot API.
 * Routes incoming messages to the agent via claude.ts.
 */

import { Bot } from 'grammy';
import { createLogger } from '../../logger.js';
import { getClaudeClient } from '../../claude.js';
import { getAgentName, getRoot } from '../../config.js';
import { Channel, ChannelMessage } from './types.js';

const logger = createLogger('channel');

export class TelegramChannel implements Channel {
  readonly name = 'telegram';
  private bot: Bot | null = null;
  private connected = false;
  private messageHandler: ((message: ChannelMessage) => Promise<void>) | null = null;

  constructor(private botToken: string) {}

  async start(): Promise<void> {
    this.bot = new Bot(this.botToken);

    this.bot.on('message:text', async (ctx) => {
      const message: ChannelMessage = {
        id: String(ctx.message.message_id),
        channelType: 'telegram',
        from: ctx.from?.username || ctx.from?.first_name || 'unknown',
        text: ctx.message.text,
        timestamp: new Date(ctx.message.date * 1000),
        metadata: {
          chatId: ctx.chat.id,
          userId: ctx.from?.id,
        },
      };

      if (this.messageHandler) {
        await this.messageHandler(message);
      } else {
        // Default: route to agent
        try {
          const client = getClaudeClient();
          const agentName = getAgentName();
          const reply = await client.complete(message.text, {
            system: `You are ${agentName}, a personal AI agent. Respond helpfully and concisely. The user is messaging via Telegram.`,
          });
          await ctx.reply(reply);
        } catch (error) {
          logger.error('Failed to process Telegram message', { error: String(error) });
          await ctx.reply('Sorry, I encountered an error processing your message.');
        }
      }
    });

    this.bot.start();
    this.connected = true;
    logger.info('Telegram channel connected');
  }

  async stop(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
    }
    this.connected = false;
    logger.info('Telegram channel disconnected');
  }

  async send(chatId: string, message: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot not started');
    await this.bot.api.sendMessage(chatId, message);
  }

  isConnected(): boolean {
    return this.connected;
  }

  onMessage(handler: (message: ChannelMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }
}
