/**
 * A bad config must fail before anything is created and before a model call is
 * billed, naming the field that is wrong.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ConfigError, parseExperiment, parseExperiments, stripJsonc } from './config.ts'

const minimal = {
  room: { name: 'R' },
  agents: [{ name: 'A', persona: 'skeptic', brain: 'claude' }],
  question: 'Something genuinely contested?',
}
const withMinimal = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ ...minimal, ...over })

test('comments and trailing commas are stripped', () => {
  const cfg = parseExperiment(`{
    // a line comment
    "room": { "name": "R" },   /* and a block one */
    "agents": [{ "name": "A", "persona": "skeptic", "brain": "claude" }],
    "question": "Contested?",
  }`)
  assert.equal(cfg.room.name, 'R')
})

test('a // inside a string is not a comment', () => {
  // Truncating a URL in the question would be a miserable bug to chase.
  const out = stripJsonc('{"question": "see https://example.com/a // not a comment"}')
  assert.match(JSON.parse(out).question, /example\.com\/a \/\/ not a comment/)
})

test('defaults are filled in', () => {
  const cfg = parseExperiment(withMinimal())
  assert.equal(cfg.mode, 'deliberation')
  assert.equal(cfg.rounds, 3)
  assert.equal(cfg.style, 'parallel')
  assert.equal(cfg.sealedOpening, true)
  assert.equal(cfg.room.tier, 'research')
})

test('a missing question is refused', () => {
  assert.throws(() => parseExperiment(JSON.stringify({ ...minimal, question: '  ' })),
    (e: Error) => e instanceof ConfigError && /question/.test(e.message))
})

test('an agent without a brain is refused, and the error says which agent', () => {
  assert.throws(
    () => parseExperiment(withMinimal({ agents: [{ name: 'A', persona: 'skeptic' }] })),
    (e: Error) => /agents\[0\]\.brain/.test(e.message))
})

test('a custom persona without instructions is refused', () => {
  // Otherwise the agent runs with no behavioural contract at all.
  assert.throws(
    () => parseExperiment(withMinimal({
      agents: [{ name: 'A', persona: 'custom', brain: 'claude' }],
    })),
    (e: Error) => /custom.*instructions/s.test(e.message))
})

test('duplicate agent names are refused', () => {
  assert.throws(
    () => parseExperiment(withMinimal({
      agents: [
        { name: 'A', persona: 'skeptic', brain: 'claude' },
        { name: 'A', persona: 'builder', brain: 'codex' },
      ],
    })),
    (e: Error) => /both called "A"/.test(e.message))
})

test('a one-agent conclave is refused rather than run to its cap', () => {
  // It cannot reach unanimity alone, so it would bill every round and then
  // report failure.
  assert.throws(
    () => parseExperiment(withMinimal({ mode: 'conclave' })),
    (e: Error) => /conclave needs at least two|at least two agents/.test(e.message))
})

test('bad enum values name the allowed set', () => {
  for (const [field, value, needle] of [
    ['mode', 'argue', 'brainstorm'],
    ['style', 'roundrobin', 'parallel'],
  ] as const) {
    assert.throws(() => parseExperiment(withMinimal({ [field]: value })),
      (e: Error) => e.message.includes(needle), `${field} did not list its options`)
  }
})

test('rounds must be a sane whole number', () => {
  for (const bad of [0, -1, 2.5, 999, 'three']) {
    assert.throws(() => parseExperiment(withMinimal({ rounds: bad })),
      (e: Error) => /rounds/.test(e.message), `accepted rounds=${bad}`)
  }
  assert.equal(parseExperiment(withMinimal({ rounds: 5 })).rounds, 5)
})

test('a jsonl file yields one config per line, and names the bad line', () => {
  const good = [withMinimal({ room: { name: 'One' } }), withMinimal({ room: { name: 'Two' } })].join('\n')
  assert.equal(parseExperiments(good, true).length, 2)

  const bad = [withMinimal(), '{"room":{"name":"X"}}'].join('\n')
  assert.throws(() => parseExperiments(bad, true), (e: Error) => /line 2/.test(e.message))
})

test('the shipped examples are valid', () => {
  // They are the documentation; if they stop parsing, the docs are wrong.
  assert.ok(parseExperiment(readFileSync('examples/conclave.jsonc', 'utf8')).agents.length >= 2)
  assert.equal(parseExperiments(readFileSync('examples/personas.jsonl', 'utf8'), true).length, 2)
})
