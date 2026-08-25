/**
 * The same behaviour, asserted against both backends.
 *
 * This is the whole point of the adapter: the choice between a native addon and
 * Node's builtin becomes something a build can decide, rather than a migration.
 * If these pass on both, the swap is a config change.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBetterSqlite } from './better.ts'
import { openNodeSqlite } from './node.ts'
import type { SqliteDatabase } from './types.ts'

const backends: [string, (p: string) => SqliteDatabase][] = [
  ['better-sqlite3', openBetterSqlite],
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
    // node:sqlite has no pragma(); the adapter routes it through exec.
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
    assert.equal(Object.getPrototypeOf(row), Object.prototype)
    assert.deepEqual({ ...row }, { id: 'a', n: 1 })
    db.close()
  })

  test(`${name}: lastInsertRowid is a plain number`, () => {
    const db = fresh()
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)')
    const r = db.prepare('INSERT INTO t (v) VALUES (?)').run('x')
    // better-sqlite3 can return a BigInt here; the ledger and event log index on it.
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
    // Search is LIKE-based today; FTS5 is the obvious upgrade, so both backends
    // must support it or the choice would constrain that.
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
