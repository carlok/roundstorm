/**
 * The behaviour db.ts relies on, pinned.
 *
 * These started life as a two-backend comparison, which is how better-sqlite3
 * was removed with confidence. They are worth keeping against the survivor:
 * node:sqlite is still an experimental API, and these are the exact places it
 * differed — pragmas, row prototypes, rowid typing, BLOBs — so they are the
 * first things a Node upgrade would break.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openNodeSqlite } from './node.ts'
import type { SqliteDatabase } from './types.ts'

const backends: [string, (p: string) => SqliteDatabase][] = [
  ['node:sqlite', openNodeSqlite],
]

for (const [name, open] of backends) {
  const fresh = () => {
    const db = open(join(mkdtempSync(join(tmpdir(), 'rs-sql-')), 'test.db'))
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    return db
  }

  test(`${name}: pragmas apply without a dedicated helper`, () => {
    const db = fresh()
    // node:sqlite has no pragma() of its own; the adapter routes it through exec.
    const mode = db.prepare('PRAGMA journal_mode').get() as any
    assert.equal(String(mode.journal_mode).toLowerCase(), 'wal')
    db.close()
  })

  test(`${name}: named parameters bind the same way`, () => {
    const db = fresh()
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)')
    db.prepare('INSERT INTO t (id,n) VALUES (@id,@n)').run({ id: 'a', n: 1 })
    assert.deepEqual(db.prepare('SELECT * FROM t WHERE id=?').get('a'), { id: 'a', n: 1 })
    db.close()
  })

  test(`${name}: rows are ordinary objects, safe to spread`, () => {
    const db = fresh()
    db.exec('CREATE TABLE t (id TEXT, n INTEGER)')
    db.prepare('INSERT INTO t VALUES (?,?)').run('a', 1)
    const row = db.prepare('SELECT * FROM t').get() as Record<string, unknown>
    // node:sqlite returns null-prototype objects; the adapter normalises them,
    // because `{...row}` and Object.prototype methods behave differently on those.
    // db.ts spreads rows in several mappers, so this is load-bearing.
    assert.equal(Object.getPrototypeOf(row), Object.prototype)
    assert.deepEqual({ ...row }, { id: 'a', n: 1 })
    db.close()
  })

  test(`${name}: lastInsertRowid is a plain number`, () => {
    const db = fresh()
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)')
    const r = db.prepare('INSERT INTO t (v) VALUES (?)').run('x')
    // The event log indexes on this and compares ids numerically.
    assert.equal(typeof r.lastInsertRowid, 'number')
    assert.equal(r.lastInsertRowid, 1)
    assert.equal(r.changes, 1)
    db.close()
  })

  test(`${name}: foreign keys cascade`, () => {
    const db = fresh()
    db.exec(`CREATE TABLE parent (id TEXT PRIMARY KEY);
             CREATE TABLE child (id TEXT, parent_id TEXT REFERENCES parent(id) ON DELETE CASCADE)`)
    db.prepare('INSERT INTO parent VALUES (?)').run('p')
    db.prepare('INSERT INTO child VALUES (?,?)').run('c', 'p')
    db.prepare('DELETE FROM parent WHERE id=?').run('p')
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM child').get() as any).c, 0)
    db.close()
  })

  test(`${name}: BLOBs round-trip as typed arrays`, () => {
    const db = fresh()
    db.exec('CREATE TABLE v (id TEXT, vec BLOB)')
    const vec = Float32Array.from([0.5, -0.25, 1])
    db.prepare('INSERT INTO v VALUES (?,?)').run('a', Buffer.from(vec.buffer))
    const row = db.prepare('SELECT vec FROM v').get() as any
    const back = new Float32Array(row.vec.buffer, row.vec.byteOffset, 3)
    assert.deepEqual([...back], [0.5, -0.25, 1])
    db.close()
  })

  test(`${name}: FTS5 is available`, () => {
    // Search is LIKE-based today; FTS5 is the obvious upgrade, so losing it
    // would be a real constraint.
    const db = fresh()
    db.exec("CREATE VIRTUAL TABLE ft USING fts5(body)")
    db.prepare('INSERT INTO ft (body) VALUES (?)').run('oil whip instability')
    const hit = db.prepare("SELECT COUNT(*) AS c FROM ft WHERE ft MATCH 'whip'").get() as any
    assert.equal(hit.c, 1)
    db.close()
  })

  test(`${name}: reports which backend it is`, () => {
    const db = fresh()
    assert.equal(db.backend, name)
    assert.match(db.sqliteVersion, /^\d+\.\d+/)
    db.close()
  })
}

test('backup captures data still sitting in the WAL', async () => {
  // The failure this prevents: copying only the .db file yields a snapshot that
  // opens cleanly and is quietly missing recent work, because in WAL mode the
  // newest writes live in the -wal — which is routinely larger than the .db.
  const { copyFileSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'rs-bk-'))
  const src = join(dir, 'src.db')

  const db = openNodeSqlite(src)
  db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)')
  const insert = db.prepare('INSERT INTO t (v) VALUES (?)')
  for (let i = 0; i < 200; i++) insert.run(`row ${i}`)

  // The naive approach, for contrast.
  const naive = join(dir, 'naive.db')
  copyFileSync(src, naive)

  const proper = join(dir, 'proper.db')
  await db.backup(proper)
  db.close()

  // A copy can be missing the table entirely: in WAL mode even the schema may
  // not have reached the .db yet.
  const count = (p: string) => {
    const h = openNodeSqlite(p)
    try {
      return (h.prepare('SELECT COUNT(*) AS c FROM t').get() as any).c as number
    } catch {
      return -1
    } finally {
      h.close()
    }
  }

  assert.equal(count(proper), 200, 'backup() lost rows held in the WAL')
  assert.ok(count(naive) < 200,
    'expected the plain file copy to be incomplete; if it is not, this test no longer proves anything')
})
