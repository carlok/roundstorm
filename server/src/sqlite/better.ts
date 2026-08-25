import Database from 'better-sqlite3'
import type { RunResult, SqliteDatabase, Statement } from './types.ts'

/**
 * better-sqlite3: a native addon, so it needs a compiled binary per
 * platform-arch. Stable, and the default.
 */
export function openBetterSqlite(path: string): SqliteDatabase {
  const db = new Database(path)

  const wrap = (stmt: Database.Statement): Statement => ({
    run: (...p) => {
      const r = stmt.run(...(p as never[]))
      return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) } satisfies RunResult
    },
    get: (...p) => stmt.get(...(p as never[])),
    all: (...p) => stmt.all(...(p as never[])),
  })

  return {
    backend: 'better-sqlite3',
    sqliteVersion: (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v,
    prepare: sql => wrap(db.prepare(sql)),
    exec: sql => { db.exec(sql) },
    pragma: statement => { db.pragma(statement) },
    close: () => db.close(),
  }
}
