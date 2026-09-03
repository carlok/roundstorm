/**
 * Round scheduler (plan §6).
 *
 * Parallel: every agent in a round sees exactly the same context — everything
 * through round N-1 and nothing from round N. That isolation is the whole point
 * of the style and is asserted in the tests against the *composed context*,
 * not against the output.
 *
 * Ping-pong: sequential within the round, speaking order rotated each round so
 * the same agent is not always last (the last speaker gets a free rebuttal).
 *
 * Sealed opening: round 1 is written blind and revealed together.
 */
import type { Agent, Deliberation, Message, Room, Tier } from '../types.ts'
import { createHash } from 'node:crypto'
import * as db from '../db.ts'
import { bus } from '../bus.ts'
import { getAdapter, schemaFor } from '../adapters/registry.ts'
import { composeContext } from './context.ts'
import { applyPositionOps } from './ledger.ts'
import { runConclave } from './conclave.ts'
import { synthesise } from './synthesis.ts'
import { TURN_SCHEMA, coerceTurn, extractJson, stripJsonBlock } from './contract.ts'

interface Running {
  deliberation: Deliberation
  controller: AbortController
  interrupt?: boolean
}

const running = new Map<string, Running>()

/** Per-turn deadline. Generous, because a tool-using turn can legitimately be slow. */
export const TURN_TIMEOUT_MS = Number(process.env.ROUNDSTORM_TURN_TIMEOUT_MS ?? 6 * 60_000)

export const isRunning = (deliberationId: string) => running.has(deliberationId)

export function stopDeliberation(id: string) {
  const r = running.get(id)
  if (!r) return
  db.updateDeliberation(id, { status: 'stopping' })
  emitDeliberation(id)
  r.controller.abort()
}

/**
 * Interrupt now (plan §8): abandon the in-flight round and restart it with the
 * human's steer included. The tokens already spent are lost, which the UI says
 * on the button rather than hiding.
 */
export function interruptDeliberation(id: string) {
  const r = running.get(id)
  if (!r) return
  db.logEvent('deliberation.interrupted', { deliberationId: id })
  // Read by runRounds, which replaces the controller and repeats the round with
  // the steer included. Without this the abort simply ended the deliberation,
  // while the button and the manual both promised a restart — and the turns
  // already in flight were billed for nothing.
  r.interrupt = true
  r.controller.abort()
}

/**
 * Abort every deliberation this process is driving. Called on shutdown, so the
 * rows are not left `running` for `reconcileDeliberations` to clean up next boot.
 */
export function abortAllDeliberations(): number {
  const n = running.size
  for (const [id, r] of running) {
    db.updateDeliberation(id, { status: 'stopped', endedAt: Date.now() })
    r.controller.abort()
  }
  return n
}

export function extendDeliberation(id: string, by: number) {
  const d = db.getDeliberation(id)
  if (!d) return
  db.updateDeliberation(id, { rounds: d.rounds + by })
  db.logEvent('deliberation.extended', { roomId: d.roomId, deliberationId: id, payload: { by } })
  emitDeliberation(id)
}

function emitDeliberation(id: string) {
  const d = db.getDeliberation(id)
  if (d) bus.emit({ type: 'deliberation', deliberation: d })
}

function setActivity(roomId: string, agentId: string, state: any, detail: string, round: number | null) {
  bus.emit({
    type: 'activity',
    roomId,
    activity: { agentId, state, detail, round, startedAt: Date.now() },
  })
}

export async function startDeliberation(deliberation: Deliberation) {
  const controller = new AbortController()
  running.set(deliberation.id, { deliberation, controller })
  db.logEvent('deliberation.started', {
    roomId: deliberation.roomId, deliberationId: deliberation.id,
    payload: { mode: deliberation.mode, rounds: deliberation.rounds, style: deliberation.style },
  })
  emitDeliberation(deliberation.id)

  try {
    if (deliberation.mode === 'conclave') {
      await runConclave(deliberation.id, controller.signal, runTurn)
    } else {
      await runRounds(deliberation.id, running.get(deliberation.id)!.controller.signal)
    }
    await synthesise(deliberation.id, controller.signal)
  } catch (err) {
    db.logEvent('deliberation.failed', {
      roomId: deliberation.roomId, deliberationId: deliberation.id,
      payload: { error: String(err) },
    })
    db.updateDeliberation(deliberation.id, { status: 'failed', endedAt: Date.now() })
  } finally {
    running.delete(deliberation.id)
    const d = db.getDeliberation(deliberation.id)
    if (d && (d.status === 'running' || d.status === 'stopping')) {
      db.updateDeliberation(deliberation.id, {
        status: d.status === 'stopping' ? 'stopped' : 'complete',
        endedAt: Date.now(),
      })
    }
    emitDeliberation(deliberation.id)
    const room = db.getRoom(deliberation.roomId)
    if (room) for (const id of room.memberIds) setActivity(room.id, id, 'idle', '', null)
  }
}

async function runRounds(deliberationId: string, signal: AbortSignal) {
  for (let round = 1; ; round++) {
    const d = db.getDeliberation(deliberationId)
    if (!d || d.status !== 'running') return
    // Not reachable through the API, which now rejects a non-numeric round count.
    // Belt and braces for a hand-edited row: `Infinity` binds as NULL, and every
    // comparison against a non-finite value is false rather than true.
    if (!Number.isFinite(d.rounds) || round > d.rounds) return
    if (signal.aborted) return

    const room = db.getRoom(d.roomId)
    if (!room) return
    const roster = room.memberIds.map(id => db.getAgent(id)).filter((a): a is Agent => !!a)
    if (!roster.length) return

    db.updateDeliberation(d.id, { currentRound: round })
    emitDeliberation(d.id)

    const sealed = d.sealedOpening && round === 1

    // Everything visible before this round starts. In parallel style this snapshot
    // is shared by every agent in the round; nothing produced now leaks backwards.
    const baseHistory = db.listMessages(d.roomId, false).filter(m => m.round == null || m.round < round)
    const steers = pendingSteers(d.roomId)

    for (const a of roster) setActivity(room.id, a.id, 'waiting', 'Waiting', round)

    if (d.style === 'parallel') {
      await Promise.all(roster.map(agent =>
        runTurn({ agent, room, roster, deliberation: d, round, history: baseHistory, steers, sealed, signal })))
    } else {
      // Rotate so the last-speaker advantage moves around.
      const order = roster.slice(round % roster.length).concat(roster.slice(0, round % roster.length))
      for (const agent of order) {
        if (signal.aborted) break
        const history = db.listMessages(d.roomId, false)
          .filter(m => m.round == null || m.round < round || (m.round === round && m.deliberationId === d.id))
        await runTurn({ agent, room, roster, deliberation: d, round, history, steers, sealed, signal })
      }
    }

    if (sealed) {
      db.revealRound(d.id, round)
      bus.emit({ type: 'reveal', roomId: d.roomId, deliberationId: d.id, round })
      for (const m of db.listMessages(d.roomId).filter(m => m.deliberationId === d.id && m.round === round)) {
        bus.emit({ type: 'message.updated', message: m })
      }
      db.logEvent('round.revealed', { roomId: d.roomId, deliberationId: d.id, payload: { round } })
    }

    // An interrupt abandons the round and repeats it with the human's steer
    // included, which is what the button promises. Reaching this with the flag
    // still set used to mean the abort simply ended the deliberation. The steer
    // must survive too, so this returns before markSteersConsumed.
    const entry = running.get(deliberationId)
    if (entry?.interrupt) {
      entry.interrupt = false
      entry.controller = new AbortController()
      signal = entry.controller.signal
      db.logEvent('round.restarted', { deliberationId, payload: { round } })
      round -= 1
      continue
    }

    markSteersConsumed(steers)
    if (signal.aborted) return
  }
}

/**
 * Human messages the agents have not been shown yet (plan §8).
 *
 * `priority` is the unconsumed flag. It used to be tracked in a module-level Set
 * that nothing ever read, so a steer sent during round 2 was re-injected as
 * "address this before anything else" at rounds 3, 4 and 5 — the room kept
 * re-answering an instruction it had already dealt with, and every later round
 * was quietly degraded. Consuming it in the database also survives a restart,
 * which the Set never could.
 */
function pendingSteers(roomId: string): Message[] {
  return db.listMessages(roomId)
    .filter(m => m.authorType === 'human' && m.priority && m.round == null)
    .slice(-3)
}

function markSteersConsumed(steers: Message[]) {
  for (const s of steers) db.updateMessage(s.id, { priority: false })
}

export async function runTurn(args: {
  agent: Agent
  room: Room
  roster: Agent[]
  deliberation: Deliberation
  round: number
  history: Message[]
  steers: Message[]
  sealed: boolean
  signal: AbortSignal
  /** Conclave uses this for the chair / devil's-seat / endorsement roles. */
  extraInstruction?: string
}) {
  const { agent, room, roster, deliberation, round, history, steers, sealed, signal } = args
  const adapter = getAdapter(agent.brain)
  if (!adapter) {
    setActivity(room.id, agent.id, 'error', `No adapter for ${agent.brain}`, round)
    return
  }

  const requested = lowerTier(room.tier, agent.tierCeiling)
  const workspace = resolveWorkspace(room, requested)
  const tier = workspace.tier
  if (workspace.downgraded) {
    db.logEvent('tier.downgraded', {
      roomId: room.id, deliberationId: deliberation.id, agentId: agent.id,
      payload: { requested, granted: tier, reason: 'no working directory set for this project' },
    })
  }

  const ctx = composeContext({
    agent, room, roster, deliberation, round, history, steers,
    schemaEnforced: adapter.schemaEnforced,
    extraInstruction: args.extraInstruction,
    // An @mention scopes a steer: everyone sees it, only the named agent is
    // asked to act on it (plan §8).
    mentioned: steers.some(s => mentions(s.body, agent.name)),
  })

  // A digest, not the prompts themselves.
  //
  // Storing both in full was ~10KB per agent-turn and grew to 90% of the whole
  // database — several times the size of the transcript anyone actually reads,
  // for text that is reconstructible from the room's own state. The digest keeps
  // what the log is for: which sections went in, how big each prompt was, and the
  // steer verbatim, because a steer is the one part that is not recoverable from
  // anywhere else.
  db.logEvent('turn.started', {
    roomId: room.id, deliberationId: deliberation.id, agentId: agent.id,
    payload: {
      round, brain: agent.brain, model: agent.model, tier,
      sections: ctx.sections,
      systemPromptBytes: Buffer.byteLength(ctx.systemPrompt),
      userPromptBytes: Buffer.byteLength(ctx.userPrompt),
      promptDigest: createHash('sha256')
        .update(ctx.systemPrompt).update('\u0000').update(ctx.userPrompt)
        .digest('hex').slice(0, 16),
      steers: steers.map(s => s.body.slice(0, 2_000)),
    },
  })

  setActivity(room.id, agent.id, 'thinking', 'Thinking', round)

  let text = ''
  let structured: unknown = null
  let costUsd: number | undefined
  let errorMsg: string | null = null

  const started = Date.now()

  // A per-turn deadline. Without one, a single hung CLI stalls the whole round
  // indefinitely — one agent stops answering and the deliberation never ends.
  // The turn is abandoned; the round continues without it.
  const turnAbort = new AbortController()
  const onOuterAbort = () => turnAbort.abort()
  signal.addEventListener('abort', onOuterAbort, { once: true })
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    turnAbort.abort()
  }, TURN_TIMEOUT_MS)

  try {
    for await (const ev of adapter.run({
      systemPrompt: ctx.systemPrompt,
      userPrompt: ctx.userPrompt,
      model: agent.model,
      tier,
      workingDir: workspace.workingDir,
      schema: schemaFor(adapter, TURN_SCHEMA),
    }, turnAbort.signal)) {
      if (ev.type === 'activity') setActivity(room.id, agent.id, 'thinking', ev.text, round)
      else if (ev.type === 'tool') {
        setActivity(room.id, agent.id, 'tool', ev.detail ?? ev.name, round)
        db.logEvent('tool.used', {
          roomId: room.id, deliberationId: deliberation.id, agentId: agent.id,
          payload: { round, tool: ev.name, detail: ev.detail },
        })
      } else if (ev.type === 'delta') {
        text = ev.text
        setActivity(room.id, agent.id, 'writing', 'Writing', round)
      } else if (ev.type === 'final') {
        structured = ev.structured
        if (ev.text) text = ev.text
        costUsd = ev.costUsd
      } else if (ev.type === 'error') {
        errorMsg = ev.message
      }
    }
  } catch (err) {
    errorMsg = String(err)
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener('abort', onOuterAbort)
  }

  if (timedOut && !structured && !text) {
    const secs = Math.round(TURN_TIMEOUT_MS / 1000)
    setActivity(room.id, agent.id, 'error', `Timed out after ${secs}s`, round)
    db.logEvent('turn.timeout', {
      roomId: room.id, deliberationId: deliberation.id, agentId: agent.id,
      payload: { round, ms: Date.now() - started, brain: agent.brain, model: agent.model },
    })
    const m = db.insertMessage({
      roomId: room.id, authorType: 'system', authorId: agent.id,
      body: `${agent.name} did not answer within ${secs}s and was skipped for this round.`,
      round, deliberationId: deliberation.id,
    })
    bus.emit({ type: 'message', message: m })
    return
  }

  if (signal.aborted && !structured && !text) {
    setActivity(room.id, agent.id, 'idle', 'Cancelled', round)
    db.logEvent('turn.cancelled', {
      roomId: room.id, deliberationId: deliberation.id, agentId: agent.id, payload: { round },
    })
    return
  }

  if (errorMsg && !structured && !text) {
    setActivity(room.id, agent.id, 'error', errorMsg.slice(0, 120), round)
    db.logEvent('turn.failed', {
      roomId: room.id, deliberationId: deliberation.id, agentId: agent.id,
      payload: { round, error: errorMsg },
    })
    const m = db.insertMessage({
      roomId: room.id, authorType: 'system', authorId: agent.id,
      body: `${agent.name} could not answer this round: ${errorMsg.slice(0, 300)}`,
      round, deliberationId: deliberation.id,
    })
    bus.emit({ type: 'message', message: m })
    return
  }

  // Schema-enforced brains hand back an object. Prompted brains need extracting,
  // and either way coerceTurn guarantees something renderable.
  const raw = structured ?? extractJson(text)
  const parsed = coerceTurn(raw, stripJsonBlock(text))

  // An error that arrived alongside some text used to be discarded outright: the
  // three guards above all require `!text`, so a hard vendor failure plus one
  // stray text block was stored as an ordinary turn. Claude reports exactly that
  // shape (`is_error` with content already streamed), and so does cursor. Keep
  // the partial work — it may be most of the answer — but never let it read as a
  // clean turn.
  if (errorMsg) {
    parsed.degraded = true
    db.logEvent('turn.degraded', {
      roomId: room.id, deliberationId: deliberation.id, agentId: agent.id,
      payload: { round, error: errorMsg, kept: text.length },
    })
    parsed.turn.body = `${parsed.turn.body}\n\n_(${agent.name}'s brain reported an error `
      + `partway through: ${errorMsg.slice(0, 200)}. What is above may be incomplete.)_`
  }

  const message = db.insertMessage({
    roomId: room.id,
    authorType: 'agent',
    authorId: agent.id,
    body: parsed.turn.body,
    replyTo: validReplyTo(parsed.turn.reply_to, history),
    round,
    deliberationId: deliberation.id,
    sealed,
    stance: parsed.turn.stance,
    claims: parsed.turn.claims,
    degraded: parsed.degraded,
    brain: agent.brain,
    model: agent.model,
    costUsd,
    raw: JSON.stringify({ structured, text }).slice(0, 8_000),
  })

  await applyPositionOps({
    roomId: room.id, agent, ops: parsed.positionOps,
    messageId: message.id, round, blind: sealed,
    deliberationId: deliberation.id,
  })

  // Memory is proposed, never written silently — the human keeps or discards
  // every card from the inbox (plan §5.2).
  //
  // Only from the closing round, and only two per agent. A first pass collected
  // from every round and produced 37 cards from a single conclave, which turns
  // the inbox from a 20-second ritual into a chore nobody performs. Memory
  // should hold what survived the argument, not every intermediate thought.
  const closing = round >= deliberation.rounds || deliberation.mode === 'conclave'
  for (const m of (closing ? parsed.memory.slice(0, 2) : [])) {
    db.proposeMemory({
      agentId: agent.id, projectId: room.projectId, roomId: room.id,
      scope: 'project', type: m.type, text: m.text, sourceMessageId: message.id,
    })
  }

  db.logEvent('turn.completed', {
    roomId: room.id, deliberationId: deliberation.id, agentId: agent.id,
    payload: {
      round, messageId: message.id, stance: parsed.turn.stance,
      claims: parsed.turn.claims.length, degraded: parsed.degraded,
      degradeReason: parsed.reason, costUsd, ms: Date.now() - started,
    },
  })

  setActivity(room.id, agent.id, 'done', sealed ? 'Committed' : 'Complete', round)
  if (!sealed) bus.emit({ type: 'message', message })
  else bus.emit({ type: 'activity', roomId: room.id, activity: {
    agentId: agent.id, state: 'done', detail: 'Committed', round, startedAt: null } })
}

/** `@Bruno` — word-boundary match so "Brunod" does not count. */
function mentions(body: string, name: string): boolean {
  return new RegExp(`@${name}\\b`, 'i').test(body)
}

/** Agents hallucinate ids; only accept one that names a message actually in view. */
function validReplyTo(id: string | null | undefined, history: Message[]): string | null {
  if (!id) return null
  return history.some(m => m.id === id) ? id : null
}

const RANK = { reasoning: 0, research: 1, workstation: 2, full: 3 } as const
/** A room can never grant an agent more than its own ceiling (plan §9). */
function lowerTier(a: Room['tier'], b: Agent['tierCeiling']) {
  return RANK[a] <= RANK[b] ? a : b
}

/**
 * Resolve the directory agents may touch, and refuse to grant file access
 * without one.
 *
 * The tiers above `research` are meaningless unless the CLI is actually confined
 * to a directory: without `--add-dir` / `--cd` the brain simply runs wherever the
 * daemon happens to be, which for a Finder-launched app is `/`. Granting
 * Write and Bash in that situation is not a scoped workstation, it is the whole
 * machine. So a room asking for file access with no working directory set is
 * downgraded to `research` rather than quietly given more than it asked for.
 */
function resolveWorkspace(room: Room, tier: Tier): { tier: Tier; workingDir: string | null; downgraded: boolean } {
  if (RANK[tier] < RANK['workstation']) return { tier, workingDir: null, downgraded: false }
  const dir = db.getProject(room.projectId)?.workingDir ?? null
  if (!dir) return { tier: 'research', workingDir: null, downgraded: true }
  return { tier, workingDir: dir, downgraded: false }
}

/** Exposed for tests: the scoping decision is the safety-critical part. */
export const resolveWorkspaceForTest = resolveWorkspace
