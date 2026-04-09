/**
 * Minimal type declarations for sql.js (pure JS/WASM SQLite).
 * Only covers the APIs used by our Database adapter.
 */
declare module 'sql.js' {
  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }

  export interface Database {
    run(sql: string, params?: any[]): void;
    exec(sql: string, params?: any[]): QueryExecResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface Statement {
    bind(params?: any[]): boolean;
    step(): boolean;
    get(params?: any[]): any[];
    getColumnNames(): string[];
    free(): void;
    reset(): void;
  }

  export interface QueryExecResult {
    columns: string[];
    values: any[][];
  }

  export default function initSqlJs(config?: {
    locateFile?: (file: string) => string;
  }): Promise<SqlJsStatic>;
}
