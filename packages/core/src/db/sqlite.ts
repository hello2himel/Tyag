/**
 * Thin, typed wrapper around SQLite (compiled to WebAssembly via sql.js).
 *
 * The same driver runs in the browser (including the Capacitor WebViews and
 * Electron) and under Node during tests, which is why the production database
 * code is what the test suite exercises. Persistence is separate: the database
 * lives in memory and is exported as bytes after each committed transaction,
 * then stored by a platform adapter (IndexedDB / filesystem / Electron IPC).
 */
import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase, SqlJsStatic } from 'sql.js';

export type SqlValue = string | number | null | Uint8Array;
export type SqlParams = SqlValue[] | Record<string, SqlValue>;

export interface LoadSqlJsOptions {
  wasmBinary?: ArrayBuffer;
  locateFile?: (file: string, prefix: string) => string;
}

/** Load the SQLite WASM engine. The caller supplies the wasm binary or a locator. */
export async function loadSqlJs(options: LoadSqlJsOptions = {}): Promise<SqlJsStatic> {
  return initSqlJs({
    wasmBinary: options.wasmBinary,
    locateFile: options.locateFile,
  });
}

export class SqlDatabase {
  private readonly db: SqlJsDatabase;
  private transactionDepth = 0;

  constructor(db: SqlJsDatabase) {
    this.db = db;
    this.db.run('PRAGMA foreign_keys = ON;');
    this.db.run('PRAGMA journal_mode = MEMORY;');
    this.db.run('PRAGMA synchronous = NORMAL;');
  }

  static fromBytes(SQL: SqlJsStatic, bytes: Uint8Array | null): SqlDatabase {
    return new SqlDatabase(bytes ? new SQL.Database(bytes) : new SQL.Database());
  }

  /** Execute one or more SQL statements without binding parameters. */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** Execute a write statement with bound parameters. */
  run(sql: string, params: SqlParams = []): void {
    this.db.run(sql, params as never);
  }

  /** Query and map rows. */
  all<T>(sql: string, params: SqlParams = []): T[] {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params as never);
      const rows: T[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  get<T>(sql: string, params: SqlParams = []): T | undefined {
    const rows = this.all<T>(sql, params);
    return rows[0];
  }

  /**
   * Run `fn` inside a transaction. Nested calls use savepoints. Any thrown
   * error rolls back to the transaction (or savepoint) start, so a failed
   * multi-record operation can never leave a partial import behind.
   */
  transaction<T>(fn: () => T): T {
    if (this.transactionDepth === 0) {
      this.db.run('BEGIN IMMEDIATE;');
    } else {
      this.db.run(`SAVEPOINT deurge_sp_${this.transactionDepth};`);
    }
    this.transactionDepth += 1;
    try {
      const result = fn();
      this.transactionDepth -= 1;
      if (this.transactionDepth === 0) {
        this.db.run('COMMIT;');
      } else {
        this.db.run(`RELEASE deurge_sp_${this.transactionDepth};`);
      }
      return result;
    } catch (error) {
      this.transactionDepth -= 1;
      if (this.transactionDepth === 0) {
        try {
          this.db.run('ROLLBACK;');
        } catch {
          /* rollback failure leaves the in-memory snapshot untouched */
        }
      } else {
        try {
          this.db.run(`ROLLBACK TO deurge_sp_${this.transactionDepth};`);
          this.db.run(`RELEASE deurge_sp_${this.transactionDepth};`);
        } catch {
          /* ignore */
        }
      }
      throw error;
    }
  }

  /** Raw database bytes — the exact snapshot a persistence adapter stores. */
  export(): Uint8Array {
    return this.db.export();
  }

  integrityCheck(): string {
    const row = this.get<Record<string, string>>('PRAGMA integrity_check;');
    return row ? String(Object.values(row)[0] ?? 'unknown') : 'unknown';
  }

  close(): void {
    this.db.close();
  }
}
