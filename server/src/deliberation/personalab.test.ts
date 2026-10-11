/**
 * Mind changes must come from the ledger, not the stance word. An earlier
 * version counted only `stance: 'concede'` and reported "nobody changed their
 * mind" over records that plainly showed agents abandoning their opening
 * position — they had written `endorse`, because the ledger instruction asks
 * them to endorse.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ROUNDSTORM_DATA = mkdtempSync(join(tmpdir(), 'rs-lab-'))

const db = await import('../db.ts')
const { reportArm, compare } = await import('./personalab.ts')

const project = db.createProject('T')
let n = 0
const mk = (name: string) => db.createAgent({
  name: `${name}-${n++}`, role: '', avatarColor: '#000', personaKey: 'skeptic',
  personaExtra: '', brain: 'claude', model: null, tierCeiling: 'research',
})

function room(name: string) {
  const cast = [mk('A'), mk('B')]
  const r = db.createRoom(project.id, name, 'room', cast.map(a => a.id))
  return { r, cast }
}

test('an agent that ends on a different position than it opened counts as moved', () => {
  const { r, cast } = room('moved')
  const p1 = db.createPosition(r.id, 'First', 'x', cast[0].id)
  const p2 = db.createPosition(r.id, 'Second', 'y', cast[1].id)
  db.recordOp({ positionId: p1.id, version: 1, agentId: cast[0].id, op: 'assert', round: 1 })
  db.recordOp({ positionId: p2.id, version: 1, agentId: cast[1].id, op: 'assert', round: 1 })
  // A abandons its own position for B's, but writes "endorse", not "concede".
  db.recordOp({ positionId: p2.id, version: 1, agentId: cast[0].id, op: 'endorse', round: 2 })

  const rep = reportArm(r.id)!
  assert.equal(rep.mindChanges, 1)
  assert.equal(rep.concessions, 0, 'stance field alone would have reported zero movement')
})

test('holding the same position all the way through is not a mind change', () => {
  const { r, cast } = room('held')
  const p = db.createPosition(r.id, 'One', 'x', cast[0].id)
  for (const a of cast) {
    db.recordOp({ positionId: p.id, version: 1, agentId: a.id, op: 'assert', round: 1 })
    db.recordOp({ positionId: p.id, version: 1, agentId: a.id, op: 'assert', round: 2 })
  }
  assert.equal(reportArm(r.id)!.mindChanges, 0)
})

test('an uncontested question is reported as such rather than blamed on the brains', () => {
  const { r, cast } = room('uncontested')
  const p = db.createPosition(r.id, 'Obvious', 'x', cast[0].id)
  for (const a of cast) db.recordOp({ positionId: p.id, version: 1, agentId: a.id, op: 'assert', round: 1 })

  const { r: r2, cast: c2 } = room('uncontested-2')
  const p2 = db.createPosition(r2.id, 'Obvious', 'x', c2[0].id)
  for (const a of c2) db.recordOp({ positionId: p2.id, version: 1, agentId: a.id, op: 'assert', round: 1 })

  const obs = compare([r.id, r2.id]).observations.join(' ')
  assert.ok(/not contested/i.test(obs), obs)
  assert.ok(!/nobody changed their mind/i.test(obs))
})

test('contested but immovable is a different finding from uncontested', () => {
  const { r, cast } = room('contested')
  const p1 = db.createPosition(r.id, 'A side', 'x', cast[0].id)
  const p2 = db.createPosition(r.id, 'B side', 'y', cast[1].id)
  db.recordOp({ positionId: p1.id, version: 1, agentId: cast[0].id, op: 'assert', round: 1 })
  db.recordOp({ positionId: p2.id, version: 1, agentId: cast[1].id, op: 'assert', round: 1 })
  db.recordOp({ positionId: p2.id, version: 1, agentId: cast[0].id, op: 'oppose', round: 2 })

  const { r: r2, cast: c2 } = room('contested-2')
  const q1 = db.createPosition(r2.id, 'A side', 'x', c2[0].id)
  const q2 = db.createPosition(r2.id, 'B side', 'y', c2[1].id)
  db.recordOp({ positionId: q1.id, version: 1, agentId: c2[0].id, op: 'assert', round: 1 })
  db.recordOp({ positionId: q2.id, version: 1, agentId: c2[1].id, op: 'assert', round: 1 })
  db.recordOp({ positionId: q1.id, version: 1, agentId: c2[1].id, op: 'oppose', round: 2 })

  const obs = compare([r.id, r2.id]).observations.join(' ')
  assert.ok(/contested but nobody moved/i.test(obs), obs)
})

test('a concession counts as movement even when the ledger shows no label change', () => {
  // De-duplication collapses the room onto one position, so an agent's first
  // recorded op is already the merged entry and the trajectory is erased. The
  // stance is then the only surviving evidence that anyone gave ground.
  const { r, cast } = room('merged')
  const p = db.createPosition(r.id, 'One', 'x', cast[0].id)
  for (const a of cast) {
    db.recordOp({ positionId: p.id, version: 1, agentId: a.id, op: 'assert', round: 1 })
    db.recordOp({ positionId: p.id, version: 1, agentId: a.id, op: 'assert', round: 2 })
  }
  db.insertMessage({
    roomId: r.id, authorType: 'agent', authorId: cast[0].id,
    body: 'I was wrong about the mechanism.', stance: 'concede', round: 2,
  })
  const rep = reportArm(r.id)!
  assert.equal(rep.concessions, 1)
  assert.equal(rep.mindChanges, 1, 'ledger showed no label change, so the stance is the only evidence')
})

test('the two signals are unioned, not double-counted', () => {
  const { r, cast } = room('both')
  const p1 = db.createPosition(r.id, 'A', 'x', cast[0].id)
  const p2 = db.createPosition(r.id, 'B', 'y', cast[1].id)
  db.recordOp({ positionId: p1.id, version: 1, agentId: cast[0].id, op: 'assert', round: 1 })
  db.recordOp({ positionId: p2.id, version: 1, agentId: cast[1].id, op: 'assert', round: 1 })
  db.recordOp({ positionId: p2.id, version: 1, agentId: cast[0].id, op: 'endorse', round: 2 })
  // Same agent both switched label and said "concede".
  db.insertMessage({
    roomId: r.id, authorType: 'agent', authorId: cast[0].id,
    body: 'Conceding.', stance: 'concede', round: 2,
  })
  assert.equal(reportArm(r.id)!.mindChanges, 1)
})

// --- one arm, run twice ---

test('re-running an arm reports the latest run, not the two fused together', () => {
  // `level` and `positions` were scoped to the room's latest run while the turn
  // count, stance mix, cost and conclusion were room-wide, so one report mixed two
  // experiments: a concession in run 1 counted in run 2's numbers, and a run that
  // produced no card quietly reported the previous run's conclusion.
  const { r, cast } = room('twice')
  const run = (q: string) => db.createDeliberation({
    roomId: r.id, mode: 'deliberation', rounds: 1, style: 'parallel', sealedOpening: false,
    status: 'complete', currentRound: 1, question: q, tier: 'research',
  } as never)
  const first = run('first'), second = run('second')

  const say = (deliberationId: string, stance: string, costUsd: number) => db.insertMessage({
    roomId: r.id, authorType: 'agent', authorId: cast[0].id, body: 'a few words here',
    round: 1, deliberationId, stance: stance as never, costUsd,
  })
  say(first.id, 'concede', 1.0); say(first.id, 'concede', 1.0); say(first.id, 'concede', 1.0)
  say(second.id, 'assert', 0.5)

  db.saveResult({
    id: 'old-card', deliberationId: first.id, roomId: r.id, level: 'strong_consensus',
    createdAt: Date.now(), conclusion: 'THE FIRST RUN CONCLUSION', why: '', commonGround: [],
    disagreement: [], alternatives: [], evidence: [], unknowns: [], nextSteps: [],
  } as never)

  const rep = reportArm(r.id)!
  assert.equal(rep.turns, 1, 'the earlier run\'s turns were counted')
  assert.equal(rep.concessions, 0, 'the earlier run\'s concessions were counted')
  assert.equal(rep.costUsd, 0.5, 'the earlier run\'s cost was counted')
  assert.equal(rep.conclusion, '', 'the latest run produced no card, so no conclusion is claimed')
})

test('a lab report with a priced and an unpriced arm does not call the unpriced one free', () => {
  // Only Claude reports a cost. An arm on another brain stored NULL, which was
  // summed as 0, so the comparison read "cost ranged $0.00 to $x" as if the
  // second arm had been free.
  const priced = room('priced'), unpriced = room('unpriced')
  const run = (r: { id: string }) => db.createDeliberation({
    roomId: r.id, mode: 'deliberation', rounds: 1, style: 'parallel', sealedOpening: false,
    status: 'complete', currentRound: 1, question: 'q', tier: 'research',
  } as never)
  const say = (r: { id: string }, authorId: string, deliberationId: string, costUsd: number | null) =>
    db.insertMessage({
      roomId: r.id, authorType: 'agent', authorId, body: 'a few words here',
      round: 1, deliberationId, stance: 'assert' as never, costUsd,
    })
  const d1 = run(priced.r), d2 = run(unpriced.r)
  say(priced.r, priced.cast[0].id, d1.id, 0.4)
  say(priced.r, priced.cast[1].id, d1.id, null)
  say(unpriced.r, unpriced.cast[0].id, d2.id, null)

  const a = reportArm(priced.r.id)!, b = reportArm(unpriced.r.id)!
  assert.equal(a.costUsd, 0.4)
  assert.equal(a.pricedTurns, 1)
  assert.equal(a.turns, 2)
  assert.equal(b.costUsd, null, 'an arm that reported no cost was summed as zero')
  assert.equal(b.pricedTurns, 0)

  const lines = compare([priced.r.id, unpriced.r.id]).observations.filter(l => /Cost/.test(l))
  assert.equal(lines.length, 1)
  assert.doesNotMatch(lines[0], /\$0\.00/, 'the unpriced arm was shown as $0.00')
  assert.match(lines[0], /1 of 2 arms reported no cost/)
})
