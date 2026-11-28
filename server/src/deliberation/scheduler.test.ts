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
const { startDeliberation, stopDeliberation, interruptDeliberation, mentions, parseTurnTimeout } =
  await import('./scheduler.ts')
const { synthesise } = await import('./synthesis.ts')

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

// --- 0.2.0 fixes ---

const eventsOf = (deliberationId: string, type: string) =>
  db.listEvents(null, 5000).filter(e => e.deliberationId === deliberationId && e.type === type)

test('the turn deadline is parsed, not cast', () => {
  // `Number("6m")` is NaN and setTimeout(NaN) fires at once: every turn timed out.
  assert.equal(parseTurnTimeout(undefined), 360_000)
  assert.equal(parseTurnTimeout('6m'), 360_000)
  assert.equal(parseTurnTimeout(''), 360_000)
  assert.equal(parseTurnTimeout('500'), 360_000, 'under a second is a typo, not a deadline')
  assert.equal(parseTurnTimeout('1.5e3'), 1_500)
  assert.equal(parseTurnTimeout('90000'), 90_000)
})

test('an @mention matches the name literally, punctuation and all', () => {
  assert.equal(mentions('@C++ Expert, over to you', 'C++ Expert'), true)
  assert.equal(mentions('ask @Brunod', 'Bruno'), false)
  assert.equal(mentions('@bruno?', 'Bruno'), true)
  assert.equal(mentions('@a.b', 'a+b'), false)
})

test('an agent named with regex characters does not fail the run when a steer is pending', async () => {
  // The name went straight into a RegExp: "C++" threw "Nothing to repeat" outside
  // the turn's try block, and the whole deliberation was marked failed.
  const { room: r, stubs, cleanup } = room(['C++ Expert'])
  const name = db.getAgent(r.memberIds[0])!.name
  db.insertMessage({ roomId: r.id, authorType: 'human', priority: true, body: `@${name} what do you think?` })
  const d = deliberation(r.id, { rounds: 1 })
  await startDeliberation(d)
  cleanup()
  assert.equal(db.getDeliberation(d.id)!.status, 'complete')
  assert.match(roundCalls(stubs.get('C++ Expert')!)[0].userPrompt, /addressed you by name/)
})

test('a steer that arrives in the final round does not lead the next run', async () => {
  const { room: r, stubs, cleanup } = room(['A'], () => ({ delayMs: 150 }))
  const first = deliberation(r.id, { rounds: 1 })
  const run = startDeliberation(first)
  let steer: ReturnType<typeof db.insertMessage> | undefined
  setTimeout(() => {
    steer = db.insertMessage({ roomId: r.id, authorType: 'human', priority: true, body: 'LATE-STEER-MARK' })
  }, 40)
  await run
  assert.equal(db.listMessages(r.id).find(m => m.id === steer!.id)?.priority, false,
    'a steer nobody was shown is still flagged as pending')

  stubs.get('A')!.reset()
  await startDeliberation(deliberation(r.id, { rounds: 1 }))
  cleanup()
  const prompt = roundCalls(stubs.get('A')!)[0].userPrompt
  assert.ok(!/# PRIORITY/.test(prompt), 'an old steer was presented as this run\'s priority')
  assert.ok(prompt.includes('LATE-STEER-MARK'), 'the message itself should still be in the transcript')
})

test('a second run sees the whole first run, labelled, and no system lines', async () => {
  // Filtering by round number alone showed run 2's round 1 nothing of run 1 past
  // its round 0, and run 2's round 3 run 1's rounds 1-2 only.
  const { room: r, stubs, cleanup } = room(['A', 'B'], n =>
    n === 'B' ? { fail: 'BOOM-FAIL' } : { reply: (_c, i) => `RUN-MARK-${i}` })
  await startDeliberation(deliberation(r.id, { rounds: 2 }))
  stubs.get('A')!.reset()
  await startDeliberation(deliberation(r.id, { rounds: 1 }))
  cleanup()

  const prompt = roundCalls(stubs.get('A')!)[0].userPrompt
  assert.match(prompt, /Earlier in this room/)
  assert.ok(prompt.includes('RUN-MARK-0') && prompt.includes('RUN-MARK-1'),
    'the earlier run\'s second round was hidden from this run\'s first')
  assert.ok(!prompt.includes('BOOM-FAIL'), 'a failure notice reached a prompt')
  assert.ok(!prompt.includes('__result__'), 'a result-card pointer reached a prompt')
})

test('a turn cut off by the deadline is not stored as an answer, even with text', async () => {
  const { room: r, cleanup } = room(['Ok', 'Slow'],
    n => n === 'Slow' ? { partial: 'Let me search for that first' } : {})
  const d = deliberation(r.id, { rounds: 1 })
  await startDeliberation(d)
  cleanup()
  const msgs = db.listMessages(r.id).filter(m => m.deliberationId === d.id)
  assert.ok(!msgs.some(m => m.body.includes('Let me search')), 'a partial reply was stored as the turn')
  assert.ok(msgs.some(m => m.authorType === 'system' && /did not answer/.test(m.body)))
  const ev = eventsOf(d.id, 'turn.timeout')[0]
  assert.ok(ev && (ev.payload as any).discardedChars > 0, 'what was discarded is not on record')
})

const rapporteur = (c: { systemPrompt: string }) => /neutral rapporteur/i.test(c.systemPrompt)
const synthOrTurn = (c: { systemPrompt: string }) => rapporteur(c)
  ? { conclusion: 'SYNTH-OK: the stub synthesiser actually ran to the end', why: 'SYNTH-WHY',
      commonGround: [], disagreement: [], alternatives: [], evidence: [], unknowns: [], nextSteps: [] }
  : { body: 'a turn', stance: 'propose', reply_to: '', claims: [{ text: 'c', basis: 'reasoned' }] }

test('synthesis after an interrupt runs under a live signal', async () => {
  // It was handed the run's first controller, which the interrupt had aborted.
  const { room: r, cleanup } = room(['A'], () => ({ delayMs: 120, turn: synthOrTurn }))
  const d = deliberation(r.id, { rounds: 1 })
  const run = startDeliberation(d)
  setTimeout(() => interruptDeliberation(d.id), 50)
  await run
  cleanup()
  const card = db.listResults(r.id).find(c => c.deliberationId === d.id)
  assert.equal(card?.why, 'SYNTH-WHY', 'the card is the bare fallback: synthesis was cancelled')
})

test('a conclave shows a pending steer, then consumes it', async () => {
  const { room: r, stubs, cleanup } = room(['A', 'B'])
  const steer = db.insertMessage({ roomId: r.id, authorType: 'human', priority: true, body: 'CONCLAVE-STEER' })
  const d = deliberation(r.id, { mode: 'conclave', rounds: 4 })
  await startDeliberation(d)
  cleanup()
  const calls = [...stubs.values()].flatMap(roundCalls)
  assert.ok(calls.some(c => /# PRIORITY[\s\S]*CONCLAVE-STEER/.test(c.userPrompt)),
    'the steer never reached a conclave turn')
  assert.equal(calls.filter(c => /# PRIORITY/.test(c.userPrompt)).length, 2,
    'the steer should lead exactly the first round (two agents), then be consumed')
  assert.equal(db.listMessages(r.id).find(m => m.id === steer.id)?.priority, false)
})

test('interrupting a conclave repeats the round instead of ending it', async () => {
  const { room: r, cleanup } = room(['A', 'B'], () => ({ delayMs: 80 }))
  const d = deliberation(r.id, { mode: 'conclave', rounds: 4 })
  const run = startDeliberation(d)
  setTimeout(() => interruptDeliberation(d.id), 40)
  await run
  cleanup()
  assert.equal(eventsOf(d.id, 'round.restarted').length, 1, 'the interrupt did not restart the round')
  assert.equal(db.getDeliberation(d.id)!.currentRound, 4, 'the conclave stopped early after an interrupt')
})

test('the conclave card takes the conclave\'s own verdict', async () => {
  // Re-deriving it from the general summary could say "reached" for a conclave
  // that had run to its cap.
  const { room: r, agents, cleanup } = room(['A', 'B'], () => ({ turn: synthOrTurn }))
  const d = deliberation(r.id, { mode: 'conclave', rounds: 4, status: 'complete' })
  db.insertMessage({ roomId: r.id, authorType: 'agent', authorId: agents[0].id, body: 'x', round: 1, deliberationId: d.id })
  const p = db.createPosition(r.id, 'Oil whip', 'It is oil whip.', agents[0].id)
  db.recordOp({ positionId: p.id, version: p.version, agentId: agents[0].id, op: 'assert', round: 1, deliberationId: d.id })
  db.recordOp({ positionId: p.id, version: p.version, agentId: agents[1].id, op: 'endorse', round: 1, deliberationId: d.id })

  const failed = await synthesise(d.id, new AbortController().signal, { conclave: { reached: false } })
  assert.equal(failed?.level, 'conclave_failed')
  const reached = await synthesise(d.id, new AbortController().signal, { conclave: { reached: true } })
  assert.equal(reached?.level, 'conclave_reached')
  cleanup()
})

test('a sealed ping-pong round does not leak the first speaker\'s position through the ledger', async () => {
  const { room: r, stubs, cleanup } = room(['A', 'B'], n => ({
    turn: (c: { systemPrompt: string }) => rapporteur(c) ? synthOrTurn(c) : {
      body: `turn by ${n}`, stance: 'propose', reply_to: '',
      claims: [{ text: 'c', basis: 'reasoned' }],
      position_ops: [{ op: 'assert', label: '', title: `SECRET-TITLE-${n}`, text: `secret ${n}`, note: '' }],
    },
  }))
  await startDeliberation(deliberation(r.id, { rounds: 1, style: 'pingpong', sealedOpening: true }))
  cleanup()
  for (const [n, stub] of stubs) {
    const other = n === 'A' ? 'B' : 'A'
    assert.ok(!roundCalls(stub)[0].userPrompt.includes(`SECRET-TITLE-${other}`),
      `${n} saw ${other}'s sealed position`)
  }
})

test('the synthesiser is given the final round of a long discussion, not just its opening', async () => {
  // A plain .slice(0, 90_000) kept the opening and cut the closing round.
  const { room: r, agents, stubs, cleanup } = room(['A'], () => ({ turn: synthOrTurn }))
  const d = deliberation(r.id, { rounds: 6, status: 'complete' })
  for (let round = 1; round <= 6; round++) {
    db.insertMessage({ roomId: r.id, authorType: 'agent', authorId: agents[0].id,
      body: `ROUND-${round}-OPENING ` + 'z'.repeat(25_000), round, deliberationId: d.id })
  }
  await synthesise(d.id, new AbortController().signal)
  cleanup()
  const call = stubs.get('A')!.calls.find(rapporteur)!
  assert.ok(call.userPrompt.includes('ROUND-6-OPENING ' + 'z'.repeat(1_000)), 'the final round was cut')
  assert.ok(call.userPrompt.length < 140_000, `synthesis prompt is ${call.userPrompt.length} chars`)
})

// --- run integrity (#78, #79) ---

const inRound = (stub: Stub, r: number) => roundCalls(stub).filter(c => new RegExp(`Round ${r} of`).test(c.userPrompt))

test('an interrupt re-runs only the turn it cut off, and every agent sees the steer once', async () => {
  const { room: r, stubs, cleanup } = room(['Fast', 'Slow'], n => ({ delayMs: n === 'Fast' ? 10 : 400 }))
  const d = deliberation(r.id, { rounds: 2 })
  const run = startDeliberation(d)
  setTimeout(() => {
    db.insertMessage({ roomId: r.id, authorType: 'human', priority: true, body: 'INTERRUPT-STEER' })
    interruptDeliberation(d.id)
  }, 150)
  await run
  cleanup()

  const fast = stubs.get('Fast')!, slow = stubs.get('Slow')!
  assert.equal(inRound(fast, 1).length, 1, 'a turn that had finished was run again')
  assert.equal(inRound(slow, 1).length, 2, 'the cut-off turn was not repeated')
  const turns = db.listMessages(r.id).filter(m => m.deliberationId === d.id && m.authorType === 'agent' && m.round === 1)
  assert.equal(turns.length, 2, 'round 1 should hold exactly one turn per agent')
  assert.match(inRound(slow, 1)[1].userPrompt, /# PRIORITY[\s\S]*INTERRUPT-STEER/)
  assert.match(inRound(fast, 2)[0].userPrompt, /# PRIORITY[\s\S]*INTERRUPT-STEER/,
    'the agent whose turn was kept never saw the steer')
  const ev = eventsOf(d.id, 'round.restarted')[0]
  assert.deepEqual([(ev.payload as any).kept, (ev.payload as any).rerun], [1, 1])
})

test('an interrupt during the votes does not make the chair draft again', async () => {
  const { room: r, stubs, cleanup } = room(['A', 'B'], n => ({ delayMs: n === 'A' ? 10 : 400 }))
  const d = deliberation(r.id, { mode: 'conclave', rounds: 4 })
  const run = startDeliberation(d)
  setTimeout(() => interruptDeliberation(d.id), 150)
  await run
  cleanup()
  const chairCalls = inRound(stubs.get('A')!, 1).filter(c => /You hold the chair/.test(c.userPrompt))
  assert.equal(chairCalls.length, 1, 'the chair drafted twice in one round')
  assert.equal(inRound(stubs.get('B')!, 1).length, 2)
})

test('a conclave keeps only the memory proposed in the round it ended on', async () => {
  const { room: r, cleanup } = room(['A', 'B'], n => ({
    turn: (c: { systemPrompt: string }) => rapporteur(c) ? synthOrTurn(c) : {
      body: `turn by ${n}`, stance: 'propose', reply_to: '', claims: [{ text: 'c', basis: 'reasoned' }],
      memory: [{ type: 'result', text: `A card worth keeping from ${n}` }],
    },
  }))
  const d = deliberation(r.id, { mode: 'conclave', rounds: 4 })
  await startDeliberation(d)
  cleanup()
  const msgs = new Map(db.listMessages(r.id).map(m => [m.id, m]))
  const cards = db.listMemory({ status: 'proposed' }).filter(c => c.roomId === r.id)
  assert.ok(cards.length > 0, 'no proposals at all')
  assert.deepEqual([...new Set(cards.map(c => msgs.get(c.sourceMessageId!)?.round))], [4],
    'proposals from earlier conclave rounds survived')
})
