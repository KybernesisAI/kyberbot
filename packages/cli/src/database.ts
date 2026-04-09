/**
 * SQLite adapter — provides a better-sqlite3-compatible API using sql.js (pure JS/WASM).
 * Eliminates native build requirements (no node-gyp, no Xcode CLT, no platform binaries).
 *
 * Usage: Drop-in replacement — change `import Database from 'better-sqlite3'`
 * to `import { Database } from '../database.js'`
 *
 * IMPORTANT: Call `await initSqlite()` once before creating any Database instances.
 */

import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase, SqlJsStatic } from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';

let SQL: SqlJsStatic | null = null;

/**
 * Initialize the sql.js WASM module. Must be called once at startup
 * before creating any Database instances.
 */
export async function initSqlite(): Promise<void> {
  if (SQL) return;
  SQL = await initSqlJs();
}

/**
 * Convert sql.js result rows ({columns, values}) to an array of objects.
 */
function rowsToObjects(columns: string[], values: any[][]): Record<string, any>[] {
  return values.map((row) => {
    const obj: Record<string, any> = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i]] = row[i];
    }
    return obj;
  });
}

/**
 * Determine if a SQL statement is a write operation that should trigger a flush.
 */
function isWriteStatement(sql: string): boolean {
  const trimmed = sql.trimStart().toUpperCase();
  return (
    trimmed.startsWith('INSERT') ||
    trimmed.startsWith('UPDATE') ||
    trimmed.startsWith('DELETE') ||
    trimmed.startsWith('CREATE') ||
    trimmed.startsWith('ALTER') ||
    trimmed.startsWith('DROP') ||
    trimmed.startsWith('REPLACE')
  );
}

/**
 * A prepared statement wrapper that mimics better-sqlite3's Statement API.
 */
class Statement {
  private db: SqlJsDatabase;
  private sql: string;
  private flushFn: (() => void) | null;

  constructor(db: SqlJsDatabase, sql: string, flushFn: (() => void) | null) {
    this.db = db;
    this.sql = sql;
    this.flushFn = flushFn;
  }

  /**
   * Execute a write statement. Returns { lastInsertRowid, changes }.
   * Positional args match better-sqlite3: .run(val1, val2, val3)
   */
  run(...params: any[]): { lastInsertRowid: number; changes: number } {
    // Flatten if a single array is passed (support both calling conventions)
    const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;

    this.db.run(this.sql, flatParams);

    const lastInsertRowid = (this.db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0] ?? 0) as number;
    const changes = (this.db.exec('SELECT changes()')[0]?.values[0]?.[0] ?? 0) as number;

    // Flush to disk after write (callback handles transaction-awareness)
    if (this.flushFn) {
      this.flushFn();
    }

    return { lastInsertRowid, changes };
  }

  /**
   * Execute a query and return the first row as an object, or undefined.
   * Positional args match better-sqlite3: .get(val1, val2)
   */
  get(...params: any[]): Record<string, any> | undefined {
    const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;

    let stmt;
    try {
      stmt = this.db.prepare(this.sql);
      if (flatParams.length > 0) {
        stmt.bind(flatParams);
      }

      if (stmt.step()) {
        const columns = stmt.getColumnNames();
        const values = stmt.get();
        const obj: Record<string, any> = {};
        for (let i = 0; i < columns.length; i++) {
          obj[columns[i]] = values[i];
        }
        return obj;
      }
      return undefined;
    } finally {
      if (stmt) stmt.free();
    }
  }

  /**
   * Execute a query and return all rows as an array of objects.
   * Positional args match better-sqlite3: .all(val1, val2)
   */
  all(...params: any[]): Record<string, any>[] {
    const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;

    const results = this.db.exec(this.sql, flatParams);
    if (results.length === 0) return [];

    return rowsToObjects(results[0].columns, results[0].values);
  }
}

/**
 * Database class that wraps sql.js with a better-sqlite3-compatible API.
 */
export class Database {
  private db: SqlJsDatabase;
  private filePath: string | null;
  private _open: boolean;
  /** When > 0, suppress auto-flush (we're inside a transaction). */
  private _transactionDepth: number = 0;

  constructor(filePath: string, _options?: { readonly?: boolean }) {
    if (!SQL) {
      throw new Error(
        'sql.js not initialized. Call `await initSqlite()` before creating Database instances.'
      );
    }

    this.filePath = filePath;

    if (existsSync(filePath)) {
      const buffer = readFileSync(filePath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }

    this._open = true;
  }

  get open(): boolean {
    return this._open;
  }

  /**
   * Execute raw SQL (multi-statement). Flushes to disk if any write detected.
   */
  exec(sql: string): void {
    // sql.js db.exec() handles multiple statements; db.run() only handles one.
    this.db.exec(sql);

    if (this.filePath && this._transactionDepth === 0 && isWriteStatement(sql)) {
      this.flush();
    }
  }

  /**
   * Handle PRAGMA statements.
   *
   * Set pragmas:  db.pragma('journal_mode = WAL')
   * Query pragmas: db.pragma('table_info(tableName)') — returns array of objects
   */
  pragma(str: string): any {
    const sql = `PRAGMA ${str}`;

    // Check if this is a query-style pragma (contains parentheses like table_info(...))
    // or an assignment pragma (contains '=')
    const isQuery = str.includes('(') && !str.includes('=');

    if (isQuery) {
      const results = this.db.exec(sql);
      if (results.length === 0) return [];
      return rowsToObjects(results[0].columns, results[0].values);
    }

    // For set pragmas, just execute
    this.db.run(sql);
    return undefined;
  }

  /**
   * Prepare a SQL statement. Returns a Statement-like object.
   */
  prepare(sql: string): Statement {
    // Create a transaction-aware flush callback
    const flushFn = this.filePath
      ? () => {
          if (this._transactionDepth === 0) {
            this.flush();
          }
        }
      : null;
    return new Statement(this.db, sql, flushFn);
  }

  /**
   * Wrap a function in a BEGIN/COMMIT transaction.
   * Returns a new function that, when called, runs the body inside a transaction.
   * Matches better-sqlite3's `db.transaction(fn)` API.
   */
  transaction<T extends (...args: any[]) => any>(fn: T): T {
    const self = this;
    const wrapped = ((...args: any[]) => {
      self._transactionDepth++;
      self.db.run('BEGIN');
      try {
        const result = fn(...args);
        self.db.run('COMMIT');
        self._transactionDepth--;
        // Flush once after the whole transaction, not per-statement
        if (self._transactionDepth === 0 && self.filePath) {
          self.flush();
        }
        return result;
      } catch (err) {
        self.db.run('ROLLBACK');
        self._transactionDepth--;
        throw err;
      }
    }) as unknown as T;
    return wrapped;
  }

  /**
   * Close the database. Flushes any pending data first.
   */
  close(): void {
    if (!this._open) return;

    try {
      this.flush();
    } catch {
      // Best-effort flush on close
    }

    this.db.close();
    this._open = false;
  }

  /**
   * Flush the in-memory database to disk.
   */
  private flush(): void {
    if (!this.filePath) return;
    const data = this.db.export();
    writeFileSync(this.filePath, Buffer.from(data));
  }
}

// Re-export Database as default for maximum compatibility
export default Database;
