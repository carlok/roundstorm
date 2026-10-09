/**
 * The origin rule, over a real socket.
 *
 * `origin.test.ts` proves the predicate; this proves it is actually wired to both
 * doors. The WebSocket is the one that matters most: handshakes are exempt from
 * CORS, and every socket is subscribed to the whole event bus, so a page could
 * stream the room live without touching `/api` at all.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'

process.env.ROUNDSTORM_DATA = mkdtempSync(join(tmpdir(), 'rs-gate-'))
const { makeApi } = await import('../api.ts')
const { websocketAllowed } = await import('./auth.ts')
const { bus } = await import('../bus.ts')

let server: Server
let port = 0

before(async () => {
  const app = express()
  app.use('/api', makeApi())
  server = createServer(app)
  // The same wiring index.ts uses.
  const wss = new WebSocketServer({
    server, path: '/ws',
    // The daemon's own decision, not a copy of it that could drift.
    verifyClient: ({ req }, done) => {
      const v = websocketAllowed(req)
      done(v.ok, v.status, v.reason)
    },
  })
  wss.on('connection', socket => {
    const off = bus.subscribe(e => socket.readyState === socket.OPEN && socket.send(JSON.stringify(e)))
    socket.on('close', off)
  })
  await new Promise<void>(r => { server.listen(0, '127.0.0.1', r) })
  port = (server.address() as { port: number }).port
})

after(() => { server?.close() })

const get = (origin?: string) =>
  fetch(`http://127.0.0.1:${port}/api/memory`, origin ? { headers: { origin } } : undefined)

test('a website cannot read the API, and is not told it may', async () => {
  const res = await get('https://evil.example')
  assert.equal(res.status, 403)
  assert.equal(res.headers.get('access-control-allow-origin'), null,
    'the refusal echoed the origin back, which makes it readable')
})

test('the packaged app can', async () => {
  const res = await get('tauri://localhost')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('access-control-allow-origin'), 'tauri://localhost')
  assert.equal(res.headers.get('vary'), 'origin')
})

test('curl can, as the README says', async () => {
  assert.equal((await get()).status, 200)
})

test('a preflight from a website is refused too', async () => {
  // Without this a cross-origin POST would still reach the route: the attacker
  // does not need to read the response to start a billable run.
  const res = await fetch(`http://127.0.0.1:${port}/api/rooms/x/deliberations`, {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
  })
  assert.equal(res.status, 403)
})

const handshake = (origin?: string) => new Promise<'open' | number>(resolve => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { headers: { origin } } : {})
  ws.on('open', () => { ws.close(); resolve('open') })
  ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
  ws.on('error', () => resolve(0))
})

test('a website cannot open the event stream', async () => {
  assert.equal(await handshake('https://evil.example'), 403,
    'a page could stream every message body without touching /api')
})

test('the packaged app can open the event stream', async () => {
  assert.equal(await handshake('tauri://localhost'), 'open')
})

test('a non-browser client can open the event stream', async () => {
  assert.equal(await handshake(), 'open')
})


// --- the bearer token, over a real socket ---

const TOKEN = 'a-test-token-0123456789'
const withToken = async (fn: () => Promise<void>) => {
  process.env.ROUNDSTORM_TOKEN = TOKEN
  try { await fn() } finally { delete process.env.ROUNDSTORM_TOKEN }
}
const call = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init)

test('with a token configured, a request without one is refused', () => withToken(async () => {
  const res = await call('/api/memory')
  assert.equal(res.status, 401)
  assert.match((await res.json()).error, /token/)
}))

test('a wrong token is refused, including one of a different length', () => withToken(async () => {
  assert.equal((await call('/api/memory?token=nope')).status, 401)
  assert.equal((await call(`/api/memory?token=${TOKEN}x`)).status, 401)
  assert.equal((await call('/api/memory?token=')).status, 401)
}))

test('the right token works as a query parameter and as a bearer header', () => withToken(async () => {
  assert.equal((await call(`/api/memory?token=${TOKEN}`)).status, 200)
  assert.equal((await call('/api/memory', { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200)
}))

test('the origin gate still runs first: a website with the right token is still refused', () => withToken(async () => {
  // A token that leaks into a web page must not be enough on its own.
  const res = await call(`/api/memory?token=${TOKEN}`, { headers: { origin: 'https://evil.example' } })
  assert.equal(res.status, 403)
}))

test('the packaged app, with its token, is served', () => withToken(async () => {
  const res = await call(`/api/memory?token=${TOKEN}`, { headers: { origin: 'tauri://localhost' } })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('access-control-allow-origin'), 'tauri://localhost')
}))

test('a preflight does not need the token, because a browser sends it without credentials', () => withToken(async () => {
  const res = await call('/api/memory', {
    method: 'OPTIONS',
    headers: { origin: 'tauri://localhost', 'access-control-request-method': 'GET',
               'access-control-request-headers': 'authorization' },
  })
  assert.equal(res.status, 204)
  assert.match(res.headers.get('access-control-allow-headers') ?? '', /authorization/i)
}))

test('with no token configured, nothing changed', async () => {
  delete process.env.ROUNDSTORM_TOKEN
  assert.equal((await call('/api/memory')).status, 200)
})

test('the event stream needs the token too', () => withToken(async () => {
  assert.equal(await handshake(), 401, 'the WebSocket was open to anyone who could reach the port')
}))

const handshakeWith = (query: string, headers: Record<string, string> = {}) => new Promise<'open' | number>(resolve => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, { headers })
  ws.on('open', () => { ws.close(); resolve('open') })
  ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
  ws.on('error', () => resolve(0))
})

test('the event stream opens with the right token, and refuses a wrong one', () => withToken(async () => {
  assert.equal(await handshakeWith(`?token=${TOKEN}`), 'open')
  assert.equal(await handshakeWith('?token=wrong'), 401)
  assert.equal(await handshakeWith(`?token=${TOKEN}`, { origin: 'https://evil.example' }), 403)
}))
