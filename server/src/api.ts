import express from 'express'
import { createReadStream, mkdirSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as db from './db.ts'
import { bus } from './bus.ts'
import { requestAllowed, warnRefused } from './http/origin.ts'
import { tokenFrom, tokenOk, warnUnauthorised } from './http/auth.ts'
import { ALL_PERSONAS } from './deliberation/personas.ts'
import { MODE_BLURB, MODE_LABEL } from './deliberation/context.ts'
import { adapterIds, listBrainOptions, probeBrains } from './adapters/registry.ts'
import { extendDeliberation, interruptDeliberation, startDeliberation, stopDeliberation } from './deliberation/scheduler.ts'
import { summarise } from './deliberation/ledger.ts'
import { renderResultMarkdown } from './deliberation/export.ts'
import { embedderStatus, indexPending, semanticSearch } from './search/embeddings.ts'
import { compare, createExperiment, reportArm } from './deliberation/personalab.ts'
import { ConfigError, parseExperiment } from './headless/config.ts'
import { setupExperiment } from './headless/run.ts'
import type { Agent, Mode, Style, Tier } from './types.ts'
import { TIER_ORDER, isTier } from './types.ts'

export function makeApi() {
  const api = express.Router()

  /**
   * The desktop shell serves the UI from `tauri://localhost`, which is a
   * different origin from the daemon on 127.0.0.1. Without CORS every request
   * from the packaged app dies in preflight and the window just stays blank.
   *
   * This used to reflect whatever `Origin` arrived, justified by "the daemon
   * binds to loopback, so this grants nothing a local process could not already
   * do". A web page is not a local process: reflecting its origin let any site
   * the user visited read every transcript in the database. See http/origin.ts.
   */
  api.use((req, res, next) => {
    const origin = req.headers.origin
    if (!requestAllowed(origin, req.headers.host)) {
      warnRefused(origin, req.headers.host)
      // No access-control-allow-origin on the refusal: a 403 that still echoes
      // the origin is a 403 the caller can read.
      return res.status(403).json({ error: 'refused: unrecognised Origin or Host' })
    }
    if (origin) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'origin')
      res.setHeader('access-control-allow-headers', 'content-type, authorization')
      res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS')
      res.setHeader('access-control-max-age', '600')
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })

  /**
   * The bearer token, when one is configured (see http/auth.ts).
   *
   * After the origin gate and after the preflight answer above, in that order: a
   * browser sends a preflight without credentials, so it has to be answered before
   * the token is demanded, and a website holding a leaked token must still be
   * refused by origin.
   */
  api.use((req, res, next) => {
    if (tokenOk(tokenFrom(req.headers.authorization, req.originalUrl))) return next()
    warnUnauthorised('http')
    res.status(401).json({ error: 'unauthorised: missing or wrong token' })
  })

  api.use(express.json({ limit: '8mb' }))


  api.get('/bootstrap', async (_req, res) => {
    res.json({
      projects: db.listProjects(),
      rooms: db.listRooms(),
      agents: db.listAgents(),
      personas: ALL_PERSONAS,
      brains: await probeBrains(),
      brainOptions: await listBrainOptions(),
      modes: (Object.keys(MODE_LABEL) as Mode[]).map(m => ({
        key: m, label: MODE_LABEL[m], blurb: MODE_BLURB[m],
      })),
    })
  })

  api.get('/rooms/:id/messages', (req, res) => {
    const room = db.getRoom(req.params.id)
    const roster = (room?.memberIds ?? []).map(id => db.getAgent(id)).filter(Boolean) as any[]
    res.json({
      messages: db.listMessages(req.params.id),
      deliberations: db.listDeliberations(req.params.id),
      active: db.activeDeliberation(req.params.id) ?? null,
      positions: db.listPositions(req.params.id),
      sources: db.listSources(req.params.id),
      results: db.listResults(req.params.id),
      // Scoped to the run in progress, or the most recent one. `positions` above
      // stays room-wide: the Inspector's Positions tab is a room panel with no
      // run selector, and scoping it would empty between deliberations.
      ledger: room ? summarise(room.id, roster, currentRun(room.id)) : null,
    })
  })

  // Memory inbox: agents propose, a human keeps or discards (plan §5.2).
  api.get('/memory', (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined
    res.json({ cards: db.listMemory({ status, agentId }) })
  })

  api.patch('/memory/:id', (req, res) => {
    const { status, text } = req.body ?? {}
    if (!['accepted', 'rejected', 'proposed'].includes(status)) {
      return res.status(400).json({ error: 'status must be accepted, rejected or proposed' })
    }
    const card = db.setMemoryStatus(req.params.id, status, typeof text === 'string' ? text : undefined)
    db.logEvent('memory.reviewed', { payload: { id: req.params.id, status } })
    res.json(card)
  })

  api.post('/rooms/:id/sources', (req, res) => {
    const { url, title, kind, snapshot } = req.body ?? {}
    if (!title) return res.status(400).json({ error: 'title required' })
    res.json(db.upsertSource(req.params.id, { url, title, kind, snapshot }))
  })

  /**
   * Global search (plan §21). Keyword always; semantic when a local embedder is
   * running. `semantic: null` means "not available", which the UI reports rather
   * than silently returning keyword hits and pretending they are the same thing.
   */
  api.get('/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : ''
    const [keyword, semantic] = await Promise.all([
      Promise.resolve(db.searchMessages(q)),
      req.query.semantic === '0' ? Promise.resolve(null) : semanticSearch(q),
    ])
    res.json({ hits: keyword, semantic })
  })

  api.get('/search/status', async (_req, res) => res.json(await embedderStatus()))

  api.post('/search/index', async (_req, res) => {
    const r = await indexPending()
    db.logEvent('search.indexed', { payload: r })
    res.json({ ...r, status: await embedderStatus() })
  })

  // Persona lab (plan §5.1): same personas, different brains, side by side.
  api.post('/lab/experiments', (req, res) => {
    const { projectId, title, personaKeys, arms, tier } = req.body ?? {}
    if (!projectId || !title || !Array.isArray(personaKeys) || !Array.isArray(arms)) {
      return res.status(400).json({ error: 'projectId, title, personaKeys and arms required' })
    }
    if (arms.length < 2) return res.status(400).json({ error: 'a comparison needs at least two arms' })
    if (tier !== undefined && !isTier(tier)) {
      return res.status(400).json({ error: `tier ${tierError.error}` })
    }
    const out = createExperiment({ projectId, title, personaKeys, arms, tier })
    db.logEvent('lab.created', { payload: { title, arms: arms.length, rooms: out.rooms.map(r => r.id) } })
    res.json(out)
  })

  api.get('/lab/compare', (req, res) => {
    const ids = String(req.query.rooms ?? '').split(',').filter(Boolean)
    if (ids.length < 2) return res.status(400).json({ error: 'pass at least two room ids' })
    res.json(compare(ids))
  })

  api.get('/lab/arm/:roomId', (req, res) => {
    const r = reportArm(req.params.roomId)
    if (!r) return res.status(404).json({ error: 'no such room' })
    res.json(r)
  })

  api.get('/rooms/:id/export', (req, res) => {
    const room = db.getRoom(req.params.id)
    if (!room) return res.status(404).json({ error: 'no such room' })
    const format = req.query.format === 'json' ? 'json' : 'markdown'
    const payload = {
      room,
      agents: room.memberIds.map(id => db.getAgent(id)).filter(Boolean),
      messages: db.listMessages(room.id),
      positions: db.listPositions(room.id),
      sources: db.listSources(room.id),
      results: db.listResults(room.id),
      deliberations: db.listDeliberations(room.id),
    }
    if (format === 'json') {
      res.setHeader('content-type', 'application/json')
      return res.send(JSON.stringify(payload, null, 2))
    }
    res.setHeader('content-type', 'text/markdown; charset=utf-8')
    res.send(renderResultMarkdown(payload as any))
  })

  /**
   * A consistent snapshot of the whole store: every room, transcript, position,
   * source, memory card and log entry, in one SQLite file.
   *
   * Uses SQLite's backup API rather than copying the file. In WAL mode the newest
   * writes live in the -wal, which is routinely larger than the .db, so a plain
   * copy produces a stale snapshot that opens fine and quietly lacks recent work.
   */
  /**
   * Write a snapshot straight to disk and report where it went.
   *
   * The GET below streams the same bytes, which is right for scripts. The
   * desktop shell needs this instead: a WKWebView does not handle a
   * content-disposition download the way a browser does, and following that link
   * can navigate the app's own window away from the UI. Saving server-side works
   * identically in the app, in a browser and from curl, and needs no save dialog.
   */
  api.post('/backup', async (req, res) => {
    // Deliberately not caller-supplied. This used to take `req.body.dir` and
    // mkdirSync it recursively, so any page that could reach the API could create
    // directory trees anywhere the daemon's user can write. No caller ever sent
    // it — both buttons POST with no body — so the parameter was pure surface.
    // The env var keeps the escape hatch somewhere a web page cannot set it.
    const dir = process.env.ROUNDSTORM_BACKUP_DIR?.trim() || join(homedir(), 'Downloads')
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const path = join(dir, `roundstorm-${stamp}.db`)
    try {
      mkdirSync(dir, { recursive: true })
      await db.db.backup(path)
      const bytes = statSync(path).size
      db.logEvent('backup.created', { payload: { path, bytes } })
      res.json({ ok: true, path, bytes })
    } catch (err) {
      res.status(500).json({ error: `backup failed: ${String(err)}` })
    }
  })

  api.get('/backup', async (_req, res) => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const name = `roundstorm-${stamp}.db`
    const tmp = join(tmpdir(), `${randomUUID()}.db`)
    try {
      await db.db.backup(tmp)
      const bytes = statSync(tmp).size
      db.logEvent('backup.created', { payload: { bytes } })
      res.setHeader('content-type', 'application/vnd.sqlite3')
      res.setHeader('content-disposition', `attachment; filename="${name}"`)
      res.setHeader('content-length', String(bytes))
      createReadStream(tmp).pipe(res).on('close', () => rmSync(tmp, { force: true }))
    } catch (err) {
      rmSync(tmp, { force: true })
      res.status(500).json({ error: `backup failed: ${String(err)}` })
    }
  })

  // Activity log as JSONL — the auditable stream, separate from the transcript.
  api.get('/events/export', (req, res) => {
    const roomId = typeof req.query.roomId === 'string' ? req.query.roomId : null
    res.setHeader('content-type', 'application/x-ndjson')
    res.send(db.listEvents(roomId, 5000).map(e => JSON.stringify(e)).join('\n'))
  })

  /**
   * Side room seeded from selected messages (plan §11). The seed is copied in as
   * quoted context so the child room stands on its own, and the parent keeps a
   * back-link.
   */
  api.post('/rooms/:id/fork', (req, res) => {
    const parent = db.getRoom(req.params.id)
    if (!parent) return res.status(404).json({ error: 'no such room' })
    const { name, memberIds = [], messageIds = [] } = req.body ?? {}
    if (!name || !Array.isArray(memberIds) || !memberIds.length) {
      return res.status(400).json({ error: 'name and memberIds required' })
    }
    const child = db.createRoom(parent.projectId, name, 'room', memberIds, parent.tier)
    const seeds = (messageIds as string[]).map(id => db.getMessage(id)).filter(Boolean)
    if (seeds.length) {
      const agentName = (id: string | null) => db.getAgent(id ?? '')?.name ?? 'Human'
      db.insertMessage({
        roomId: child.id, authorType: 'system',
        body: `Taken from **${parent.name}**:\n\n` + seeds
          .map(m => `> **${agentName(m!.authorId)}**: ${m!.body.trim().slice(0, 1200)}`)
          .join('\n>\n'),
      })
    }
    db.logEvent('room.forked', { roomId: parent.id, payload: { child: child.id, seeds: seeds.length } })
    res.json(child)
  })

  api.post('/deliberations/:id/interrupt', (req, res) => {
    interruptDeliberation(req.params.id)
    res.json(db.getDeliberation(req.params.id))
  })

  /** "What did Alice see?" — the exact composed context behind one message. */
  api.get('/messages/:id/context', (req, res) => {
    const events = db.listEvents(null, 5000)
      .filter(e => e.type === 'turn.started' || e.type === 'turn.completed')
    const completed = events.find(e =>
      e.type === 'turn.completed' && (e.payload as any)?.messageId === req.params.id)
    if (!completed) return res.status(404).json({ error: 'no context recorded for that message' })
    const started = [...events]
      .filter(e => e.type === 'turn.started' && e.agentId === completed.agentId && e.id < completed.id)
      .pop()
    res.json({ context: started?.payload ?? null, outcome: completed.payload })
  })

  api.post('/rooms', (req, res) => {
    const { projectId, name, kind = 'room', memberIds = [], tier = 'research' } = req.body ?? {}
    if (!projectId || !name) return res.status(400).json({ error: 'projectId and name required' })
    if (!isTier(tier)) return res.status(400).json({ error: `tier ${tierError.error}` })
    res.json(db.createRoom(projectId, name, kind, memberIds, tier))
  })

  api.patch('/rooms/:id', (req, res) => {
    const { tier, memberIds, name } = req.body ?? {}
    if (tier !== undefined) {
      if (!isTier(tier)) return res.status(400).json({ error: `tier ${tierError.error}` })
      db.setRoomTier(req.params.id, tier)
    }
    if (typeof name === 'string' && name.trim()) db.renameRoom(req.params.id, name.trim())
    if (Array.isArray(memberIds)) db.setRoomMembers(req.params.id, memberIds)
    res.json(db.getRoom(req.params.id))
  })

  api.delete('/rooms/:id/messages', (req, res) => {
    const room = db.getRoom(req.params.id)
    if (!room) return res.status(404).json({ error: 'no such room' })
    if (db.activeDeliberation(room.id)) {
      return res.status(409).json({ error: 'stop the running deliberation first' })
    }
    const info = db.clearRoom(room.id)
    db.logEvent('room.cleared', { roomId: room.id, payload: info })
    res.json({ ok: true, ...info })
  })

  api.patch('/projects/:id', (req, res) => {
    const { name, workingDir, defaultTier } = req.body ?? {}
    if (defaultTier !== undefined && !isTier(defaultTier)) {
      return res.status(400).json({ error: `defaultTier ${tierError.error}` })
    }
    // The working directory is the only thing standing between the workstation
    // tiers and the whole machine, so it is resolved and checked here rather than
    // taken as a string. Resolving matters on its own: a relative path resolves
    // against the daemon's cwd, which for a Finder-launched app is `/`.
    let dir = workingDir
    if (typeof dir === 'string' && dir.trim()) {
      dir = resolve(dir.trim())
      if (!isDirectory(dir)) return res.status(400).json({ error: `no such directory: ${dir}` })
    } else if (dir !== undefined) {
      dir = null  // explicit clear
    }
    const p = db.updateProject(req.params.id, { name, workingDir: dir, defaultTier })
    if (!p) return res.status(404).json({ error: 'no such project' })
    db.logEvent('project.updated', { payload: { workingDir: p.workingDir } })
    res.json(p)
  })

  api.delete('/rooms/:id', (req, res) => {
    const room = db.getRoom(req.params.id)
    if (!room) return res.status(404).json({ error: 'no such room' })
    if (db.activeDeliberation(room.id)) {
      return res.status(409).json({ error: 'stop the running deliberation first' })
    }
    db.deleteRoom(room.id)
    db.logEvent('room.deleted', { payload: { name: room.name } })
    res.json({ ok: true })
  })

  api.post('/rooms/:id/messages', async (req, res) => {
    const room = db.getRoom(req.params.id)
    if (!room) return res.status(404).json({ error: 'no such room' })
    const { body, replyTo = null } = req.body ?? {}
    if (typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ error: 'body required' })
    }
    const active = db.activeDeliberation(room.id)
    const message = db.insertMessage({
      roomId: room.id, authorType: 'human', body: body.trim(), replyTo,
      // A human message during a live deliberation jumps the queue (plan §8).
      priority: !!active,
    })
    db.logEvent('human.message', { roomId: room.id, payload: { messageId: message.id, priority: !!active } })
    bus.emit({ type: 'message', message })

    // In a DM the agent answers immediately; no rounds, no ceremony (plan §11).
    if (room.kind === 'dm' && !active) {
      const { replyInDm } = await import('./deliberation/dm.ts')
      void replyInDm(room, message)
    }
    res.json(message)
  })

  /**
   * Load an experiment file from the interface.
   *
   * The same parser and the same setup the CLI uses, so a config that works
   * headless works here. It creates the cast and the room and stops — starting a
   * run costs money, and that decision stays with whoever pressed the button.
   */
  api.post('/experiments', (req, res) => {
    const text = typeof req.body?.config === 'string' ? req.body.config : ''
    if (!text.trim()) return res.status(400).json({ error: 'send the file contents as "config"' })

    let cfg
    try {
      cfg = parseExperiment(text, { brains: adapterIds(), personas: ALL_PERSONAS.map(p => p.key) })
    } catch (err) {
      // A parse failure is the user's to fix; hand back the message naming the
      // field rather than a generic 400.
      return res.status(400).json({ error: err instanceof ConfigError ? err.message : String(err) })
    }

    const { room, agents } = setupExperiment(cfg)
    db.logEvent('experiment.loaded', {
      roomId: room.id,
      payload: { room: room.name, agents: agents.length, mode: cfg.mode, rounds: cfg.rounds },
    })
    res.json({
      room, agents,
      deliberation: {
        mode: cfg.mode, rounds: cfg.rounds, style: cfg.style,
        sealedOpening: cfg.sealedOpening, question: cfg.question,
      },
    })
  })

  api.post('/agents', (req, res) => {
    const b = req.body ?? {}
    if (!b.name || typeof b.name !== 'string') return res.status(400).json({ error: 'name required' })
    res.json(db.createAgent({
      name: db.uniqueAgentName(b.name.trim()),
      role: b.role ?? '',
      avatarColor: b.avatarColor ?? '#5b8def',
      personaKey: b.personaKey ?? 'skeptic',
      personaExtra: b.personaExtra ?? '',
      brain: b.brain ?? 'claude',
      model: b.model ?? null,
      tierCeiling: b.tierCeiling ?? 'research',  // validated above
    }))
  })
  api.patch('/agents/:id', (req, res) => {
    const b = req.body ?? {}
    if (b.tierCeiling !== undefined && !isTier(b.tierCeiling)) {
      return res.status(400).json({ error: `tierCeiling ${tierError.error}` })
    }
    // A whitelist, not the body. Spreading the body into the row let a caller set
    // any column the mapper happened to read.
    const patch: Partial<Agent> = {}
    for (const k of ['name', 'role', 'avatarColor', 'personaKey', 'personaExtra',
                     'brain', 'model', 'tierCeiling'] as const) {
      if (b[k] !== undefined) (patch as Record<string, unknown>)[k] = b[k]
    }
    const agent = db.updateAgent(req.params.id, patch)
    if (!agent) return res.status(404).json({ error: 'no such agent' })
    res.json(agent)
  })

  api.delete('/agents/:id', (req, res) => {
    const agent = db.getAgent(req.params.id)
    if (!agent) return res.status(404).json({ error: 'no such agent' })
    const info = db.deleteAgent(req.params.id)
    db.logEvent('agent.deleted', { agentId: req.params.id, payload: { name: agent.name, ...info } })
    res.json({ ok: true, ...info })
  })

  api.post('/agents/:id/duplicate', (req, res) => {
    const a = db.getAgent(req.params.id)
    if (!a) return res.status(404).json({ error: 'no such agent' })
    // "Duplicate & edit" is the intended route to a custom persona (plan §5.1).
    res.json(db.createAgent({
      ...a, name: db.uniqueAgentName(`${a.name} copy`),
    }))
  })

  api.post('/rooms/:id/deliberations', (req, res) => {
    const room = db.getRoom(req.params.id)
    if (!room) return res.status(404).json({ error: 'no such room' })
    if (db.activeDeliberation(room.id)) {
      return res.status(409).json({ error: 'a deliberation is already running in this room' })
    }
    if (!room.memberIds.length) return res.status(400).json({ error: 'room has no agents' })

    const {
      mode = 'deliberation', rounds = 4, style = 'parallel',
      sealedOpening = true, question = '', tier = room.tier,
    } = req.body ?? {}

    // The default is the room's own tier, which a pre-fix database may hold as
    // junk, so this validates the default too rather than only the override.
    if (!isTier(tier)) return res.status(400).json({ error: `tier ${tierError.error}` })

    const q = String(question).trim() || lastHumanMessage(room.id)
    if (!q) return res.status(400).json({ error: 'ask a question first' })

    // Before the question is inserted below. Validating after it meant a rejected
    // request still left the room showing a question nobody was ever asked.
    const n = roundsOrNull(rounds)
    if (n === null) return res.status(400).json({ error: 'rounds must be a whole number from 1 to 20' })

    // A question typed into the deliberation sheet has to land in the transcript
    // too, otherwise the room opens with agents answering something the record
    // never shows. Skip it when the question already is the last thing said.
    if (q !== lastHumanMessage(room.id)) {
      const asked = db.insertMessage({ roomId: room.id, authorType: 'human', body: q })
      db.logEvent('human.message', {
        roomId: room.id, payload: { messageId: asked.id, viaDeliberationSheet: true },
      })
      bus.emit({ type: 'message', message: asked })
    }

    const d = db.createDeliberation({
      roomId: room.id, mode: mode as Mode, rounds: n,
      style: style as Style, sealedOpening: !!sealedOpening, status: 'running',
      currentRound: 0, question: q, tier: tier as Tier,
    })
    void startDeliberation(d)
    res.json(d)
  })

  api.post('/deliberations/:id/stop', (req, res) => {
    stopDeliberation(req.params.id)
    res.json(db.getDeliberation(req.params.id))
  })

  api.post('/deliberations/:id/extend', (req, res) => {
    const by = roundsOrNull(req.body?.by ?? 1)
    if (by === null) return res.status(400).json({ error: 'by must be a whole number from 1 to 20' })
    extendDeliberation(req.params.id, by)
    res.json(db.getDeliberation(req.params.id))
  })

  api.get('/events', (req, res) => {
    const roomId = typeof req.query.roomId === 'string' ? req.query.roomId : null
    res.json({ events: db.listEvents(roomId) })
  })

  /**
   * Turn a thrown error into a readable message. Without this Express serves a
   * stack trace as HTML and the UI shows "500" with nothing to act on.
   */
  api.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : String(err)
    // express.json rejects a malformed body with a SyntaxError. That is the
    // caller's mistake, not ours, and answering 500 sent them looking in the
    // wrong place.
    const bad = err instanceof SyntaxError && 'body' in (err as object)
    db.logEvent('api.error', { payload: { message, status: bad ? 400 : 500 } })
    if (!bad) console.error('[api]', message)
    res.status(bad ? 400 : 500).json({ error: bad ? `malformed JSON body: ${message}` : message })
  })

  return api
}

/**
 * Rounds, or nothing.
 *
 * This used to be `Math.max(1, Math.min(20, Number(rounds)))`. `Number('abc')` is
 * NaN, and NaN passes through both Math calls untouched. SQLite then refuses the
 * bind — `NOT NULL constraint failed: deliberations.rounds` — so the route died
 * with a 500 and a stack trace, *after* the question had already been inserted
 * into the transcript. The room was left showing a question nobody was asked.
 *
 * Reject it up front instead, before anything is written.
 */
/**
 * A tier decides what an agent may do to the machine, so it is never taken on
 * trust from a request body.
 *
 * `PATCH /agents/:id` used to be `db.updateAgent(id, req.body)` — the whole body,
 * unvalidated — and the lookups downstream failed open for anything they did not
 * recognise. That is an unauthenticated path from a web page to write and shell.
 */
const tierError = { error: `must be one of ${TIER_ORDER.join(', ')}` }

const isDirectory = (p: string): boolean => {
  try { return statSync(p).isDirectory() } catch { return false }
}

function roundsOrNull(v: unknown): number | null {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : null
}

/** The deliberation a room's headline should be about: the live one, else the last. */
function currentRun(roomId: string): string | undefined {
  const active = db.activeDeliberation(roomId)
  if (active) return active.id
  const all = db.listDeliberations(roomId)
  return all.length ? all[all.length - 1].id : undefined
}

function lastHumanMessage(roomId: string): string {
  const msgs = db.listMessages(roomId).filter(m => m.authorType === 'human')
  return msgs.length ? msgs[msgs.length - 1].body : ''
}
