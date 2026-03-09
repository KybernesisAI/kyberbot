import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from '../logger.js';
import type { ServiceHandle } from '../types.js';

const logger = createLogger('tunnel');

let tunnelUrl: string | null = null;

export function getTunnelUrl(): string | null {
  return tunnelUrl;
}

export async function startTunnel(port: number): Promise<ServiceHandle> {
  tunnelUrl = null;

  // Check if ngrok is available
  const ngrokAvailable = await checkNgrok();
  if (!ngrokAvailable) {
    throw new Error('ngrok is not installed. Install it from https://ngrok.com/download');
  }

  return new Promise((resolve, reject) => {
    const proc: ChildProcess = spawn('ngrok', ['http', String(port), '--log=stdout', '--log-format=json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let resolved = false;
    let stderr = '';

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          // ngrok logs the tunnel URL in a "start tunnel" message
          if (entry.url && typeof entry.url === 'string' && entry.url.startsWith('https://')) {
            tunnelUrl = entry.url;
            logger.info(`Tunnel established: ${tunnelUrl}`);
            if (!resolved) {
              resolved = true;
              resolve({
                stop: async () => {
                  tunnelUrl = null;
                  proc.kill('SIGTERM');
                  await new Promise<void>((r) => {
                    proc.on('close', () => r());
                    setTimeout(() => { proc.kill('SIGKILL'); r(); }, 3000);
                  });
                  logger.info('Tunnel stopped');
                },
                status: () => tunnelUrl ? 'running' : 'stopped',
              });
            }
          }
          if (entry.msg) {
            logger.debug(entry.msg);
          }
        } catch {
          // not JSON, ignore
        }
      }
    });

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Failed to start ngrok: ${err.message}`));
      }
    });

    proc.on('close', (code) => {
      tunnelUrl = null;
      if (!resolved) {
        resolved = true;
        const detail = stderr.trim() || `exit code ${code}`;
        reject(new Error(`ngrok exited unexpectedly: ${detail}`));
      }
    });

    // Fallback: if no URL detected within 5s, try the ngrok API
    setTimeout(async () => {
      if (!resolved) {
        try {
          const url = await fetchTunnelUrl();
          if (url) {
            tunnelUrl = url;
            logger.info(`Tunnel established: ${tunnelUrl}`);
            resolved = true;
            resolve({
              stop: async () => {
                tunnelUrl = null;
                proc.kill('SIGTERM');
                await new Promise<void>((r) => {
                  proc.on('close', () => r());
                  setTimeout(() => { proc.kill('SIGKILL'); r(); }, 3000);
                });
                logger.info('Tunnel stopped');
              },
              status: () => tunnelUrl ? 'running' : 'stopped',
            });
          }
        } catch {
          // ignore
        }
      }
    }, 5000);

    // Final timeout
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill('SIGTERM');
        reject(new Error('Timed out waiting for ngrok tunnel URL'));
      }
    }, 15000);
  });
}

async function checkNgrok(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('ngrok', ['version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

async function fetchTunnelUrl(): Promise<string | null> {
  try {
    const response = await fetch('http://localhost:4040/api/tunnels');
    if (!response.ok) return null;
    const data = await response.json() as { tunnels: Array<{ public_url: string; proto: string }> };
    const https = data.tunnels?.find((t) => t.proto === 'https');
    return https?.public_url ?? data.tunnels?.[0]?.public_url ?? null;
  } catch {
    return null;
  }
}
