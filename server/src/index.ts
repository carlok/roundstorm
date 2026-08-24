import express from 'express'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { makeApi } from './api.ts'
import { bus } from './bus.ts'
import { seedIfEmpty } from './seed.ts'
import { probeBrains } from './adapters/registry.ts'
import { DATA_PATH, logEvent } from './db.ts'

const PORT = Number(process.env.PORT ?? 8787)

seedIfEmpty()

const app = express()
app.use('/api', makeApi())
app.get('/health', (_req, res) => res.json({ ok: true, data: DATA_PATH }))

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
  console.log(`brains             probing…`)

  const brains = await probeBrains()
  const line = brains.map(b =>
    `${b.id} ${b.available ? '✔' : '✖'}${b.available && b.models.length ? ` (${b.models.length})` : ''}`
  ).join(' · ')
  console.log(`brains             ${line}`)
  logEvent('daemon.started', { payload: { brains: brains.map(b => ({ id: b.id, available: b.available })) } })
})
