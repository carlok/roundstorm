import { DatabaseSync, backup } from 'node:sqlite'
import type { RunResult, SqliteDatabase, Statement } from './types.ts'

/**
 * Node's built-in SQLite. No native dependency at all, which is what makes a
 * multi-platform build tractable — the daemon becomes pure JavaScript.
 *
 * Two differences have to be smoothed over:
 *  - there is no `pragma()` helper, only `exec('PRAGMA …')`
 *  - rows come back as null-prototype objects, which behave oddly under spread
 *    and `instanceof`, so they are copied into ordinary ones
 *
 * Still flagged experimental, so this is opt-in via ROUNDSTORM_SQLITE=node.
 */
export function openNodeSqlite(path: string): SqliteDatabase {
  const db = new DatabaseSync(path)

  const plain = (row: unknown): unknown =>
    row && typeof row === 'object' ? { ...(row as Record<string, unknown>) } : row

  const wrap = (stmt: ReturnType<DatabaseSync['prepare']>): Statement => ({
    run: (...p) => {
      const r = stmt.run(...(p as never[]))
      return {
        changes: Number(r.changes),
        lastInsertRowid: Number(r.lastInsertRowid),
      } satisfies RunResult
    },
    get: (...p) => plain(stmt.get(...(p as never[]))),
    all: (...p) => (stmt.all(...(p as never[])) as unknown[]).map(plain),
  })

  return {
    backend: 'node:sqlite',
    sqliteVersion: ((db.prepare('SELECT sqlite_version() AS v').get() as any).v) as string,
    prepare: sql => wrap(db.prepare(sql)),
    exec: sql => { db.exec(sql) },
    pragma: statement => { db.exec(`PRAGMA ${statement}`) },
    close: () => db.close(),
    backup: async destPath => { await backup(db, destPath) },
  }
}
