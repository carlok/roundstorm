import express from 'express'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { makeApi } from './api.ts'
import { warnRefused } from './http/origin.ts'
import { tokenRequired, websocketAllowed } from './http/auth.ts'
import { bus } from './bus.ts'
import { seedIfEmpty } from './seed.ts'
import { probeBrains } from './adapters/registry.ts'
import { terminateAll } from './adapters/spawn.ts'
import { abortAllDeliberations } from './deliberation/scheduler.ts'
import { DATA_PATH, db, logEvent, reconcileDeliberations } from './db.ts'

// ROUNDSTORM_PORT is the documented name; PORT stays accepted because the
// shell and older scripts set it.
const PORT = Number(process.env.ROUNDSTORM_PORT ?? process.env.PORT ?? 8787)

/**
 * Where to listen. Loopback unless explicitly told otherwise.
 *
 * Binding beyond loopback exposes an unauthenticated API that can start
 * processes on this machine — at the workstation and full-local tiers that means
 * reading and writing files and running commands. It is genuinely useful for
 * driving the interface from another machine on a trusted network, and it is not
 * something to leave on.
 */
const HOST = process.env.ROUNDSTORM_HOST ?? '127.0.0.1'
const isLoopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1'

/** Addresses this machine can be reached on, for the startup banner. */
function lanUrls(): string[] {
  const out: string[] = []
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${PORT}`)
    }
  }
  return out
}

seedIfEmpty()

const app = express()
app.use('/api', makeApi())
app.get('/health', (_req, res) => res.json({ ok: true, data: DATA_PATH }))

/**
 * Serve the built UI, so the daemon alone is the whole product.
 *
 * This is what makes Roundstorm runnable on Linux and Windows: the desktop shell
 * is the only platform-specific part, and it exists to draw a window around this
 * server. Without it you get the same app in a browser tab, on any machine with
 * Node — no Rust toolchain, no WebKitGTK, no WebView2, nothing to sign.
 *
 * Skipped when the bundle is absent (`npm run dev`, where Vite serves the UI and
 * proxies here, and the packaged app, which serves the UI itself).
 */
const webRoot = findWebRoot()
if (webRoot) {
  app.use(express.static(webRoot, { index: 'index.html' }))
  // SPA fallback, but never for /api or /ws — a mistyped endpoint should 404 as
  // an endpoint, not silently return the app shell with a 200.
  app.get(/^(?!\/(api|ws|health)\b).*/, (_req, res) => {
    res.sendFile(join(webRoot, 'index.html'))
  })
}

function findWebRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.ROUNDSTORM_WEB_ROOT,
    // Bundled: dist-server/index.mjs sits beside dist-web/.
    join(here, '..', 'dist-web'),
    // Running from source via tsx: server/src/ -> repo root.
    join(here, '..', '..', 'dist-web'),
  ].filter((p): p is string => !!p)
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return resolve(c)
  }
  return null
}

const server = createServer(app)
/**
 * The same origin rule as the API.
 *
 * WebSocket handshakes are exempt from CORS, and every socket here is subscribed
 * to the whole event bus — so before this, any web page could open
 * `ws://127.0.0.1:8787/ws` and stream every message body live without ever
 * touching `/api`. Fixing the CORS header and leaving this open fixes nothing.
 */
const wss = new WebSocketServer({
  server, path: '/ws',
  // `req.headers.origin`, not `info.origin`: ws normalises absent to '' in some
  // versions, and '' must read as "no browser", not as an unparseable origin.
  verifyClient: ({ req }, done) => {
    const v = websocketAllowed(req)
    if (!v.ok && v.status === 403) warnRefused(req.headers.origin, req.headers.host)
    done(v.ok, v.status, v.reason)
  },
})
// It shares the http server, so it re-emits that server's listen failure. Left
// unhandled, an EADDRINUSE killed the daemon with a raw stack trace from ws
// before the readable message below could be printed.
wss.on('error', () => {})

wss.on('connection', socket => {
  const unsubscribe = bus.subscribe(event => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event))
  })
  socket.on('close', unsubscribe)
  socket.on('error', unsubscribe)
})

/**
 * Exit when the desktop shell that launched us goes away.
 *
 * The shell kills the daemon on a clean quit, but a crash or a force-quit leaves
 * it orphaned — holding port 8787, so the next launch silently talks to a stale
 * build. On Unix an orphan is reparented to pid 1, which is the signal to stop.
 */
function watchParent() {
  const parent = Number(process.env.ROUNDSTORM_PARENT_PID)
  if (!parent) return
  setInterval(() => {
    let alive = false
    try {
      process.kill(parent, 0)
      alive = true
    } catch { /* gone */ }
    // `ppid === 1` is the Unix orphan signal. Windows does not reparent, and a
    // systemd user session may reparent to a subreaper rather than pid 1, so the
    // liveness probe above is the portable half and this is a Unix bonus.
    const reparented = process.platform !== 'win32' && process.ppid === 1
    if (!alive || reparented) {
      logEvent('daemon.orphaned', { payload: { parent } })
      // Not process.exit: that skips the brain processes we started, which then
      // keep running against the user's account with nobody reading their output.
      void shutdown('orphaned')
    }
  }, 3000).unref()
}

/**
 * Leave nothing behind.
 *
 * The brains are separate processes — `claude`, `codex`, `cursor-agent` — and
 * killing this daemon does not touch them. Before this, quitting the app left a
 * turn's worth of CLI running against the user's account, invisibly, with no
 * reader for its output. `terminateAll` is the only thing that reaches them.
 */
let shuttingDown = false
async function shutdown(reason: string, code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  const aborted = abortAllDeliberations()
  const killed = terminateAll()
  if (aborted || killed) {
    console.log(`shutdown (${reason}): stopped ${aborted} deliberation(s), ended ${killed} brain process(es)`)
  }
  try { logEvent('daemon.shutdown', { payload: { reason, aborted, killed } }) } catch { /* db may be gone */ }
  server.close()
  // The http server can hold a keep-alive socket open past everything useful.
  setTimeout(() => process.exit(code), 500).unref()
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { void shutdown(sig) })
}

/**
 * A rejected promise must not take the daemon with it.
 *
 * Express 5 forwards a rejected async route handler to the error middleware, so
 * routes no longer need this. It stays because nothing else is guaranteed to be
 * awaited: the fire-and-forget DM reply, the background embedding index, a
 * deliberation's own bookkeeping. Before it existed, one stray rejection killed a
 * daemon that was in the middle of a paid deliberation. Log it and keep going; a
 * genuinely broken process will fail its next request loudly enough.
 */
process.on('unhandledRejection', reason => {
  console.error('unhandled rejection:', reason)
  try { logEvent('daemon.unhandled', { payload: { kind: 'rejection', message: String(reason) } }) } catch { }
})
process.on('uncaughtException', err => {
  console.error('uncaught exception:', err)
  try { logEvent('daemon.unhandled', { payload: { kind: 'exception', message: String(err?.message ?? err) } }) } catch { }
})

const reconciled = reconcileDeliberations()

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is already in use — another Roundstorm daemon is probably running.`)
    console.error(`set ROUNDSTORM_PORT to a free port, or stop the other one first.`)
    process.exit(2)
  }
  if (err.code === 'EACCES') {
    console.error(`not allowed to listen on ${HOST}:${PORT}. Ports below 1024 need privileges.`)
    process.exit(2)
  }
  throw err
})

server.listen(PORT, HOST, async () => {
  watchParent()
  if (reconciled.length) {
    console.log(`recovered           ${reconciled.length} deliberation(s) left running by a previous exit`)
  }
  // Print before probing. Brain discovery shells out to every CLI and
  // `cursor-agent --list-models` alone takes ~30s, so logging only afterwards
  // leaves the log file empty for half a minute after a successful start —
  // indistinguishable from a daemon that never came up.
  console.log(`roundstorm daemon  http://127.0.0.1:${PORT}`)
  console.log(`data               ${DATA_PATH}`)
  console.log(`storage            ${db.backend} (SQLite ${db.sqliteVersion})`)
  // Say that a token is required, never what it is: when the shell starts the
  // daemon this stdout is a log file other accounts on the machine may be able to
  // read, and printing the secret there would defeat it.
  if (tokenRequired()) {
    console.log('access             ROUNDSTORM_TOKEN is set: /api and /ws need it')
    console.log('                   in a browser, open the interface once as  http://<host>:<port>/#token=<your token>')
  }
  // Absent is normal, not a fault: the desktop shell embeds the UI in its own
  // binary, and `npm run dev` has Vite serve it.
  console.log(webRoot
    ? `interface          http://127.0.0.1:${PORT}`
    : `interface          API only (the shell or the dev server is serving the UI)`)

  if (!isLoopback) {
    // Deliberately noisy. Someone who set this on purpose loses nothing by
    // reading four lines; someone who set it by accident needs to.
    console.log('')
    console.log(`!! listening on ${HOST}, not just this machine`)
    console.log('!! the API is unauthenticated and can start processes here.')
    console.log('!! rooms above the research tier can read files and run commands.')
    console.log('!! use this only on a network you trust, and only while you need it.')
    for (const url of lanUrls()) console.log(`   reachable at ${url}`)
    console.log('')
    logEvent('daemon.exposed', { payload: { host: HOST, urls: lanUrls() } })
  }
  console.log(`brains             probing…`)

  const brains = await probeBrains()
  const line = brains.map(b =>
    `${b.id} ${b.available ? '✔' : '✖'}${b.available && b.models.length ? ` (${b.models.length})` : ''}`
  ).join(' · ')
  console.log(`brains             ${line}`)
  logEvent('daemon.started', { payload: { brains: brains.map(b => ({ id: b.id, available: b.available })) } })
})
