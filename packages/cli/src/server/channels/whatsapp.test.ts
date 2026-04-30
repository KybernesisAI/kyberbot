import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock config
vi.mock('../../config.js', () => ({
  getRoot: () => '/tmp/test-root',
  getAgentNameForRoot: () => 'TestBot',
  isFleetMode: () => false,
}));

// Mock claude client
const mockComplete = vi.fn();
vi.mock('../../claude.js', () => ({
  getClaudeClient: () => ({ complete: mockComplete }),
}));

// Mock conversation history
vi.mock('./conversation-history.js', () => ({
  pushUserMessage: vi.fn(),
  pushAssistantMessage: vi.fn(),
  buildPromptWithHistory: vi.fn((_, text) => text),
}));

// Mock system prompt
vi.mock('./system-prompt.js', () => ({
  buildChannelSystemPrompt: vi.fn().mockResolvedValue('system prompt'),
}));

// Mock store conversation
vi.mock('../../brain/store-conversation.js', () => ({
  storeConversation: vi.fn().mockResolvedValue(undefined),
}));

// Mock Baileys — this is the critical mock
const mockEventHandlers = new Map<string, (...args: any[]) => any>();
const mockSendMessage = vi.fn();
const mockEnd = vi.fn();
const mockSock = {
  ev: {
    on: vi.fn((event: string, handler: (...args: any[]) => any) => {
      mockEventHandlers.set(event, handler);
    }),
  },
  sendMessage: mockSendMessage,
  end: mockEnd,
};
const mockUseMultiFileAuthState = vi.fn().mockResolvedValue({
  state: {},
  saveCreds: vi.fn(),
});

vi.mock('@whiskeysockets/baileys', () => ({
  default: vi.fn(() => mockSock),
  useMultiFileAuthState: mockUseMultiFileAuthState,
  DisconnectReason: { loggedOut: 401 },
}));

const { WhatsAppChannel } = await import('./whatsapp.js');

describe('WhatsAppChannel', () => {
  let channel: InstanceType<typeof WhatsAppChannel>;

  beforeEach(() => {
    channel = new WhatsAppChannel('/tmp/test-root');
    mockEventHandlers.clear();
    mockComplete.mockReset();
    mockSendMessage.mockReset();
    mockEnd.mockReset();
  });

  describe('name', () => {
    it('should be whatsapp', () => {
      expect(channel.name).toBe('whatsapp');
    });
  });

  describe('isConnected', () => {
    it('should be false initially', () => {
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('start', () => {
    it('should register event handlers', async () => {
      await channel.start();

      expect(mockEventHandlers.has('creds.update')).toBe(true);
      expect(mockEventHandlers.has('connection.update')).toBe(true);
      expect(mockEventHandlers.has('messages.upsert')).toBe(true);
    });

    it('should set connected to true on connection open', async () => {
      await channel.start();

      const connectionHandler = mockEventHandlers.get('connection.update')!;
      connectionHandler({ connection: 'open' });

      expect(channel.isConnected()).toBe(true);
    });

    it('should set connected to false on connection close', async () => {
      await channel.start();

      const connectionHandler = mockEventHandlers.get('connection.update')!;
      connectionHandler({ connection: 'open' });
      expect(channel.isConnected()).toBe(true);

      connectionHandler({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      });
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('stop', () => {
    it('should call sock.end and set connected to false', async () => {
      await channel.start();

      // Simulate connected
      const connectionHandler = mockEventHandlers.get('connection.update')!;
      connectionHandler({ connection: 'open' });
      expect(channel.isConnected()).toBe(true);

      await channel.stop();
      expect(mockEnd).toHaveBeenCalledWith(undefined);
      expect(channel.isConnected()).toBe(false);
    });

    it('should be safe to call when not connected', async () => {
      await expect(channel.stop()).resolves.toBeUndefined();
    });
  });

  describe('send', () => {
    it('should throw when not connected', async () => {
      await expect(channel.send('jid@s.whatsapp.net', 'hello'))
        .rejects.toThrow('WhatsApp not connected');
    });

    it('should send a message through the socket', async () => {
      await channel.start();

      await channel.send('jid@s.whatsapp.net', 'hello');
      expect(mockSendMessage).toHaveBeenCalledWith('jid@s.whatsapp.net', { text: 'hello' });
    });
  });

  describe('onMessage', () => {
    it('should register a custom message handler', async () => {
      const handler = vi.fn();
      channel.onMessage(handler);

      await channel.start();

      // Simulate incoming message
      const messageHandler = mockEventHandlers.get('messages.upsert')!;
      await messageHandler({
        messages: [{
          message: { conversation: 'test message' },
          key: { id: 'msg-1', fromMe: false, remoteJid: 'sender@s.whatsapp.net' },
          pushName: 'Test User',
          messageTimestamp: Math.floor(Date.now() / 1000),
        }],
      });

      expect(handler).toHaveBeenCalledTimes(1);
      const call = handler.mock.calls[0][0];
      expect(call.text).toBe('test message');
      expect(call.channelType).toBe('whatsapp');
      expect(call.from).toBe('sender@s.whatsapp.net');
    });
  });

  describe('message processing', () => {
    it('should skip messages from self', async () => {
      await channel.start();

      const messageHandler = mockEventHandlers.get('messages.upsert')!;
      await messageHandler({
        messages: [{
          message: { conversation: 'my own message' },
          key: { id: 'msg-1', fromMe: true, remoteJid: 'self@s.whatsapp.net' },
          messageTimestamp: Math.floor(Date.now() / 1000),
        }],
      });

      expect(mockComplete).not.toHaveBeenCalled();
    });

    it('should skip messages with no text', async () => {
      await channel.start();

      const messageHandler = mockEventHandlers.get('messages.upsert')!;
      await messageHandler({
        messages: [{
          message: null,
          key: { id: 'msg-1', fromMe: false, remoteJid: 'sender@s.whatsapp.net' },
          messageTimestamp: Math.floor(Date.now() / 1000),
        }],
      });

      expect(mockComplete).not.toHaveBeenCalled();
    });

    it('should extract text from extendedTextMessage', async () => {
      const handler = vi.fn();
      channel.onMessage(handler);
      await channel.start();

      const messageHandler = mockEventHandlers.get('messages.upsert')!;
      await messageHandler({
        messages: [{
          message: { extendedTextMessage: { text: 'extended text' } },
          key: { id: 'msg-1', fromMe: false, remoteJid: 'sender@s.whatsapp.net' },
          pushName: 'Test User',
          messageTimestamp: Math.floor(Date.now() / 1000),
        }],
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].text).toBe('extended text');
    });

    it('should process messages through Claude when no custom handler', async () => {
      mockComplete.mockResolvedValue('Claude response');

      await channel.start();

      const messageHandler = mockEventHandlers.get('messages.upsert')!;
      await messageHandler({
        messages: [{
          message: { conversation: 'hello bot' },
          key: { id: 'msg-1', fromMe: false, remoteJid: 'sender@s.whatsapp.net' },
          pushName: 'Test User',
          messageTimestamp: Math.floor(Date.now() / 1000),
        }],
      });

      expect(mockComplete).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith('sender@s.whatsapp.net', { text: 'Claude response' });
    });

    it('should skip reply when Claude returns empty response', async () => {
      mockComplete.mockResolvedValue('');

      await channel.start();

      const messageHandler = mockEventHandlers.get('messages.upsert')!;
      await messageHandler({
        messages: [{
          message: { conversation: 'hello' },
          key: { id: 'msg-1', fromMe: false, remoteJid: 'sender@s.whatsapp.net' },
          pushName: 'Test User',
          messageTimestamp: Math.floor(Date.now() / 1000),
        }],
      });

      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });
});
