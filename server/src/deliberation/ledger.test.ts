/**
 * The consensus level must be a fact derived from the record. These tests exist
 * because the failure mode here is silent: a wrong level produces a
 * confident-sounding result card that nobody can tell is wrong.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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
  applyPositionOps({ roomId: room.id, agent, ops, messageId: 'm', round: 1 , deliberationId: null})

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

test('a restatement under a new title is merged into the position that already said it', async t => {
  // The failure this prevents: a room in unanimous agreement reporting "no
  // reliable conclusion" because each agent opened its own phrasing of one idea.
  const { similarity } = await import('../search/embeddings.ts')
  // A bare `return` here is a silent PASS, not a skip — which is how the
  // position-merge path, the subtlest logic in the product, reported green with
  // zero coverage on every machine without a local embedder.
  if (await similarity('a', 'b') === null) return t.skip('needs a local embedder')

  const roster2 = [A, B, C]
  const r2 = db.createRoom(project.id, 'Dedup', 'room', roster2.map(a => a.id))
  const put = (agent: typeof A, title: string, text: string) =>
    applyPositionOps({
      roomId: r2.id, agent,
      ops: [{ label: null, title, op: 'assert', note: '', text }],
      messageId: 'm', round: 1, deliberationId: null,
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

test('a genuinely different position is not merged away', async t => {
  const { similarity } = await import('../search/embeddings.ts')
  // A bare `return` here is a silent PASS, not a skip — which is how the
  // position-merge path, the subtlest logic in the product, reported green with
  // zero coverage on every machine without a local embedder.
  if (await similarity('a', 'b') === null) return t.skip('needs a local embedder')

  const r3 = db.createRoom(project.id, 'NoDedup', 'room', [A.id, B.id])
  const put = (agent: typeof A, title: string, text: string) =>
    applyPositionOps({
      roomId: r3.id, agent,
      ops: [{ label: null, title, op: 'assert', note: '', text }],
      messageId: 'm', round: 1, deliberationId: null,
    })
  await put(A, 'Oil whip diagnosis via subsynchronous frequency lock',
    'The vibration locks to the first natural frequency.')
  await put(B, 'Hardening jump with order-tracking discriminator',
    'The resonance stays tied to shaft order and bends upward.')

  assert.equal(db.listPositions(r3.id).length, 2)
})

test('a blind restatement is recorded as co-assertion, not as endorsing the unseen', async t => {
  // In a sealed round nobody can see the other positions, so recording a merged
  // restatement as "endorse" claims an agreement that never happened.
  const { similarity } = await import('../search/embeddings.ts')
  // A bare `return` here is a silent PASS, not a skip — which is how the
  // position-merge path, the subtlest logic in the product, reported green with
  // zero coverage on every machine without a local embedder.
  if (await similarity('a', 'b') === null) return t.skip('needs a local embedder')

  const r = db.createRoom(project.id, 'Blind', 'room', [A.id, B.id])
  const put = (agent: typeof A, title: string, text: string, blind: boolean) =>
    applyPositionOps({
      roomId: r.id, agent, ops: [{ label: null, title, op: 'assert', note: '', text }],
      messageId: 'm', round: 1, deliberationId: null, blind,
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

test('a sighted restatement IS an endorsement', async t => {
  const { similarity } = await import('../search/embeddings.ts')
  // A bare `return` here is a silent PASS, not a skip — which is how the
  // position-merge path, the subtlest logic in the product, reported green with
  // zero coverage on every machine without a local embedder.
  if (await similarity('a', 'b') === null) return t.skip('needs a local embedder')

  const r = db.createRoom(project.id, 'Sighted', 'room', [A.id, B.id])
  await applyPositionOps({
    roomId: r.id, agent: A, messageId: 'm', round: 1, deliberationId: null, blind: true,
    ops: [{ label: null, title: 'Hysteresis band alone cannot distinguish mechanism',
            op: 'assert', note: '', text: 'Not diagnostic on its own.' }],
  })
  await applyPositionOps({
    roomId: r.id, agent: B, messageId: 'm', round: 2, deliberationId: null, blind: false,
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

// --- capability scoping ---

test('file access is refused when no working directory is set', async () => {
  // Without --add-dir/--cd the brain runs wherever the daemon happens to be,
  // which for a Finder-launched app is `/`. Granting Write and Bash there is not
  // a scoped workstation, it is the whole machine.
  const { resolveWorkspaceForTest } = await import('./scheduler.ts')
  const proj = db.createProject('NoDir', null)
  const r = db.createRoom(proj.id, 'NoDir room', 'room', [A.id], 'full')

  const got = resolveWorkspaceForTest(r, 'full')
  assert.equal(got.tier, 'research', 'full tier must not survive without a directory')
  assert.equal(got.workingDir, null)
  assert.equal(got.downgraded, true)
})

test('file access is granted once a working directory exists', async () => {
  const { resolveWorkspaceForTest } = await import('./scheduler.ts')
  // A real directory. This used to name a path that did not exist and still
  // asserted `full`, which is exactly the gap: the only gate was "is this string
  // non-empty".
  const dir = mkdtempSync(join(tmpdir(), 'rs-workspace-'))
  const proj = db.createProject('WithDir', dir)
  const r = db.createRoom(proj.id, 'WithDir room', 'room', [A.id], 'full')

  const got = resolveWorkspaceForTest(r, 'full')
  assert.equal(got.tier, 'full')
  assert.equal(got.workingDir, dir)
  assert.equal(got.downgraded, false)
})

test('file access is withdrawn if the working directory goes away mid-run', async () => {
  const { resolveWorkspaceForTest } = await import('./scheduler.ts')
  const dir = mkdtempSync(join(tmpdir(), 'rs-workspace-gone-'))
  const proj = db.createProject('GoneDir', dir)
  const r = db.createRoom(proj.id, 'GoneDir room', 'room', [A.id], 'full')
  assert.equal(resolveWorkspaceForTest(r, 'full').tier, 'full')

  rmSync(dir, { recursive: true, force: true })

  const got = resolveWorkspaceForTest(r, 'full')
  assert.equal(got.tier, 'research', 'full tier survived a working directory that is gone')
  assert.equal(got.workingDir, null)
  assert.equal(got.downgraded, true)
  assert.match(got.reason!, /no longer exists/)
})

test('reasoning and research never need a directory', async () => {
  const { resolveWorkspaceForTest } = await import('./scheduler.ts')
  const proj = db.createProject('Plain', null)
  const r = db.createRoom(proj.id, 'Plain room', 'room', [A.id], 'research')
  for (const t of ['reasoning', 'research'] as const) {
    const got = resolveWorkspaceForTest(r, t)
    assert.equal(got.tier, t)
    assert.equal(got.downgraded, false)
  }
})

test('clearing a room also erases what the agents remembered from it', () => {
  // Otherwise an agent still carries a discussion the user believes they erased
  // into the next one.
  const proj = db.createProject('Clearable')
  const r = db.createRoom(proj.id, 'Clearable room', 'room', [A.id])
  db.insertMessage({ roomId: r.id, authorType: 'human', body: 'a question' })
  const proposed = db.proposeMemory({
    agentId: A.id, projectId: proj.id, roomId: r.id, scope: 'project',
    type: 'result', text: 'Something learned here.', sourceMessageId: null,
  })
  db.setMemoryStatus(proposed.id, 'accepted')
  assert.equal(db.listMemory({ agentId: A.id, status: 'accepted' }).filter(c => c.roomId === r.id).length, 1)

  const info = db.clearRoom(r.id)
  assert.equal(info.messages, 1)
  assert.equal(info.memoryCards, 1)
  assert.equal(db.listMemory({ agentId: A.id }).filter(c => c.roomId === r.id).length, 0,
    'an accepted card outlived the room it came from')
  assert.equal(db.listMessages(r.id).length, 0)
  assert.ok(db.getRoom(r.id), 'the room itself must survive a clear')
})

test('deleting a room takes its memory with it', () => {
  const proj = db.createProject('Deletable')
  const r = db.createRoom(proj.id, 'Deletable room', 'room', [A.id])
  const c = db.proposeMemory({
    agentId: A.id, projectId: proj.id, roomId: r.id, scope: 'project',
    type: 'result', text: 'Learned in a room that will not exist.', sourceMessageId: null,
  })
  db.setMemoryStatus(c.id, 'accepted')
  db.deleteRoom(r.id)
  assert.equal(db.listMemory({ agentId: A.id }).filter(x => x.roomId === r.id).length, 0)
})

// --- one room, more than one deliberation ---

test('a second deliberation does not inherit the first one\'s consensus', async () => {
  // The room's positions are its standing beliefs and outlive any single run —
  // that is the product. What was wrong is counting stances nobody cast in this
  // run: the headline consensus level, which is the thing the result card leads
  // with, was computed over a previous question's answers.
  const r = db.createRoom(project.id, 'Two runs', 'room', roster.map(a => a.id))
  const run1 = db.createDeliberation({
    roomId: r.id, mode: 'deliberation', rounds: 2, style: 'parallel',
    sealedOpening: false, status: 'complete', currentRound: 2,
    question: 'first question', tier: 'reasoning',
  } as never)
  const put = (agent: typeof A, ops: any[], deliberationId: string | null) =>
    applyPositionOps({ roomId: r.id, agent, ops, messageId: 'm', round: 1, deliberationId })

  await put(A, [{ label: null, title: 'Bearing clearance', op: 'assert', note: '', text: 'x' }], run1.id)
  for (const a of [B, C, D]) {
    await put(a, [{ label: 'P1', title: null, op: 'endorse', note: 'agreed', text: '' }], run1.id)
  }
  assert.equal(summarise(r.id, roster, run1.id).level, 'strong_consensus')

  const run2 = db.createDeliberation({
    roomId: r.id, mode: 'deliberation', rounds: 2, style: 'parallel',
    sealedOpening: false, status: 'running', currentRound: 0,
    question: 'an entirely different question', tier: 'reasoning',
  } as never)

  assert.equal(summarise(r.id, roster, run2.id).level, 'no_reliable_conclusion',
    'the new run reported a consensus reached about a different question')
  assert.equal(summarise(r.id, roster).level, 'strong_consensus',
    'the room-wide view lost what the room actually settled')
})

test('a later run taking a stance on a standing position counts only that run', async () => {
  const r = db.createRoom(project.id, 'Carry over', 'room', roster.map(a => a.id))
  const mkRun = (q: string) => db.createDeliberation({
    roomId: r.id, mode: 'deliberation', rounds: 2, style: 'parallel',
    sealedOpening: false, status: 'running', currentRound: 0, question: q, tier: 'reasoning',
  } as never)
  const run1 = mkRun('first'), run2 = mkRun('second')
  const put = (agent: typeof A, ops: any[], deliberationId: string) =>
    applyPositionOps({ roomId: r.id, agent, ops, messageId: 'm', round: 1, deliberationId })

  await put(A, [{ label: null, title: 'A standing belief', op: 'assert', note: '', text: 'y' }], run1.id)
  for (const a of [B, C, D]) {
    await put(a, [{ label: 'P1', title: null, op: 'endorse', note: '', text: '' }], run1.id)
  }
  // In run 2 only one agent goes on the record about it.
  await put(A, [{ label: 'P1', title: null, op: 'endorse', note: 'still think so', text: '' }], run2.id)

  const scoped = summarise(r.id, roster, run2.id)
  assert.equal(scoped.positions.length, 1, 'the position was not pulled into the run')
  assert.equal(scoped.positions[0].stances.length, 1,
    'the earlier run\'s endorsements were counted again')
  assert.notEqual(scoped.level, 'strong_consensus',
    'one agent on the record was reported as the whole room agreeing')
})

test('a concurrent turn sees the position the other one just opened', async () => {
  // Not a label race: `createPosition` counts and inserts with no await between,
  // and Node is single-threaded, so labels cannot collide. The real one is the
  // read *before* the await. `applyPositionOps` runs synchronously up to
  // `await nearest(...)`, so in a parallel round the second agent resolves its
  // label — and reads the position list the merge check uses — while the first
  // agent's insert is still pending. Its endorsement was then dropped as naming
  // a position that does not exist, and its restatement opened a duplicate
  // instead of merging. Both fragment the ledger, which is what makes a room in
  // agreement report as having reached no reliable conclusion.
  const r = db.createRoom(project.id, 'Concurrent', 'room', roster.map(a => a.id))

  await Promise.all([
    applyPositionOps({
      roomId: r.id, agent: A,
      ops: [{ label: null, title: 'Bearing clearance', op: 'assert', note: '', text: 'x' }],
      messageId: 'm', round: 1, deliberationId: null,
    }),
    applyPositionOps({
      roomId: r.id, agent: B,
      ops: [{ label: 'P1', title: null, op: 'endorse', note: 'agreed', text: '' }],
      messageId: 'm', round: 1, deliberationId: null,
    }),
  ])

  const positions = db.listPositions(r.id)
  assert.equal(positions.length, 1)
  assert.equal(positions[0].stances.length, 2,
    "the second agent's endorsement was dropped as naming a position that did not exist yet")
})

test('the prompt separates this run\'s positions from the room\'s standing ones', async () => {
  // The rendered ledger stays room-wide on purpose — see renderLedger. But an old
  // position must not read as though this run's participants backed it.
  const r = db.createRoom(project.id, 'Sectioned', 'room', roster.map(a => a.id))
  const mkRun = (q: string) => db.createDeliberation({
    roomId: r.id, mode: 'deliberation', rounds: 2, style: 'parallel',
    sealedOpening: false, status: 'running', currentRound: 0, question: q, tier: 'reasoning',
  } as never)
  const run1 = mkRun('first'), run2 = mkRun('second')

  await applyPositionOps({
    roomId: r.id, agent: A,
    ops: [{ label: null, title: 'Settled last time', op: 'assert', note: '', text: 'old' }],
    messageId: 'm', round: 1, deliberationId: run1.id,
  })
  await applyPositionOps({
    roomId: r.id, agent: B,
    ops: [{ label: null, title: 'Raised this time', op: 'assert', note: '', text: 'new' }],
    messageId: 'm', round: 1, deliberationId: run2.id,
  })

  const text = renderLedger(r.id, roster, run2.id)
  assert.match(text, /Raised this time/, "this run's position is missing from the prompt")
  assert.match(text, /Standing positions from earlier deliberations/)
  assert.match(text, /Settled last time/, 'the room lost its standing position entirely')

  // The old position is listed, but without stances — those were cast about a
  // different question and read as support for this one.
  const standing = text.slice(text.indexOf('Standing positions'))
  assert.doesNotMatch(standing, /Alice: assert/,
    "an earlier run's stances were shown as though they applied here")
})
