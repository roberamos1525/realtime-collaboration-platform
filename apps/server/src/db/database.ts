import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

export type SqlParams = Record<string, SQLInputValue> | SQLInputValue[];
export type Row = Record<string, SQLInputValue>;

/**
 * Thin wrapper over `node:sqlite` adding a prepared-statement cache, typed
 * helpers and nestable transactions (savepoints).
 */
export class Database {
  readonly raw: DatabaseSync;
  readonly path: string;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;
  private savepointCounter = 0;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") {
      this.raw.exec("PRAGMA journal_mode = WAL");
      this.raw.exec("PRAGMA synchronous = NORMAL");
    }
  }

  private statement(sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  run(sql: string, params: SqlParams = []): { changes: number; lastInsertRowid: number } {
    const stmt = this.statement(sql);
    const result = Array.isArray(params) ? stmt.run(...params) : stmt.run(params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get<T = Row>(sql: string, params: SqlParams = []): T | undefined {
    const stmt = this.statement(sql);
    return (Array.isArray(params) ? stmt.get(...params) : stmt.get(params)) as T | undefined;
  }

  all<T = Row>(sql: string, params: SqlParams = []): T[] {
    const stmt = this.statement(sql);
    return (Array.isArray(params) ? stmt.all(...params) : stmt.all(params)) as T[];
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /**
   * Runs `fn` atomically. Nested calls use savepoints so an inner failure
   * rolls back only the inner block when the caller catches it.
   */
  transaction<T>(fn: () => T): T {
    if (this.depth === 0) {
      this.raw.exec("BEGIN IMMEDIATE");
      this.depth++;
      try {
        const result = fn();
        this.raw.exec("COMMIT");
        return result;
      } catch (err) {
        this.raw.exec("ROLLBACK");
        throw err;
      } finally {
        this.depth--;
      }
    }
    const name = `sp_${++this.savepointCounter}`;
    this.raw.exec(`SAVEPOINT ${name}`);
    this.depth++;
    try {
      const result = fn();
      this.raw.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      this.raw.exec(`ROLLBACK TO ${name}`);
      this.raw.exec(`RELEASE ${name}`);
      throw err;
    } finally {
      this.depth--;
    }
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  close(): void {
    this.statements.clear();
    if (this.raw.isOpen) this.raw.close();
  }
}
