/**
 * SQLite Auto-Recovery
 *
 * First startup runs PRAGMA integrity_check and marks the DB verified.
 * If the DB is corrupt, attempts recovery via the sqlite3 CLI .recover
 * command and falls back to starting fresh.
 */

import Database from 'libsql';
import { existsSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { createLogger } from '../logger.js';

const logger = createLogger('db-recovery');

export function openWithRecovery(dbPath: string): Database.Database {
  const verifiedPath = dbPath + '.verified';

  if (existsSync(verifiedPath)) {
    try {
      return new Database(dbPath);
    } catch {
      try { unlinkSync(verifiedPath); } catch { /* ignore */ }
    }
  }

  try {
    const db = new Database(dbPath);
    const check = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (check[0]?.integrity_check === 'ok') {
      markVerified(verifiedPath);
      return db;
    }
    db.close();
    logger.warn(`Database corruption detected: ${dbPath}`);
  } catch (err) {
    logger.warn(`Database failed to open: ${dbPath}`, { error: String(err) });
  }

  const recoveredPath = dbPath + '.recovered';
  const corruptedPath = dbPath + '.corrupted';

  try {
    logger.info(`Attempting recovery of ${dbPath}...`);
    execSync(`sqlite3 "${dbPath}" ".recover" | sqlite3 "${recoveredPath}"`, {
      timeout: 30_000,
      stdio: 'pipe',
    });

    const recoveredDb = new Database(recoveredPath);
    const check = recoveredDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
    recoveredDb.close();

    if (check[0]?.integrity_check === 'ok') {
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

    unlinkSync(recoveredPath);
    logger.warn('Recovery produced invalid database — starting fresh');
  } catch (err) {
    logger.warn('Recovery via sqlite3 CLI failed', { error: String(err) });
    try { unlinkSync(recoveredPath); } catch { /* ignore */ }
  }

  try {
    if (existsSync(dbPath)) renameSync(dbPath, corruptedPath);
    for (const suffix of ['-wal', '-shm']) {
      try { unlinkSync(dbPath + suffix); } catch { /* may not exist */ }
    }
  } catch { /* ignore */ }

  logger.info(`Starting fresh database: ${dbPath}`);
  const freshDb = new Database(dbPath);
  markVerified(verifiedPath);
  return freshDb;
}

function markVerified(verifiedPath: string): void {
  try {
    writeFileSync(verifiedPath, new Date().toISOString(), 'utf-8');
  } catch { /* non-fatal */ }
}
