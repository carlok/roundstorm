import { openNodeSqlite } from './node.ts'
import type { SqliteDatabase } from './types.ts'

export type { SqliteDatabase, Statement, RunResult } from './types.ts'

/**
 * Storage is Node's built-in SQLite, so the daemon has no native dependency at
 * all — the bundle is a single JavaScript file that runs anywhere Node 22.5+
 * does. That is what makes a multi-platform build tractable.
 *
 * The adapter around it stays. It is what made removing better-sqlite3 a
 * deletion rather than a migration, it keeps the two places the backends
 * disagreed (pragmas, null-prototype rows) in one file, and the next swap —
 * Bun, or a native build wanting sqlite-vec — starts from the same seam.
 *
 * Note the one thing this does not solve: loading any SQLite extension brings
 * per-platform binaries straight back.
 */
export function openDatabase(path: string): SqliteDatabase {
  return openNodeSqlite(path)
}
