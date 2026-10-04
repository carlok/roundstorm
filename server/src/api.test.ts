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
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
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

// --- privilege fields ---

/** An agent with a known ceiling, to prove a refused request changed nothing. */
function agent(name: string) {
  return db.createAgent({
    name, role: '', avatarColor: '#000', personaKey: 'skeptic', personaExtra: '',
    brain: 'stub', model: 'm', tierCeiling: 'research',
  } as never)
}

const patch = (path: string, body: unknown) =>
  fetch(`${origin}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

test('an agent ceiling cannot be raised by a request body', async () => {
  // This route was `res.json(db.updateAgent(req.params.id, req.body))` — the whole
  // body, unvalidated, into a row spread. With the adapters failing open on an
  // unrecognised tier, that was an unauthenticated path to write and shell.
  const a = agent('ceiling-check')
  const res = await patch(`/api/agents/${a.id}`, { tierCeiling: 'workstation ' })

  assert.equal(res.status, 400, `answered ${res.status}`)
  assert.equal(db.getAgent(a.id)!.tierCeiling, 'research',
    'the ceiling was written even though the request was refused')
})

test('a legitimate agent edit still works', async () => {
  const a = agent('edit-check')
  const res = await patch(`/api/agents/${a.id}`, { tierCeiling: 'workstation', role: 'analyst' })
  assert.equal(res.status, 200)
  assert.equal(db.getAgent(a.id)!.tierCeiling, 'workstation')
  assert.equal(db.getAgent(a.id)!.role, 'analyst')
})

test('editing an agent that does not exist is a 404, not an empty 200', async () => {
  const res = await patch('/api/agents/no-such-agent', { role: 'x' })
  assert.equal(res.status, 404)
})

test('a room tier cannot be set to something the adapters do not know', async () => {
  const r = room('tier-check')
  const res = await patch(`/api/rooms/${r.id}`, { tier: '__proto__' })
  assert.equal(res.status, 400)
  assert.equal(db.getRoom(r.id)!.tier, 'reasoning', 'the tier was written anyway')
})

test('a project working directory must exist', async () => {
  const p = db.createProject('workdir-check')
  const res = await patch(`/api/projects/${p.id}`, { workingDir: '/definitely/not/here' })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /no such directory/)
  assert.equal(db.getProject(p.id)!.workingDir, null)
})

test('a working directory is stored resolved, not as given', async () => {
  // A relative path resolves against the daemon's cwd, which for a Finder-launched
  // app is `/` — the case resolveWorkspace's own comment is written to prevent.
  const p = db.createProject('workdir-resolve')
  const res = await patch(`/api/projects/${p.id}`, { workingDir: '.' })
  assert.equal(res.status, 200)
  const stored = db.getProject(p.id)!.workingDir!
  assert.ok(stored.startsWith('/'), `stored as ${stored}`)
})

// --- the framework behaviour this file's routes now rely on ---

test('a rejected async handler becomes a 500 instead of hanging the request', async () => {
  // Express 4 dropped a rejected promise on the floor: the request never answered
  // and Node saw an unhandled rejection, which is why every async route used to be
  // wrapped by hand. Express 5 forwards it to the error middleware itself, and the
  // wrapper is gone — so this is what stops a downgrade or a mis-pinned version
  // from quietly reintroducing the hang. Hence the timeout: on 4 this never ends.
  const app = express()
  app.get('/boom', async () => { throw new Error('boom') })
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message })
  })
  const srv = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  try {
    const port = (srv.address() as { port: number }).port
    const res = await fetch(`http://127.0.0.1:${port}/boom`, { signal: AbortSignal.timeout(2000) })
    assert.equal(res.status, 500)
    assert.equal((await res.json()).error, 'boom')
  } finally {
    srv.close()
  }
})
