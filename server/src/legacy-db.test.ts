/**
 * A database written by a build that predates the migration must still boot.
 *
 * `db.ts` creates its schema at import, and every query runs against a handle
 * opened there — so a missing column is not a bad request, it is a daemon that
 * never reaches `listen()`. The user's research lives in one of these files, so
 * this is the test that says the upgrade is safe to install.
 *
 * The fixture is a frozen copy of the old DDL, pasted rather than imported: the
 * real old schema lives in git history, and a fixture that tracked `db.ts` would
 * quietly stop testing anything.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from './sqlite/index.ts'

const dir = mkdtempSync(join(tmpdir(), 'rs-legacy-'))

// --- write an old-schema database before db.ts is ever imported ---
{
  const old = openDatabase(join(dir, 'roundstorm.db'))
  old.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, working_dir TEXT,
      default_tier TEXT NOT NULL DEFAULT 'research', created_at INTEGER NOT NULL);
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
      avatar_color TEXT NOT NULL DEFAULT '#888', persona_key TEXT NOT NULL,
      persona_extra TEXT NOT NULL DEFAULT '', brain TEXT NOT NULL, model TEXT,
      tier_ceiling TEXT NOT NULL DEFAULT 'research', created_at INTEGER NOT NULL);
    CREATE TABLE rooms (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'room', tier TEXT NOT NULL DEFAULT 'research',
      created_at INTEGER NOT NULL);
    CREATE TABLE room_members (room_id TEXT NOT NULL, agent_id TEXT NOT NULL);
    CREATE TABLE deliberations (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, mode TEXT NOT NULL,
      rounds INTEGER NOT NULL, style TEXT NOT NULL, sealed_opening INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL, current_round INTEGER NOT NULL DEFAULT 0,
      question TEXT NOT NULL DEFAULT '', tier TEXT NOT NULL DEFAULT 'research',
      created_at INTEGER NOT NULL, ended_at INTEGER);
    CREATE TABLE messages (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, author_type TEXT NOT NULL,
      author_id TEXT, body TEXT NOT NULL DEFAULT '', reply_to TEXT, round INTEGER,
      deliberation_id TEXT, sealed INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 0,
      stance TEXT, claims TEXT NOT NULL DEFAULT '[]', degraded INTEGER NOT NULL DEFAULT 0,
      brain TEXT, model TEXT, cost_usd REAL, raw TEXT,
      created_at INTEGER NOT NULL, seq INTEGER NOT NULL);
    CREATE TABLE positions (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, label TEXT NOT NULL,
      title TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, text TEXT NOT NULL DEFAULT '',
      created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE position_ops (id INTEGER PRIMARY KEY AUTOINCREMENT, position_id TEXT NOT NULL,
      version INTEGER NOT NULL, agent_id TEXT, op TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      message_id TEXT, round INTEGER, created_at INTEGER NOT NULL);
  `)
  old.exec(`
    INSERT INTO projects VALUES ('pr1', 'Old project', NULL, 'research', 1);
    INSERT INTO agents VALUES ('a1','Alice','', '#888','skeptic','','claude',NULL,'research',1);
    INSERT INTO agents VALUES ('a2','Bruno','', '#888','skeptic','','claude',NULL,'research',1);
    INSERT INTO rooms VALUES ('r1','pr1','Old room','room','research',1);
    INSERT INTO room_members VALUES ('r1','a1'), ('r1','a2');
    INSERT INTO deliberations VALUES
      ('d1','r1','deliberation',2,'parallel',0,'complete',2,'an old question','research',1,2);
    INSERT INTO messages (id,room_id,author_type,author_id,body,deliberation_id,round,created_at,seq)
      VALUES ('m1','r1','agent','a1','said something','d1',1,1,1),
             ('m2','r1','agent','a2','agreed','d1',1,2,2);
    INSERT INTO positions VALUES ('p1','r1','P1','The old conclusion',1,'text','a1',1,1);
    INSERT INTO position_ops (position_id,version,agent_id,op,note,message_id,round,created_at)
      VALUES ('p1',1,'a1','assert','','m1',1,1), ('p1',1,'a2','endorse','','m2',1,2);
  `)
  old.close()
}

process.env.ROUNDSTORM_DATA = dir
const db = await import('./db.ts')
const { summarise } = await import('./deliberation/ledger.ts')

test('the daemon opens a database written before the migration existed', () => {
  // Reaching this line at all is most of the test: db.ts throws at import if the
  // schema it queries does not match, which happens before the server listens.
  assert.equal(db.schemaVersion.from, 0)
  assert.ok(db.schemaVersion.to >= 1)
  assert.deepEqual(db.listRooms().map(r => r.name), ['Old room'])
})

test('the room keeps the consensus it had reached', () => {
  // The migration backfills each op from the message it came from, so an existing
  // room's verdict survives instead of falling outside every run and vanishing.
  const roster = ['a1', 'a2'].map(id => db.getAgent(id)!)
  assert.equal(summarise('r1', roster, 'd1').level, 'strong_consensus')
  assert.equal(summarise('r1', roster).level, 'strong_consensus')
})

test('a new deliberation in that room does not inherit the old verdict', () => {
  const roster = ['a1', 'a2'].map(id => db.getAgent(id)!)
  const fresh = db.createDeliberation({
    roomId: 'r1', mode: 'deliberation', rounds: 2, style: 'parallel',
    sealedOpening: false, status: 'running', currentRound: 0,
    question: 'a new question', tier: 'reasoning',
  } as never)
  assert.equal(summarise('r1', roster, fresh.id).level, 'no_reliable_conclusion')
})
