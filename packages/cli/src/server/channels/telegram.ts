/**
 * KyberBot — Telegram Channel Bridge
 *
 * Uses grammy to connect to Telegram Bot API.
 * Routes incoming messages to the agent via claude.ts.
 *
 * Security: One-time verification code flow ensures only the owner
 * can interact with the bot. On first start (no owner_chat_id),
 * a 6-char code is printed to the console. The owner sends
 * `/start CODE` in Telegram to verify. After that, all messages
 * from non-owner chat_ids are silently ignored.
 */

import { Bot } from 'grammy';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import yaml from 'js-yaml';
import { createLogger } from '../../logger.js';
import { getClaudeClient } from '../../claude.js';
import { getAgentName, getRoot } from '../../config.js';
import { Channel, ChannelMessage } from './types.js';
import { storeConversation } from '../../brain/store-conversation.js';
import { buildChannelSystemPrompt } from './system-prompt.js';

const logger = createLogger('telegram');

export interface TelegramConfig {
  bot_token: string;
  owner_chat_id?: number;
}

export class TelegramChannel implements Channel {
  readonly name = 'telegram';
  private bot: Bot | null = null;
  private connected = false;
  private messageHandler: ((message: ChannelMessage) => Promise<void>) | null = null;
  private verificationCode: string | null = null;
  private ownerChatId: number | null;

  constructor(private config: TelegramConfig) {
    this.ownerChatId = config.owner_chat_id ?? null;
  }

  async start(): Promise<void> {
    this.bot = new Bot(this.config.bot_token);

    // If no owner set, enter verification mode
    if (!this.ownerChatId) {
      this.verificationCode = randomBytes(3).toString('hex').toUpperCase();
      logger.info('─────────────────────────────────────────────');
      logger.info(`Telegram verification required`);
      logger.info(`Send /start ${this.verificationCode} to your bot`);
      logger.info('─────────────────────────────────────────────');
      console.log('');
      console.log(`  🔐 Telegram verification code: ${this.verificationCode}`);
      console.log(`  Send /start ${this.verificationCode} to your bot in Telegram`);
      console.log('');
    }

    this.bot.on('message:text', async (ctx) => {
      const chatId = ctx.chat.id;
      const userId = ctx.from?.id;
      const text = ctx.message.text;

      // ── Verification mode ──────────────────────────────────────────────
      if (this.verificationCode) {
        // Only handle /start CODE during verification
        if (text.startsWith('/start ')) {
          const code = text.slice(7).trim();
          if (code === this.verificationCode) {
            // Verification successful
            this.ownerChatId = chatId;
            this.verificationCode = null;
            this.saveOwnerChatId(chatId);
            logger.info(`Owner verified: chat_id=${chatId}`);

            const agentName = getAgentName();
            const greeting = this.loadGreeting(agentName);
            await ctx.reply(`Connected! You are now the verified owner.\n\n${greeting}`);
            return;
          }
          // Wrong code — silently ignore
          logger.warn(`Invalid verification attempt from chat_id=${chatId}`);
          return;
        }
        // Not a /start command during verification — ignore
        return;
      }

      // ── Owner guard ────────────────────────────────────────────────────
      if (chatId !== this.ownerChatId) {
        // Silently ignore messages from non-owner
        logger.debug(`Ignored message from non-owner chat_id=${chatId}`);
        return;
      }

      // ── Handle /start after verification ───────────────────────────────
      if (text === '/start') {
        const agentName = getAgentName();
        const greeting = this.loadGreeting(agentName);
        await ctx.reply(greeting);
        return;
      }

      // ── Route message ──────────────────────────────────────────────────
      const message: ChannelMessage = {
        id: String(ctx.message.message_id),
        channelType: 'telegram',
        from: ctx.from?.username || ctx.from?.first_name || 'unknown',
        text,
        timestamp: new Date(ctx.message.date * 1000),
        metadata: {
          chatId,
          userId,
        },
      };

      if (this.messageHandler) {
        await this.messageHandler(message);
      } else {
        // Default: route to agent
        try {
          const client = getClaudeClient();
          const reply = await client.complete(text, { system: buildChannelSystemPrompt('telegram'), maxTurns: 30 });
          if (!reply || reply.trim().length === 0) {
            logger.warn('Claude returned empty response, skipping reply');
            return;
          }
          // Telegram has a 4096 char limit per message
          if (reply.length > 4096) {
            const chunks = this.chunkMessage(reply, 4096);
            for (const chunk of chunks) {
              await ctx.reply(chunk);
            }
          } else {
            await ctx.reply(reply);
          }

          // Fire-and-forget: store conversation in memory
          storeConversation(getRoot(), {
            prompt: text,
            response: reply,
            channel: 'telegram',
            metadata: { chatId, userId },
          }).catch((err) => logger.warn('Memory storage failed', { error: String(err) }));
        } catch (error) {
          logger.error('Failed to process Telegram message', { error: String(error) });
          await ctx.reply('Sorry, I encountered an error processing your message.');
        }
      }
    });

    this.bot.start();
    this.connected = true;
    logger.info(`Telegram channel connected${this.ownerChatId ? ` (owner: ${this.ownerChatId})` : ' (awaiting verification)'}`);
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

  isVerified(): boolean {
    return this.ownerChatId !== null;
  }

  onMessage(handler: (message: ChannelMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private saveOwnerChatId(chatId: number): void {
    try {
      const root = getRoot();
      const identityPath = join(root, 'identity.yaml');
      const raw = readFileSync(identityPath, 'utf-8');
      const identity = yaml.load(raw) as Record<string, any>;

      if (identity.channels?.telegram) {
        identity.channels.telegram.owner_chat_id = chatId;
      }

      writeFileSync(identityPath, yaml.dump(identity, { lineWidth: 120 }));
      logger.info(`Saved owner_chat_id=${chatId} to identity.yaml`);
    } catch (error) {
      logger.error('Failed to save owner_chat_id to identity.yaml', { error: String(error) });
    }
  }

  private loadGreeting(agentName: string): string {
    try {
      const root = getRoot();
      const userPath = join(root, 'USER.md');
      const userMd = existsSync(userPath) ? readFileSync(userPath, 'utf-8') : '';
      const isFirstRun = userMd.includes('<!-- I will fill this in') || userMd.length < 300;

      if (isFirstRun) {
        return `Hey! I'm ${agentName}, and I just came online for the first time.\n\n` +
          `I'd love to get to know you — tell me about yourself, what you're working on, ` +
          `what matters to you. Everything you share helps me be a better partner.\n\n` +
          `You can also tell me how you'd like me to communicate and I'll adapt.`;
      }
    } catch {
      // Non-fatal
    }
    return `Hey! I'm ${agentName}. Send me a message and I'll help however I can.`;
  }

  private chunkMessage(text: string, maxLen: number): string[] {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      // Try to break at a newline
      let breakAt = remaining.lastIndexOf('\n', maxLen);
      if (breakAt < maxLen / 2) {
        // No good newline break, try space
        breakAt = remaining.lastIndexOf(' ', maxLen);
      }
      if (breakAt < maxLen / 2) {
        breakAt = maxLen;
      }
      chunks.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt).trimStart();
    }
    return chunks;
  }
}
