import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tempDir: string;
let envPath: string;

// Mock config to use temp dir
vi.mock('../config.js', () => ({
  paths: {
    get env() {
      return envPath;
    },
  },
}));

const { createTokenCommand } = await import('./token.js');

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'kyberbot-token-test-'));
  envPath = join(tempDir, '.env');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('createTokenCommand', () => {
  it('should create a command named token', () => {
    const cmd = createTokenCommand();
    expect(cmd.name()).toBe('token');
  });

  it('should have show and regenerate subcommands', () => {
    const cmd = createTokenCommand();
    const subcommands = cmd.commands.map(c => c.name());
    expect(subcommands).toContain('show');
    expect(subcommands).toContain('regenerate');
  });
});

describe('token regenerate', () => {
  it('should create .env file if it does not exist', async () => {
    const cmd = createTokenCommand();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const regenerateCmd = cmd.commands.find(c => c.name() === 'regenerate')!;
    // Access the action handler through commander internals
    await regenerateCmd.parseAsync(['node', 'test', 'regenerate'], { from: 'user' });

    const content = await readFile(envPath, 'utf-8');
    expect(content).toMatch(/^KYBERBOT_API_TOKEN=kb_[a-f0-9]{48}\n$/);

    consoleSpy.mockRestore();
  });

  it('should replace existing token in .env', async () => {
    writeFileSync(envPath, 'OTHER_VAR=hello\nKYBERBOT_API_TOKEN=old_token\nANOTHER=world\n');

    const cmd = createTokenCommand();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const regenerateCmd = cmd.commands.find(c => c.name() === 'regenerate')!;
    await regenerateCmd.parseAsync(['node', 'test', 'regenerate'], { from: 'user' });

    const content = await readFile(envPath, 'utf-8');
    expect(content).toContain('OTHER_VAR=hello');
    expect(content).toContain('ANOTHER=world');
    expect(content).not.toContain('old_token');
    expect(content).toMatch(/KYBERBOT_API_TOKEN=kb_[a-f0-9]{48}/);

    consoleSpy.mockRestore();
  });

  it('should append token to existing .env without token line', async () => {
    writeFileSync(envPath, 'OTHER_VAR=hello\n');

    const cmd = createTokenCommand();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const regenerateCmd = cmd.commands.find(c => c.name() === 'regenerate')!;
    await regenerateCmd.parseAsync(['node', 'test', 'regenerate'], { from: 'user' });

    const content = await readFile(envPath, 'utf-8');
    expect(content).toContain('OTHER_VAR=hello');
    expect(content).toMatch(/KYBERBOT_API_TOKEN=kb_[a-f0-9]{48}/);

    consoleSpy.mockRestore();
  });

  it('should generate tokens with kb_ prefix and 48 hex chars', async () => {
    const cmd = createTokenCommand();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const regenerateCmd = cmd.commands.find(c => c.name() === 'regenerate')!;
    await regenerateCmd.parseAsync(['node', 'test', 'regenerate'], { from: 'user' });

    // The second console.log call is the token itself
    const tokenOutput = consoleSpy.mock.calls.find(
      call => typeof call[0] === 'string' && call[0].startsWith('kb_')
    );
    expect(tokenOutput).toBeDefined();
    expect(tokenOutput![0]).toMatch(/^kb_[a-f0-9]{48}$/);

    consoleSpy.mockRestore();
  });
});
