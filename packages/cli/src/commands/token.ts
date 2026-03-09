import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { paths } from '../config.js';
import chalk from 'chalk';

export function createTokenCommand(): Command {
  const cmd = new Command('token')
    .description('Manage API authentication token');

  cmd
    .command('show')
    .description('Display the current API token')
    .action(() => {
      const token = process.env.KYBERBOT_API_TOKEN;
      if (!token) {
        console.log(chalk.yellow('No API token configured.'));
        console.log(chalk.dim('Run `kyberbot token regenerate` to create one, or add KYBERBOT_API_TOKEN to your .env file.'));
        return;
      }
      console.log(token);
    });

  cmd
    .command('regenerate')
    .description('Generate a new API token and update .env')
    .action(() => {
      const envPath = paths.env;
      const newToken = `kb_${randomBytes(24).toString('hex')}`;

      if (existsSync(envPath)) {
        let content = readFileSync(envPath, 'utf-8');
        if (/^KYBERBOT_API_TOKEN=.*/m.test(content)) {
          content = content.replace(/^KYBERBOT_API_TOKEN=.*/m, `KYBERBOT_API_TOKEN=${newToken}`);
        } else {
          content = content.trimEnd() + `\n\nKYBERBOT_API_TOKEN=${newToken}\n`;
        }
        writeFileSync(envPath, content);
      } else {
        writeFileSync(envPath, `KYBERBOT_API_TOKEN=${newToken}\n`);
      }

      console.log(chalk.green('API token regenerated.'));
      console.log(newToken);
      console.log(chalk.dim('\nRestart kyberbot for the new token to take effect.'));
    });

  // Default action (no subcommand) — show token
  cmd.action(() => {
    const token = process.env.KYBERBOT_API_TOKEN;
    if (!token) {
      console.log(chalk.yellow('No API token configured.'));
      console.log(chalk.dim('Run `kyberbot token regenerate` to create one.'));
      return;
    }
    console.log(token);
  });

  return cmd;
}
