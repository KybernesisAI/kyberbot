/**
 * Channel Command
 *
 * Channel management: list, add, remove, status.
 * Reads and writes channel configuration in identity.yaml.
 *
 * Usage:
 *   kyberbot channel list                    # Show configured channels
 *   kyberbot channel add telegram|whatsapp   # Configure a channel
 *   kyberbot channel remove <name>           # Remove a channel
 *   kyberbot channel status                  # Check channel connectivity
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { getRoot, getIdentity } from '../config.js';
import { IdentityConfig } from '../types.js';

type ChannelType = 'telegram' | 'whatsapp';

interface ChannelInfo {
  type: ChannelType;
  configured: boolean;
  enabled: boolean;
  details: string;
}

function getChannelInfos(identity: IdentityConfig): ChannelInfo[] {
  const channels: ChannelInfo[] = [];

  if (identity.channels?.telegram) {
    const tg = identity.channels.telegram;
    channels.push({
      type: 'telegram',
      configured: !!tg.bot_token && tg.bot_token !== 'YOUR_BOT_TOKEN_HERE',
      enabled: true,
      details: tg.bot_token ? 'Bot token set' : 'No bot token',
    });
  }

  if (identity.channels?.whatsapp) {
    const wa = identity.channels.whatsapp;
    channels.push({
      type: 'whatsapp',
      configured: wa.enabled,
      enabled: wa.enabled,
      details: wa.enabled ? 'Enabled' : 'Disabled',
    });
  }

  return channels;
}

export function createChannelCommand(): Command {
  const cmd = new Command('channel')
    .description('Manage messaging channels');

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot channel list
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('list')
    .description('Show configured channels')
    .action(() => {
      try {
        const identity = getIdentity();
        const channels = getChannelInfos(identity);

        console.log(chalk.cyan.bold('\nMessaging Channels\n'));

        if (channels.length === 0) {
          console.log(chalk.dim('  No channels configured.'));
          console.log(chalk.dim('  Run `kyberbot channel add telegram` to connect one.\n'));
          return;
        }

        for (const ch of channels) {
          const type = ch.type.charAt(0).toUpperCase() + ch.type.slice(1);
          const statusIcon = ch.configured
            ? chalk.green('[configured]')
            : chalk.yellow('[needs setup]');

          console.log(`  ${statusIcon} ${chalk.white.bold(type)}`);
          console.log(chalk.dim(`             ${ch.details}`));
        }

        console.log('');
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        console.log(chalk.dim('  Run `kyberbot onboard` first to create identity.yaml.\n'));
      }
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot channel add <type>
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('add')
    .description('Add a messaging channel')
    .argument('<type>', 'Channel type: telegram or whatsapp')
    .action((type: string) => {
      if (type !== 'telegram' && type !== 'whatsapp') {
        console.error(chalk.red(`\nUnknown channel type: ${type}`));
        console.log(chalk.dim('  Supported: telegram, whatsapp\n'));
        process.exit(1);
      }

      try {
        const root = getRoot();
        const identityPath = join(root, 'identity.yaml');
        const raw = readFileSync(identityPath, 'utf-8');
        const identity = yaml.load(raw) as Record<string, unknown>;

        if (!identity.channels) {
          identity.channels = {};
        }

        const channels = identity.channels as Record<string, unknown>;

        if (type === 'telegram') {
          if (channels.telegram) {
            console.log(chalk.yellow('\nTelegram channel already configured.'));
            console.log(chalk.dim('  Edit identity.yaml to modify the bot_token.\n'));
            return;
          }

          channels.telegram = {
            bot_token: 'YOUR_BOT_TOKEN_HERE',
          };

          writeFileSync(identityPath, yaml.dump(identity, { lineWidth: 120 }));

          console.log(chalk.green('\nTelegram channel added to identity.yaml'));
          console.log('');
          console.log(chalk.dim('  Next steps:'));
          console.log(chalk.dim('  1. Get a bot token from @BotFather on Telegram'));
          console.log(chalk.dim('  2. Replace YOUR_BOT_TOKEN_HERE in identity.yaml'));
          console.log(chalk.dim('  3. Run `kyberbot run` to connect'));
          console.log('');
        } else if (type === 'whatsapp') {
          if (channels.whatsapp) {
            console.log(chalk.yellow('\nWhatsApp channel already configured.'));
            console.log(chalk.dim('  Edit identity.yaml to modify settings.\n'));
            return;
          }

          channels.whatsapp = {
            enabled: true,
          };

          writeFileSync(identityPath, yaml.dump(identity, { lineWidth: 120 }));

          console.log(chalk.green('\nWhatsApp channel added to identity.yaml'));
          console.log('');
          console.log(chalk.dim('  Next steps:'));
          console.log(chalk.dim('  1. Run `kyberbot run` to start the pairing process'));
          console.log(chalk.dim('  2. Scan the QR code with WhatsApp'));
          console.log('');
        }
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        console.log(chalk.dim('  Make sure identity.yaml exists. Run `kyberbot onboard` first.\n'));
      }
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot channel remove <type>
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('remove')
    .description('Remove a messaging channel')
    .argument('<type>', 'Channel type to remove: telegram or whatsapp')
    .action((type: string) => {
      if (type !== 'telegram' && type !== 'whatsapp') {
        console.error(chalk.red(`\nUnknown channel type: ${type}`));
        console.log(chalk.dim('  Supported: telegram, whatsapp\n'));
        process.exit(1);
      }

      try {
        const root = getRoot();
        const identityPath = join(root, 'identity.yaml');
        const raw = readFileSync(identityPath, 'utf-8');
        const identity = yaml.load(raw) as Record<string, unknown>;

        if (!identity.channels) {
          console.log(chalk.yellow('\nNo channels configured.\n'));
          return;
        }

        const channels = identity.channels as Record<string, unknown>;

        if (!channels[type]) {
          console.log(chalk.yellow(`\nNo ${type} channel configured.\n`));
          return;
        }

        delete channels[type];

        // Clean up empty channels object
        if (Object.keys(channels).length === 0) {
          delete identity.channels;
        }

        writeFileSync(identityPath, yaml.dump(identity, { lineWidth: 120 }));

        const typeName = type.charAt(0).toUpperCase() + type.slice(1);
        console.log(chalk.green(`\n${typeName} channel removed from identity.yaml.\n`));
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
      }
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot channel status
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('status')
    .description('Check channel configuration and connectivity')
    .action(() => {
      try {
        const identity = getIdentity();
        const channels = getChannelInfos(identity);

        console.log(chalk.cyan.bold('\nChannel Status\n'));

        if (channels.length === 0) {
          console.log(chalk.dim('  No channels configured.'));
          console.log(chalk.dim('  Run `kyberbot channel add telegram` to get started.\n'));
          return;
        }

        for (const ch of channels) {
          const type = ch.type.charAt(0).toUpperCase() + ch.type.slice(1);

          if (!ch.configured) {
            console.log(`  ${chalk.yellow('[needs setup]')} ${type}`);
            if (ch.type === 'telegram') {
              console.log(chalk.dim('    Set bot_token in identity.yaml'));
            }
          } else if (!ch.enabled) {
            console.log(`  ${chalk.gray('[disabled]')} ${type}`);
          } else {
            console.log(`  ${chalk.green('[configured]')} ${type}`);
          }
        }

        console.log('');
        console.log(chalk.dim('  Channels connect when `kyberbot run` starts.'));
        console.log('');
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        console.log(chalk.dim('  Run `kyberbot onboard` first to create identity.yaml.\n'));
      }
    });

  return cmd;
}
