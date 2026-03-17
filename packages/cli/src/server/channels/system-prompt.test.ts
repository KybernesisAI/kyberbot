import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all external dependencies
vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../config.js', () => ({
  getAgentName: vi.fn(() => 'TestBot'),
  getRoot: vi.fn(() => '/mock/root'),
}));

vi.mock('../../skills/loader.js', () => ({
  loadInstalledSkills: vi.fn(() => []),
}));

vi.mock('../../agents/loader.js', () => ({
  loadInstalledAgents: vi.fn(() => []),
}));

vi.mock('../../brain/timeline.js', () => ({
  getRecentActivity: vi.fn(async () => []),
}));

// Mock fs — default: no files exist
const mockReadFileSync = vi.fn(() => '');
const mockExistsSync = vi.fn(() => false);
vi.mock('fs', () => ({
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  existsSync: (...args: any[]) => mockExistsSync(...args),
}));

const { buildChannelSystemPrompt } = await import('./system-prompt.js');
const { loadInstalledSkills } = await import('../../skills/loader.js');
const { loadInstalledAgents } = await import('../../agents/loader.js');
const { getRecentActivity } = await import('../../brain/timeline.js');

describe('system-prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('');
  });

  describe('channel-specific framing', () => {
    it('should include Telegram framing for telegram channel', async () => {
      const prompt = await buildChannelSystemPrompt('telegram');
      expect(prompt).toContain('You are TestBot');
      expect(prompt).toContain('Telegram');
      expect(prompt).toContain('4096 character limit');
    });

    it('should include WhatsApp framing for whatsapp channel', async () => {
      const prompt = await buildChannelSystemPrompt('whatsapp');
      expect(prompt).toContain('You are TestBot');
      expect(prompt).toContain('WhatsApp');
      expect(prompt).toContain('concise and conversational');
    });

    it('should include web framing with memory-first protocol for web channel', async () => {
      const prompt = await buildChannelSystemPrompt('web');
      expect(prompt).toContain('You are TestBot');
      expect(prompt).toContain('web interface');
      expect(prompt).toContain('Memory-First Protocol');
      expect(prompt).toContain('kyberbot recall');
      expect(prompt).toContain('kyberbot search');
      expect(prompt).toContain('kyberbot timeline');
    });

    it('should always include full tool access statement', async () => {
      const prompt = await buildChannelSystemPrompt('telegram');
      expect(prompt).toContain('full tool access');
      expect(prompt).toContain('same agent');
    });
  });

  describe('loading SOUL.md', () => {
    it('should include SOUL.md content when file exists', async () => {
      mockExistsSync.mockImplementation((path: string) =>
        path.endsWith('SOUL.md')
      );
      mockReadFileSync.mockImplementation((path: string) => {
        if (typeof path === 'string' && path.endsWith('SOUL.md'))
          return '# I am a friendly agent\nI value honesty.';
        return '';
      });

      const prompt = await buildChannelSystemPrompt('telegram');
      expect(prompt).toContain('Personality & Values');
      expect(prompt).toContain('I am a friendly agent');
      expect(prompt).toContain('I value honesty');
    });

    it('should gracefully skip when SOUL.md does not exist', async () => {
      const prompt = await buildChannelSystemPrompt('telegram');
      expect(prompt).not.toContain('Personality & Values');
    });

    it('should gracefully handle SOUL.md read errors', async () => {
      mockExistsSync.mockImplementation((path: string) =>
        path.endsWith('SOUL.md')
      );
      mockReadFileSync.mockImplementation((path: string) => {
        if (typeof path === 'string' && path.endsWith('SOUL.md'))
          throw new Error('Permission denied');
        return '';
      });

      const prompt = await buildChannelSystemPrompt('telegram');
      expect(prompt).not.toContain('Personality & Values');
      // Should not throw
    });
  });

  describe('loading USER.md', () => {
    it('should include USER.md content when file exists', async () => {
      mockExistsSync.mockImplementation((path: string) =>
        path.endsWith('USER.md')
      );
      mockReadFileSync.mockImplementation((path: string) => {
        if (typeof path === 'string' && path.endsWith('USER.md'))
          return 'Name: Ian\nRole: Founder';
        return '';
      });

      const prompt = await buildChannelSystemPrompt('telegram');
      expect(prompt).toContain('About the User');
      expect(prompt).toContain('Name: Ian');
    });

    it('should gracefully skip when USER.md does not exist', async () => {
      const prompt = await buildChannelSystemPrompt('telegram');
      expect(prompt).not.toContain('About the User');
    });
  });

  describe('loading CLAUDE.md', () => {
    it('should include CLAUDE.md as Operational Manual', async () => {
      mockExistsSync.mockImplementation((path: string) =>
        path.endsWith('CLAUDE.md')
      );
      mockReadFileSync.mockImplementation((path: string) => {
        if (typeof path === 'string' && path.endsWith('CLAUDE.md'))
          return '## Skills\n- backup\n- recall';
        return '';
      });

      const prompt = await buildChannelSystemPrompt('telegram');
      expect(prompt).toContain('Operational Manual');
      expect(prompt).toContain('backup');
    });

    it('should strip ## Identity section from CLAUDE.md', async () => {
      mockExistsSync.mockImplementation((path: string) =>
        path.endsWith('CLAUDE.md')
      );
      mockReadFileSync.mockImplementation((path: string) => {
        if (typeof path === 'string' && path.endsWith('CLAUDE.md'))
          return '## Identity\nRead SOUL.md for who I am.\n\n## Skills\n- backup';
        return '';
      });

      const prompt = await buildChannelSystemPrompt('telegram');
      expect(prompt).not.toContain('Read SOUL.md for who I am');
      expect(prompt).toContain('backup');
    });

    it('should strip ## First Run section from CLAUDE.md', async () => {
      mockExistsSync.mockImplementation((path: string) =>
        path.endsWith('CLAUDE.md')
      );
      mockReadFileSync.mockImplementation((path: string) => {
        if (typeof path === 'string' && path.endsWith('CLAUDE.md'))
          return '## First Run\nWelcome new user!\n\n## Skills\n- recall';
        return '';
      });

      const prompt = await buildChannelSystemPrompt('telegram');
      expect(prompt).not.toContain('Welcome new user');
      expect(prompt).toContain('recall');
    });
  });

  describe('installed skills', () => {
    it('should list installed skills when present', async () => {
      vi.mocked(loadInstalledSkills).mockReturnValue([
        { name: 'backup', description: 'Back up all data', version: '1.0.0' },
        { name: 'recall', description: 'Look up entities', version: '1.0.0' },
      ] as any);

      const prompt = await buildChannelSystemPrompt('telegram');
      expect(prompt).toContain('Installed Skills');
      expect(prompt).toContain('**backup**: Back up all data');
      expect(prompt).toContain('**recall**: Look up entities');
    });

    it('should omit skills section when no skills installed', async () => {
      vi.mocked(loadInstalledSkills).mockReturnValue([]);

      const prompt = await buildChannelSystemPrompt('telegram');
      expect(prompt).not.toContain('Installed Skills');
    });

    it('should always include skill creation guidance', async () => {
      const prompt = await buildChannelSystemPrompt('telegram');
      expect(prompt).toContain('Creating New Skills');
      expect(prompt).toContain('kyberbot skill rebuild');
      expect(prompt).toContain('SKILL.md Required Format');
    });

    it('should gracefully handle skill loader errors', async () => {
      vi.mocked(loadInstalledSkills).mockImplementation(() => {
        throw new Error('Skill loader broken');
      });

      const prompt = await buildChannelSystemPrompt('telegram');
      // Should not throw, just skip skills section
      expect(prompt).toContain('You are TestBot');
    });
  });

  describe('installed agents', () => {
    it('should list installed agents when present', async () => {
      vi.mocked(loadInstalledAgents).mockReturnValue([
        { name: 'reviewer', model: 'opus', description: 'Reviews code', role: 'Code reviewer' },
      ] as any);

      const prompt = await buildChannelSystemPrompt('telegram');
      expect(prompt).toContain('Available Sub-Agents');
      expect(prompt).toContain('**reviewer** (opus): Reviews code');
      expect(prompt).toContain('kyberbot agent spawn');
    });

    it('should omit agents section when no agents installed', async () => {
      vi.mocked(loadInstalledAgents).mockReturnValue([]);

      const prompt = await buildChannelSystemPrompt('telegram');
      expect(prompt).not.toContain('Available Sub-Agents');
    });
  });

  describe('cross-channel activity', () => {
    it('should include recent activity events', async () => {
      const now = new Date();
      vi.mocked(getRecentActivity).mockResolvedValue([
        {
          timestamp: new Date(now.getTime() - 5 * 60000).toISOString(), // 5m ago
          title: 'Deployed KyberCo',
          summary: 'Successful deployment to production',
          entities: ['KyberCo'],
        },
      ] as any);

      const prompt = await buildChannelSystemPrompt('telegram');
      expect(prompt).toContain('Recent Activity (Cross-Channel)');
      expect(prompt).toContain('Deployed KyberCo');
      expect(prompt).toContain('[KyberCo]');
      expect(prompt).toContain('Successful deployment');
    });

    it('should truncate long summaries to 200 chars', async () => {
      const longSummary = 'X'.repeat(300);
      vi.mocked(getRecentActivity).mockResolvedValue([
        {
          timestamp: new Date().toISOString(),
          title: 'Long event',
          summary: longSummary,
          entities: [],
        },
      ] as any);

      const prompt = await buildChannelSystemPrompt('telegram');
      expect(prompt).toContain('X'.repeat(197) + '...');
      expect(prompt).not.toContain('X'.repeat(198) + '...');
    });

    it('should limit entities to 5 per event', async () => {
      vi.mocked(getRecentActivity).mockResolvedValue([
        {
          timestamp: new Date().toISOString(),
          title: 'Multi-entity event',
          summary: 'Many entities involved',
          entities: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
        },
      ] as any);

      const prompt = await buildChannelSystemPrompt('telegram');
      expect(prompt).toContain('[A, B, C, D, E]');
      // F and G should not appear in the entity bracket list
      expect(prompt).not.toContain('[A, B, C, D, E, F');
      expect(prompt).not.toContain('G]');
    });

    it('should omit activity section when no recent events', async () => {
      vi.mocked(getRecentActivity).mockResolvedValue([]);

      const prompt = await buildChannelSystemPrompt('telegram');
      expect(prompt).not.toContain('Recent Activity');
    });

    it('should gracefully handle timeline errors', async () => {
      vi.mocked(getRecentActivity).mockRejectedValue(new Error('DB error'));

      const prompt = await buildChannelSystemPrompt('telegram');
      expect(prompt).toContain('You are TestBot');
      // Should not throw
    });
  });

  describe('full prompt assembly', () => {
    it('should assemble all sections in order', async () => {
      // Enable all file reads
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation((path: string) => {
        if (typeof path === 'string' && path.endsWith('SOUL.md')) return 'SOUL_CONTENT';
        if (typeof path === 'string' && path.endsWith('USER.md')) return 'USER_CONTENT';
        if (typeof path === 'string' && path.endsWith('CLAUDE.md')) return '## Skills\nCLAUDE_CONTENT';
        return '';
      });

      vi.mocked(loadInstalledSkills).mockReturnValue([
        { name: 'test-skill', description: 'A test skill', version: '1.0.0' },
      ] as any);

      const prompt = await buildChannelSystemPrompt('telegram');

      // Verify ordering: framing → SOUL → USER → CLAUDE → skills → skill guidance
      const framingIdx = prompt.indexOf('You are TestBot');
      const soulIdx = prompt.indexOf('SOUL_CONTENT');
      const userIdx = prompt.indexOf('USER_CONTENT');
      const claudeIdx = prompt.indexOf('CLAUDE_CONTENT');
      const skillsIdx = prompt.indexOf('Installed Skills');
      const guidanceIdx = prompt.indexOf('Creating New Skills');

      expect(framingIdx).toBeLessThan(soulIdx);
      expect(soulIdx).toBeLessThan(userIdx);
      expect(userIdx).toBeLessThan(claudeIdx);
      expect(claudeIdx).toBeLessThan(skillsIdx);
      expect(skillsIdx).toBeLessThan(guidanceIdx);
    });
  });
});
