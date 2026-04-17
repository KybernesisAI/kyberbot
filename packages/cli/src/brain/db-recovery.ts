/**
 * SQLite Auto-Recovery
 *
 * Detects corrupted databases and recovers them automatically.
 * Used by all DB modules on initialization. The sql.js migration
 * (v1.3.0-v1.3.1) corrupted some databases via Buffer pooling.
 * This ensures affected users recover transparently on next startup.
 *
 * After a database passes integrity check (or is recovered), a
 * .verified marker file is written. Subsequent startups skip the
 * integrity check entirely — no repeated work on healthy databases.
 */

import Database from 'better-sqlite3';
import { existsSync, renameSync, unlinkSync, writeFileSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { createLogger } from '../logger.js';

const logger = createLogger('db-recovery');

/**
 * Open a SQLite database with one-time corruption recovery.
 *
 * First startup: runs PRAGMA integrity_check. If healthy, writes a
 * .verified marker so future startups skip the check entirely.
 * If corrupted, recovers via sqlite3 .recover, then marks verified.
 *
 * @param dbPath Full path to the .db file
 * @returns A healthy Database instance
 */
export function openWithRecovery(dbPath: string): Database.Database {
  const verifiedPath = dbPath + '.verified';

  // If already verified in a previous run, skip integrity check
  if (existsSync(verifiedPath)) {
    try {
      return new Database(dbPath);
    } catch (err) {
      // Native module mismatch — don't touch the DB files, just throw
      if (isNativeModuleError(err)) {
        throw err;
      }
      // File was deleted or moved since verification — re-check below
      try { unlinkSync(verifiedPath); } catch { /* ignore */ }
    }
  }

  // First run or re-check needed: open + integrity check
  try {
    const db = new Database(dbPath);
    const check = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (check[0]?.integrity_check === 'ok') {
      markVerified(verifiedPath);
      return db; // Healthy
    }
    db.close();
    logger.warn(`Database corruption detected: ${dbPath}`);
  } catch (err) {
    // Native module mismatch (NODE_MODULE_VERSION, wrong arch, etc.)
    // is NOT a DB problem — don't attempt recovery, don't touch data files.
    // The fix is `pnpm rebuild better-sqlite3` + restart, not data recovery.
    if (isNativeModuleError(err)) {
      logger.error(
        `better-sqlite3 native module mismatch — run: cd ~/.kyberbot/source && pnpm rebuild better-sqlite3 && then restart the agent`,
        { error: String(err) },
      );
      throw err;
    }
    logger.warn(`Database failed to open: ${dbPath}`, { error: String(err) });
  }

  // Attempt recovery via sqlite3 CLI (.recover command)
  const recoveredPath = dbPath + '.recovered';
  const corruptedPath = dbPath + '.corrupted';

  try {
    logger.info(`Attempting recovery of ${dbPath}...`);
    execSync(`sqlite3 "${dbPath}" ".recover" | sqlite3 "${recoveredPath}"`, {
      timeout: 30_000,
      stdio: 'pipe',
    });

    // Verify recovered DB
    const recoveredDb = new Database(recoveredPath);
    const check = recoveredDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
    recoveredDb.close();

    if (check[0]?.integrity_check === 'ok') {
      // Swap files — also remove stale WAL/SHM from the corrupted original
      renameSync(dbPath, corruptedPath);
      renameSync(recoveredPath, dbPath);
      for (const suffix of ['-wal', '-shm']) {
        try { unlinkSync(dbPath + suffix); } catch { /* may not exist */ }
        try { unlinkSync(corruptedPath + suffix); } catch { /* may not exist */ }
      }
      logger.info(`Recovery successful: ${dbPath} (corrupted file saved as .corrupted)`);
      markVerified(verifiedPath);
      return new Database(dbPath);
    }

    // Recovery produced another bad file
    unlinkSync(recoveredPath);
    logger.warn('Recovery produced invalid database — starting fresh');
  } catch (err) {
    // If recovery itself hits a native module error, bail out completely
    if (isNativeModuleError(err)) throw err;
    logger.warn('Recovery via sqlite3 CLI failed', { error: String(err) });
    try { unlinkSync(recoveredPath); } catch { /* ignore */ }
  }

  // Last resort: rename corrupted file and start fresh
  try {
    if (existsSync(dbPath)) {
      renameSync(dbPath, corruptedPath);
    }
    for (const suffix of ['-wal', '-shm']) {
      try { unlinkSync(dbPath + suffix); } catch { /* may not exist */ }
    }
  } catch { /* ignore */ }

  logger.info(`Starting fresh database: ${dbPath}`);
  const freshDb = new Database(dbPath);
  markVerified(verifiedPath);
  return freshDb;
}

/**
 * Detect errors caused by native module version mismatch rather than
 * actual database corruption. These should NOT trigger data recovery.
 */
function isNativeModuleError(err: unknown): boolean {
  const msg = String(err);
  return msg.includes('NODE_MODULE_VERSION')
    || msg.includes('was compiled against a different Node.js version')
    || msg.includes('not a valid Win32 application')
    || msg.includes('invalid ELF header');
}

/** Write a marker file so we skip integrity checks on future startups */
function markVerified(verifiedPath: string): void {
  try {
    writeFileSync(verifiedPath, new Date().toISOString(), 'utf-8');
  } catch { /* non-fatal */ }
}
