/**
 * What a headless run reports, and what it does when something goes wrong.
 *
 * Each of these used to produce a plausible wrong answer rather than an error: a
 * previous run's conclusion printed as this one's, a run in which nobody spoke
 * exiting 2 ("no reliable conclusion") instead of 3 ("it broke"), a batch losing
 * everything that had already finished.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ROUNDSTORM_DATA = mkdtempSync(join(tmpdir(), 'rs-run-'))
const db = await import('../db.ts')
const { cardFor, exitCodeFor, runBatch, writeOutput, setupExperiment } = await import('./run.ts')
type RunOutcome = Awaited<ReturnType<typeof import('./run.ts').runExperiment>>
type Cfg = Parameters<typeof setupExperiment>[0]

const cfg = (over: Partial<Cfg> = {}): Cfg => ({
  room: { name: 'R', tier: 'research' },
  agents: [{ name: 'A', persona: 'skeptic', brain: 'claude' }],
  question: 'q?', mode: 'deliberation', rounds: 1, style: 'parallel', sealedOpening: true,
  ...over,
} as Cfg)

const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
  room: { name: 'R' }, agents: [], card: { level: 'strong_consensus' }, messages: 3,
  costUsd: 0, failedTurns: 0, ms: 1, ...over,
} as unknown as RunOutcome)

// --- the card must belong to this run ---

function card(roomId: string, deliberationId: string, conclusion: string) {
  db.saveResult({
    id: `c-${deliberationId}`, deliberationId, roomId, level: 'strong_consensus', createdAt: Date.now(),
    conclusion, why: '', commonGround: [], disagreement: [], alternatives: [], evidence: [],
    unknowns: [], nextSteps: [],
  } as never)
}

test('a run that produced no card does not report the previous run\'s conclusion', () => {
  // `listResults(room.id).at(-1)` is room-wide. When synthesis returned nothing it
  // picked up the last run's card, and exitCodeFor saw a card and exited 0.
  const { room } = setupExperiment(cfg({ room: { name: 'stale', tier: 'research' } }))
  const mk = () => db.createDeliberation({
    roomId: room.id, mode: 'deliberation', rounds: 1, style: 'parallel', sealedOpening: false,
    status: 'complete', currentRound: 1, question: 'q', tier: 'research',
  } as never)
  const first = mk(), second = mk()
  card(room.id, first.id, 'THE OLD ANSWER')

  assert.equal(cardFor(room.id, second.id), null, 'the second run was handed the first run\'s card')
  assert.equal(cardFor(room.id, first.id)?.conclusion, 'THE OLD ANSWER')
})

// --- exit codes ---

test('a run in which nobody spoke is broken (3), whatever else it produced', () => {
  // The missing-brain case writes no visible failure, so failedTurns was 0 and
  // this fell through to "no reliable conclusion" (2).
  assert.equal(exitCodeFor(outcome({ messages: 0, failedTurns: 0 })), 3)
  assert.equal(exitCodeFor(outcome({ messages: 0, failedTurns: 2 })), 3)
})

test('the ordinary outcomes keep their codes', () => {
  assert.equal(exitCodeFor(outcome()), 0)
  assert.equal(exitCodeFor(outcome({ card: { level: 'no_reliable_conclusion' } as never })), 2)
  assert.equal(exitCodeFor(outcome({ card: { level: 'conclave_failed' } as never })), 2)
  assert.equal(exitCodeFor(outcome({ card: null })), 3)
})

// --- setup ---

test('a room with the same name in another project is not hijacked', () => {
  const a = setupExperiment(cfg({ project: 'Project A', room: { name: 'Main room', tier: 'research' } }))
  const b = setupExperiment(cfg({ project: 'Project B', room: { name: 'Main room', tier: 'research' } }))
  assert.notEqual(a.room.id, b.room.id, 'the second experiment took over the first project\'s room')
  assert.notEqual(a.room.projectId, b.room.projectId)
})

test('reusing an agent under another brain says so', () => {
  const lines: string[] = []
  const spec = (brain: string, persona: string) =>
    cfg({ project: 'reuse', room: { name: 'reuse room', tier: 'research' },
          agents: [{ name: 'Reused', persona, brain }] as never })
  setupExperiment(spec('claude', 'skeptic'), l => lines.push(l))
  assert.equal(lines.length, 0, 'a first creation is not a reuse')

  setupExperiment(spec('agy', 'mathematician'), l => lines.push(l))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /reusing "Reused"/)
  assert.match(lines[0], /claude\/skeptic/)
  assert.match(lines[0], /agy\/mathematician/)
})

test('re-running an unchanged agent is silent', () => {
  const lines: string[] = []
  const spec = cfg({ project: 'quiet', room: { name: 'quiet room', tier: 'research' },
                     agents: [{ name: 'Same', persona: 'skeptic', brain: 'claude' }] as never })
  setupExperiment(spec, l => lines.push(l))
  setupExperiment(spec, l => lines.push(l))
  assert.equal(lines.length, 0)
})

// --- a batch keeps what it finished ---

test('a failure in the middle of a batch does not lose the earlier results', async () => {
  const ran: string[] = []
  const runner = async (c: Cfg): Promise<RunOutcome> => {
    ran.push(c.room.name)
    if (c.room.name === 'two') throw new Error('brain exploded')
    return outcome({ room: { name: c.room.name } as never })
  }
  const lines: string[] = []
  const { outcomes, worst } = await runBatch(
    [cfg({ room: { name: 'one' } as never }), cfg({ room: { name: 'two' } as never }), cfg({ room: { name: 'three' } as never })],
    runner, l => lines.push(l))

  assert.deepEqual(ran, ['one', 'two', 'three'], 'the batch stopped at the first failure')
  assert.equal(outcomes.length, 3)
  assert.equal(outcomes[0].card !== null, true, 'experiment one\'s result was thrown away')
  assert.equal(outcomes[1].card, null)
  assert.equal(worst, 3)
  assert.ok(lines.some(l => /brain exploded/.test(l)), 'the failure was not reported')
})

test('a clean batch reports the worst exit code among its experiments', async () => {
  const runner = async (c: Cfg) => outcome({
    room: { name: c.room.name } as never,
    card: { level: c.room.name === 'b' ? 'no_reliable_conclusion' : 'strong_consensus' } as never,
  })
  const { worst } = await runBatch([cfg({ room: { name: 'a' } as never }), cfg({ room: { name: 'b' } as never })], runner, () => {})
  assert.equal(worst, 2)
})

// --- writing the output ---

test('an unwritable output path is reported, not thrown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-out-'))
  assert.equal(writeOutput(join(dir, 'ok.md'), 'x'), null)
  const err = writeOutput(join(dir, 'missing', 'sub', 'x.md'), 'x')
  assert.ok(err && /missing/.test(err), `expected a message naming the path, got ${err}`)
  mkdirSync(join(dir, 'isdir'))
  assert.ok(writeOutput(join(dir, 'isdir'), 'x'), 'writing onto a directory should be an error value')
  writeFileSync(join(dir, 'f'), '')
})
