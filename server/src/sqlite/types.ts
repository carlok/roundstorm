/**
 * The slice of SQLite this project actually uses.
 *
 * Deliberately small. The daemon only ever prepares statements, runs them, and
 * issues pragmas — so the surface an alternative backend has to satisfy is a
 * dozen lines, not an ORM.
 */

export interface RunResult {
  changes: number
  /** Normalised to `number`; better-sqlite3 can hand back a BigInt. */
  lastInsertRowid: number
}

export interface Statement {
  run(...params: unknown[]): RunResult
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export interface SqliteDatabase {
  prepare(sql: string): Statement
  exec(sql: string): void
  /** `journal_mode = WAL`, not the full `PRAGMA …` statement. */
  pragma(statement: string): void
  close(): void
  /**
   * Write a consistent snapshot to `destPath`.
   *
   * Not a file copy: in WAL mode the newest data lives in the -wal file, which
   * can be larger than the database itself, so copying only the .db yields a
   * stale snapshot that looks plausible. Learned the hard way.
   */
  backup(destPath: string): Promise<void>
  /** For diagnostics: which implementation is behind this handle. */
  readonly backend: 'better-sqlite3' | 'node:sqlite'
  readonly sqliteVersion: string
}
