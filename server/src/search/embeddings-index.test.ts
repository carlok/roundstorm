/**
 * The index against a stand-in embedder: which rows count as pending, what a
 * change of model does to them, and what a search is allowed to compare.
 *
 * The stand-in maps text to a 3-vector by keyword, so which of two messages is
 * nearer to a query is known in advance, and echoes the model it was asked for.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'

process.env.ROUNDSTORM_DATA = mkdtempSync(join(tmpdir(), 'rs-embidx-'))

let server: Server
const asked: string[] = []
const vecFor = (t: string) => [/bearing/i.test(t) ? 1 : 0, /pump/i.test(t) ? 1 : 0, 0.1]

before(async () => {
  server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) { res.end('{"data":[]}'); return }
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      const { model, input } = JSON.parse(body)
      asked.push(model)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: input.map((t: string, index: number) => ({ index, embedding: vecFor(t) })) }))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  process.env.ROUNDSTORM_EMBED_URL = `http://127.0.0.1:${(server.address() as any).port}/v1`
  process.env.ROUNDSTORM_EMBED_MODEL = 'model-a'
})
after(() => { server.close() })

const db = await import('../db.ts')
const { indexPending, semanticSearch, embedderStatus } = await import('./embeddings.ts')

const project = db.createProject('Emb')
const agent = db.createAgent({
  name: 'E', role: '', avatarColor: '#000', personaKey: 'skeptic', personaExtra: '',
  brain: 'claude', model: null, tierCeiling: 'research',
} as never)
const room = (name: string) => db.createRoom(project.id, name, 'room', [agent.id])
const say = (roomId: string, body: string, extra: Record<string, unknown> = {}) =>
  db.insertMessage({ roomId, authorType: 'agent', authorId: agent.id, body, ...extra } as never)

const r1 = room('One'), r2 = room('Two')
say(r1.id, 'the bearing is worn')
say(r1.id, 'the pump is loud')
say(r2.id, 'another bearing story')

test('indexing fills the index and the pending count drains to zero', async () => {
  assert.equal((await embedderStatus()).pending, 3)
  const r = await indexPending()
  assert.equal(r.indexed, 3)
  const s = await embedderStatus()
  assert.equal(s.pending, 0)
  assert.equal(s.indexed, 3)
})

test('empty messages and unrevealed sealed ones never count as pending', async () => {
  say(r1.id, '   ')
  say(r1.id, 'a sealed opening about bearings', { sealed: true })
  assert.equal((await embedderStatus()).pending, 0, 'something that can never be indexed is holding the count up')
  assert.equal((await indexPending()).indexed, 0)
})

test('search can be scoped to one room', async () => {
  const all = (await semanticSearch('bearing', 10))!
  assert.equal(all.length, 3)
  const scoped = (await semanticSearch('bearing', 10, { roomId: r2.id }))!
  assert.deepEqual(scoped.map(h => h.roomId), [r2.id])
})

test('search returns the best `limit` hits in order', async () => {
  const hits = (await semanticSearch('bearing', 2))!
  assert.equal(hits.length, 2)
  assert.ok(hits[0].score >= hits[1].score)
  assert.ok(hits.every(h => /bearing/.test(h.message.body)), 'the pump message outranked a bearing one')
})

test('changing the embedding model re-embeds instead of mixing two vector spaces', async () => {
  process.env.ROUNDSTORM_EMBED_MODEL = 'model-b'
  // Same 3 dimensions, so the old check (dim only) would have compared them.
  assert.equal((await embedderStatus()).pending, 3, 'old-model rows still counted as indexed')
  assert.deepEqual((await semanticSearch('bearing', 10))!, [], 'search compared vectors from another model')

  asked.length = 0
  assert.equal((await indexPending()).indexed, 3)
  assert.ok(asked.every(m => m === 'model-b'))
  assert.equal((await embedderStatus()).pending, 0)
  assert.equal((await semanticSearch('bearing', 10))!.length, 3)
})
