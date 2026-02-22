#!/usr/bin/env node

/**
 * create-kyberbot
 *
 * Usage: npx create-kyberbot my-agent
 *
 * Creates a new KyberBot agent instance by copying the template
 * and running the onboard wizard.
 */

import { program } from 'commander';
import { cpSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';

program
  .name('create-kyberbot')
  .description('Create a new KyberBot agent instance')
  .version('0.1.0')
  .argument('[directory]', 'Directory name for the new agent', 'my-agent')
  .option('--skip-install', 'Skip npm install')
  .option('--skip-onboard', 'Skip the onboard wizard')
  .action(async (directory: string, options: { skipInstall?: boolean; skipOnboard?: boolean }) => {
    const targetDir = resolve(directory);

    console.log();
    console.log('  Creating KyberBot agent...');
    console.log();

    // Check if directory exists
    if (existsSync(targetDir)) {
      console.error(`  Error: Directory already exists: ${targetDir}`);
      process.exit(1);
    }

    // Find template directory
    const templateDir = findTemplateDir();
    if (!templateDir) {
      console.error('  Error: Could not find template directory');
      process.exit(1);
    }

    // Copy template
    console.log(`  Copying template to ${targetDir}...`);
    mkdirSync(targetDir, { recursive: true });
    cpSync(templateDir, targetDir, { recursive: true });

    // Initialize git
    console.log('  Initializing git repository...');
    try {
      execSync('git init', { cwd: targetDir, stdio: 'ignore' });
      execSync('git add .', { cwd: targetDir, stdio: 'ignore' });
      execSync('git commit -m "Initial KyberBot setup"', { cwd: targetDir, stdio: 'ignore' });
    } catch {
      console.log('  Warning: git init failed (non-fatal)');
    }

    // Install dependencies
    if (!options.skipInstall) {
      console.log('  Installing dependencies...');
      try {
        execSync('npm install', { cwd: targetDir, stdio: 'inherit' });
      } catch {
        console.log('  Warning: npm install failed. Run it manually.');
      }
    }

    console.log();
    console.log('  Done! Your KyberBot agent is ready.');
    console.log();
    console.log(`  Next steps:`);
    console.log(`    cd ${directory}`);

    if (options.skipOnboard) {
      console.log('    kyberbot onboard   # Set up your agent');
    } else {
      console.log('    kyberbot onboard   # Set up your agent identity');
    }

    console.log('    claude             # Start talking to your agent');
    console.log();
  });

function findTemplateDir(): string | null {
  // Try relative to this script (when installed via npm)
  const candidates = [
    join(__dirname, '..', '..', '..', 'template'),
    join(__dirname, '..', 'template'),
    join(__dirname, '..', '..', 'template'),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'identity.yaml'))) {
      return candidate;
    }
  }

  return null;
}

program.parse();
