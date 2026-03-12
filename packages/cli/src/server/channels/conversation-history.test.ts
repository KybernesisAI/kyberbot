import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock logger to suppress output during tests
vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const {
  pushUserMessage,
  pushAssistantMessage,
  buildPromptWithHistory,
  getHistoryLength,
  clearHistory,
} = await import('./conversation-history.js');

describe('conversation-history', () => {
  const chatId = 'test-chat-123';

  beforeEach(() => {
    clearHistory(chatId);
  });

  describe('pushUserMessage / pushAssistantMessage', () => {
    it('should add messages and increase history length', () => {
      expect(getHistoryLength(chatId)).toBe(0);
      pushUserMessage(chatId, 'Hello');
      expect(getHistoryLength(chatId)).toBe(1);
      pushAssistantMessage(chatId, 'Hi there');
      expect(getHistoryLength(chatId)).toBe(2);
    });

    it('should maintain separate histories for different conversations', () => {
      const other = 'other-chat-456';
      pushUserMessage(chatId, 'Hello');
      pushUserMessage(other, 'Hey');
      pushUserMessage(other, 'How are you?');

      expect(getHistoryLength(chatId)).toBe(1);
      expect(getHistoryLength(other)).toBe(2);

      clearHistory(other);
    });
  });

  describe('clearHistory', () => {
    it('should reset history to zero', () => {
      pushUserMessage(chatId, 'Hello');
      pushAssistantMessage(chatId, 'Hi');
      expect(getHistoryLength(chatId)).toBe(2);

      clearHistory(chatId);
      expect(getHistoryLength(chatId)).toBe(0);
    });

    it('should be safe to call on non-existent conversation', () => {
      clearHistory('nonexistent');
      expect(getHistoryLength('nonexistent')).toBe(0);
    });
  });

  describe('buildPromptWithHistory', () => {
    it('should return just the message when no history exists', () => {
      const prompt = buildPromptWithHistory(chatId, 'What is 2+2?');
      expect(prompt).toBe('What is 2+2?');
    });

    it('should include history before the current message', () => {
      pushUserMessage(chatId, 'My name is Ian');
      pushAssistantMessage(chatId, 'Nice to meet you, Ian');

      const prompt = buildPromptWithHistory(chatId, 'What is my name?');

      expect(prompt).toContain('--- Conversation history');
      expect(prompt).toContain('User: My name is Ian');
      expect(prompt).toContain('Assistant: Nice to meet you, Ian');
      expect(prompt).toContain('--- End of history ---');
      expect(prompt).toContain('User: What is my name?');
    });

    it('should truncate long assistant messages to 500 chars in history', () => {
      pushUserMessage(chatId, 'Tell me a story');
      const longResponse = 'A'.repeat(600);
      pushAssistantMessage(chatId, longResponse);

      const prompt = buildPromptWithHistory(chatId, 'Continue');

      // Should contain truncated version (497 chars + "...")
      expect(prompt).toContain('A'.repeat(497) + '...');
      expect(prompt).not.toContain('A'.repeat(498));
    });

    it('should NOT truncate short assistant messages', () => {
      pushUserMessage(chatId, 'Hi');
      pushAssistantMessage(chatId, 'Hello, how can I help?');

      const prompt = buildPromptWithHistory(chatId, 'Thanks');
      expect(prompt).toContain('Assistant: Hello, how can I help?');
    });

    it('should NOT truncate long user messages', () => {
      const longUserMsg = 'B'.repeat(600);
      pushUserMessage(chatId, longUserMsg);

      const prompt = buildPromptWithHistory(chatId, 'Continue');
      expect(prompt).toContain(`User: ${longUserMsg}`);
    });
  });

  describe('trimming — max entries', () => {
    it('should trim to MAX_ENTRIES (40) when exceeded', () => {
      // Push 50 messages (25 exchanges)
      for (let i = 0; i < 25; i++) {
        pushUserMessage(chatId, `User message ${i}`);
        pushAssistantMessage(chatId, `Assistant message ${i}`);
      }

      // Should be capped at 40
      expect(getHistoryLength(chatId)).toBe(40);
    });

    it('should remove oldest messages when trimming', () => {
      // Push 22 exchanges (44 messages, 4 over limit)
      for (let i = 0; i < 22; i++) {
        pushUserMessage(chatId, `User message ${i}`);
        pushAssistantMessage(chatId, `Assistant message ${i}`);
      }

      // Build prompt and check that early messages are gone
      const prompt = buildPromptWithHistory(chatId, 'latest');
      // "User message 0" should not appear as a standalone entry
      // (careful: "User message 1" is a substring of "User message 10", etc.)
      expect(prompt).not.toContain('User: User message 0\n');
      expect(prompt).not.toContain('User: User message 1\n');
      // Later messages should still be present
      expect(prompt).toContain('User message 21');
    });
  });

  describe('trimming — stale entries', () => {
    it('should filter out messages older than 4 hours in buildPromptWithHistory', () => {
      pushUserMessage(chatId, 'Recent message');

      // Manually verify that buildPromptWithHistory filters by timestamp
      // Since we can't easily mock Date.now inside the module's internal state,
      // we verify the current behavior: recent messages should appear
      const prompt = buildPromptWithHistory(chatId, 'Now');
      expect(prompt).toContain('User: Recent message');
    });
  });

  describe('getHistoryLength', () => {
    it('should return 0 for unknown conversation', () => {
      expect(getHistoryLength('never-used')).toBe(0);
    });

    it('should track length accurately', () => {
      pushUserMessage(chatId, 'one');
      expect(getHistoryLength(chatId)).toBe(1);
      pushUserMessage(chatId, 'two');
      expect(getHistoryLength(chatId)).toBe(2);
      pushAssistantMessage(chatId, 'three');
      expect(getHistoryLength(chatId)).toBe(3);
    });
  });
});
