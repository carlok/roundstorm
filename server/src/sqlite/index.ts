import { openBetterSqlite } from './better.ts'
import { openNodeSqlite } from './node.ts'
import type { SqliteDatabase } from './types.ts'

export type { SqliteDatabase, Statement, RunResult } from './types.ts'

/**
 * Which SQLite backend to use.
 *
 * Default is better-sqlite3: stable, and what every run so far has used.
 * `ROUNDSTORM_SQLITE=node` switches to Node's builtin.
 *
 * Both are imported statically. Lazy-loading them would need `require`, which
 * does not exist in this ES module, and a dynamic `import()` would force
 * `openDatabase` to be async — which ripples through db.ts, since it opens the
 * handle at module scope.
 *
 * The consequence: a bundle built today still contains better-sqlite3 even when
 * running on node:sqlite. Dropping the native dependency entirely is one further
 * step — delete `better.ts`, remove the import above and the package — and the
 * point of this layer is that the step is a deletion rather than a migration.
 */
export function openDatabase(path: string): SqliteDatabase {
  const choice = (process.env.ROUNDSTORM_SQLITE ?? 'better').toLowerCase()
  return choice === 'node' || choice === 'node:sqlite'
    ? openNodeSqlite(path)
    : openBetterSqlite(path)
}
