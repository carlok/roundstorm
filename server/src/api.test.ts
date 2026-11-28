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
import { isAbsolute, join } from 'node:path'
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

test('stop, interrupt, extend and a room edit on an unknown id are 404s', async () => {
  for (const path of ['stop', 'interrupt', 'extend']) {
    const res = await post(`/api/deliberations/no-such-run/${path}`, {})
    assert.equal(res.status, 404, `${path} answered ${res.status} for an id that does not exist`)
  }
  const res = await fetch(`${origin}/api/rooms/no-such-room`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }),
  })
  assert.equal(res.status, 404)
})

test('both backup routes log the same event shape', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-bk-'))
  process.env.ROUNDSTORM_BACKUP_DIR = dir
  const before = db.listEvents(null, 5000).filter(e => e.type === 'backup.created').length

  assert.equal((await post('/api/backup', {})).status, 200)
  const dl = await fetch(`${origin}/api/backup`)
  assert.equal(dl.status, 200)
  await dl.arrayBuffer()

  // Written on the response's close for the download, so give it a moment.
  for (let i = 0; i < 40 && db.listEvents(null, 5000).filter(e => e.type === 'backup.created').length < before + 2; i++) {
    await new Promise(r => setTimeout(r, 25))
  }
  const events = db.listEvents(null, 5000).filter(e => e.type === 'backup.created').slice(-2)
  assert.equal(events.length, 2)
  for (const e of events) {
    assert.deepEqual(Object.keys(e.payload as object).sort(), ['bytes', 'path', 'via'], 'the two routes log different shapes')
  }
  const vias = events.map(e => (e.payload as any).via).sort()
  assert.deepEqual(vias, ['download', 'file'])
  delete process.env.ROUNDSTORM_BACKUP_DIR
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
  assert.ok(isAbsolute(stored), `stored as ${stored}`)
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

test('an agent in a running deliberation cannot be deleted from under it', async () => {
  const r = room('busy-room')
  const agentId = r.memberIds[0]
  const d = db.createDeliberation({
    roomId: r.id, mode: 'deliberation', rounds: 2, style: 'parallel', sealedOpening: false,
    status: 'running', currentRound: 1, question: 'q', tier: 'reasoning',
  } as never)
  const del = () => fetch(`${origin}/api/agents/${agentId}`, { method: 'DELETE' })
  const res = await del()
  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /running deliberation/)
  assert.ok(db.getAgent(agentId), 'the agent was deleted anyway')

  db.updateDeliberation(d.id, { status: 'complete' })
  assert.equal((await del()).status, 200)
})

test('the ledger route returns the run summary, and 404s for a room that does not exist', async () => {
  const r = room('ledger-room')
  const res = await fetch(`${origin}/api/rooms/${r.id}/ledger`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.standing, null)
  assert.equal(body.level, 'no_reliable_conclusion')
  assert.equal((await fetch(`${origin}/api/rooms/nope/ledger`)).status, 404)
})

// --- run integrity (#80, #81) ---

test('extending a deliberation that has ended is a 409, not a silent 200', async () => {
  const r = room('ended-room')
  const d = db.createDeliberation({
    roomId: r.id, mode: 'deliberation', rounds: 2, style: 'parallel', sealedOpening: false,
    status: 'complete', currentRound: 2, question: 'q', tier: 'reasoning',
  } as never)
  const res = await post(`/api/deliberations/${d.id}/extend`, { by: 1 })
  assert.equal(res.status, 409)
  assert.equal(db.getDeliberation(d.id)!.rounds, 2, 'rounds were bumped anyway')
})

test('an unknown member id is refused before anything is written', async () => {
  const r = room('cast-room')
  const before = db.listRooms().length
  const created = await post('/api/rooms', { projectId: r.projectId, name: 'bad cast', memberIds: [r.memberIds[0], 'ghost'] })
  assert.equal(created.status, 400)
  assert.match((await created.json()).error, /ghost/)
  assert.equal(db.listRooms().length, before, 'a half-made room was left behind')

  const edited = await patch(`/api/rooms/${r.id}`, { memberIds: ['ghost'] })
  assert.equal(edited.status, 400)
  assert.deepEqual(db.getRoom(r.id)!.memberIds, r.memberIds, 'the cast was emptied by a bad edit')

  const fork = await post(`/api/rooms/${r.id}/fork`, { name: 'side', memberIds: ['ghost'] })
  assert.equal(fork.status, 400)
  assert.equal(db.listRooms().length, before)
})

test('a transaction lands all of its writes or none of them', () => {
  const p = db.createProject('tx')
  assert.throws(() => db.tx(() => {
    db.createRoom(p.id, 'tx-room', 'room', [])
    throw new Error('boom')
  }), /boom/)
  assert.ok(!db.listRooms().some(r => r.name === 'tx-room'), 'a write survived the rollback')
  assert.equal(db.tx(() => db.createRoom(p.id, 'tx-ok', 'room', []).name), 'tx-ok')
})

// --- inspectability (#83, #84) ---

test('a turn\'s recorded context is found by message id, however old', async () => {
  const r = room('context-room')
  const agentId = r.memberIds[0]
  const d = db.createDeliberation({
    roomId: r.id, mode: 'deliberation', rounds: 1, style: 'parallel', sealedOpening: false,
    status: 'complete', currentRound: 1, question: 'q', tier: 'reasoning',
  } as never)
  const m = db.insertMessage({ roomId: r.id, authorType: 'agent', authorId: agentId, body: 'x', round: 1, deliberationId: d.id })
  db.logEvent('tier.downgraded', { roomId: r.id, deliberationId: d.id, agentId,
    payload: { requested: 'full', granted: 'research', reason: 'no working directory set for this project' } })
  db.logEvent('turn.started', { roomId: r.id, deliberationId: d.id, agentId,
    payload: { round: 1, tier: 'research', sections: [{ name: 'question', chars: 10 }], steers: ['STEER-X'] } })
  db.logEvent('turn.completed', { roomId: r.id, deliberationId: d.id, agentId, payload: { messageId: m.id, claims: 1 } })
  // Bury it: the old lookup only scanned the newest 5,000 events. One
  // transaction, so this takes milliseconds: written one by one it took long
  // enough on the Windows runner for the server to drop the idle keep-alive
  // socket, and the next fetch on it failed.
  db.tx(() => { for (let i = 0; i < 5_100; i++) db.logEvent('noise') })

  const res = await fetch(`${origin}/api/messages/${m.id}/context`, { headers: { connection: 'close' } })
  assert.equal(res.status, 200, 'an older message had "no context recorded"')
  const body = await res.json()
  assert.deepEqual(body.context.steers, ['STEER-X'])
  assert.equal(body.downgraded.reason, 'no working directory set for this project')
  assert.equal((await fetch(`${origin}/api/messages/nope/context`)).status, 404)
})

test('a memory card can be edited and forgotten, and a forgotten card leaves the prompt', async () => {
  const { composeContext } = await import('./deliberation/context.ts')
  const r = room('memory-room')
  const agent = db.getAgent(r.memberIds[0])!
  const card = db.proposeMemory({ agentId: agent.id, projectId: r.projectId, roomId: r.id, scope: 'project',
    type: 'result', text: 'The original wording of a card', sourceMessageId: null })
  const compose = () => composeContext({
    agent, room: db.getRoom(r.id)!, roster: [agent], round: 1, history: [], steers: [], schemaEnforced: true,
    deliberation: { id: 'd', roomId: r.id, mode: 'deliberation', rounds: 1, style: 'parallel', sealedOpening: false,
      status: 'running', currentRound: 1, question: 'q', tier: 'reasoning', createdAt: 0, endedAt: null } as never,
  }).userPrompt

  assert.equal((await patch(`/api/memory/${card.id}`, { status: 'accepted', text: 'short' })).status, 400)
  assert.equal((await patch(`/api/memory/nope`, { status: 'accepted' })).status, 404)
  const kept = await patch(`/api/memory/${card.id}`, { status: 'accepted', text: '  The corrected wording of a card  ' })
  assert.equal(kept.status, 200)
  assert.ok(compose().includes('The corrected wording of a card'), 'the edit did not reach the prompt')

  assert.equal((await patch(`/api/memory/${card.id}`, { status: 'rejected' })).status, 200)
  assert.ok(!compose().includes('The corrected wording'), 'a forgotten card still reached the prompt')
})

test('a room lists its members in the order they joined, not by id', () => {
  // Roster order decides ping-pong rotation, the conclave chair and the synthesiser.
  const p = db.createProject('order')
  const mk = (n: string) => db.createAgent({ name: n, role: '', avatarColor: '#000', personaKey: 'skeptic',
    personaExtra: '', brain: 'x', model: null, tierCeiling: 'reasoning' } as never)
  const agents = ['Zed', 'Amy', 'Mia', 'Bob', 'Kai', 'Lee'].map(mk)
  const ids = agents.map(a => a.id).reverse()
  const r = db.createRoom(p.id, 'ordered', 'room', ids)
  assert.deepEqual(db.getRoom(r.id)!.memberIds, ids)
  assert.deepEqual(db.listRooms().find(x => x.id === r.id)!.memberIds, ids)
})

test('bootstrap lists the rooms with a run in progress', async () => {
  const r = room('running-room')
  db.createDeliberation({
    roomId: r.id, mode: 'deliberation', rounds: 2, style: 'parallel', sealedOpening: false,
    status: 'running', currentRound: 1, question: 'q', tier: 'reasoning',
  } as never)
  const boot = await (await fetch(`${origin}/api/bootstrap`)).json()
  assert.ok(boot.running.includes(r.id))
  assert.ok(!boot.running.includes(room('idle-room').id))
})

test('the synthesise route answers 404 and 409 rather than starting nonsense', async () => {
  assert.equal((await post('/api/deliberations/nope/synthesise', {})).status, 404)
  const r = room('synth-route')
  const d = db.createDeliberation({
    roomId: r.id, mode: 'deliberation', rounds: 2, style: 'parallel', sealedOpening: false,
    status: 'running', currentRound: 1, question: 'q', tier: 'reasoning',
  } as never)
  const res = await post(`/api/deliberations/${d.id}/synthesise`, {})
  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /still running/)
})

// --- sources, export, search scope (#96, #95, #100) ---

test('a source can be added by hand, and pasted evidence reaches the prompt', async () => {
  const { composeContext } = await import('./deliberation/context.ts')
  const r = room('evidence-room')
  assert.equal((await post('/api/rooms/nope/sources', { title: 'x' })).status, 404)
  assert.equal((await post(`/api/rooms/${r.id}/sources`, { title: '  ' })).status, 400)
  assert.equal((await post(`/api/rooms/${r.id}/sources`, { title: 'x', url: 'javascript:alert(1)' })).status, 400)
  assert.equal((await post(`/api/rooms/${r.id}/sources`, { title: 'x', snapshot: 'y'.repeat(20_001) })).status, 400)

  const res = await post(`/api/rooms/${r.id}/sources`, { title: 'Bench run 3', snapshot: 'PASTED-EVIDENCE: peak at 0.47x' })
  assert.equal(res.status, 200)
  const src = await res.json()
  assert.equal(src.kind, 'note')
  assert.ok(db.listEvents(r.id).some(e => e.type === 'source.added'))

  const agent = db.getAgent(r.memberIds[0])!
  const prompt = composeContext({
    agent, room: db.getRoom(r.id)!, roster: [agent], round: 1, history: [], steers: [], schemaEnforced: true,
    deliberation: { id: 'd', roomId: r.id, mode: 'deliberation', rounds: 1, style: 'parallel', sealedOpening: false,
      status: 'running', currentRound: 1, question: 'q', tier: 'reasoning', createdAt: 0, endedAt: null } as never,
  }).userPrompt
  assert.ok(prompt.includes('PASTED-EVIDENCE: peak at 0.47x'), 'the pasted text never reached the agents')
})

test('keyword search can be scoped to one room', async () => {
  const a = room('scope-a'), b = room('scope-b')
  db.insertMessage({ roomId: a.id, authorType: 'human', body: 'SCOPE-WORD in room a' })
  db.insertMessage({ roomId: b.id, authorType: 'human', body: 'SCOPE-WORD in room b' })
  const all = await (await fetch(`${origin}/api/search?q=SCOPE-WORD&semantic=0`)).json()
  assert.equal(all.hits.filter((h: any) => [a.id, b.id].includes(h.roomId)).length, 2)
  const one = await (await fetch(`${origin}/api/search?q=SCOPE-WORD&semantic=0&roomId=${b.id}`)).json()
  assert.deepEqual(one.hits.map((h: any) => h.roomId), [b.id])
})

test('a room export is saved as a file, in Markdown or JSON', async () => {
  const { readFileSync } = await import('node:fs')
  process.env.ROUNDSTORM_BACKUP_DIR = mkdtempSync(join(tmpdir(), 'rs-export-'))
  const r = room('Export Me!')
  db.insertMessage({ roomId: r.id, authorType: 'human', body: 'EXPORT-MARK' })
  const md = await (await post(`/api/rooms/${r.id}/export`, { format: 'markdown' })).json()
  assert.match(md.path, /roundstorm-export-me-.*\.md$/)
  assert.ok(readFileSync(md.path, 'utf8').includes('EXPORT-MARK'))
  const js = await (await post(`/api/rooms/${r.id}/export`, { format: 'json' })).json()
  assert.equal(JSON.parse(readFileSync(js.path, 'utf8')).room.id, r.id)
  assert.equal((await post('/api/rooms/nope/export', {})).status, 404)
  delete process.env.ROUNDSTORM_BACKUP_DIR
})
