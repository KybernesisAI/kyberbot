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
  getAgentName: vi.fn(() => 'TestBot'),
  getAgentNameForRoot: vi.fn(() => 'TestBot'),
  getRoot: vi.fn(() => '/mock/root'),
  isFleetMode: vi.fn(() => false),
}));

// Mock claude client
const mockComplete = vi.fn(async () => 'Mock response');
vi.mock('../../claude.js', () => ({
  getClaudeClient: vi.fn(() => ({
    complete: mockComplete,
  })),
}));

// Mock store-conversation
vi.mock('../../brain/store-conversation.js', () => ({
  storeConversation: vi.fn(async () => {}),
}));

// Mock system-prompt
vi.mock('./system-prompt.js', () => ({
  buildChannelSystemPrompt: vi.fn(async () => 'System prompt for testing'),
}));

// Mock conversation-history
const mockPushUser = vi.fn();
const mockPushAssistant = vi.fn();
const mockBuildPrompt = vi.fn((_, text) => text);
const mockClearHistory = vi.fn();
vi.mock('./conversation-history.js', () => ({
  pushUserMessage: (...args: any[]) => mockPushUser(...args),
  pushAssistantMessage: (...args: any[]) => mockPushAssistant(...args),
  buildPromptWithHistory: (...args: any[]) => mockBuildPrompt(...args),
  clearHistory: (...args: any[]) => mockClearHistory(...args),
}));

// Mock fs
const mockReadFileSync = vi.fn(() => '');
const mockWriteFileSync = vi.fn();
const mockExistsSync = vi.fn(() => false);
vi.mock('fs', () => ({
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  existsSync: (...args: any[]) => mockExistsSync(...args),
}));

vi.mock('js-yaml', () => ({
  default: {
    load: vi.fn(() => ({ channels: { telegram: {} } })),
    dump: vi.fn(() => 'dumped yaml'),
  },
}));

// Mock grammy Bot
const mockBotOn = vi.fn();
const mockBotStart = vi.fn();
const mockBotStop = vi.fn();
const mockSendMessage = vi.fn(async () => {});
vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({
    on: mockBotOn,
    start: mockBotStart,
    stop: mockBotStop,
    api: {
      sendMessage: mockSendMessage,
    },
  })),
}));

vi.mock('crypto', () => ({
  randomBytes: vi.fn(() => ({
    toString: () => 'abc123',
  })),
}));

const { TelegramChannel } = await import('./telegram.js');

describe('TelegramChannel', () => {
  let channel: InstanceType<typeof TelegramChannel>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockComplete.mockResolvedValue('Mock response');
  });

  describe('constructor', () => {
    it('should set name to telegram', () => {
      channel = new TelegramChannel({ bot_token: 'test-token' }, '/tmp/test-root');
      expect(channel.name).toBe('telegram');
    });

    it('should start unconnected', () => {
      channel = new TelegramChannel({ bot_token: 'test-token' }, '/tmp/test-root');
      expect(channel.isConnected()).toBe(false);
    });

    it('should be unverified when no owner_chat_id provided', () => {
      channel = new TelegramChannel({ bot_token: 'test-token' }, '/tmp/test-root');
      expect(channel.isVerified()).toBe(false);
    });

    it('should be verified when owner_chat_id is provided', () => {
      channel = new TelegramChannel({ bot_token: 'test-token', owner_chat_id: 12345 }, '/tmp/test-root');
      expect(channel.isVerified()).toBe(true);
    });
  });

  describe('start()', () => {
    it('should create a Bot and register message handler', async () => {
      channel = new TelegramChannel({ bot_token: 'test-token', owner_chat_id: 12345 }, '/tmp/test-root');
      await channel.start();

      expect(mockBotOn).toHaveBeenCalledWith('message:text', expect.any(Function));
      expect(mockBotStart).toHaveBeenCalled();
      expect(channel.isConnected()).toBe(true);
    });

    it('should enter verification mode when no owner_chat_id', async () => {
      channel = new TelegramChannel({ bot_token: 'test-token' }, '/tmp/test-root');
      await channel.start();

      expect(channel.isConnected()).toBe(true);
      expect(channel.isVerified()).toBe(false);
    });
  });

  describe('stop()', () => {
    it('should stop the bot and set connected to false', async () => {
      channel = new TelegramChannel({ bot_token: 'test-token', owner_chat_id: 12345 }, '/tmp/test-root');
      await channel.start();
      expect(channel.isConnected()).toBe(true);

      await channel.stop();
      expect(mockBotStop).toHaveBeenCalled();
      expect(channel.isConnected()).toBe(false);
    });

    it('should be safe to call when not started', async () => {
      channel = new TelegramChannel({ bot_token: 'test-token' }, '/tmp/test-root');
      await channel.stop(); // Should not throw
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('send()', () => {
    it('should throw if bot not started', async () => {
      channel = new TelegramChannel({ bot_token: 'test-token' }, '/tmp/test-root');
      await expect(channel.send('123', 'hello')).rejects.toThrow('Telegram bot not started');
    });

    it('should send message via bot API', async () => {
      channel = new TelegramChannel({ bot_token: 'test-token', owner_chat_id: 12345 }, '/tmp/test-root');
      await channel.start();
      await channel.send('123', 'hello');

      expect(mockSendMessage).toHaveBeenCalledWith('123', 'hello');
    });
  });

  describe('onMessage()', () => {
    it('should register a custom message handler', async () => {
      channel = new TelegramChannel({ bot_token: 'test-token', owner_chat_id: 12345 }, '/tmp/test-root');
      const handler = vi.fn(async () => {});
      channel.onMessage(handler);

      await channel.start();

      // Get the registered handler and simulate a message
      const messageHandler = mockBotOn.mock.calls[0][1];
      await messageHandler({
        chat: { id: 12345 },
        from: { id: 1, username: 'testuser', first_name: 'Test' },
        message: { text: 'Hello', message_id: 1, date: Math.floor(Date.now() / 1000) },
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: 'telegram',
          text: 'Hello',
          from: 'testuser',
        })
      );
    });
  });

  describe('message routing', () => {
    it('should ignore messages from non-owner', async () => {
      channel = new TelegramChannel({ bot_token: 'test-token', owner_chat_id: 12345 }, '/tmp/test-root');
      await channel.start();

      const messageHandler = mockBotOn.mock.calls[0][1];
      const ctx = {
        chat: { id: 99999 }, // Not the owner
        from: { id: 2, username: 'stranger' },
        message: { text: 'Hello', message_id: 1, date: Math.floor(Date.now() / 1000) },
        reply: vi.fn(),
      };

      await messageHandler(ctx);
      expect(ctx.reply).not.toHaveBeenCalled();
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it('should route owner messages to Claude and reply', async () => {
      channel = new TelegramChannel({ bot_token: 'test-token', owner_chat_id: 12345 }, '/tmp/test-root');
      await channel.start();

      const messageHandler = mockBotOn.mock.calls[0][1];
      const ctx = {
        chat: { id: 12345 },
        from: { id: 1, username: 'owner', first_name: 'Owner' },
        message: { text: 'What time is it?', message_id: 1, date: Math.floor(Date.now() / 1000) },
        reply: vi.fn(),
      };

      await messageHandler(ctx);

      expect(mockBuildPrompt).toHaveBeenCalledWith('TestBot:telegram:12345', 'What time is it?');
      expect(mockComplete).toHaveBeenCalled();
      expect(mockPushUser).toHaveBeenCalledWith('TestBot:telegram:12345', 'What time is it?');
      expect(mockPushAssistant).toHaveBeenCalledWith('TestBot:telegram:12345', 'Mock response');
      expect(ctx.reply).toHaveBeenCalledWith('Mock response');
    });

    it('should skip reply when Claude returns empty response', async () => {
      mockComplete.mockResolvedValue('   ');
      channel = new TelegramChannel({ bot_token: 'test-token', owner_chat_id: 12345 }, '/tmp/test-root');
      await channel.start();

      const messageHandler = mockBotOn.mock.calls[0][1];
      const ctx = {
        chat: { id: 12345 },
        from: { id: 1, username: 'owner' },
        message: { text: 'Hello', message_id: 1, date: Math.floor(Date.now() / 1000) },
        reply: vi.fn(),
      };

      await messageHandler(ctx);

      expect(mockPushUser).toHaveBeenCalled();
      expect(mockPushAssistant).not.toHaveBeenCalled();
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it('should chunk long messages over 4096 chars', async () => {
      const longResponse = 'A'.repeat(5000);
      mockComplete.mockResolvedValue(longResponse);
      channel = new TelegramChannel({ bot_token: 'test-token', owner_chat_id: 12345 }, '/tmp/test-root');
      await channel.start();

      const messageHandler = mockBotOn.mock.calls[0][1];
      const ctx = {
        chat: { id: 12345 },
        from: { id: 1, username: 'owner' },
        message: { text: 'Tell me a story', message_id: 1, date: Math.floor(Date.now() / 1000) },
        reply: vi.fn(),
      };

      await messageHandler(ctx);

      // Should have been called more than once (chunked)
      expect(ctx.reply.mock.calls.length).toBeGreaterThan(1);
      // All chunks should be <= 4096
      for (const call of ctx.reply.mock.calls) {
        expect(call[0].length).toBeLessThanOrEqual(4096);
      }
    });

    it('should reply with error message when Claude throws', async () => {
      mockComplete.mockRejectedValue(new Error('API error'));
      channel = new TelegramChannel({ bot_token: 'test-token', owner_chat_id: 12345 }, '/tmp/test-root');
      await channel.start();

      const messageHandler = mockBotOn.mock.calls[0][1];
      const ctx = {
        chat: { id: 12345 },
        from: { id: 1, username: 'owner' },
        message: { text: 'Hello', message_id: 1, date: Math.floor(Date.now() / 1000) },
        reply: vi.fn(),
      };

      await messageHandler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Sorry, I encountered an error processing your message.');
    });
  });

  describe('verification flow', () => {
    it('should accept correct verification code and set owner', async () => {
      channel = new TelegramChannel({ bot_token: 'test-token' }, '/tmp/test-root');
      await channel.start();

      expect(channel.isVerified()).toBe(false);

      const messageHandler = mockBotOn.mock.calls[0][1];
      const ctx = {
        chat: { id: 42 },
        from: { id: 1 },
        message: { text: '/start ABC123', message_id: 1, date: Math.floor(Date.now() / 1000) },
        reply: vi.fn(),
      };

      await messageHandler(ctx);

      expect(channel.isVerified()).toBe(true);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Connected!'));
    });

    it('should reject incorrect verification code silently', async () => {
      channel = new TelegramChannel({ bot_token: 'test-token' }, '/tmp/test-root');
      await channel.start();

      const messageHandler = mockBotOn.mock.calls[0][1];
      const ctx = {
        chat: { id: 42 },
        from: { id: 1 },
        message: { text: '/start WRONG', message_id: 1, date: Math.floor(Date.now() / 1000) },
        reply: vi.fn(),
      };

      await messageHandler(ctx);

      expect(channel.isVerified()).toBe(false);
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it('should ignore non-start messages during verification', async () => {
      channel = new TelegramChannel({ bot_token: 'test-token' }, '/tmp/test-root');
      await channel.start();

      const messageHandler = mockBotOn.mock.calls[0][1];
      const ctx = {
        chat: { id: 42 },
        from: { id: 1 },
        message: { text: 'Just a regular message', message_id: 1, date: Math.floor(Date.now() / 1000) },
        reply: vi.fn(),
      };

      await messageHandler(ctx);

      expect(ctx.reply).not.toHaveBeenCalled();
      expect(mockComplete).not.toHaveBeenCalled();
    });
  });

  describe('/start command (post-verification)', () => {
    it('should clear history and send greeting on /start', async () => {
      channel = new TelegramChannel({ bot_token: 'test-token', owner_chat_id: 12345 }, '/tmp/test-root');
      await channel.start();

      const messageHandler = mockBotOn.mock.calls[0][1];
      const ctx = {
        chat: { id: 12345 },
        from: { id: 1 },
        message: { text: '/start', message_id: 1, date: Math.floor(Date.now() / 1000) },
        reply: vi.fn(),
      };

      await messageHandler(ctx);

      expect(mockClearHistory).toHaveBeenCalledWith('TestBot:telegram:12345');
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('TestBot'));
      expect(mockComplete).not.toHaveBeenCalled(); // Should not route to Claude
    });
  });

  describe('message metadata', () => {
    it('should construct ChannelMessage with correct fields', async () => {
      channel = new TelegramChannel({ bot_token: 'test-token', owner_chat_id: 12345 }, '/tmp/test-root');
      const handler = vi.fn(async () => {});
      channel.onMessage(handler);
      await channel.start();

      const now = Math.floor(Date.now() / 1000);
      const messageHandler = mockBotOn.mock.calls[0][1];
      await messageHandler({
        chat: { id: 12345 },
        from: { id: 99, username: 'ian', first_name: 'Ian' },
        message: { text: 'Test message', message_id: 42, date: now },
      });

      expect(handler).toHaveBeenCalledWith({
        id: '42',
        channelType: 'telegram',
        from: 'ian',
        text: 'Test message',
        timestamp: new Date(now * 1000),
        metadata: { chatId: 12345, userId: 99 },
      });
    });

    it('should fallback to first_name when username is not available', async () => {
      channel = new TelegramChannel({ bot_token: 'test-token', owner_chat_id: 12345 }, '/tmp/test-root');
      const handler = vi.fn(async () => {});
      channel.onMessage(handler);
      await channel.start();

      const messageHandler = mockBotOn.mock.calls[0][1];
      await messageHandler({
        chat: { id: 12345 },
        from: { id: 99, first_name: 'Ian' },
        message: { text: 'Hi', message_id: 1, date: Math.floor(Date.now() / 1000) },
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'Ian' })
      );
    });

    it('should fallback to unknown when no user info available', async () => {
      channel = new TelegramChannel({ bot_token: 'test-token', owner_chat_id: 12345 }, '/tmp/test-root');
      const handler = vi.fn(async () => {});
      channel.onMessage(handler);
      await channel.start();

      const messageHandler = mockBotOn.mock.calls[0][1];
      await messageHandler({
        chat: { id: 12345 },
        from: undefined,
        message: { text: 'Hi', message_id: 1, date: Math.floor(Date.now() / 1000) },
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'unknown' })
      );
    });
  });
});
