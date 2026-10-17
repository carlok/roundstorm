/**
 * Round isolation is asserted against the COMPOSED CONTEXT, not against model
 * output (plan §20). What an agent was shown is a fact; what it said is not.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeContext, modeInstruction } from './context.ts'
import type { Agent, Deliberation, Message, Room } from '../types.ts'

const agent = (name: string, personaKey: string): Agent => ({
  id: `a-${name}`, name, role: '', avatarColor: '#000', personaKey, personaExtra: '',
  brain: 'claude', model: null, tierCeiling: 'research', createdAt: 0,
})

const msg = (id: string, authorId: string, body: string, round: number | null): Message => ({
  id, roomId: 'r1', authorType: 'agent', authorId, body, replyTo: null, round,
  deliberationId: 'd1', sealed: false, priority: false, stance: 'propose', claims: [],
  degraded: false, brain: 'claude', model: null, costUsd: null, createdAt: 0, seq: 0,
})

const room: Room = {
  id: 'r1', projectId: 'p1', name: 'Test room', kind: 'room',
  tier: 'research', createdAt: 0, memberIds: ['a-Alice', 'a-Bruno'],
}

const delib = (over: Partial<Deliberation> = {}): Deliberation => ({
  id: 'd1', roomId: 'r1', mode: 'deliberation', rounds: 3, style: 'parallel',
  sealedOpening: true, status: 'running', currentRound: 1,
  question: 'Why is the system unstable?', tier: 'research',
  createdAt: 0, endedAt: null, ...over,
})

const roster = [agent('Alice', 'mathematician'), agent('Bruno', 'skeptic')]

test('parallel round context excludes anything from the current round', () => {
  const history = [msg('m1', 'a-Bruno', 'ROUND ONE CONTENT', 1)]
  const ctx = composeContext({
    agent: roster[0], room, roster, deliberation: delib({ currentRound: 2 }),
    round: 2, history, steers: [], schemaEnforced: true,
  })
  assert.ok(ctx.userPrompt.includes('ROUND ONE CONTENT'))
  // The scheduler passes only pre-round history; nothing from round 2 can appear.
  assert.ok(!ctx.userPrompt.includes('ROUND TWO CONTENT'))
})

test('sealed opening round tells the agent it is writing blind and shows no transcript', () => {
  const ctx = composeContext({
    agent: roster[0], room, roster, deliberation: delib(),
    round: 1, history: [], steers: [], schemaEnforced: true,
  })
  assert.ok(ctx.userPrompt.includes('sealed opening round'))
  assert.ok(!ctx.sections.some(s => s.name === 'transcript'))
})

test('a human steer is injected verbatim and marked priority', () => {
  const steer: Message = { ...msg('s1', '', 'Focus on Bruno\'s objection.', null), authorType: 'human' }
  const ctx = composeContext({
    agent: roster[0], room, roster, deliberation: delib({ currentRound: 2 }),
    round: 2, history: [], steers: [steer], schemaEnforced: true,
  })
  assert.ok(ctx.userPrompt.includes('PRIORITY'))
  assert.ok(ctx.userPrompt.includes("Focus on Bruno's objection."))
})

test('the persona contract reaches the system prompt, not the user prompt', () => {
  const ctx = composeContext({
    agent: roster[1], room, roster, deliberation: delib(),
    round: 1, history: [], steers: [], schemaEnforced: true,
  })
  assert.ok(ctx.systemPrompt.includes('counterexample'))
  assert.ok(ctx.systemPrompt.includes('what evidence would change your mind'))
  assert.ok(!ctx.userPrompt.includes('counterexample'))
})

test('schema-less brains get the prompted contract appended; schema brains do not', () => {
  const args = {
    agent: roster[0], room, roster, deliberation: delib(),
    round: 1, history: [], steers: [],
  }
  assert.ok(composeContext({ ...args, schemaEnforced: false }).systemPrompt.includes('Output format'))
  assert.ok(!composeContext({ ...args, schemaEnforced: true }).systemPrompt.includes('Output format'))
})

test('agents see each other by name so they can address one another', () => {
  const ctx = composeContext({
    agent: roster[0], room, roster, deliberation: delib(),
    round: 1, history: [], steers: [], schemaEnforced: true,
  })
  assert.ok(ctx.systemPrompt.includes('Bruno'))
  assert.ok(!ctx.systemPrompt.includes('Other participants: Alice'))
})

test('message ids are exposed so a reply can name its target', () => {
  const ctx = composeContext({
    agent: roster[0], room, roster, deliberation: delib({ currentRound: 2 }),
    round: 2, history: [msg('m-xyz', 'a-Bruno', 'text', 1)], steers: [], schemaEnforced: true,
  })
  assert.ok(ctx.userPrompt.includes('[id: m-xyz]'))
})

test('the final round forbids manufacturing agreement', () => {
  const last = modeInstruction('deliberation', 3, 3, false)
  assert.ok(/do not manufacture agreement/i.test(last))
  assert.ok(!/do not manufacture agreement/i.test(modeInstruction('deliberation', 2, 3, false)))
})

test('each mode produces a materially different instruction', () => {
  const modes = ['brainstorm', 'critique', 'deliberation', 'consensus', 'research_plan', 'conclave'] as const
  const texts = modes.map(m => modeInstruction(m, 2, 4, false))
  assert.equal(new Set(texts).size, modes.length)
})

test('after round 1 the prompt explicitly forbids duplicate positions', () => {
  // Agents default to opening a near-duplicate rather than endorsing a peer,
  // which misreports the room as more divided than it is.
  const ctx = composeContext({
    agent: roster[0], room, roster, deliberation: delib({ currentRound: 2 }),
    round: 2, history: [], steers: [], schemaEnforced: true,
  })
  assert.ok(/do NOT open a near-duplicate/i.test(ctx.userPrompt))
  assert.ok(/read the ledger above/i.test(ctx.userPrompt))
})

test('the sealed opening round does not mention a ledger it cannot see', () => {
  const ctx = composeContext({
    agent: roster[0], room, roster, deliberation: delib(),
    round: 1, history: [], steers: [], schemaEnforced: true,
  })
  assert.ok(!/read the ledger above/i.test(ctx.userPrompt))
})

test('a conclave role instruction replaces the mode instruction entirely', () => {
  const ctx = composeContext({
    agent: roster[0], room, roster, deliberation: delib({ mode: 'conclave', currentRound: 2 }),
    round: 2, history: [], steers: [], schemaEnforced: true,
    extraInstruction: 'You hold the devil’s seat this round.',
  })
  assert.ok(ctx.userPrompt.includes("devil’s seat"))
  assert.ok(!/You are in conclave: the room cannot finish/.test(ctx.userPrompt))
})

test('an @mention tells the named agent to answer and everyone else to stay out', () => {
  const steer: Message = { ...msg('s1', '', '@Alice can you check the scaling?', null), authorType: 'human' }
  const mine = composeContext({
    agent: roster[0], room, roster, deliberation: delib({ currentRound: 2 }),
    round: 2, history: [], steers: [steer], schemaEnforced: true, mentioned: true,
  })
  const theirs = composeContext({
    agent: roster[1], room, roster, deliberation: delib({ currentRound: 2 }),
    round: 2, history: [], steers: [steer], schemaEnforced: true, mentioned: false,
  })
  assert.ok(/addressed you by name/i.test(mine.userPrompt))
  assert.ok(/let them answer it/i.test(theirs.userPrompt))
})

// --- history budget (#33) ---

const human = (id: string, body: string, round: number | null): Message =>
  ({ ...msg(id, 'a-Alice', body, round), authorType: 'human', authorId: null })

const compose = (history: Message[], historyBudget?: number, round = 4) => composeContext({
  agent: roster[0], room, roster, deliberation: delib({ currentRound: round, rounds: 6 }),
  round, history, steers: [], schemaEnforced: true, historyBudget,
})

/** Three rounds of two messages of about 1,000 characters each. */
const long = () => [1, 2, 3].flatMap(r => ['Alice', 'Bruno'].map((n, i) =>
  msg(`m${r}${i}`, `a-${n}`, `R${r}-${n} ` + 'x'.repeat(1000), r)))

test('under the budget the transcript is untouched and nothing is reported omitted', () => {
  const ctx = compose(long(), 100_000)
  assert.equal(ctx.omittedMessages, 0)
  assert.ok(!ctx.userPrompt.includes('omitted'))
  for (const r of [1, 2, 3]) for (const n of ['Alice', 'Bruno']) assert.ok(ctx.userPrompt.includes(`R${r}-${n} `))
})

test('over the budget the oldest messages go, the newest round stays, and a marker says so', () => {
  const ctx = compose(long(), 3_000)
  assert.ok(ctx.omittedMessages > 0)
  assert.ok(!ctx.userPrompt.includes('R1-Alice '), 'the oldest message was kept over budget')
  assert.ok(ctx.userPrompt.includes('R3-Alice ') && ctx.userPrompt.includes('R3-Bruno '),
    'the most recent round must never be dropped')
  assert.match(ctx.userPrompt, /\[\d+ earlier messages? omitted/)
  assert.match(ctx.userPrompt, /ledger above still records/)
})

test('the transcript section stays inside the budget when something can be dropped', () => {
  const budget = 4_000
  const ctx = compose(long(), budget)
  const t = ctx.sections.find(s => s.name === 'transcript')!
  assert.ok(t.chars <= budget + 400, `transcript was ${t.chars} chars against a ${budget} budget`)
})

test('a human message survives even when it is the oldest thing in the room', () => {
  const history = [human('h1', 'HUMAN STEER ' + 'y'.repeat(500), 1), ...long()]
  const ctx = compose(history, 3_000)
  assert.ok(ctx.userPrompt.includes('HUMAN STEER'), 'a human message was dropped to save space')
  assert.ok(!ctx.userPrompt.includes('R1-Alice '))
})

test('one marker stands for each run of omitted messages, in place', () => {
  const ctx = compose(long(), 3_000)
  const at = ctx.userPrompt.indexOf('omitted to keep')
  assert.ok(at > 0)
  assert.ok(at < ctx.userPrompt.indexOf('R3-Alice '), 'the marker should come before what survives')
  assert.equal(ctx.userPrompt.match(/omitted to keep/g)!.length, 1)
})

test('trimming never lets in a round the caller excluded', () => {
  // Round isolation is the property this file exists for.
  const ctx = compose(long(), 3_000, 3)
  assert.ok(!ctx.userPrompt.includes('ROUND FOUR'))
  const withoutRound3 = long().filter(m => m.round !== 3)
  const c2 = compose(withoutRound3, 2_500, 3)
  assert.ok(!c2.userPrompt.includes('R3-'), 'a message from an excluded round appeared')
})

test('prompt size grows slowly once the budget binds', () => {
  const make = (rounds: number) => Array.from({ length: rounds }, (_, i) => i + 1).flatMap(r =>
    ['Alice', 'Bruno', 'Cara', 'Dev', 'Eli'].map((n, k) => msg(`m${r}${k}`, `a-${n}`, 'z'.repeat(1500), r)))
  const sizeAt = (r: number) => compose(make(r), 12_000, r + 1).userPrompt.length
  assert.ok(sizeAt(10) < sizeAt(3) * 2.2, 'prompt size still tracks the length of the discussion')
})

test('a dropped message leaves one line: who, which round, stance, the gist', () => {
  const history = [
    { ...msg('o1', 'a-Bruno', 'Bearings fail first. Everything after is detail ' + 'q'.repeat(900), 1), stance: 'oppose' as const },
    ...long().filter(m => m.round !== 1),
  ]
  const ctx = compose(history, 3_000)
  assert.ok(ctx.omittedMessages >= 1)
  assert.match(ctx.userPrompt, /- Bruno, round 1 \[oppose\]: Bearings fail first\./)
  assert.ok(!ctx.userPrompt.includes('q'.repeat(50)), 'the body of a dropped message leaked into the digest')
})

test('a digest line is cut short, and the lines share a bounded allowance', () => {
  const many = Array.from({ length: 40 }, (_, i) => msg(`d${i}`, 'a-Alice', 'Sentence without an end ' + 'w'.repeat(400), 1 + (i % 2)))
  const ctx = compose([...many, ...long().filter(m => m.round === 3)], 4_000)
  const lines = ctx.userPrompt.split('\n').filter(l => l.startsWith('- Alice, round'))
  assert.ok(lines.length > 0)
  assert.ok(lines.every(l => l.length <= 190), 'a digest line was not shortened')
  assert.match(ctx.userPrompt, /\(\d+ older not listed\)/, 'the allowance should have run out and said so')
  const t = ctx.sections.find(s => s.name === 'transcript')!
  assert.ok(t.chars <= 4_000 + 600, `transcript was ${t.chars} chars`)
})

test('under the budget there is no digest at all', () => {
  assert.ok(!compose(long(), 100_000).userPrompt.includes('one line each'))
})
