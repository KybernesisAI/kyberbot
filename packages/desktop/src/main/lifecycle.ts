/**
 * CLI child process lifecycle manager.
 *
 * Spawns `kyberbot run` as a child process, monitors health via HTTP,
 * and manages graceful shutdown. The desktop never imports CLI internals —
 * this is the boundary.
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import { join } from 'path';
import { existsSync, createWriteStream, mkdirSync, WriteStream } from 'fs';
import { EventEmitter } from 'events';
import { AppStore } from './store.js';
import type { HealthData } from '../types/ipc.js';

type CliStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';

export class LifecycleManager extends EventEmitter {
  private store: AppStore;
  private process: ChildProcess | null = null;
  private _status: CliStatus = 'stopped';
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private lastHealth: HealthData | null = null;
  private logStream: WriteStream | null = null;
  private stdoutBuffer: string[] = [];
  private readonly MAX_BUFFER_LINES = 1000;
  private restartCount = 0;
  private readonly MAX_RESTARTS = 10;

  constructor(store: AppStore) {
    super();
    this.store = store;
  }

  get status(): CliStatus {
    return this._status;
  }

  getHealth(): HealthData | null {
    return this.lastHealth;
  }

  isRunning(): boolean {
    return this._status === 'running' || this._status === 'starting';
  }

  getRecentLogs(): string[] {
    return [...this.stdoutBuffer];
  }

  async startCli(): Promise<void> {
    if (this.process) return;
    this.restartCount = 0;
    this.spawnProcess();
  }

  async stopCli(): Promise<void> {
    if (!this.process) return;
    this._status = 'stopping';
    this.emit('status-change', this._status);
    this.stopHealthPolling();

    this.process.kill('SIGTERM');

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) this.process.kill('SIGKILL');
        resolve();
      }, 10_000);

      this.process?.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.process = null;
    this.logStream?.end();
    this.logStream = null;
    this._status = 'stopped';
    this.emit('status-change', this._status);
  }

  private spawnProcess(): void {
    const agentRoot = this.store.getAgentRoot();
    if (!agentRoot) throw new Error('Agent root not configured');

    this._status = 'starting';
    this.emit('status-change', this._status);

    const cliPath = this.resolveCliPath();

    // Ensure logs directory
    const logDir = join(agentRoot, 'logs');
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

    const logPath = join(logDir, 'desktop-cli.log');
    this.logStream = createWriteStream(logPath, { flags: 'a' });

    // Spawn kyberbot directly (it has its own shebang with node + max-old-space-size)
    this.process = spawn(cliPath, ['run'], {
      cwd: agentRoot,
      env: {
        ...process.env,
        KYBERBOT_ROOT: agentRoot,
        KYBERBOT_CHILD: '1', // Disables CLI's built-in watchdog (run.ts:64)
        NODE_ENV: 'production',
        PATH: process.env.PATH, // Ensure node is on PATH for the shebang
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        this.pushLogLine(line);
        this.logStream?.write(line + '\n');
      }
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        this.pushLogLine(`[stderr] ${line}`);
        this.logStream?.write(`[stderr] ${line}\n`);
      }
    });

    this.process.on('error', (error: Error) => {
      this._status = 'crashed';
      this.emit('status-change', this._status);
      this.emit('error', error.message);
    });

    this.process.on('exit', (code) => {
      this.process = null;
      this.logStream?.end();
      this.logStream = null;

      if (this._status === 'stopping') {
        this._status = 'stopped';
        this.emit('status-change', this._status);
        return;
      }

      this._status = 'crashed';
      this.emit('status-change', this._status);
      this.emit('error', `CLI exited with code ${code}`);

      if (code !== 0 && this.restartCount < this.MAX_RESTARTS) {
        this.restartCount++;
        const delay = this.restartCount > 3 ? 10_000 : 2_000;
        setTimeout(() => this.spawnProcess(), delay);
      }
    });

    // Start health polling after startup delay
    setTimeout(() => this.startHealthPolling(), 3000);
  }

  private startHealthPolling(): void {
    this.stopHealthPolling();

    const poll = async () => {
      try {
        const port = this.getServerPort();
        const response = await fetch(`http://localhost:${port}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        const data = await response.json() as HealthData;
        this.lastHealth = data;

        if (this._status === 'starting') {
          this._status = 'running';
          this.emit('status-change', this._status);
        }

        this.emit('health-update', data);
      } catch {
        if (this._status === 'running') {
          const offlineHealth: HealthData = {
            status: 'offline',
            timestamp: new Date().toISOString(),
            uptime: '0s',
            channels: [],
            services: [],
            errors: 0,
            memory: {},
            pid: 0,
            node_version: '',
          };
          this.lastHealth = offlineHealth;
          this.emit('health-update', offlineHealth);
        }
      }
    };

    poll();
    this.healthTimer = setInterval(poll, 5000);
  }

  private stopHealthPolling(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private getServerPort(): number {
    const agentRoot = this.store.getAgentRoot();
    if (!agentRoot) return 3456;
    try {
      const yaml = require('js-yaml');
      const fs = require('fs');
      const identity = yaml.load(fs.readFileSync(join(agentRoot, 'identity.yaml'), 'utf-8'));
      return identity?.server?.port ?? 3456;
    } catch {
      return 3456;
    }
  }

  private resolveCliPath(): string {
    // Check global install
    try {
      const globalPath = execSync('which kyberbot', { encoding: 'utf-8' }).trim();
      if (globalPath) return globalPath;
    } catch { /* not found */ }

    // Check agent root node_modules
    const agentRoot = this.store.getAgentRoot()!;
    const localCli = join(agentRoot, 'node_modules', '@kyberbot', 'cli', 'dist', 'index.js');
    if (existsSync(localCli)) return localCli;

    throw new Error('kyberbot CLI not found. Install with: npm install -g @kyberbot/cli');
  }

  private pushLogLine(line: string): void {
    this.stdoutBuffer.push(line);
    if (this.stdoutBuffer.length > this.MAX_BUFFER_LINES) {
      this.stdoutBuffer.shift();
    }
    this.emit('log-line', line);
  }
}
