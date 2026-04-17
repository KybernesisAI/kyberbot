#!/usr/bin/env -S node --max-old-space-size=16384

/**
 * KyberBot CLI — Entry Point
 *
 * This file is intentionally minimal. It runs the native module guard
 * BEFORE importing any code that depends on better-sqlite3, then
 * dynamically imports the actual CLI.
 *
 * ESM hoists all static imports before executing module-level code,
 * so the guard must live in a separate phase from the main CLI imports.
 */

import { ensureNativeModules } from './native-check.js';

if (ensureNativeModules()) {
  // Native modules are good — load the CLI
  await import('./cli.js');
}
