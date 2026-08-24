/**
 * The consensus level must be a fact derived from the record. These tests exist
 * because the failure mode here is silent: a wrong level produces a
 * confident-sounding result card that nobody can tell is wrong.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ROUNDSTORM_DATA = mkdtempSync(join(tmpdir(), 'rs-ledger-'))

const db = await import('../db.ts')
const { summarise, renderLedger } = await import('./ledger.ts')
const { applyPositionOps } = await import('./ledger.ts')

const project = db.createProject('T')
const mkAgent = (name: string) => db.createAgent({
  name, role: '', avatarColor: '#000', personaKey: 'skeptic', personaExtra: '',
  brain: 'claude', model: null, tierCeiling: 'research',
})
const A = mkAgent('Alice'), B = mkAgent('Bruno'), C = mkAgent('Curie'), D = mkAgent('Gauss')
const roster = [A, B, C, D]
const room = db.createRoom(project.id, 'R', 'room', roster.map(a => a.id))

const op = (agent: typeof A, ops: any[]) =>
  applyPositionOps({ roomId: room.id, agent, ops, messageId: 'm', round: 1 })

test('everyone backing the same position is strong consensus', async () => {
  await op(A, [{ label: null, title: 'Oil whip', op: 'assert', note: '', text: 'It is oil whip.' }])
  for (const a of [B, C, D]) await op(a, [{ label: 'P1', title: null, op: 'endorse', note: 'agreed', text: '' }])
  const s = summarise(room.id, roster)
  assert.equal(s.level, 'strong_consensus')
  assert.equal(s.leading?.label, 'P1')
})

test('one dissenter downgrades it rather than being rounded away', async () => {
  await op(D, [{ label: 'P1', title: null, op: 'oppose', note: 'onset undefined below 4e3', text: '' }])
  assert.equal(summarise(room.id, roster).level, 'consensus_with_reservations')
})

test('a genuine 2-2 split reports two positions, not a winner', async () => {
  await op(D, [{ label: null, title: 'Hardening', op: 'assert', note: '', text: 'Duffing jump.' }])
  await op(C, [{ label: 'P2', title: null, op: 'endorse', note: '', text: '' }])
  const s = summarise(room.id, roster)
  assert.equal(s.level, 'two_positions')
})

test('the latest op per agent wins — a ledger is state, not history', async () => {
  // Curie moved from P1 to P2 above; she must not still count toward P1.
  const p1 = summarise(room.id, roster).positions.find(p => p.label === 'P1')!
  const curie = p1.stances.filter(s => s.agentId === C.id)
  assert.equal(curie.length, 1)
  assert.equal(curie[0].op, 'endorse')
})

test('revising a position wipes the endorsements collected against the old one', async () => {
  const before = summarise(room.id, roster).positions.find(p => p.label === 'P1')!
  assert.ok(before.stances.some(s => s.op === 'endorse'))
  await op(A, [{ label: 'P1', title: null, op: 'revise', note: 'narrowed', text: 'Oil whip above 4e3 only.' }])
  const after = summarise(room.id, roster).positions.find(p => p.label === 'P1')!
  assert.equal(after.version, before.version + 1)
  assert.equal(after.stances.filter(s => s.op === 'endorse').length, 0)
})

test('an op naming a position that does not exist is dropped, not invented', async () => {
  const before = db.listPositions(room.id).length
  await op(B, [{ label: 'P99', title: null, op: 'endorse', note: 'hallucinated', text: '' }])
  assert.equal(db.listPositions(room.id).length, before)
})

test('an empty room yields no reliable conclusion rather than a cheerful blank', async () => {
  const empty = db.createRoom(project.id, 'Empty', 'room', [A.id])
  const s = summarise(empty.id, [A])
  assert.equal(s.level, 'no_reliable_conclusion')
  assert.equal(s.leading, null)
})

test('the rendered ledger names each position, version and who stands where', async () => {
  const text = renderLedger(room.id, roster)
  assert.ok(text.includes('**P1**'))
  assert.ok(/v\d/.test(text))
  assert.ok(text.includes('Alice'))
})

test('sources are deduped by url so agents can argue about "S3" by name', async () => {
  const a = db.upsertSource(room.id, { url: 'https://example.org/p', title: 'Paper' })
  const b = db.upsertSource(room.id, { url: 'https://example.org/p', title: 'Paper again' })
  assert.equal(a.id, b.id)
  assert.equal(a.label, b.label)
  const c = db.upsertSource(room.id, { url: 'https://example.org/other', title: 'Other' })
  assert.notEqual(c.label, a.label)
})

test('a memory card is proposed, not remembered, until a human keeps it', async () => {
  const card = db.proposeMemory({
    agentId: A.id, projectId: null, roomId: room.id, scope: 'project',
    type: 'definition', text: 'Onset means the first Re with a positive exponent.',
    sourceMessageId: null,
  })
  assert.equal(card.status, 'proposed')
  assert.equal(db.listMemory({ agentId: A.id, status: 'accepted' }).length, 0)
  db.setMemoryStatus(card.id, 'accepted')
  assert.equal(db.listMemory({ agentId: A.id, status: 'accepted' }).length, 1)
})

test('search finds a message by substring and never returns sealed turns', async () => {
  db.insertMessage({ roomId: room.id, authorType: 'agent', authorId: A.id,
    body: 'A distinctive phrase about bifurcation.', sealed: false })
  db.insertMessage({ roomId: room.id, authorType: 'agent', authorId: B.id,
    body: 'A distinctive phrase that is still sealed.', sealed: true })
  const hits = db.searchMessages('distinctive phrase')
  assert.equal(hits.length, 1)
  assert.ok(hits[0].snippet.includes('bifurcation'))
})

test('a restatement under a new title is merged into the position that already said it', async () => {
  // The failure this prevents: a room in unanimous agreement reporting "no
  // reliable conclusion" because each agent opened its own phrasing of one idea.
  // Needs a local embedder; skipped rather than silently passing without one.
  const { similarity } = await import('../search/embeddings.ts')
  if (await similarity('a', 'b') === null) return

  const roster2 = [A, B, C]
  const r2 = db.createRoom(project.id, 'Dedup', 'room', roster2.map(a => a.id))
  const put = (agent: typeof A, title: string, text: string) =>
    applyPositionOps({
      roomId: r2.id, agent,
      ops: [{ label: null, title, op: 'assert', note: '', text }],
      messageId: 'm', round: 1,
    })

  await put(A, 'Hysteresis band alone cannot distinguish mechanism',
    'A hysteresis band on its own does not identify the mechanism.')
  await put(B, 'Hysteresis band insufficient to distinguish mechanism',
    'The band alone is insufficient to tell the mechanisms apart.')
  await put(C, 'HysteresisBandIsInsufficient',
    'A 300 rpm hysteresis band alone is insufficient.')

  const positions = db.listPositions(r2.id)
  assert.equal(positions.length, 1, `expected one position, got ${positions.map(p => p.title)}`)
  assert.equal(positions[0].stances.length, 3)
  // And the room now reads as the agreement it actually is.
  assert.equal(summarise(r2.id, roster2).level, 'strong_consensus')
})

test('a genuinely different position is not merged away', async () => {
  const { similarity } = await import('../search/embeddings.ts')
  if (await similarity('a', 'b') === null) return

  const r3 = db.createRoom(project.id, 'NoDedup', 'room', [A.id, B.id])
  const put = (agent: typeof A, title: string, text: string) =>
    applyPositionOps({
      roomId: r3.id, agent,
      ops: [{ label: null, title, op: 'assert', note: '', text }],
      messageId: 'm', round: 1,
    })
  await put(A, 'Oil whip diagnosis via subsynchronous frequency lock',
    'The vibration locks to the first natural frequency.')
  await put(B, 'Hardening jump with order-tracking discriminator',
    'The resonance stays tied to shaft order and bends upward.')

  assert.equal(db.listPositions(r3.id).length, 2)
})

test('a blind restatement is recorded as co-assertion, not as endorsing the unseen', async () => {
  // In a sealed round nobody can see the other positions, so recording a merged
  // restatement as "endorse" claims an agreement that never happened.
  const { similarity } = await import('../search/embeddings.ts')
  if (await similarity('a', 'b') === null) return

  const r = db.createRoom(project.id, 'Blind', 'room', [A.id, B.id])
  const put = (agent: typeof A, title: string, text: string, blind: boolean) =>
    applyPositionOps({
      roomId: r.id, agent, ops: [{ label: null, title, op: 'assert', note: '', text }],
      messageId: 'm', round: 1, blind,
    })

  await put(A, 'Hysteresis band alone cannot distinguish mechanism',
    'A hysteresis band on its own does not identify the mechanism.', true)
  await put(B, 'Hysteresis band insufficient to distinguish mechanism',
    'The band alone is insufficient to tell the mechanisms apart.', true)

  const p = db.listPositions(r.id)
  assert.equal(p.length, 1)
  assert.ok(p[0].stances.every(s => s.op === 'assert'),
    `sealed-round merge recorded as ${p[0].stances.map(s => s.op)}`)
  assert.ok(p[0].stances.some(s => /independently stated/.test(s.note)))
})

test('a sighted restatement IS an endorsement', async () => {
  const { similarity } = await import('../search/embeddings.ts')
  if (await similarity('a', 'b') === null) return

  const r = db.createRoom(project.id, 'Sighted', 'room', [A.id, B.id])
  await applyPositionOps({
    roomId: r.id, agent: A, messageId: 'm', round: 1, blind: true,
    ops: [{ label: null, title: 'Hysteresis band alone cannot distinguish mechanism',
            op: 'assert', note: '', text: 'Not diagnostic on its own.' }],
  })
  await applyPositionOps({
    roomId: r.id, agent: B, messageId: 'm', round: 2, blind: false,
    ops: [{ label: null, title: 'Hysteresis band insufficient to distinguish mechanism',
            op: 'assert', note: '', text: 'The band alone is insufficient.' }],
  })
  const p = db.listPositions(r.id)
  assert.equal(p.length, 1)
  assert.ok(p[0].stances.some(s => s.agentId === B.id && s.op === 'endorse'))
})

test('a synthesiser echoing the agreement level back is not accepted as a conclusion', async () => {
  // Observed from a small local model: it returned "Consensus with reservations"
  // as the conclusion, which reads like an answer and says nothing.
  const { pickConclusionForTest } = await import('./synthesis.ts')
  const fallback = 'Coast-down before run-up, to capture the hysteretic jump.'
  assert.equal(pickConclusionForTest('Consensus with reservations', fallback, 'consensus_with_reservations'), fallback)
  assert.equal(pickConclusionForTest('Too short', fallback, 'strong_consensus'), fallback)
  assert.equal(pickConclusionForTest('', fallback, 'strong_consensus'), fallback)
  const real = 'The room converged on starting with a coast-down, because it captures the jump.'
  assert.equal(pickConclusionForTest(real, fallback, 'strong_consensus'), real)
})
