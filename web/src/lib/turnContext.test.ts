import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeTurn } from './turnContext.ts'

test('a recorded turn reads as facts, sections with shares, steers and outcome', () => {
  const d = describeTurn({
    context: {
      round: 3, brain: 'claude', model: 'claude-haiku-5-5', tier: 'research',
      sections: [{ name: 'question', chars: 200 }, { name: 'transcript', chars: 14_000 }, { name: 'steer', chars: 800 }],
      omittedMessages: 4, systemPromptBytes: 1_000, userPromptBytes: 15_000, promptDigest: 'abc123',
      steers: ['focus on the bearing'],
    },
    outcome: { stance: 'object', claims: 2, degraded: false, costUsd: 0.0123, ms: 4_200 },
    downgraded: { requested: 'full', granted: 'research', reason: 'no working directory set for this project' },
  })
  assert.deepEqual(d.facts, [
    'Round 3', 'claude · claude-haiku-5-5',
    'Tier research (asked for full: no working directory set for this project)',
    '4 earlier messages reduced to one line each to fit',
    'Prompt 16k chars · digest abc123',
  ])
  assert.deepEqual(d.sections.map(s => [s.label, s.size]), [
    ['Question and round', '200 chars'], ['Discussion so far', '14k chars'], ['Your steer', '800 chars'],
  ])
  assert.ok(Math.abs(d.sections[1].share - 14 / 15) < 1e-9)
  assert.deepEqual(d.steers, ['focus on the bearing'])
  assert.deepEqual(d.outcome, ['Stance: object', '2 claims', '$0.0123', '4.2s'])
})

test('a DM turn with no sections still describes itself', () => {
  const d = describeTurn({ context: { dm: true, brain: 'codex', model: null, tier: 'reasoning' }, outcome: null, downgraded: null })
  assert.deepEqual(d.facts, ['Direct message', 'codex', 'Tier reasoning'])
  assert.deepEqual(d.sections, [])
})
