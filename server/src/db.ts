import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type {
  Agent, Claim, Deliberation, LogEntry, MemoryCard, Message, Position,
  PositionStanceRow, Project, ResultCard, Room, Source, Stance, Tier,
} from './types.ts'

/**
 * Where the research lives.
 *
 * Always absolute: child CLIs resolve paths we hand them against their own cwd,
 * so a relative data dir silently becomes a different (missing) directory.
 *
 * Per-platform, because `~/Library/Application Support` is a macOS convention and
 * creating that literal path on Linux or Windows is just wrong — it works, which
 * is worse, because the data ends up somewhere no backup tool or user expects.
 */
export function defaultDataDirFor(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv = {}): string {
  switch (platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Roundstorm')
    case 'win32':
      return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Roundstorm')
    default:
      // XDG Base Directory, which is what Linux desktops and backup tools expect.
      return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'roundstorm')
  }
}

const defaultDataDir = () => defaultDataDirFor(process.platform, homedir(), process.env)

const DATA_DIR = resolve(process.env.ROUNDSTORM_DATA ?? defaultDataDir())
mkdirSync(DATA_DIR, { recursive: true })

import { openDatabase } from './sqlite/index.ts'

export const db = openDatabase(join(DATA_DIR, 'roundstorm.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  working_dir TEXT,
  default_tier TEXT NOT NULL DEFAULT 'research',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT '',
  avatar_color TEXT NOT NULL DEFAULT '#888',
  persona_key TEXT NOT NULL,
  persona_extra TEXT NOT NULL DEFAULT '',
  brain TEXT NOT NULL,
  model TEXT,
  tier_ceiling TEXT NOT NULL DEFAULT 'research',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'room',
  tier TEXT NOT NULL DEFAULT 'research',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  PRIMARY KEY (room_id, agent_id)
);

CREATE TABLE IF NOT EXISTS deliberations (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  rounds INTEGER NOT NULL,
  style TEXT NOT NULL,
  sealed_opening INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  current_round INTEGER NOT NULL DEFAULT 0,
  question TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL DEFAULT 'research',
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL,
  author_id TEXT,
  body TEXT NOT NULL,
  reply_to TEXT,
  round INTEGER,
  deliberation_id TEXT,
  sealed INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  stance TEXT,
  claims TEXT NOT NULL DEFAULT '[]',
  degraded INTEGER NOT NULL DEFAULT 0,
  brain TEXT,
  model TEXT,
  cost_usd REAL,
  raw TEXT,
  created_at INTEGER NOT NULL,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, seq);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  title TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  text TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_positions_room ON positions(room_id);

CREATE TABLE IF NOT EXISTS position_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id TEXT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  agent_id TEXT,
  op TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  message_id TEXT,
  round INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ops_position ON position_ops(position_id, id);

CREATE TABLE IF NOT EXISTS memory_cards (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id TEXT,
  room_id TEXT,
  scope TEXT NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  source_message_id TEXT,
  created_at INTEGER NOT NULL,
  last_used INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memory_agent ON memory_cards(agent_id, status);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  url TEXT,
  title TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'web',
  snapshot TEXT,
  found_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_room ON sources(room_id);

CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  deliberation_id TEXT NOT NULL REFERENCES deliberations(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  level TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  room_id TEXT,
  deliberation_id TEXT,
  agent_id TEXT,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_room ON events(room_id, id);
`)

export const uid = () => randomUUID()
export const now = () => Date.now()

// ---------- row mappers ----------

const toProject = (r: any): Project => ({
  id: r.id, name: r.name, workingDir: r.working_dir,
  defaultTier: r.default_tier, createdAt: r.created_at,
})

const toAgent = (r: any): Agent => ({
  id: r.id, name: r.name, role: r.role, avatarColor: r.avatar_color,
  personaKey: r.persona_key, personaExtra: r.persona_extra,
  brain: r.brain, model: r.model, tierCeiling: r.tier_ceiling, createdAt: r.created_at,
})

const toMessage = (r: any): Message => ({
  id: r.id, roomId: r.room_id, authorType: r.author_type, authorId: r.author_id,
  body: r.body, replyTo: r.reply_to, round: r.round, deliberationId: r.deliberation_id,
  sealed: !!r.sealed, priority: !!r.priority,
  stance: r.stance as Stance | null,
  claims: safeParse<Claim[]>(r.claims, []),
  degraded: !!r.degraded, brain: r.brain, model: r.model, costUsd: r.cost_usd,
  createdAt: r.created_at, seq: r.seq,
})

const toDeliberation = (r: any): Deliberation => ({
  id: r.id, roomId: r.room_id, mode: r.mode, rounds: r.rounds, style: r.style,
  sealedOpening: !!r.sealed_opening, status: r.status, currentRound: r.current_round,
  question: r.question, tier: r.tier, createdAt: r.created_at, endedAt: r.ended_at,
})

function safeParse<T>(s: string | null, fallback: T): T {
  if (!s) return fallback
  try { return JSON.parse(s) as T } catch { return fallback }
}

// ---------- projects ----------

export const listProjects = (): Project[] =>
  db.prepare('SELECT * FROM projects ORDER BY created_at').all().map(toProject)

export function createProject(name: string, workingDir: string | null = null): Project {
  const p = { id: uid(), name, working_dir: workingDir, default_tier: 'research', created_at: now() }
  db.prepare(`INSERT INTO projects (id,name,working_dir,default_tier,created_at)
              VALUES (@id,@name,@working_dir,@default_tier,@created_at)`).run(p)
  return toProject(p)
}

// ---------- agents ----------

export const listAgents = (): Agent[] =>
  db.prepare('SELECT * FROM agents ORDER BY created_at').all().map(toAgent)

export const getAgent = (id: string): Agent | undefined => {
  const r = db.prepare('SELECT * FROM agents WHERE id = ?').get(id)
  return r ? toAgent(r) : undefined
}

/**
 * Agent names are unique because `@mention` resolves by name. Callers that
 * generate names (the persona lab creates a fresh cast per experiment) would
 * otherwise collide on the second run, so give them a way to ask for a free one.
 */
export function uniqueAgentName(base: string): string {
  const taken = new Set((db.prepare('SELECT name FROM agents').all() as any[]).map(r => r.name))
  if (!taken.has(base)) return base
  for (let i = 2; i < 500; i++) {
    const candidate = `${base} ${i}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base} ${uid().slice(0, 6)}`
}

export function createAgent(a: Omit<Agent, 'id' | 'createdAt'>): Agent {
  const row = {
    id: uid(), name: a.name, role: a.role, avatar_color: a.avatarColor,
    persona_key: a.personaKey, persona_extra: a.personaExtra,
    brain: a.brain, model: a.model, tier_ceiling: a.tierCeiling, created_at: now(),
  }
  db.prepare(`INSERT INTO agents (id,name,role,avatar_color,persona_key,persona_extra,brain,model,tier_ceiling,created_at)
              VALUES (@id,@name,@role,@avatar_color,@persona_key,@persona_extra,@brain,@model,@tier_ceiling,@created_at)`).run(row)
  return toAgent(row)
}

export function updateAgent(id: string, patch: Partial<Agent>): Agent | undefined {
  const cur = getAgent(id)
  if (!cur) return undefined
  const next = { ...cur, ...patch }
  db.prepare(`UPDATE agents SET name=?, role=?, avatar_color=?, persona_key=?, persona_extra=?,
              brain=?, model=?, tier_ceiling=? WHERE id=?`)
    .run(next.name, next.role, next.avatarColor, next.personaKey, next.personaExtra,
         next.brain, next.model, next.tierCeiling, id)
  return getAgent(id)
}

// ---------- rooms ----------

export function listRooms(): Room[] {
  const rooms = db.prepare('SELECT * FROM rooms ORDER BY created_at').all() as any[]
  const members = db.prepare('SELECT * FROM room_members').all() as any[]
  return rooms.map(r => ({
    id: r.id, projectId: r.project_id, name: r.name, kind: r.kind, tier: r.tier,
    createdAt: r.created_at,
    memberIds: members.filter(m => m.room_id === r.id).map(m => m.agent_id),
  }))
}

export const getRoom = (id: string): Room | undefined => listRooms().find(r => r.id === id)

export function createRoom(
  projectId: string, name: string, kind: 'room' | 'dm', memberIds: string[], tier: Tier = 'research',
): Room {
  const id = uid()
  db.prepare(`INSERT INTO rooms (id,project_id,name,kind,tier,created_at)
              VALUES (?,?,?,?,?,?)`).run(id, projectId, name, kind, tier, now())
  const ins = db.prepare('INSERT OR IGNORE INTO room_members (room_id,agent_id) VALUES (?,?)')
  for (const m of memberIds) ins.run(id, m)
  return getRoom(id)!
}

/**
 * Deleting a researcher leaves its past messages intact — a transcript that
 * loses its authors is worthless, and §12 requires the record stay auditable.
 * Only the roster entry and the agent row go.
 */
export function deleteAgent(id: string): { removedFromRooms: number } {
  const rooms = db.prepare('SELECT COUNT(*) AS c FROM room_members WHERE agent_id=?').get(id) as any
  db.prepare('DELETE FROM room_members WHERE agent_id=?').run(id)
  db.prepare('DELETE FROM agents WHERE id=?').run(id)
  return { removedFromRooms: rooms.c }
}

/**
 * Rooms cascade: messages, deliberations, positions and sources go with them.
 * Memory cards are not covered by the foreign key (they hang off the agent), so
 * they are removed explicitly — otherwise an agent keeps remembering a room the
 * user deleted.
 */
export function deleteRoom(id: string) {
  db.prepare('DELETE FROM memory_cards WHERE room_id=?').run(id)
  db.prepare('DELETE FROM rooms WHERE id=?').run(id)
}

/**
 * Empty a room without destroying it. The room and its cast stay; everything the
 * room produced goes.
 *
 * That includes the memory cards derived from it — both the ones still waiting
 * in the inbox and the ones already accepted into an agent's long-term memory.
 * Leaving accepted cards behind would mean an agent still "remembers" a
 * discussion the user believes they erased, and silently carries it into the
 * next one. Clearing has to mean clearing.
 */
export function clearRoom(id: string): { messages: number; memoryCards: number } {
  const n = (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE room_id=?').get(id) as any).c
  const mem = (db.prepare('SELECT COUNT(*) AS c FROM memory_cards WHERE room_id=?').get(id) as any).c
  db.prepare('DELETE FROM memory_cards WHERE room_id=?').run(id)
  db.prepare('DELETE FROM position_ops WHERE position_id IN (SELECT id FROM positions WHERE room_id=?)').run(id)
  db.prepare('DELETE FROM positions WHERE room_id=?').run(id)
  db.prepare('DELETE FROM sources WHERE room_id=?').run(id)
  db.prepare('DELETE FROM results WHERE room_id=?').run(id)
  db.prepare('DELETE FROM deliberations WHERE room_id=?').run(id)
  db.prepare('DELETE FROM embeddings WHERE room_id=?').run(id)
  db.prepare('DELETE FROM messages WHERE room_id=?').run(id)
  return { messages: n, memoryCards: mem }
}

export function updateProject(id: string, patch: { name?: string; workingDir?: string | null; defaultTier?: Tier }) {
  const cur = db.prepare('SELECT * FROM projects WHERE id=?').get(id) as any
  if (!cur) return undefined
  db.prepare('UPDATE projects SET name=?, working_dir=?, default_tier=? WHERE id=?').run(
    patch.name ?? cur.name,
    patch.workingDir === undefined ? cur.working_dir : patch.workingDir,
    patch.defaultTier ?? cur.default_tier,
    id)
  return toProject(db.prepare('SELECT * FROM projects WHERE id=?').get(id))
}

export const getProject = (id: string): Project | undefined => {
  const r = db.prepare('SELECT * FROM projects WHERE id=?').get(id)
  return r ? toProject(r) : undefined
}

export function renameRoom(id: string, name: string) {
  db.prepare('UPDATE rooms SET name=? WHERE id=?').run(name.slice(0, 120), id)
}

export function setRoomTier(id: string, tier: Tier) {
  db.prepare('UPDATE rooms SET tier=? WHERE id=?').run(tier, id)
}

export function setRoomMembers(id: string, memberIds: string[]) {
  db.prepare('DELETE FROM room_members WHERE room_id=?').run(id)
  const ins = db.prepare('INSERT OR IGNORE INTO room_members (room_id,agent_id) VALUES (?,?)')
  for (const m of memberIds) ins.run(id, m)
}

// ---------- messages ----------

const nextSeq = db.prepare('SELECT IFNULL(MAX(seq),0)+1 AS n FROM messages')

export function insertMessage(m: Partial<Message> & { roomId: string; authorType: Message['authorType']; body: string; raw?: string }): Message {
  const row = {
    id: m.id ?? uid(),
    room_id: m.roomId,
    author_type: m.authorType,
    author_id: m.authorId ?? null,
    body: m.body,
    reply_to: m.replyTo ?? null,
    round: m.round ?? null,
    deliberation_id: m.deliberationId ?? null,
    sealed: m.sealed ? 1 : 0,
    priority: m.priority ? 1 : 0,
    stance: m.stance ?? null,
    claims: JSON.stringify(m.claims ?? []),
    degraded: m.degraded ? 1 : 0,
    brain: m.brain ?? null,
    model: m.model ?? null,
    cost_usd: m.costUsd ?? null,
    raw: (m as any).raw ?? null,
    created_at: m.createdAt ?? now(),
    seq: (nextSeq.get() as any).n as number,
  }
  db.prepare(`INSERT INTO messages
    (id,room_id,author_type,author_id,body,reply_to,round,deliberation_id,sealed,priority,
     stance,claims,degraded,brain,model,cost_usd,raw,created_at,seq)
    VALUES (@id,@room_id,@author_type,@author_id,@body,@reply_to,@round,@deliberation_id,@sealed,@priority,
     @stance,@claims,@degraded,@brain,@model,@cost_usd,@raw,@created_at,@seq)`).run(row)
  return toMessage(row)
}

export function updateMessage(id: string, patch: Partial<Message> & { raw?: string }): Message | undefined {
  const cur = getMessage(id)
  if (!cur) return undefined
  const next = { ...cur, ...patch }
  db.prepare(`UPDATE messages SET body=?, sealed=?, priority=?, stance=?, claims=?, degraded=?,
              cost_usd=?, raw=COALESCE(?,raw) WHERE id=?`)
    .run(next.body, next.sealed ? 1 : 0, next.priority ? 1 : 0, next.stance,
         JSON.stringify(next.claims), next.degraded ? 1 : 0, next.costUsd,
         patch.raw ?? null, id)
  return getMessage(id)
}

export const getMessage = (id: string): Message | undefined => {
  const r = db.prepare('SELECT * FROM messages WHERE id=?').get(id)
  return r ? toMessage(r) : undefined
}

/** Room transcript. Sealed messages are withheld from the UI until their round is revealed. */
export function listMessages(roomId: string, includeSealed = false): Message[] {
  const rows = db.prepare('SELECT * FROM messages WHERE room_id=? ORDER BY seq').all(roomId) as any[]
  const all = rows.map(toMessage)
  return includeSealed ? all : all.filter(m => !m.sealed)
}

export function revealRound(deliberationId: string, round: number) {
  db.prepare('UPDATE messages SET sealed=0 WHERE deliberation_id=? AND round=?').run(deliberationId, round)
}

// ---------- deliberations ----------

export function createDeliberation(d: Omit<Deliberation, 'id' | 'createdAt' | 'endedAt'>): Deliberation {
  const row = {
    id: uid(), room_id: d.roomId, mode: d.mode, rounds: d.rounds, style: d.style,
    sealed_opening: d.sealedOpening ? 1 : 0, status: d.status, current_round: d.currentRound,
    question: d.question, tier: d.tier, created_at: now(), ended_at: null,
  }
  db.prepare(`INSERT INTO deliberations
    (id,room_id,mode,rounds,style,sealed_opening,status,current_round,question,tier,created_at,ended_at)
    VALUES (@id,@room_id,@mode,@rounds,@style,@sealed_opening,@status,@current_round,@question,@tier,@created_at,@ended_at)`).run(row)
  return toDeliberation(row)
}

export const getDeliberation = (id: string): Deliberation | undefined => {
  const r = db.prepare('SELECT * FROM deliberations WHERE id=?').get(id)
  return r ? toDeliberation(r) : undefined
}

export function updateDeliberation(id: string, patch: Partial<Deliberation>): Deliberation | undefined {
  const cur = getDeliberation(id)
  if (!cur) return undefined
  const n = { ...cur, ...patch }
  db.prepare(`UPDATE deliberations SET mode=?, rounds=?, style=?, sealed_opening=?, status=?,
              current_round=?, question=?, tier=?, ended_at=? WHERE id=?`)
    .run(n.mode, n.rounds, n.style, n.sealedOpening ? 1 : 0, n.status, n.currentRound,
         n.question, n.tier, n.endedAt, id)
  return getDeliberation(id)
}

export const activeDeliberation = (roomId: string): Deliberation | undefined => {
  const r = db.prepare(`SELECT * FROM deliberations WHERE room_id=? AND status IN ('running','stopping')
                        ORDER BY created_at DESC LIMIT 1`).get(roomId)
  return r ? toDeliberation(r) : undefined
}

/**
 * A crash leaves deliberations at `running` or `stopping` forever. Nothing in
 * the process is driving them any more, but `activeDeliberation` still returns
 * one, and every route that guards on it — deliberate, clear, delete, rename —
 * refuses. The room is bricked, with no way out from the interface.
 *
 * So at startup, before anything can query it, close every deliberation the
 * scheduler is demonstrably not running, and say so in the room rather than
 * letting a run appear to have finished normally.
 */
export function reconcileDeliberations(): Deliberation[] {
  const stale = (db.prepare(`SELECT * FROM deliberations WHERE status IN ('running','stopping')`)
    .all() as any[]).map(toDeliberation)

  for (const d of stale) {
    updateDeliberation(d.id, { status: 'stopped', endedAt: now() })
    insertMessage({
      roomId: d.roomId, authorType: 'system', deliberationId: d.id,
      body: `This deliberation was interrupted at round ${d.currentRound} — Roundstorm stopped `
          + `while it was running. Nothing after that round was recorded. Start a new one when ready.`,
    })
    logEvent('deliberation.reconciled', {
      roomId: d.roomId, deliberationId: d.id, payload: { was: d.status, round: d.currentRound },
    })
  }
  return stale
}

export const listDeliberations = (roomId: string): Deliberation[] =>
  (db.prepare('SELECT * FROM deliberations WHERE room_id=? ORDER BY created_at').all(roomId) as any[])
    .map(toDeliberation)

// ---------- activity log (plan §12) ----------

export function logEvent(
  type: string,
  opts: { roomId?: string | null; deliberationId?: string | null; agentId?: string | null; payload?: unknown } = {},
): LogEntry {
  const ts = now()
  const info = db.prepare(`INSERT INTO events (ts,type,room_id,deliberation_id,agent_id,payload)
              VALUES (?,?,?,?,?,?)`)
    .run(ts, type, opts.roomId ?? null, opts.deliberationId ?? null, opts.agentId ?? null,
         JSON.stringify(opts.payload ?? null))
  return {
    id: Number(info.lastInsertRowid), ts, type,
    roomId: opts.roomId ?? null, deliberationId: opts.deliberationId ?? null,
    agentId: opts.agentId ?? null, payload: opts.payload ?? null,
  }
}

export function listEvents(roomId: string | null, limit = 500): LogEntry[] {
  const rows = roomId
    ? db.prepare('SELECT * FROM events WHERE room_id=? ORDER BY id DESC LIMIT ?').all(roomId, limit)
    : db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit)
  return (rows as any[]).map(r => ({
    id: r.id, ts: r.ts, type: r.type, roomId: r.room_id,
    deliberationId: r.deliberation_id, agentId: r.agent_id,
    payload: safeParse<unknown>(r.payload, null),
  })).reverse()
}

export const DATA_PATH = DATA_DIR

// ---------- positions ledger ----------

const toPosition = (r: any, stances: PositionStanceRow[]): Position => ({
  id: r.id, roomId: r.room_id, label: r.label, title: r.title, version: r.version,
  text: r.text, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  stances,
})

export function listPositions(roomId: string): Position[] {
  const rows = db.prepare('SELECT * FROM positions WHERE room_id=? ORDER BY created_at').all(roomId) as any[]
  const ops = db.prepare(`SELECT * FROM position_ops WHERE position_id IN
    (SELECT id FROM positions WHERE room_id=?) ORDER BY id`).all(roomId) as any[]
  return rows.map(r => {
    // Latest op per agent wins: a ledger is a current state, not a pile of history.
    const latest = new Map<string, any>()
    for (const o of ops) if (o.position_id === r.id && o.agent_id) latest.set(o.agent_id, o)
    return toPosition(r, [...latest.values()].map(o => ({
      agentId: o.agent_id, op: o.op, note: o.note, version: o.version, round: o.round,
    })))
  })
}

export function getPositionByLabel(roomId: string, label: string) {
  const r = db.prepare('SELECT * FROM positions WHERE room_id=? AND label=?').get(roomId, label) as any
  return r ?? null
}

export function createPosition(
  roomId: string, title: string, text: string, createdBy: string | null,
): Position {
  const n = (db.prepare('SELECT COUNT(*) AS c FROM positions WHERE room_id=?').get(roomId) as any).c
  const row = {
    id: uid(), room_id: roomId, label: `P${n + 1}`, title: title.slice(0, 200),
    version: 1, text, created_by: createdBy, created_at: now(), updated_at: now(),
  }
  db.prepare(`INSERT INTO positions (id,room_id,label,title,version,text,created_by,created_at,updated_at)
    VALUES (@id,@room_id,@label,@title,@version,@text,@created_by,@created_at,@updated_at)`).run(row)
  return toPosition(row, [])
}

/**
 * Revising a position bumps its version, which invalidates every endorsement
 * collected against the old one (plan §7). No accumulating stale yeses.
 */
export function revisePosition(positionId: string, text: string, title?: string): number {
  const cur = db.prepare('SELECT * FROM positions WHERE id=?').get(positionId) as any
  if (!cur) return 0
  const version = cur.version + 1
  db.prepare('UPDATE positions SET version=?, text=?, title=COALESCE(?,title), updated_at=? WHERE id=?')
    .run(version, text, title ?? null, now(), positionId)
  db.prepare(`DELETE FROM position_ops WHERE position_id=? AND op='endorse'`).run(positionId)
  return version
}

export function recordOp(o: {
  positionId: string; version: number; agentId: string | null; op: string
  note?: string; messageId?: string | null; round?: number | null
}) {
  db.prepare(`INSERT INTO position_ops (position_id,version,agent_id,op,note,message_id,round,created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(o.positionId, o.version, o.agentId, o.op, o.note ?? '',
         o.messageId ?? null, o.round ?? null, now())
}

// ---------- results ----------

export function saveResult(card: ResultCard) {
  db.prepare(`INSERT OR REPLACE INTO results (id,deliberation_id,room_id,level,payload,created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(card.id, card.deliberationId, card.roomId, card.level, JSON.stringify(card), card.createdAt)
}

export function listResults(roomId: string): ResultCard[] {
  return (db.prepare('SELECT payload FROM results WHERE room_id=? ORDER BY created_at').all(roomId) as any[])
    .map(r => safeParse<ResultCard | null>(r.payload, null))
    .filter((c): c is ResultCard => !!c)
}

// ---------- memory cards ----------

const toMemory = (r: any): MemoryCard => ({
  id: r.id, agentId: r.agent_id, projectId: r.project_id, roomId: r.room_id,
  scope: r.scope, type: r.type, text: r.text, status: r.status,
  sourceMessageId: r.source_message_id, createdAt: r.created_at, lastUsed: r.last_used,
})

export function proposeMemory(c: Omit<MemoryCard, 'id' | 'createdAt' | 'lastUsed' | 'status'>): MemoryCard {
  const row = {
    id: uid(), agent_id: c.agentId, project_id: c.projectId, room_id: c.roomId,
    scope: c.scope, type: c.type, text: c.text, status: 'proposed',
    source_message_id: c.sourceMessageId, created_at: now(), last_used: null,
  }
  db.prepare(`INSERT INTO memory_cards (id,agent_id,project_id,room_id,scope,type,text,status,source_message_id,created_at,last_used)
    VALUES (@id,@agent_id,@project_id,@room_id,@scope,@type,@text,@status,@source_message_id,@created_at,@last_used)`).run(row)
  return toMemory(row)
}

export const listMemory = (filter: { agentId?: string; status?: string; projectId?: string } = {}): MemoryCard[] => {
  const where: string[] = []
  const args: unknown[] = []
  if (filter.agentId) { where.push('agent_id=?'); args.push(filter.agentId) }
  if (filter.status) { where.push('status=?'); args.push(filter.status) }
  if (filter.projectId) { where.push('(project_id=? OR project_id IS NULL)'); args.push(filter.projectId) }
  const sql = `SELECT * FROM memory_cards ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`
  return (db.prepare(sql).all(...args) as any[]).map(toMemory)
}

export function setMemoryStatus(id: string, status: MemoryCard['status'], text?: string) {
  db.prepare('UPDATE memory_cards SET status=?, text=COALESCE(?,text) WHERE id=?').run(status, text ?? null, id)
  const r = db.prepare('SELECT * FROM memory_cards WHERE id=?').get(id)
  return r ? toMemory(r) : undefined
}

export function touchMemory(ids: string[]) {
  if (!ids.length) return
  const stmt = db.prepare('UPDATE memory_cards SET last_used=? WHERE id=?')
  for (const id of ids) stmt.run(now(), id)
}

// ---------- sources ----------

const toSource = (r: any): Source => ({
  id: r.id, roomId: r.room_id, label: r.label, url: r.url, title: r.title,
  kind: r.kind, snapshot: r.snapshot, foundBy: r.found_by, createdAt: r.created_at,
})

export const listSources = (roomId: string): Source[] =>
  (db.prepare('SELECT * FROM sources WHERE room_id=? ORDER BY created_at').all(roomId) as any[]).map(toSource)

/** Sources are deduped at room scope so agents can argue about "S3" by name. */
export function upsertSource(
  roomId: string, s: { url?: string | null; title: string; kind?: Source['kind']; snapshot?: string | null; foundBy?: string | null },
): Source {
  if (s.url) {
    const existing = db.prepare('SELECT * FROM sources WHERE room_id=? AND url=?').get(roomId, s.url)
    if (existing) return toSource(existing)
  }
  const n = (db.prepare('SELECT COUNT(*) AS c FROM sources WHERE room_id=?').get(roomId) as any).c
  const row = {
    id: uid(), room_id: roomId, label: `S${n + 1}`, url: s.url ?? null,
    title: s.title.slice(0, 300), kind: s.kind ?? 'web', snapshot: s.snapshot ?? null,
    found_by: s.foundBy ?? null, created_at: now(),
  }
  db.prepare(`INSERT INTO sources (id,room_id,label,url,title,kind,snapshot,found_by,created_at)
    VALUES (@id,@room_id,@label,@url,@title,@kind,@snapshot,@found_by,@created_at)`).run(row)
  return toSource(row)
}

// ---------- search (plan §21) ----------

export interface SearchHit {
  message: Message
  roomId: string
  roomName: string
  snippet: string
}

export function searchMessages(query: string, limit = 60): SearchHit[] {
  const q = query.trim()
  if (q.length < 2) return []
  const rows = db.prepare(`
    SELECT m.*, r.name AS room_name FROM messages m
    JOIN rooms r ON r.id = m.room_id
    WHERE m.sealed = 0 AND m.body LIKE ? ESCAPE '\\'
    ORDER BY m.seq DESC LIMIT ?`)
    .all(`%${q.replace(/[%_\\]/g, c => '\\' + c)}%`, limit) as any[]
  return rows.map(r => {
    const m = toMessage(r)
    const at = m.body.toLowerCase().indexOf(q.toLowerCase())
    const from = Math.max(0, at - 60)
    return {
      message: m, roomId: m.roomId, roomName: r.room_name,
      snippet: (from ? '…' : '') + m.body.slice(from, at + q.length + 90).trim(),
    }
  })
}
