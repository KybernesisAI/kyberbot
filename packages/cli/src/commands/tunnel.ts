import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { paths, getServerPort } from '../config.js';
import { startTunnel, getTunnelUrl } from '../services/tunnel.js';
import chalk from 'chalk';

export function createTunnelCommand(): Command {
  const cmd = new Command('tunnel')
    .description('Manage ngrok tunnel for remote access');

  cmd
    .command('setup')
    .description('Configure ngrok authtoken')
    .action(async () => {
      const { default: inquirer } = await import('inquirer');

      console.log(chalk.bold('\nngrok Tunnel Setup\n'));
      console.log('ngrok creates a secure tunnel so KyberCo can reach this Kyberbot instance remotely.');
      console.log(chalk.dim('Sign up at https://ngrok.com and copy your authtoken from the dashboard.\n'));

      const { authtoken } = await inquirer.prompt([{
        type: 'password',
        name: 'authtoken',
        message: 'ngrok authtoken:',
        mask: '*',
        validate: (v: string) => v.trim().length > 0 || 'Authtoken is required',
      }]);

      // Run ngrok config add-authtoken
      const { spawn } = await import('node:child_process');
      const proc = spawn('ngrok', ['config', 'add-authtoken', authtoken.trim()], {
        stdio: 'inherit',
      });

      await new Promise<void>((resolve, reject) => {
        proc.on('close', (code) => {
          if (code === 0) {
            console.log(chalk.green('\nngrok authtoken configured successfully.'));

            // Update identity.yaml to enable tunnel
            try {
              const identityPath = paths.identity;
              if (existsSync(identityPath)) {
                let content = readFileSync(identityPath, 'utf-8');
                if (!content.includes('tunnel:')) {
                  content = content.trimEnd() + '\n\ntunnel:\n  enabled: true\n  provider: ngrok\n';
                  writeFileSync(identityPath, content);
                  console.log(chalk.dim('Tunnel enabled in identity.yaml'));
                }
              }
            } catch {
              // non-fatal
            }

            console.log(chalk.dim('Restart kyberbot to start the tunnel.\n'));
            resolve();
          } else {
            reject(new Error(`ngrok config failed with code ${code}`));
          }
        });
        proc.on('error', () => {
          console.log(chalk.red('\nngrok is not installed. Install it from https://ngrok.com/download'));
          reject(new Error('ngrok not found'));
        });
      });
    });

  cmd
    .command('status')
    .description('Check tunnel status')
    .action(async () => {
      try {
        const response = await fetch('http://localhost:4040/api/tunnels');
        if (!response.ok) {
          console.log(chalk.yellow('No active tunnel.'));
          return;
        }
        const data = await response.json() as { tunnels: Array<{ public_url: string; proto: string }> };
        if (!data.tunnels || data.tunnels.length === 0) {
          console.log(chalk.yellow('No active tunnels.'));
          return;
        }
        for (const t of data.tunnels) {
          console.log(`${chalk.green('●')} ${t.public_url} (${t.proto})`);
        }
      } catch {
        console.log(chalk.yellow('No active tunnel (ngrok API not reachable).'));
      }
    });

  cmd
    .command('start')
    .description('Start ngrok tunnel')
    .action(async () => {
      try {
        const port = getServerPort();
        console.log(`Starting ngrok tunnel to port ${port}...`);
        await startTunnel(port);
        const url = getTunnelUrl();
        if (url) {
          console.log(chalk.green(`\nTunnel active: ${url}`));
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`Failed to start tunnel: ${message}`));
      }
    });

  return cmd;
}
