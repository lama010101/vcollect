// =============================================================================
// DB client — built-in node:sqlite (no native build deps).
//
// We use Node's built-in `node:sqlite` (DatabaseSync) instead of better-sqlite3
// to avoid native compilation on boxes without a VC++ toolset. The API surface
// we use (exec / prepare / run / get / all) is nearly identical.
//
// A thin typed wrapper (`Sql`) is exported so call sites stay clean and get
// row type-safety via generics. All queries use positional `?` params.
// =============================================================================

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PATHS } from "../config.js";

// Ensure the database directory exists before opening.
mkdirSync(dirname(PATHS.database), { recursive: true });

// node:sqlite is experimental in Node 24; suppress the noisy warning once.
const origEmit = process.emitWarning.bind(process);
process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  if (typeof warning === "string" && warning.includes("SQLite is an experimental feature")) {
    return;
  }
  return origEmit(warning as string, ...(rest as []));
}) as typeof process.emitWarning;

export const sqlite = new DatabaseSync(PATHS.database);
sqlite.exec("PRAGMA journal_mode = WAL");
sqlite.exec("PRAGMA foreign_keys = ON");

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

/** Thin wrapper exposing typed helpers over a prepared statement. */
export class Sql {
  /** Nesting depth of open transaction() calls — 0 = no open transaction. */
  private txDepth = 0;
  /** Prepared statements are reusable, so cache them by SQL text: run/get/all
   *  route through prepare() and hot paths shouldn't re-prepare every call. */
  private readonly stmtCache = new Map<string, Statement>();

  constructor(private readonly db: DatabaseSync) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): Statement {
    const cached = this.stmtCache.get(sql);
    if (cached) return cached;
    const s: StatementSync = this.db.prepare(sql);
    const stmt: Statement = {
      run: (...p: unknown[]) => s.run(...(p as never[])) as unknown as RunResult,
      get: (...p: unknown[]) => s.get(...(p as never[])) as Record<string, unknown> | undefined,
      all: (...p: unknown[]) => s.all(...(p as never[])) as Record<string, unknown>[],
    };
    this.stmtCache.set(sql, stmt);
    return stmt;
  }

  run(sql: string, ...params: unknown[]): RunResult {
    return this.prepare(sql).run(...params);
  }

  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.prepare(sql).all(...params) as T[];
  }

  /** Run a function inside a transaction. Throws on error → rollback.
   *  Reentrant: nested calls run inside a SAVEPOINT instead of a bare BEGIN,
   *  so repository helpers that open their own transaction (e.g. deleteShot)
   *  can be called from a caller's transaction. An inner throw rolls back
   *  only the inner unit; the outer transaction may continue or rethrow. */
  transaction<T>(fn: () => T): T {
    const depth = this.txDepth;
    const outer = depth === 0;
    const sp = `twio_sp_${depth}`;
    this.db.exec(outer ? "BEGIN" : `SAVEPOINT ${sp}`);
    this.txDepth = depth + 1;
    try {
      const result = fn();
      // Restore depth BEFORE COMMIT/RELEASE so a failed commit can't leave it
      // wrong; assigning `depth` (not decrementing) keeps the catch idempotent.
      this.txDepth = depth;
      this.db.exec(outer ? "COMMIT" : `RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (err) {
      this.txDepth = depth;
      try {
        if (outer) {
          this.db.exec("ROLLBACK");
        } else {
          // RELEASE after ROLLBACK TO so the savepoint name can be reused.
          this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
          this.db.exec(`RELEASE SAVEPOINT ${sp}`);
        }
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  /** Close the underlying connection (clears the statement cache first). */
  close(): void {
    this.stmtCache.clear();
    this.db.close();
  }
}

export const db = new Sql(sqlite);

export function closeDb(): void {
  try {
    db.close();
  } catch {
    /* already closed */
  }
}
