/**
 * KyberBot — WhatsApp Channel Bridge
 *
 * Uses @whiskeysockets/baileys to connect to WhatsApp Web.
 * Routes incoming messages to the agent via claude.ts.
 */

import { createLogger } from '../../logger.js';
import { getClaudeClient } from '../../claude.js';
import { Channel, ChannelMessage } from './types.js';
import { join } from 'path';
import { storeConversation } from '../../brain/store-conversation.js';
import { buildChannelSystemPrompt } from './system-prompt.js';
import { pushUserMessage, pushAssistantMessage, buildPromptWithHistory } from './conversation-history.js';

const logger = createLogger('channel');

export class WhatsAppChannel implements Channel {
  readonly name = 'whatsapp';
  private sock: any = null;
  private connected = false;
  private messageHandler: ((message: ChannelMessage) => Promise<void>) | null = null;

  constructor(private root: string) {}

  async start(): Promise<void> {
    try {
      const baileys = await import('@whiskeysockets/baileys');
      const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;

      const authDir = join(this.root, 'data', 'whatsapp-auth');
      const { state, saveCreds } = await useMultiFileAuthState(authDir);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.sock = (makeWASocket as any)({
        auth: state,
        printQRInTerminal: true,
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', (update: any) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          logger.warn('WhatsApp connection closed', { shouldReconnect });
          this.connected = false;
          if (shouldReconnect) {
            setTimeout(() => this.start(), 5000);
          }
        } else if (connection === 'open') {
          this.connected = true;
          logger.info('WhatsApp channel connected');
        }
      });

      this.sock.ev.on('messages.upsert', async (m: any) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const text = msg.message.conversation ||
          msg.message.extendedTextMessage?.text || '';

        if (!text) return;

        const message: ChannelMessage = {
          id: msg.key.id || '',
          channelType: 'whatsapp',
          from: msg.key.remoteJid || 'unknown',
          text,
          timestamp: new Date((msg.messageTimestamp as number) * 1000),
          metadata: {
            remoteJid: msg.key.remoteJid,
            pushName: msg.pushName,
          },
        };

        if (this.messageHandler) {
          await this.messageHandler(message);
        } else {
          const convoId = `whatsapp:${msg.key.remoteJid}`;
          try {
            const client = getClaudeClient();
            const prompt = buildPromptWithHistory(convoId, text, this.root);
            const systemPrompt = await buildChannelSystemPrompt('whatsapp', this.root);
            const reply = await client.complete(prompt, {
              system: systemPrompt,
              maxTurns: 30,
              subprocess: true,
              cwd: this.root,
            });

            // Track both sides in history
            pushUserMessage(convoId, text, this.root);

            if (!reply || reply.trim().length === 0) {
              logger.warn('Claude returned empty response, skipping reply');
              return;
            }

            pushAssistantMessage(convoId, reply, this.root);
            await this.send(msg.key.remoteJid!, reply);

            // Fire-and-forget: store conversation in memory
            // skipEmbeddings: true — sleep agent handles ChromaDB indexing to avoid OOM
            storeConversation(this.root, {
              prompt: text,
              response: reply,
              channel: 'whatsapp',
              metadata: { remoteJid: msg.key.remoteJid, pushName: msg.pushName },
            }, { skipEmbeddings: true }).catch((err) => logger.warn('Memory storage failed', { error: String(err) }));
          } catch (error) {
            logger.error('Failed to process WhatsApp message', { error: String(error) });
          }
        }
      });
    } catch (error) {
      logger.error('Failed to start WhatsApp channel', { error: String(error) });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this.connected = false;
    logger.info('WhatsApp channel disconnected');
  }

  async send(jid: string, message: string): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp not connected');
    await this.sock.sendMessage(jid, { text: message });
  }

  isConnected(): boolean {
    return this.connected;
  }

  onMessage(handler: (message: ChannelMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }
}
