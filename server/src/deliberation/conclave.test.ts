/**
 * Conclave unanimity must be computed, and must be capable of reporting
 * failure. A conclave that quietly rounds 3-of-4 up to "reached" is the single
 * worst bug this product could ship.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ROUNDSTORM_DATA = mkdtempSync(join(tmpdir(), 'rs-conclave-'))

const db = await import('../db.ts')
const { applyPositionOps } = await import('./ledger.ts')
const { runConclave } = await import('./conclave.ts')

const project = db.createProject('T')
const mk = (name: string) => db.createAgent({
  name, role: '', avatarColor: '#000', personaKey: 'skeptic', personaExtra: '',
  brain: 'claude', model: null, tierCeiling: 'research',
})

let scenarioNo = 0

function scenario(behaviour: (agentName: string, round: number) => any[]) {
  // Agent names are unique across the whole store, so each scenario needs its
  // own cast; `name` still reads as Alice/Bruno/Curie inside the behaviour fn.
  const tag = `-${scenarioNo++}`
  const roster = ['Alice', 'Bruno', 'Curie'].map(n => mk(n + tag))
  const room = db.createRoom(project.id, `R${tag}`, 'room', roster.map(a => a.id))
  const d = db.createDeliberation({
    roomId: room.id, mode: 'conclave', rounds: 4, style: 'parallel',
    sealedOpening: false, status: 'running', currentRound: 0,
    question: 'q', tier: 'reasoning',
  })
  // Stand in for the model: apply whatever ops the scenario dictates.
  const runTurn = async (args: any) => {
    const ops = behaviour(args.agent.name.replace(tag, ''), args.round)
    applyPositionOps({
      roomId: room.id, agent: args.agent, ops, messageId: 'm', round: args.round,
    })
  }
  return { room, d, roster, runTurn }
}

const assertP1 = { label: null, title: 'The proposal', op: 'assert', note: '', text: 'v1' }
const endorse = { label: 'P1', title: null, op: 'endorse', note: 'ok', text: '' }
const oppose = { label: 'P1', title: null, op: 'oppose', note: 'no', text: '' }

test('unanimous endorsement at the current version ends the conclave', async () => {
  const { d, runTurn } = scenario((name, round) =>
    round === 1 && name === 'Alice' ? [assertP1] : [endorse])
  const out = await runConclave(d.id, new AbortController().signal, runTurn as any)
  assert.equal(out.reached, true)
  assert.equal(out.holdouts.length, 0)
})

test('a single permanent holdout fails the conclave instead of being smoothed over', async () => {
  const { d, runTurn } = scenario((name, round) => {
    if (round === 1 && name === 'Alice') return [assertP1]
    return name === 'Bruno' ? [oppose] : [endorse]
  })
  const out = await runConclave(d.id, new AbortController().signal, runTurn as any)
  assert.equal(out.reached, false)
  assert.deepEqual(out.holdouts.map(h => h.replace(/-\d+$/, '')), ['Bruno'])
})

test('the emergency cap bounds an unwinnable conclave', async () => {
  const { d, runTurn } = scenario((name, round) => {
    if (round === 1 && name === 'Alice') return [assertP1]
    return name === 'Bruno' ? [oppose] : [endorse]
  })
  const out = await runConclave(d.id, new AbortController().signal, runTurn as any)
  assert.equal(out.reached, false)
  assert.ok(out.rounds <= 4, `ran ${out.rounds} rounds, cap was 4`)
})

test('endorsements of a stale version do not count toward unanimity', async () => {
  // Round 1: Alice proposes, Bruno endorses v1, Curie opposes — not unanimous.
  // Round 2: Alice revises to v2 and Curie endorses it, but Bruno says nothing.
  // Bruno's round-1 yes was against v1 and must not carry forward.
  const { room, d, runTurn } = scenario((name, round) => {
    if (round === 1) {
      if (name === 'Alice') return [assertP1]
      if (name === 'Bruno') return [endorse]
      return [oppose]
    }
    if (round === 2) {
      if (name === 'Alice') return [{ label: 'P1', title: null, op: 'revise', note: 'narrowed', text: 'v2' }]
      if (name === 'Curie') return [endorse]
      return []
    }
    return []
  })
  const out = await runConclave(d.id, new AbortController().signal, runTurn as any)
  const p = db.listPositions(room.id).find(x => x.label === 'P1')!
  assert.ok(p.version >= 2, `expected a revision, got v${p.version}`)
  assert.equal(out.reached, false)
  assert.ok(out.holdouts.some(h => h.startsWith('Bruno')),
    `Bruno's stale endorsement carried forward: holdouts=${out.holdouts}`)
})

test('an aborted conclave stops rather than running to the cap', async () => {
  const ac = new AbortController()
  const { d, runTurn } = scenario((name, round) => {
    if (round === 1) ac.abort()
    return name === 'Alice' ? [assertP1] : []
  })
  const out = await runConclave(d.id, ac.signal, runTurn as any)
  assert.equal(out.reached, false)
  assert.ok(out.rounds <= 1)
})

test("the devil's seat rotates so no agent is permanently chair or attacker", async () => {
  const seen: { chair: string; devil: string }[] = []
  const { d, runTurn } = scenario(() => [])
  const wrapped = async (args: any) => {
    // The chair runs alone first, then the rest concurrently — reconstruct the
    // pairing from the instruction each agent was handed.
    if (/hold the chair/.test(args.extraInstruction ?? '')) {
      seen.push({ chair: args.agent.name, devil: '' })
    } else if (/devil's seat/.test(args.extraInstruction ?? '')) {
      const last = seen[seen.length - 1]
      if (last) last.devil = args.agent.name
    }
    return runTurn(args)
  }
  await runConclave(d.id, new AbortController().signal, wrapped as any)
  assert.ok(seen.length >= 3)
  assert.notEqual(seen[0].chair, seen[1].chair)
  assert.notEqual(seen[0].devil, seen[1].devil)
  // The chair never attacks its own draft in the same round.
  for (const r of seen) assert.notEqual(r.chair, r.devil)
})
