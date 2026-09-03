/**
 * Migrations against a database built by the OLD schema.
 *
 * The fixture below is a frozen copy of the pre-migration DDL, pasted rather than
 * imported on purpose: the real old schema lives in git history, and a fixture
 * that tracked `db.ts` would silently stop testing anything the moment the
 * baseline changed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from './index.ts'
import { migrate, MIGRATIONS } from './migrate.ts'
import type { SqliteDatabase } from './types.ts'

/** The shape of these four tables before any migration existed. */
const OLD_SCHEMA = `
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  deliberation_id TEXT,
  body TEXT NOT NULL DEFAULT ''
);
CREATE TABLE positions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  label TEXT NOT NULL,
  title TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE position_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  agent_id TEXT,
  op TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  message_id TEXT,
  round INTEGER,
  created_at INTEGER NOT NULL
);
`

function oldDatabase(): SqliteDatabase {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'rs-migrate-')), 'old.db'))
  db.exec(OLD_SCHEMA)
  db.exec(`
    INSERT INTO messages (id, room_id, deliberation_id) VALUES ('m1', 'r1', 'd1');
    INSERT INTO positions (id, room_id, label, title) VALUES ('p1', 'r1', 'P1', 'A claim');
    INSERT INTO position_ops (position_id, version, agent_id, op, message_id, round, created_at)
      VALUES ('p1', 1, 'a1', 'assert', 'm1', 1, 1);
    INSERT INTO position_ops (position_id, version, agent_id, op, message_id, round, created_at)
      VALUES ('p1', 1, 'a2', 'endorse', NULL, 1, 2);
  `)
  return db
}

const version = (db: SqliteDatabase) =>
  Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)

const columns = (db: SqliteDatabase, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name)

test('an unmigrated database starts at version 0', () => {
  assert.equal(version(oldDatabase()), 0)
})

test('the column an old database is missing is added', () => {
  const db = oldDatabase()
  const r = migrate(db)
  assert.equal(r.from, 0)
  assert.equal(r.to, MIGRATIONS[MIGRATIONS.length - 1].version)
  assert.ok(columns(db, 'position_ops').includes('deliberation_id'))
})

test('history is backfilled from the message each op came from, not left blank', () => {
  // Without this an existing room's whole ledger falls outside every run and the
  // next deliberation starts from nothing the user recognises.
  const db = oldDatabase()
  migrate(db)
  const rows = db.prepare(
    'SELECT agent_id, deliberation_id FROM position_ops ORDER BY id').all() as
    { agent_id: string; deliberation_id: string | null }[]
  assert.deepEqual(rows, [
    { agent_id: 'a1', deliberation_id: 'd1' },
    // No message to attribute it to; NULL honestly means "not attributable".
    { agent_id: 'a2', deliberation_id: null },
  ])
})

test('migrating twice changes nothing', () => {
  const db = oldDatabase()
  migrate(db)
  const second = migrate(db)
  assert.deepEqual(second.applied, [])
  assert.equal(version(db), MIGRATIONS[MIGRATIONS.length - 1].version)
})

test('a lost user_version does not re-run a change that is already there', () => {
  // Guarding on user_version alone would ALTER a column that exists and throw.
  const db = oldDatabase()
  migrate(db)
  db.exec('PRAGMA user_version = 0')
  assert.doesNotThrow(() => migrate(db))
  assert.equal(version(db), MIGRATIONS[MIGRATIONS.length - 1].version)
})

test('a database from a newer build is left alone rather than refused', () => {
  const db = oldDatabase()
  migrate(db)
  db.exec('PRAGMA user_version = 999')
  const r = migrate(db)
  assert.equal(r.to, 999, 'a newer schema was downgraded or rejected')
})

test('the real schema reaches the latest version at import', async () => {
  process.env.ROUNDSTORM_DATA = mkdtempSync(join(tmpdir(), 'rs-migrate-fresh-'))
  const db = await import('../db.ts')
  assert.equal(db.schemaVersion.to, MIGRATIONS[MIGRATIONS.length - 1].version)
  assert.ok(columns(db.db, 'position_ops').includes('deliberation_id'))
})
