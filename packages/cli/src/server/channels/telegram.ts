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
import { getAgentNameForRoot } from '../../config.js';
import { Channel, ChannelMessage } from './types.js';
import { storeConversation } from '../../brain/store-conversation.js';
import { buildChannelSystemPrompt } from './system-prompt.js';
import { pushUserMessage, pushAssistantMessage, buildPromptWithHistory, clearHistory } from './conversation-history.js';

const logger = createLogger('telegram');

/** Delay before treating a Claude-routed message as "long-running".
 *  If complete() returns within this window, no acknowledgement or typing
 *  indicator is sent — the bot just replies normally. */
const LONG_RUNNING_DELAY_MS = 1500;

/** Refresh interval for Telegram's `typing` chat-action.
 *  Telegram clears the typing indicator after ~5s of inactivity, so we
 *  re-send it at 4s with a 1s safety margin. */
const TYPING_REFRESH_MS = 4000;

/** Fixed acknowledgement string emitted once the long-running threshold
 *  is crossed. Per operator decision Q2, no echo / no per-message restate. */
const STARTING_ACK = 'Starting on it…';

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

  constructor(private config: TelegramConfig, private root: string) {
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

            const agentName = getAgentNameForRoot(this.root);
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
        clearHistory(`telegram:${chatId}`);
        const agentName = getAgentNameForRoot(this.root);
        const greeting = this.loadGreeting(agentName);
        await ctx.reply(greeting);
        return;
      }

      // ── /model — show or switch the interactive Claude model ───────────
      if (text.startsWith('/model')) {
        const arg = text.slice('/model'.length).trim().toLowerCase();
        const identityPath = join(this.root, 'identity.yaml');
        const VALID = ['opus', 'sonnet', 'haiku'] as const;
        type Model = (typeof VALID)[number];

        let identity: { claude?: { model?: string } } & Record<string, unknown>;
        try {
          identity = yaml.load(readFileSync(identityPath, 'utf-8')) as typeof identity;
        } catch (e) {
          await ctx.reply(`Could not read identity.yaml: ${String(e)}`);
          return;
        }
        const current = identity?.claude?.model ?? 'sonnet';

        if (!arg) {
          await ctx.reply(
            `🧠 Current model: *${current}*\n\nSwitch with /model opus, /model sonnet, or /model haiku.`,
            { parse_mode: 'Markdown' },
          );
          return;
        }
        if (!(VALID as readonly string[]).includes(arg)) {
          await ctx.reply(
            `Unknown model: \`${arg}\`. Valid: ${VALID.join(', ')}`,
            { parse_mode: 'Markdown' },
          );
          return;
        }
        if (arg === current) {
          await ctx.reply(`Already on *${current}*.`, { parse_mode: 'Markdown' });
          return;
        }
        identity.claude = { ...(identity.claude ?? {}), model: arg as Model };
        try {
          writeFileSync(identityPath, yaml.dump(identity));
          await ctx.reply(
            `🧠 Model switched: *${current}* → *${arg}*. Takes effect on next message.`,
            { parse_mode: 'Markdown' },
          );
        } catch (e) {
          await ctx.reply(`Failed to write identity.yaml: ${String(e)}`);
        }
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
        // Default: route to agent with conversation history
        const convoId = `telegram:${chatId}`;
        const stopAffordance = this.startLongRunningAffordance(ctx, chatId);
        try {
          const client = getClaudeClient();
          const prompt = buildPromptWithHistory(convoId, text);
          const systemPrompt = await buildChannelSystemPrompt('telegram');
          const reply = await client.complete(prompt, { system: systemPrompt, maxTurns: 30, subprocess: true, cwd: this.root });

          // Track both sides in history
          pushUserMessage(convoId, text);

          if (!reply || reply.trim().length === 0) {
            logger.warn('Claude returned empty response, skipping reply');
            return;
          }

          pushAssistantMessage(convoId, reply);

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
          // skipEmbeddings: true — sleep agent handles ChromaDB indexing to avoid OOM
          storeConversation(this.root, {
            prompt: text,
            response: reply,
            channel: 'telegram',
            metadata: { chatId, userId },
          }, { skipEmbeddings: true }).catch((err) => logger.warn('Memory storage failed', { error: String(err) }));
        } catch (error) {
          logger.error('Failed to process Telegram message', { error: String(error) });
          await ctx.reply('Sorry, I encountered an error processing your message.');
        } finally {
          stopAffordance();
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

  /**
   * Start the "long-running" responsiveness affordance for a Claude-routed
   * Telegram message. Schedules an acknowledgement reply + typing indicator
   * to fire after `LONG_RUNNING_DELAY_MS`; if work completes before that,
   * the returned cleanup is a no-op. Once active, the typing indicator is
   * refreshed every `TYPING_REFRESH_MS` (Telegram clears it after ~5s).
   *
   * Returns an idempotent `cleanup()` closure: callers must invoke it
   * (typically in a `finally` block) to clear both timers regardless of
   * success / failure / throw. All Telegram API errors are logged and
   * swallowed so they cannot crash the user-visible task.
   */
  private startLongRunningAffordance(ctx: any, chatId: number): () => void {
    let startTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshTimer: ReturnType<typeof setInterval> | null = null;

    startTimer = setTimeout(async () => {
      // Threshold crossed — fire the ack reply, then start the typing loop.
      try {
        await ctx.reply(STARTING_ACK);
      } catch (err) {
        logger.warn('Telegram ack reply failed', { error: String(err) });
      }

      try {
        await this.bot?.api.sendChatAction(chatId, 'typing');
      } catch (err) {
        logger.warn('Telegram sendChatAction failed', { error: String(err) });
      }

      // Refresh the typing indicator before Telegram's ~5s TTL elapses.
      // Use .catch (not await) so a transient failure on a tick logs but
      // never crashes the timer or surfaces as an unhandledRejection.
      refreshTimer = setInterval(() => {
        this.bot?.api.sendChatAction(chatId, 'typing').catch((err) =>
          logger.warn('Telegram sendChatAction refresh failed', { error: String(err) })
        );
      }, TYPING_REFRESH_MS);
    }, LONG_RUNNING_DELAY_MS);

    return () => {
      if (startTimer !== null) {
        clearTimeout(startTimer);
        startTimer = null;
      }
      if (refreshTimer !== null) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
    };
  }

  private saveOwnerChatId(chatId: number): void {
    try {
      const identityPath = join(this.root, 'identity.yaml');
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
      const userPath = join(this.root, 'USER.md');
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
