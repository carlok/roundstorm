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
import { isTier } from '../types.ts'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import * as db from '../db.ts'
import { bus } from '../bus.ts'
import { getAdapter, schemaFor } from '../adapters/registry.ts'
import { composeContext } from './context.ts'
import { applyPositionOps } from './ledger.ts'
import { runConclave } from './conclave.ts'
import { synthesise } from './synthesis.ts'
import { historyFor } from './history.ts'
import { TURN_SCHEMA, coerceTurn, extractJson, stripJsonBlock } from './contract.ts'

interface Running {
  deliberation: Deliberation
  controller: AbortController
  interrupt?: boolean
}

const running = new Map<string, Running>()

/**
 * Per-turn deadline. Generous, because a tool-using turn can legitimately be slow.
 *
 * Parsed, not cast: `Number("6m")` is NaN, `setTimeout(fn, NaN)` fires after a
 * millisecond, and every turn of every run then "timed out" with nothing on screen
 * saying why. Anything that is not a whole number of at least one second falls back
 * to the default.
 */
export function parseTurnTimeout(raw: string | undefined): number {
  const n = Number(raw)
  return raw !== undefined && raw.trim() !== '' && Number.isInteger(n) && n >= 1_000 ? n : 6 * 60_000
}
export const TURN_TIMEOUT_MS = parseTurnTimeout(process.env.ROUNDSTORM_TURN_TIMEOUT_MS)


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
  db.logEvent('deliberation.interrupted', { roomId: db.getDeliberation(id)?.roomId, deliberationId: id })
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
    let conclave: { reached: boolean } | undefined
    if (deliberation.mode === 'conclave') {
      conclave = await runConclave(deliberation.id, controller.signal, runTurn, {
        pendingSteers, markSteersConsumed,
        takeInterrupt: () => takeInterrupt(deliberation.id),
      })
      const last = db.getDeliberation(deliberation.id)?.currentRound
      if (last) db.pruneProposedMemory(deliberation.id, last)
    } else {
      await runRounds(deliberation.id, running.get(deliberation.id)!.controller.signal)
    }
    // The CURRENT controller, not the one this run started with: an interrupt
    // replaces it, and the original is already aborted, so synthesis after an
    // interrupt was cancelled before it began and every such run got the bare
    // fallback card. Bounded by the turn deadline too, so a synthesiser that hangs
    // cannot leave the deliberation `running` for ever.
    const current = running.get(deliberation.id)?.controller.signal ?? controller.signal
    // A plain timer rather than AbortSignal.timeout, whose timer does not keep
    // the process alive: with nothing else pending, the process could exit while
    // synthesis was still waiting on it.
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), TURN_TIMEOUT_MS)
    try {
      await synthesise(deliberation.id, AbortSignal.any([current, deadline.signal]), { conclave })
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    db.logEvent('deliberation.failed', {
      roomId: deliberation.roomId, deliberationId: deliberation.id,
      payload: { error: String(err) },
    })
    db.updateDeliberation(deliberation.id, { status: 'failed', endedAt: Date.now() })
  } finally {
    running.delete(deliberation.id)
    // A steer that arrived after the last round's snapshot (during the final round,
    // during synthesis, while stopping) was never shown to anyone, and its
    // `priority` flag would otherwise make it the first thing the NEXT deliberation
    // in this room is told to address, possibly days later. It stays in the
    // transcript, where the next run still sees it as an ordinary message.
    markSteersConsumed(pendingSteers(deliberation.roomId, Infinity))
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
  // After an interrupt: the agents whose turn was cut off, who are the only ones
  // to run again. Null outside a repeated round.
  let rerun: Set<string> | null = null
  // An interrupt's steer is kept pending through the round after the repeat, so
  // agents whose turn had already finished still see it once.
  let deferSteers = false
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
    const baseHistory = historyFor(d, round)
    const steers = pendingSteers(d.roomId)

    // A repeated round runs only the agents whose turn the interrupt cut off.
    // The tooltip promises the *in-flight* turns are discarded; re-running the
    // ones that had already finished gave those agents two turns in one round.
    const speakers: Agent[] = rerun ? roster.filter(a => rerun!.has(a.id)) : roster
    const settled = new Set<string>()

    for (const a of speakers) setActivity(room.id, a.id, 'waiting', 'Waiting', round)

    if (d.style === 'parallel') {
      await Promise.all(speakers.map(async agent => {
        if (await runTurn({ agent, room, roster, deliberation: d, round, history: baseHistory, steers, sealed, signal })) {
          settled.add(agent.id)
        }
      }))
    } else {
      // Rotate so the last-speaker advantage moves around.
      const order = roster.slice(round % roster.length).concat(roster.slice(0, round % roster.length))
        .filter(a => speakers.includes(a))
      for (const agent of order) {
        if (signal.aborted) break
        const history = historyFor(d, round, { sameRound: true })
        if (await runTurn({ agent, room, roster, deliberation: d, round, history, steers, sealed, signal })) {
          settled.add(agent.id)
        }
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
    const restarted = takeInterrupt(deliberationId)
    if (restarted) {
      signal = restarted
      rerun = new Set(speakers.filter(a => !settled.has(a.id)).map(a => a.id))
      deferSteers = true
      db.logEvent('round.restarted', {
        roomId: db.getDeliberation(deliberationId)?.roomId, deliberationId,
        payload: { round, kept: settled.size, rerun: rerun.size },
      })
      round -= 1
      continue
    }

    rerun = null
    // The round after the repeat is the one where every agent sees the steer.
    if (deferSteers && round < (db.getDeliberation(deliberationId)?.rounds ?? round)) {
      deferSteers = false
    } else {
      deferSteers = false
      markSteersConsumed(steers)
    }
    if (signal.aborted) return
  }
}

/**
 * If an interrupt is pending, clear it and hand back the replacement signal the
 * repeated round should run under. Null when there is nothing to restart.
 */
function takeInterrupt(deliberationId: string): AbortSignal | null {
  const entry = running.get(deliberationId)
  if (!entry?.interrupt) return null
  entry.interrupt = false
  entry.controller = new AbortController()
  return entry.controller.signal
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
export function pendingSteers(roomId: string, limit = 3): Message[] {
  return db.listMessages(roomId)
    .filter(m => m.authorType === 'human' && m.priority && m.round == null)
    .slice(-limit)
}

export function markSteersConsumed(steers: Message[]) {
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
}): Promise<boolean> {
  const { agent, room, roster, deliberation, round, history, steers, sealed, signal } = args
  const adapter = getAdapter(agent.brain)
  if (!adapter) {
    setActivity(room.id, agent.id, 'error', `No adapter for ${agent.brain}`, round)
    // Say so in the transcript, not only in the activity strip. A mistyped brain
    // in a config used to produce an agent that was simply absent from every
    // round, and nothing the reader could see explained why.
    db.logEvent('turn.failed', {
      roomId: room.id, deliberationId: deliberation.id, agentId: agent.id,
      payload: { round, error: `no adapter for ${agent.brain}` },
    })
    const m = db.insertMessage({
      roomId: room.id, authorType: 'system', authorId: agent.id,
      body: `${agent.name} could not be started: there is no brain called "${agent.brain}".`,
      round, deliberationId: deliberation.id,
    })
    bus.emit({ type: 'message', message: m })
    return true
  }

  const requested = lowerTier(room.tier, agent.tierCeiling)
  const workspace = resolveWorkspace(room, requested)
  const tier = workspace.tier
  if (workspace.downgraded) {
    db.logEvent('tier.downgraded', {
      roomId: room.id, deliberationId: deliberation.id, agentId: agent.id,
      // The reason comes from resolveWorkspace now. Hardcoding it here made the
      // log say "none set" for a directory that was set and then deleted.
      payload: { requested, granted: tier, reason: workspace.reason },
    })
  }

  const ctx = composeContext({
    agent, room, roster, deliberation, round, history, steers,
    schemaEnforced: adapter.schemaEnforced,
    ownContract: adapter.promptsOwnContract,
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
      omittedMessages: ctx.omittedMessages,
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

  // A turn cut off by the deadline or by Stop/Interrupt is not a turn, even if
  // some text had streamed: "Let me search for that..." from an agent that then
  // hung used to be stored as its answer for the round, marked complete. Only a
  // structured result means the brain actually finished. What was dropped is
  // logged, so it is not lost silently.
  if (timedOut && !structured) {
    const secs = Math.round(TURN_TIMEOUT_MS / 1000)
    setActivity(room.id, agent.id, 'error', `Timed out after ${secs}s`, round)
    db.logEvent('turn.timeout', {
      roomId: room.id, deliberationId: deliberation.id, agentId: agent.id,
      payload: { round, ms: Date.now() - started, brain: agent.brain, model: agent.model,
                 discardedChars: text.length },
    })
    const m = db.insertMessage({
      roomId: room.id, authorType: 'system', authorId: agent.id,
      body: `${agent.name} did not answer within ${secs}s and was skipped for this round.`,
      round, deliberationId: deliberation.id,
    })
    bus.emit({ type: 'message', message: m })
    return true
  }

  if (signal.aborted && !structured) {
    setActivity(room.id, agent.id, 'idle', 'Cancelled', round)
    db.logEvent('turn.cancelled', {
      roomId: room.id, deliberationId: deliberation.id, agentId: agent.id,
      payload: { round, discardedChars: text.length },
    })
    return false
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
    return true
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
  return true
}

/**
 * `@Bruno`, but not `@Brunod`.
 *
 * The name is matched literally. It used to be pasted into a RegExp, so an agent
 * called "C++ Expert" threw "Nothing to repeat" the moment any steer was pending,
 * outside the turn's try block: the whole deliberation was marked failed while the
 * other agents' turns kept running and billing.
 */
export function mentions(body: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`@${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(body)
}

/** Agents hallucinate ids; only accept one that names a message actually in view. */
function validReplyTo(id: string | null | undefined, history: Message[]): string | null {
  if (!id) return null
  return history.some(m => m.id === id) ? id : null
}

const RANK = { reasoning: 0, research: 1, workstation: 2, full: 3 } as const

/**
 * Rank a tier, treating anything unrecognised as the most restrictive one.
 *
 * `RANK[garbage]` is `undefined`, and every comparison against it is false — so
 * `lowerTier` returned the ceiling unchanged and `resolveWorkspace` skipped its
 * downgrade. A stored tier of `"workstation "` (trailing space) therefore reached
 * the adapters intact.
 */
const rank = (t: string): number => (isTier(t) ? RANK[t] : 0)

/** A room can never grant an agent more than its own ceiling (plan §9). */
export function lowerTier(a: Room['tier'], b: Agent['tierCeiling']) {
  return rank(a) <= rank(b) ? a : b
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
export function resolveWorkspace(room: Room, tier: Tier):
    { tier: Tier; workingDir: string | null; downgraded: boolean; reason?: string } {
  if (rank(tier) < rank('workstation')) return { tier, workingDir: null, downgraded: false }
  const dir = db.getProject(room.projectId)?.workingDir ?? null
  if (!dir) {
    return { tier: 'research', workingDir: null, downgraded: true,
             reason: 'no working directory set for this project' }
  }
  // Checked per turn, not once per run, so a directory deleted mid-deliberation
  // is caught. One statSync against a turn that takes minutes is free, and
  // handing a CLI `--add-dir` for a path that is gone is how an agent ends up
  // running wherever the daemon happens to be.
  if (!isDirectory(dir)) {
    return { tier: 'research', workingDir: null, downgraded: true,
             reason: `the working directory no longer exists: ${dir}` }
  }
  return { tier, workingDir: dir, downgraded: false }
}

const isDirectory = (p: string): boolean => {
  try { return statSync(p).isDirectory() } catch { return false }
}

/** Exposed for tests: the scoping decision is the safety-critical part. */
export const resolveWorkspaceForTest = resolveWorkspace
