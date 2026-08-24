/**
 * Semantic search (plan §21, §14).
 *
 * Keyword search finds a phrase you already remember. A research notebook needs
 * the other thing: "where did we talk about the onset threshold?" when the
 * transcript says "bifurcation point". So embeddings, but local ones — a search
 * index that phones a vendor would undo the whole local-first commitment, and
 * an embedding model is small enough that there is no excuse.
 *
 * Vectors live in SQLite as raw Float32 blobs and are scanned in process.
 * That is fine at notebook scale: a year of heavy use is tens of thousands of
 * messages, and a linear scan of 30k × 768 floats is a few milliseconds.
 * An ANN index would be premature.
 */
import { db, now } from '../db.ts'
import type { Message } from '../types.ts'

const BASE = process.env.ROUNDSTORM_EMBED_URL ?? 'http://127.0.0.1:1234/v1'
const MODEL = process.env.ROUNDSTORM_EMBED_MODEL ?? 'text-embedding-nomic-embed-text-v1.5'

db.exec(`
CREATE TABLE IF NOT EXISTS embeddings (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emb_room ON embeddings(room_id);
`)

export interface EmbedderStatus {
  available: boolean
  model: string
  baseUrl: string
  indexed: number
  pending: number
  note: string
}

export async function embedderStatus(): Promise<EmbedderStatus> {
  const indexed = (db.prepare('SELECT COUNT(*) AS c FROM embeddings').get() as any).c
  const pending = (db.prepare(`SELECT COUNT(*) AS c FROM messages m
    WHERE m.sealed = 0 AND m.author_type != 'system'
      AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.message_id = m.id)`).get() as any).c
  return {
    available: await reachable(),
    model: MODEL, baseUrl: BASE, indexed, pending,
    note: 'Runs entirely on this machine. Nothing is sent anywhere.',
  }
}

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

async function embed(texts: string[]): Promise<Float32Array[]> {
  const res = await fetch(`${BASE}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: texts }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`embedder ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = await res.json() as any
  // The API may return results out of order; `index` is authoritative.
  const out: Float32Array[] = new Array(texts.length)
  for (const row of body.data ?? []) {
    out[row.index ?? 0] = normalise(Float32Array.from(row.embedding))
  }
  return out
}

/** Pre-normalise so similarity is a plain dot product at query time. */
function normalise(v: Float32Array): Float32Array {
  let sum = 0
  for (const x of v) sum += x * x
  const norm = Math.sqrt(sum) || 1
  for (let i = 0; i < v.length; i++) v[i] /= norm
  return v
}

/**
 * Index whatever is not yet indexed. Safe to call repeatedly; it is incremental
 * and skips anything already stored.
 */
export async function indexPending(limit = 400): Promise<{ indexed: number; skipped: boolean }> {
  if (!await reachable()) return { indexed: 0, skipped: true }

  const rows = db.prepare(`SELECT m.id, m.room_id, m.body FROM messages m
    WHERE m.sealed = 0 AND m.author_type != 'system'
      AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.message_id = m.id)
    ORDER BY m.seq LIMIT ?`).all(limit) as any[]
  if (!rows.length) return { indexed: 0, skipped: false }

  const insert = db.prepare(`INSERT OR REPLACE INTO embeddings
    (message_id, room_id, model, dim, vec, created_at) VALUES (?,?,?,?,?,?)`)

  let done = 0
  // Small batches: one oversized request can time out and lose the whole run.
  for (let i = 0; i < rows.length; i += 16) {
    const batch = rows.slice(i, i + 16)
    let vecs: Float32Array[]
    try {
      vecs = await embed(batch.map(r => truncate(r.body)))
    } catch {
      break
    }
    for (let j = 0; j < batch.length; j++) {
      const v = vecs[j]
      if (!v) continue
      insert.run(batch[j].id, batch[j].room_id, MODEL, v.length, Buffer.from(v.buffer), now())
      done++
    }
  }
  return { indexed: done, skipped: false }
}

/** Embedding models have a context limit; the opening of a turn carries its thesis. */
const truncate = (s: string) => s.trim().slice(0, 4000)

export interface SemanticHit {
  message: Message
  roomId: string
  roomName: string
  score: number
  snippet: string
}

export async function semanticSearch(query: string, limit = 25): Promise<SemanticHit[] | null> {
  if (query.trim().length < 3) return []
  if (!await reachable()) return null

  let qv: Float32Array
  try {
    [qv] = await embed([query.trim()])
  } catch {
    return null
  }
  if (!qv) return null

  const rows = db.prepare(`SELECT e.message_id, e.room_id, e.dim, e.vec, r.name AS room_name
    FROM embeddings e JOIN rooms r ON r.id = e.room_id`).all() as any[]

  const scored: { id: string; score: number; roomName: string }[] = []
  for (const row of rows) {
    const v = new Float32Array(
      row.vec.buffer, row.vec.byteOffset, row.dim)
    if (v.length !== qv.length) continue
    let dot = 0
    for (let i = 0; i < v.length; i++) dot += v[i] * qv[i]
    scored.push({ id: row.message_id, score: dot, roomName: row.room_name })
  }

  scored.sort((a, b) => b.score - a.score)

  const get = db.prepare('SELECT * FROM messages WHERE id=?')
  const hits: SemanticHit[] = []
  for (const s of scored.slice(0, limit)) {
    const row = get.get(s.id) as any
    if (!row) continue
    hits.push({
      message: rowToMessage(row),
      roomId: row.room_id,
      roomName: s.roomName,
      score: Number(s.score.toFixed(4)),
      snippet: row.body.trim().slice(0, 220),
    })
  }
  return hits
}

function rowToMessage(r: any): Message {
  return {
    id: r.id, roomId: r.room_id, authorType: r.author_type, authorId: r.author_id,
    body: r.body, replyTo: r.reply_to, round: r.round, deliberationId: r.deliberation_id,
    sealed: !!r.sealed, priority: !!r.priority, stance: r.stance,
    claims: safe(r.claims), degraded: !!r.degraded, brain: r.brain, model: r.model,
    costUsd: r.cost_usd, createdAt: r.created_at, seq: r.seq,
  }
}

function safe(s: string | null) {
  try { return s ? JSON.parse(s) : [] } catch { return [] }
}

/**
 * Similarity between two short texts, or null when no local embedder is running.
 * Used for position de-duplication (see ledger.ts).
 */
export async function similarity(a: string, b: string): Promise<number | null> {
  if (!await reachable()) return null
  try {
    const [va, vb] = await embed([truncate(a), truncate(b)])
    if (!va || !vb || va.length !== vb.length) return null
    let dot = 0
    for (let i = 0; i < va.length; i++) dot += va[i] * vb[i]
    return dot
  } catch {
    return null
  }
}

/** Most similar candidate above `threshold`, or null. Vectors are pre-normalised. */
export async function nearest(
  query: string, candidates: { id: string; text: string }[], threshold: number,
): Promise<{ id: string; score: number } | null> {
  if (!candidates.length) return null
  if (!await reachable()) return null
  try {
    const vecs = await embed([truncate(query), ...candidates.map(c => truncate(c.text))])
    const qv = vecs[0]
    if (!qv) return null
    let best: { id: string; score: number } | null = null
    for (let i = 0; i < candidates.length; i++) {
      const v = vecs[i + 1]
      if (!v || v.length !== qv.length) continue
      let dot = 0
      for (let j = 0; j < v.length; j++) dot += v[j] * qv[j]
      if (dot >= threshold && (!best || dot > best.score)) {
        best = { id: candidates[i].id, score: dot }
      }
    }
    return best
  } catch {
    return null
  }
}
