/**
 * The scheduler, exercised for real.
 *
 * Every path here calls a brain, so until a brain could be substituted this file
 * sat at 17% coverage while holding round isolation, the sealed opening, the turn
 * deadline, cancellation and human steering — the logic most able to fail
 * silently. The stub answers instantly and records what it was shown, which is
 * what makes isolation assertable: what an agent was given is a fact, what it
 * said is not.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ROUNDSTORM_DATA = mkdtempSync(join(tmpdir(), 'rs-sched-'))
// Keep the deadline short so the timeout test does not take six minutes.
process.env.ROUNDSTORM_TURN_TIMEOUT_MS = '1500'

const db = await import('../db.ts')
const { registerAdapter } = await import('../adapters/registry.ts')
const { makeStubBrain } = await import('../adapters/stub.ts')
type StubOptions = Parameters<typeof makeStubBrain>[0]
const { startDeliberation, stopDeliberation, interruptDeliberation } =
  await import('./scheduler.ts')

const project = db.createProject('Scheduler tests')
let seq = 0

/** A room of stub-brained agents, each on its own adapter id so calls are separable. */
function room(names: string[], opts: (name: string) => StubOptions = () => ({})) {
  const tag = `-${seq++}`
  const stubs = new Map<string, ReturnType<typeof makeStubBrain>>()
  const cleanups: (() => void)[] = []
  const agents = names.map(n => {
    const id = `stub-${n}${tag}`.toLowerCase()
    const stub = makeStubBrain({ id, ...opts(n) })
    stubs.set(n, stub)
    cleanups.push(registerAdapter(stub.adapter))
    return db.createAgent({
      name: `${n}${tag}`, role: '', avatarColor: '#000',
      personaKey: 'skeptic', personaExtra: '',
      brain: id, model: 'stub-1', tierCeiling: 'reasoning',
    })
  })
  const r = db.createRoom(project.id, `Room${tag}`, 'room', agents.map(a => a.id), 'reasoning')
  return { room: r, agents, stubs, cleanup: () => cleanups.forEach(c => c()) }
}

/**
 * The turns an agent actually took.
 *
 * The synthesiser reuses a brain from the room, so a stub sees one extra call
 * after the last round. Filtering on its system prompt keeps round assertions
 * about rounds.
 */
type Stub = ReturnType<typeof makeStubBrain>
const roundCalls = (stub: Stub): Stub['calls'] =>
  stub.calls.filter(c => !/neutral rapporteur/i.test(c.systemPrompt))

const deliberation = (roomId: string, over: Record<string, unknown> = {}) =>
  db.createDeliberation({
    roomId, mode: 'deliberation', rounds: 2, style: 'parallel',
    sealedOpening: false, status: 'running', currentRound: 0,
    question: 'Oil whip or a hardening nonlinearity?', tier: 'reasoning',
    ...over,
  } as never)

// --- round isolation ---

test('a parallel round shows nobody what was said in it', async () => {
  const { room: r, stubs, cleanup } = room(['A', 'B'], () => ({
    reply: (_c, i) => `DISTINCTIVE-ROUND-CONTENT-${i}`,
  }))
  await startDeliberation(deliberation(r.id, { rounds: 2 }))
  cleanup()

  // Each agent's round-2 prompt must contain round 1, and never the peer's
  // round-2 turn — which is the whole point of the style.
  const a = roundCalls(stubs.get('A')!)
  assert.equal(a.length, 2, 'expected one call per round')
  assert.match(a[1].userPrompt, /Round 1/)
  const bRound2 = roundCalls(stubs.get('B')!)[1].userPrompt
  assert.ok(!bRound2.includes('DISTINCTIVE-ROUND-CONTENT-1'),
    'a round-2 turn leaked into another agent’s round-2 context')
})

test('ping-pong lets later speakers see earlier ones from the same round', async () => {
  const { room: r, stubs, cleanup } = room(['A', 'B'], () => ({
    reply: (_c, i) => `PINGPONG-BODY-${i}`,
  }))
  await startDeliberation(deliberation(r.id, { style: 'pingpong', rounds: 1 }))
  cleanup()

  const all = [...stubs.values()].flatMap(roundCalls)
  assert.equal(all.length, 2)
  // Exactly one of them saw the other's turn: whoever spoke second.
  const sawPeer = all.filter(c => /PINGPONG-BODY-0/.test(c.userPrompt))
  assert.equal(sawPeer.length, 1, 'sequential speaking did not reach the second agent')
})

// --- the sealed opening ---

test('a sealed opening round is hidden until every agent has committed', async () => {
  const { room: r, cleanup } = room(['A', 'B'])
  const d = deliberation(r.id, { rounds: 1, sealedOpening: true })
  await startDeliberation(d)
  cleanup()

  const visible = db.listMessages(r.id).filter(m => m.round === 1)
  assert.equal(visible.length, 2, 'sealed turns were not revealed after the round')
  assert.ok(visible.every(m => !m.sealed), 'a turn is still sealed after reveal')
})

// --- the turn deadline ---

test('a hung brain hits the deadline and the round carries on without it', async () => {
  // Before this deadline existed, one slow CLI stalled a round indefinitely.
  const { room: r, cleanup } = room(['Fast', 'Hung'],
    n => n === 'Hung' ? { hang: true } : {})
  await startDeliberation(deliberation(r.id, { rounds: 1 }))
  cleanup()

  const msgs = db.listMessages(r.id)
  assert.equal(msgs.filter(m => m.authorType === 'agent').length, 1,
    'the responsive agent did not produce a turn')
  const note = msgs.find(m => m.authorType === 'system')
  assert.ok(note, 'a timed-out agent left no trace in the transcript')
  assert.match(note!.body, /did not answer/i)
})

test('a brain that cannot start is reported, not silently absent', async () => {
  // A conclave once reported a holdout for an agent that never ran.
  const { room: r, cleanup } = room(['Ok', 'Broken'],
    n => n === 'Broken' ? { fail: 'stub is not installed' } : {})
  await startDeliberation(deliberation(r.id, { rounds: 1 }))
  cleanup()

  const note = db.listMessages(r.id).find(m => m.authorType === 'system')
  assert.ok(note && /could not answer/i.test(note.body))
  assert.match(note!.body, /not installed/)
})

test('an agent whose brain does not exist leaves a visible trace', async () => {
  // This used to write an activity event and return, so a mistyped brain in a
  // config produced an agent that was simply absent from every round, with
  // nothing in the transcript to say why.
  const lone = db.createAgent({
    name: `Ghost-${seq++}`, role: '', avatarColor: '#000', personaKey: 'skeptic', personaExtra: '',
    brain: 'no-such-brain', model: null, tierCeiling: 'reasoning',
  })
  const r = db.createRoom(project.id, `GhostRoom-${seq++}`, 'room', [lone.id], 'reasoning')
  await startDeliberation(deliberation(r.id, { rounds: 1 }))

  const note = db.listMessages(r.id).find(m => m.authorType === 'system' && m.authorId === lone.id)
  assert.ok(note, 'nothing in the transcript says the agent never ran')
  assert.match(note!.body, /no-such-brain/)
  assert.match(note!.body, new RegExp(lone.name))
})

// --- human steering ---

test('a steer reaches the next round and then stops', async () => {
  // The bug this pins: `consumed` was written and never read, and nothing clears
  // `priority`, so a steer was re-injected as PRIORITY on every later round.
  const { room: r, stubs, cleanup } = room(['A'], () => ({ delayMs: 40 }))
  const d = deliberation(r.id, { rounds: 3 })

  db.insertMessage({
    roomId: r.id, authorType: 'human', priority: true,
    body: 'STEER-MARKER: focus on the bearing clearance',
  })

  await startDeliberation(d)
  cleanup()

  const sawSteer = roundCalls(stubs.get('A')!).map(c =>
    /# PRIORITY — from the human researcher/.test(c.userPrompt))
  assert.equal(sawSteer[0], true, 'the steer never reached the next round')
  assert.deepEqual(sawSteer.slice(1), [false, false],
    'the steer was re-injected after the round that consumed it')
})

// --- stopping ---

test('stopping mid-flight ends the deliberation', async () => {
  const { room: r, cleanup } = room(['A', 'B'], () => ({ delayMs: 300 }))
  const d = deliberation(r.id, { rounds: 5 })
  const running = startDeliberation(d)
  setTimeout(() => stopDeliberation(d.id), 120)
  await running
  cleanup()

  const after = db.getDeliberation(d.id)!
  assert.ok(['stopped', 'complete'].includes(after.status), `status was ${after.status}`)
  assert.ok(after.currentRound < 5, 'it ran to the full round count despite being stopped')
})

test('interrupting repeats the round rather than ending the run', async () => {
  // The button and the manual both promise a restart with the steer included.
  // Before this, the flag was set and never read, so the abort simply ended the
  // deliberation and billed for the discarded turns.
  const { room: r, stubs, cleanup } = room(['A'], () => ({ delayMs: 120 }))
  const d = deliberation(r.id, { rounds: 2 })
  const running = startDeliberation(d)
  setTimeout(() => interruptDeliberation(d.id), 60)
  await running
  cleanup()

  const after = db.getDeliberation(d.id)!
  assert.equal(after.status, 'complete', `run ended as ${after.status} instead of finishing`)
  assert.equal(after.currentRound, 2, 'the interrupted round was not repeated to completion')
  // The interrupted attempt plus both real rounds: more calls than rounds.
  assert.ok(roundCalls(stubs.get('A')!).length > 2,
    'the round was not actually re-run after the interrupt')
})

// --- capability scoping, through the real path ---

test('a room asking for file access without a directory is downgraded', async () => {
  // Asserted here rather than only on the pure helper, so the downgrade is known
  // to actually reach the brain.
  const { room: r, stubs, cleanup } = room(['A'])
  db.setRoomTier(r.id, 'full')
  const agent = db.listAgents().find(a => a.id === r.memberIds[0])!
  db.updateAgent(agent.id, { tierCeiling: 'full' })

  await startDeliberation(deliberation(r.id, { rounds: 1, tier: 'full' }))
  cleanup()

  const call = roundCalls(stubs.get('A')!)[0]
  assert.equal(call.tier, 'research', 'full tier survived with no working directory')
  assert.equal(call.workingDir, null)
})
