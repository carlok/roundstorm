/**
 * The HTTP surface, which had no tests at all.
 *
 * Routes are where bad input arrives, and this file's job is the handful of
 * cases where a bad request used to produce something worse than a 400: a
 * stack trace, a half-written room, or a dead daemon.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import type { Server } from 'node:http'

process.env.ROUNDSTORM_DATA = mkdtempSync(join(tmpdir(), 'rs-api-'))
const db = await import('./db.ts')
const { makeApi } = await import('./api.ts')

let server: Server
let origin: string

before(async () => {
  const app = express()
  app.use('/api', makeApi())
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', r) })
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

after(() => { server?.close() })

const post = (path: string, body: unknown, raw = false) =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  })

/** A room with one agent, enough for the deliberation route to get past its guards. */
function room(name: string) {
  const p = db.createProject(name)
  const a = db.createAgent({
    name: `${name}-agent`, role: '', avatarColor: '#000', personaKey: 'skeptic',
    personaExtra: '', brain: 'nonexistent-brain', model: 'm', tierCeiling: 'reasoning',
  } as never)
  return db.createRoom(p.id, name, 'room', [a.id], 'reasoning')
}

test('a malformed JSON body is the caller\'s mistake, not a server error', async () => {
  const res = await post('/api/rooms', '{"projectId": ', true)
  assert.equal(res.status, 400, 'a broken body answered 500, sending the caller to look at our logs')
  assert.match((await res.json()).error, /malformed JSON/)
})

test('a non-numeric round count is refused before anything is written', async () => {
  // Number('abc') is NaN, and NaN passes through Math.max/min untouched. SQLite
  // then refused the bind, so the route threw a 500 — after the question had
  // already been inserted into the transcript, leaving the room showing a
  // question nobody was asked.
  const r = room('rounds-check')
  const before = db.listMessages(r.id).length

  const res = await post(`/api/rooms/${r.id}/deliberations`, {
    question: 'Does this get written before the failure?', rounds: 'abc',
  })

  assert.equal(res.status, 400, `answered ${res.status}`)
  assert.match((await res.json()).error, /rounds/)
  assert.equal(db.listMessages(r.id).length, before,
    'the question was written to the transcript even though the run never started')
  assert.equal(db.activeDeliberation(r.id), undefined)
})

test('a valid round count still works', async () => {
  const r = room('rounds-ok')
  const res = await post(`/api/rooms/${r.id}/deliberations`, { question: 'A real question', rounds: 3 })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).rounds, 3)
})

test('extending by a nonsense amount is refused', async () => {
  const res = await post('/api/deliberations/does-not-matter/extend', { by: 'lots' })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /by/)
})

test('a 404 is a 404, not an empty 200', async () => {
  const res = await post('/api/rooms/no-such-room/deliberations', { question: 'x' })
  assert.equal(res.status, 404)
})
