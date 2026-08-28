import express from 'express'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { makeApi } from './api.ts'
import { bus } from './bus.ts'
import { seedIfEmpty } from './seed.ts'
import { probeBrains } from './adapters/registry.ts'
import { DATA_PATH, db, logEvent } from './db.ts'

const PORT = Number(process.env.PORT ?? 8787)

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
const wss = new WebSocketServer({ server, path: '/ws' })

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
    if (!alive || process.ppid === 1) {
      logEvent('daemon.orphaned', { payload: { parent } })
      process.exit(0)
    }
  }, 3000).unref()
}

server.listen(PORT, '127.0.0.1', async () => {
  watchParent()
  // Print before probing. Brain discovery shells out to every CLI and
  // `cursor-agent --list-models` alone takes ~30s, so logging only afterwards
  // leaves the log file empty for half a minute after a successful start —
  // indistinguishable from a daemon that never came up.
  console.log(`roundstorm daemon  http://127.0.0.1:${PORT}`)
  console.log(`data               ${DATA_PATH}`)
  console.log(`storage            ${db.backend} (SQLite ${db.sqliteVersion})`)
  console.log(webRoot
    ? `interface          http://127.0.0.1:${PORT}`
    : `interface          not bundled — run \`npm run build\`, or use the dev server`)
  console.log(`brains             probing…`)

  const brains = await probeBrains()
  const line = brains.map(b =>
    `${b.id} ${b.available ? '✔' : '✖'}${b.available && b.models.length ? ` (${b.models.length})` : ''}`
  ).join(' · ')
  console.log(`brains             ${line}`)
  logEvent('daemon.started', { payload: { brains: brains.map(b => ({ id: b.id, available: b.available })) } })
})
