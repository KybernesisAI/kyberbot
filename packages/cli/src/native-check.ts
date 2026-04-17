/**
 * Native Module Startup Guard
 *
 * Verifies that better-sqlite3's compiled native addon matches the
 * running Node.js ABI version. If mismatched, auto-rebuilds and
 * re-executes the process transparently.
 *
 * Why this exists: better-sqlite3 is a C++ addon compiled against a
 * specific NODE_MODULE_VERSION. If the user switches Node versions
 * (via nvm, brew, etc.) the compiled binary becomes incompatible.
 * Without this guard, every DB open attempt crashes and the recovery
 * code can destroy user data thinking the databases are corrupted.
 */

import { execFileSync, execSync } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Check if better-sqlite3 can load. If not, rebuild and re-exec.
 * Returns true if the CLI should continue, false if it should exit.
 */
export function ensureNativeModules(): boolean {
  try {
    const require = createRequire(import.meta.url);
    require('better-sqlite3');
    return true;
  } catch (err: any) {
    if (!isNativeModuleError(err)) return true;

    console.error('\n  better-sqlite3 native module mismatch detected.');
    console.error(`  Compiled ABI does not match Node ${process.version}.`);
    console.error('  Rebuilding automatically...\n');

    const sourceDir = resolveSourceDir();
    if (!sourceDir) {
      console.error('  Could not find KyberBot source directory.');
      console.error('  Fix manually: cd ~/.kyberbot/source && pnpm rebuild better-sqlite3');
      console.error('  Then restart the agent.\n');
      process.exit(1);
    }

    try {
      const usePnpm = existsSync(join(sourceDir, 'pnpm-lock.yaml'));
      const pm = usePnpm ? 'pnpm' : 'npm';
      execSync(`${pm} rebuild better-sqlite3`, {
        cwd: sourceDir,
        stdio: 'inherit',
        timeout: 60_000,
      });

      // Lock the current Node binary so the wrapper uses it too
      try {
        const lockFile = join(homedir(), '.kyberbot', 'node_path');
        writeFileSync(lockFile, process.execPath, 'utf-8');
      } catch { /* non-fatal */ }

      console.error('\n  Rebuild successful. Restarting...\n');

      // Re-exec with the same arguments
      try {
        execFileSync(process.execPath, process.argv.slice(1), {
          stdio: 'inherit',
          env: process.env,
        });
      } catch { /* child exit code propagated */ }
      process.exit(0);
    } catch {
      console.error(`\n  Auto-rebuild failed.`);
      console.error(`  Fix manually: cd ${sourceDir} && pnpm rebuild better-sqlite3`);
      console.error('  Then restart the agent.\n');
      process.exit(1);
    }
  }
}

function isNativeModuleError(err: unknown): boolean {
  const msg = String(err);
  return msg.includes('NODE_MODULE_VERSION')
    || msg.includes('was compiled against a different Node.js version')
    || msg.includes('invalid ELF header')
    || msg.includes('not a valid Win32 application');
}

function resolveSourceDir(): string | null {
  const home = homedir();

  // Standard install: ~/.kyberbot/source
  const standard = join(home, '.kyberbot', 'source');
  if (existsSync(join(standard, 'package.json'))) return standard;

  // npm link / monorepo: walk up from dist/ to repo root
  const candidate = join(__dirname, '..', '..', '..', '..');
  if (existsSync(join(candidate, 'packages', 'cli', 'package.json'))) return candidate;

  return null;
}
