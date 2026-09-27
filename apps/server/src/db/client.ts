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
  constructor(private readonly db: DatabaseSync) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): Statement {
    const s: StatementSync = this.db.prepare(sql);
    return {
      run: (...p: unknown[]) => s.run(...(p as never[])) as unknown as RunResult,
      get: (...p: unknown[]) => s.get(...(p as never[])) as Record<string, unknown> | undefined,
      all: (...p: unknown[]) => s.all(...(p as never[])) as Record<string, unknown>[],
    };
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

  /** Run a function inside a transaction. Throws on error → rollback. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
}

export const db = new Sql(sqlite);

export function closeDb(): void {
  try {
    sqlite.close();
  } catch {
    /* already closed */
  }
}
