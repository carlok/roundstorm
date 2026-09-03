/**
 * Schema changes on a database that already exists.
 *
 * `db.ts` creates the schema with one `CREATE TABLE IF NOT EXISTS` block. That
 * handles a *new* table on an old database and nothing else: a new **column**
 * never appears, and the first query naming it throws at import — before
 * `listen()` — so the daemon does not start at all. The user's research is in
 * `~/Library/Application Support/Roundstorm`, so that failure mode is fatal.
 *
 * The rule this establishes: **the CREATE block in `db.ts` is frozen as the v0
 * baseline.** Every column added from here lives only in a migration, which runs
 * on fresh and existing databases alike. Adding it in both places makes the
 * `ALTER` throw `duplicate column name` on a fresh database.
 *
 * Migrations are TypeScript, not `.sql` files: `scripts/build-server.mjs` bundles
 * the daemon into a single `.mjs`, so a `readFileSync` would work in development
 * and break in the packaged sidecar.
 */
import type { SqliteDatabase } from './types.ts'

export interface Migration {
  /** Matches the `user_version` this migration produces. Never reordered. */
  readonly version: number
  readonly name: string
  /** Skip when the change is already present, so a lost user_version is survivable. */
  needed(db: SqliteDatabase): boolean
  up(db: SqliteDatabase): void
}

const hasColumn = (db: SqliteDatabase, table: string, column: string): boolean =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .some(c => c.name === column)

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'position_ops.deliberation_id',
    needed: db => !hasColumn(db, 'position_ops', 'deliberation_id'),
    up: db => {
      db.exec('ALTER TABLE position_ops ADD COLUMN deliberation_id TEXT')
      // Backfill rather than leave history blank. Every op recorded by the real
      // path carries the message it came from, and that message knows its run —
      // so an existing room keeps its ledger, and a deliberation in flight across
      // the upgrade does not lose the positions it has already taken.
      db.exec(`UPDATE position_ops SET deliberation_id = (
                 SELECT m.deliberation_id FROM messages m WHERE m.id = position_ops.message_id
               ) WHERE message_id IS NOT NULL`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_ops_position_delib
               ON position_ops(position_id, deliberation_id, id)`)
    },
  },
]

const readVersion = (db: SqliteDatabase): number =>
  Number((db.prepare('PRAGMA user_version').get() as { user_version?: number })?.user_version ?? 0)

/**
 * Bring a database up to the current schema. Idempotent.
 *
 * A `user_version` ahead of what this build knows is logged and left alone: every
 * migration here adds something nullable, so an older build reads a newer
 * database fine, and refusing to boot would turn a cosmetic mismatch into a dead
 * app for someone who just downgraded.
 */
export function migrate(db: SqliteDatabase): { from: number; to: number; applied: string[] } {
  const from = readVersion(db)
  const applied: string[] = []

  for (const m of MIGRATIONS) {
    if (m.version <= from) continue
    if (m.needed(db)) {
      // No `transaction()` on the adapter, so the boundary is written by hand.
      db.exec('BEGIN')
      try {
        m.up(db)
        // PRAGMA takes no bound parameter, so this is interpolated — the value is
        // the migration's own integer literal and never comes from input.
        db.exec(`PRAGMA user_version = ${m.version}`)
        db.exec('COMMIT')
      } catch (e) {
        try { db.exec('ROLLBACK') } catch { /* nothing to roll back */ }
        throw e
      }
      applied.push(m.name)
    } else {
      // Already present — record the version so it is not reconsidered.
      db.exec(`PRAGMA user_version = ${m.version}`)
    }
  }

  const latest = MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].version : 0
  if (from > latest) {
    console.warn(`database is at schema v${from}, this build knows v${latest} — continuing`)
    return { from, to: from, applied }
  }
  return { from, to: readVersion(db), applied }
}
