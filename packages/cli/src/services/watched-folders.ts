/**
 * Watched Folders Service
 *
 * Scans configured directories on an interval, ingests new/changed files
 * into the brain pipeline, and cleans up deleted files.
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'fs';
import { join, relative, extname, basename } from 'path';
import { createLogger } from '../logger.js';
import { getIdentity, getRoot } from '../config.js';
import { storeConversation } from '../brain/store-conversation.js';
import { removeFromTimeline } from '../brain/timeline.js';
import type { ServiceHandle } from '../types.js';

const logger = createLogger('watched-folders');

const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const DEFAULT_EXTENSIONS = new Set(['.md', '.txt', '.yaml', '.yml', '.json', '.csv']);

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.DS_Store',
  '__pycache__', '.venv', 'venv', '.next', 'dist', 'build',
]);

interface SyncEntry {
  mtime: number;
  size: number;
  source_path: string;
  last_synced: string;
}

type SyncState = Record<string, Record<string, SyncEntry>>;

function getSyncStatePath(root: string): string {
  return join(root, 'data', 'watched_folders_state.json');
}

function loadSyncState(root: string): SyncState {
  const path = getSyncStatePath(root);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSyncState(root: string, state: SyncState): void {
  const path = getSyncStatePath(root);
  const dir = join(root, 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/**
 * Recursively walk a directory, returning file paths that match the allowed extensions.
 */
function walkDir(dir: string, extensions: Set<string>, files: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, extensions, files);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (extensions.has(ext)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

/**
 * Build a source_path URI for a watched file.
 */
function buildSourcePath(folderLabel: string, folderPath: string, filePath: string): string {
  const rel = relative(folderPath, filePath);
  return `file://watched/${folderLabel}/${rel}`;
}

/**
 * Remove a file's data from all brain stores.
 * The actual DB source_path is channel://watched-folder/{uuid}, not the file:// path.
 * We find matching records by looking up timeline entries with the filename in the title.
 */
async function cleanupFile(root: string, sourcePath: string, relPath: string): Promise<void> {
  const fileName = relPath.split('/').pop() || relPath;

  // Find the actual channel:// source paths from timeline by matching title
  let channelSourcePaths: string[] = [];
  try {
    const { getTimelineDb } = await import('../brain/timeline.js');
    const tdb = await getTimelineDb(root);
    const rows = tdb.prepare(
      `SELECT source_path FROM timeline_events WHERE source_path LIKE 'channel://watched-folder/%' AND title LIKE ?`
    ).all(`%${fileName}%`) as Array<{ source_path: string }>;
    channelSourcePaths = rows.map(r => r.source_path);

    // Delete timeline entries
    for (const sp of channelSourcePaths) {
      tdb.prepare('DELETE FROM timeline_events WHERE source_path = ?').run(sp);
    }

    // Also delete facts
    for (const sp of channelSourcePaths) {
      tdb.prepare('DELETE FROM facts WHERE source_path LIKE ?').run(`%${sp}%`);
    }

    logger.debug('Cleaned timeline + facts', { fileName, count: channelSourcePaths.length });
  } catch (err) {
    logger.debug('Failed to remove timeline/facts', { sourcePath, error: String(err) });
  }

  // Entity mentions — delete by the channel source paths, then prune orphaned entities
  if (channelSourcePaths.length > 0) {
    try {
      const { getEntityGraphDb } = await import('../brain/entity-graph.js');
      const db = await getEntityGraphDb(root);

      for (const sp of channelSourcePaths) {
        // Get entity IDs that have mentions from this source
        const affectedEntities = db.prepare(
          'SELECT DISTINCT entity_id FROM entity_mentions WHERE source_path = ?'
        ).all(sp) as Array<{ entity_id: number }>;

        // Delete the mentions
        db.prepare('DELETE FROM entity_mentions WHERE source_path = ?').run(sp);

        // Prune entities that now have zero mentions
        for (const { entity_id } of affectedEntities) {
          const remaining = db.prepare(
            'SELECT COUNT(*) as count FROM entity_mentions WHERE entity_id = ?'
          ).get(entity_id) as { count: number };

          if (remaining.count === 0) {
            db.prepare('DELETE FROM entity_relations WHERE source_id = ? OR target_id = ?').run(entity_id, entity_id);
            db.prepare('DELETE FROM entities WHERE id = ?').run(entity_id);
            logger.debug('Pruned orphaned entity', { entity_id });
          } else {
            db.prepare('UPDATE entities SET mention_count = ? WHERE id = ?').run(remaining.count, entity_id);
          }
        }
      }
    } catch (err) {
      logger.debug('Failed to remove entity mentions', { sourcePath, error: String(err) });
    }
  }
}

/**
 * Read file content based on extension.
 */
function readFileContent(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  try {
    if (ext === '.pdf') {
      // PDF support requires pdf-parse — skip if not available
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pdfParse = require('pdf-parse');
        const buffer = readFileSync(filePath);
        // pdf-parse is async but we need sync here — skip PDFs for now
        // TODO: add async PDF support
        logger.debug('PDF files not yet supported', { filePath });
        return null;
      } catch {
        return null;
      }
    }
    // Text-based files
    return readFileSync(filePath, 'utf-8');
  } catch (err) {
    logger.debug('Failed to read file', { filePath, error: String(err) });
    return null;
  }
}

/**
 * Run one sync cycle for all watched folders.
 */
async function syncCycle(root: string): Promise<{ ingested: number; deleted: number; errors: number }> {
  let identity;
  try {
    identity = getIdentity();
  } catch {
    // Can't read identity — skip this cycle
    return { ingested: 0, deleted: 0, errors: 0 };
  }

  const folders = identity.watched_folders?.filter(f => f.enabled !== false) || [];
  if (folders.length === 0) return { ingested: 0, deleted: 0, errors: 0 };

  const state = loadSyncState(root);
  let ingested = 0;
  let deleted = 0;
  let errors = 0;

  for (const folder of folders) {
    if (!existsSync(folder.path)) {
      logger.warn('Watched folder not found, skipping', { path: folder.path });
      continue;
    }

    const label = folder.label || basename(folder.path);
    const extensions = folder.extensions
      ? new Set(folder.extensions.map(e => e.startsWith('.') ? e : `.${e}`))
      : DEFAULT_EXTENSIONS;

    // Get current files on disk
    const diskFiles = walkDir(folder.path, extensions);
    const diskFileSet = new Set(diskFiles);

    // Initialize folder state if needed
    if (!state[folder.path]) state[folder.path] = {};
    const folderState = state[folder.path];

    // Check for new and changed files
    for (const filePath of diskFiles) {
      try {
        const stats = statSync(filePath);
        const relPath = relative(folder.path, filePath);
        const existing = folderState[relPath];

        // Skip if unchanged
        if (existing && existing.mtime === stats.mtimeMs && existing.size === stats.size) {
          continue;
        }

        // Read content
        const content = readFileContent(filePath);
        if (!content) continue;

        // Cap file size at 100KB to avoid overwhelming the pipeline
        if (content.length > 100_000) {
          logger.debug('File too large, skipping', { filePath, size: content.length });
          continue;
        }

        const sourcePath = buildSourcePath(label, folder.path, filePath);

        // If this is an update, clean up old data first
        if (existing) {
          await cleanupFile(root, existing.source_path, relPath);
        }

        // Ingest
        const fileName = basename(filePath);
        await storeConversation(root, {
          prompt: `File: ${relPath}`,
          response: content,
          channel: 'watched-folder',
          timestamp: new Date(stats.mtimeMs).toISOString(),
          metadata: {
            file_path: filePath,
            file_name: fileName,
            folder_label: label,
            folder_path: folder.path,
            extension: extname(filePath),
            source_path: sourcePath,
          },
        }, {
          entityStoplist: identity.memory?.entity_stoplist,
        });

        // Update sync state
        folderState[relPath] = {
          mtime: stats.mtimeMs,
          size: stats.size,
          source_path: sourcePath,
          last_synced: new Date().toISOString(),
        };

        ingested++;
        logger.info(`Ingested: ${relPath}`, { folder: label, action: existing ? 'updated' : 'new' });
      } catch (err) {
        errors++;
        logger.error('Failed to process file', { filePath, error: String(err) });
      }
    }

    // Check for deleted files
    const stateKeys = Object.keys(folderState);
    for (const relPath of stateKeys) {
      const fullPath = join(folder.path, relPath);
      if (!diskFileSet.has(fullPath)) {
        try {
          await cleanupFile(root, folderState[relPath].source_path, relPath);
          delete folderState[relPath];
          deleted++;
          logger.info(`Cleaned up deleted file: ${relPath}`, { folder: label });
        } catch (err) {
          errors++;
          logger.error('Failed to cleanup deleted file', { relPath, error: String(err) });
        }
      }
    }
  }

  // Clean up state for folders that are no longer watched
  const watchedPaths = new Set(folders.map(f => f.path));
  for (const path of Object.keys(state)) {
    if (!watchedPaths.has(path)) {
      // Clean up all files from this folder
      for (const [relPath, entry] of Object.entries(state[path])) {
        try { await cleanupFile(root, entry.source_path, relPath); } catch {}
      }
      delete state[path];
    }
  }

  saveSyncState(root, state);
  return { ingested, deleted, errors };
}

/**
 * Start the watched folders service.
 */
export async function startWatchedFolders(root: string): Promise<ServiceHandle> {
  let running = true;
  let timer: ReturnType<typeof setTimeout> | null = null;

  logger.info('Watched folders service started');

  // Initial sync after a short delay (let other services start first)
  const initialDelay = setTimeout(async () => {
    if (!running) return;
    try {
      const result = await syncCycle(root);
      if (result.ingested > 0 || result.deleted > 0) {
        logger.info('Initial sync complete', result);
      }
    } catch (err) {
      logger.error('Initial sync failed', { error: String(err) });
    }
    scheduleNext();
  }, 10_000);

  function scheduleNext() {
    if (!running) return;
    timer = setTimeout(async () => {
      if (!running) return;
      try {
        const result = await syncCycle(root);
        if (result.ingested > 0 || result.deleted > 0) {
          logger.info('Sync cycle complete', result);
        }
      } catch (err) {
        logger.error('Sync cycle failed', { error: String(err) });
      }
      scheduleNext();
    }, SCAN_INTERVAL_MS);
  }

  return {
    stop: async () => {
      running = false;
      if (timer) clearTimeout(timer);
      clearTimeout(initialDelay);
      logger.info('Watched folders service stopped');
    },
    status: () => running ? 'running' : 'stopped',
  };
}

/**
 * Get sync status for all watched folders (for management API).
 */
export function getWatchedFoldersStatus(root: string): Array<{
  path: string;
  label: string;
  enabled: boolean;
  fileCount: number;
  lastSync: string | null;
}> {
  let identity;
  try { identity = getIdentity(); } catch { return []; }

  const folders = identity.watched_folders || [];
  const state = loadSyncState(root);

  return folders.map(f => {
    const folderState = state[f.path] || {};
    const entries = Object.values(folderState);
    const lastSync = entries.length > 0
      ? entries.reduce((latest, e) => e.last_synced > latest ? e.last_synced : latest, '')
      : null;

    return {
      path: f.path,
      label: f.label || basename(f.path),
      enabled: f.enabled !== false,
      fileCount: entries.length,
      lastSync,
    };
  });
}
