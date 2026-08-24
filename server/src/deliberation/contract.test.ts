import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coerceTurn, extractJson, stripJsonBlock } from './contract.ts'

test('schema-shaped output passes through intact', () => {
  const r = coerceTurn({
    body: 'The obstruction is topological.',
    stance: 'object',
    reply_to: 'm1',
    claims: [{ text: 'Spectral degeneracy is ruled out', basis: 'computed', confidence: 'high' }],
  }, 'fallback')
  assert.equal(r.degraded, false)
  assert.equal(r.turn.stance, 'object')
  assert.equal(r.turn.reply_to, 'm1')
  assert.equal(r.turn.claims[0].basis, 'computed')
})

test('a claim marked sourced with no refs is downgraded to reasoned', () => {
  const r = coerceTurn({
    body: 'b', stance: 'propose',
    claims: [
      { text: 'laundered', basis: 'sourced' },
      { text: 'legitimate', basis: 'sourced', refs: ['S3'] },
    ],
  }, 'fallback')
  assert.equal(r.turn.claims[0].basis, 'reasoned')
  assert.equal(r.turn.claims[1].basis, 'sourced')
})

test('garbage degrades to a readable message instead of throwing', () => {
  for (const junk of [null, undefined, 'a string', 42, [], {}]) {
    const r = coerceTurn(junk, 'The prose the agent actually wrote.')
    assert.equal(r.degraded, true)
    assert.equal(r.turn.body, 'The prose the agent actually wrote.')
    assert.equal(r.turn.stance, 'propose')
  }
})

test('an unparseable turn with no prose still yields something renderable', () => {
  const r = coerceTurn(null, '   ')
  assert.equal(r.degraded, true)
  assert.ok(r.turn.body.length > 0)
})

test('invalid stance and basis values fall back rather than propagate', () => {
  const r = coerceTurn({
    body: 'b', stance: 'SHOUTING',
    claims: [{ text: 't', basis: 'vibes' }],
  }, 'f')
  assert.equal(r.turn.stance, 'propose')
  assert.equal(r.turn.claims[0].basis, 'reasoned')
})

test('extractJson finds the fenced block a prompted brain emits', () => {
  const text = 'Here is my view.\n\n```json\n{"body":"x","stance":"refine","claims":[]}\n```'
  const v = extractJson(text) as any
  assert.equal(v.stance, 'refine')
  assert.equal(stripJsonBlock(text), 'Here is my view.')
})

test('extractJson survives braces inside strings', () => {
  const v = extractJson('prose {"body":"a } b","stance":"propose","claims":[]}') as any
  assert.equal(v.body, 'a } b')
})

test('extractJson returns null rather than throwing on malformed JSON', () => {
  assert.equal(extractJson('no json here'), null)
  assert.equal(extractJson('{"unclosed": '), null)
})

// --- regressions from sprint 3, all found against real CLI output ---

test('prose followed by a bare turn object: the OUTER object wins, not the last brace', () => {
  // agy emits exactly this shape. Taking the last `{` finds the final claim
  // object, and the whole ledger silently comes back empty.
  const text = `I favor the **oil whip** hypothesis.

### Why
Hysteresis matches a subcritical Hopf bifurcation.
{"body":"I favor oil whip.","claims":[{"text":"first claim","basis":"reasoned"},{"text":"Under oil whip the frequency stays locked.","basis":"reasoned"}],"reply_to":"","stance":"propose","toolAction":"Finishing the task"}`
  const v = extractJson(text) as any
  assert.equal(v.stance, 'propose')
  assert.equal(v.claims.length, 2)
  const parsed = coerceTurn(v, text)
  assert.equal(parsed.degraded, false)
  assert.equal(parsed.turn.claims.length, 2)
})

test('the trailing bare turn object is stripped from the rendered body', () => {
  const text = 'Real prose here.\n{"body":"x","stance":"propose","claims":[]}'
  assert.equal(stripJsonBlock(text), 'Real prose here.')
})

test('a bare object that is not turn-shaped is left in the prose', () => {
  const text = 'Use the config {"timeout": 30} for the run.'
  assert.equal(stripJsonBlock(text), text)
})

test('vendor-injected extra keys are ignored rather than degrading the turn', () => {
  // agy appends toolAction/toolSummary to schema-shaped output.
  const r = coerceTurn({
    body: 'b', stance: 'propose', claims: [{ text: 't', basis: 'reasoned' }],
    toolAction: 'Finishing task', toolSummary: 'Finish',
  }, 'f')
  assert.equal(r.degraded, false)
  assert.equal(r.turn.claims.length, 1)
})
