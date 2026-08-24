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
