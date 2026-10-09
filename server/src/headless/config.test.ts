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

// --- a config that is accepted and quietly ignored is worse than one that is refused ---

test('an unknown top-level key is refused, with the field it was probably meant to be', () => {
  // `"round": 5` used to parse cleanly and the default of 3 silently won, so the
  // run looked like the experiment that was written and was not.
  assert.throws(() => parseExperiment(withMinimal({ round: 5 })),
    (e: Error) => e instanceof ConfigError && /"round"/.test(e.message) && /did you mean "rounds"/.test(e.message))
})

test('snake_case is caught too, not just near-misses', () => {
  assert.throws(() => parseExperiment(withMinimal({ sealed_opening: false })),
    (e: Error) => /"sealed_opening"/.test(e.message) && /sealedOpening/.test(e.message))
})

test('an unknown key with no close match lists what is valid', () => {
  assert.throws(() => parseExperiment(withMinimal({ temperature: 0.2 })),
    (e: Error) => /"temperature"/.test(e.message) && /rounds/.test(e.message) && /question/.test(e.message))
})

test('unknown keys are caught inside room and inside an agent', () => {
  assert.throws(() => parseExperiment(withMinimal({ room: { name: 'R', teir: 'full' } })),
    (e: Error) => /room/.test(e.message) && /did you mean "tier"/.test(e.message))
  assert.throws(() => parseExperiment(withMinimal({
    agents: [{ name: 'A', persona: 'skeptic', brain: 'claude', tierCeling: 'full' }] })),
    (e: Error) => /agents\[0\]/.test(e.message) && /did you mean "tierCeiling"/.test(e.message))
})

test('a boolean field is checked, not coerced', () => {
  // `!!"false"` is true, so `"sealedOpening": "false"` turned sealing ON.
  assert.throws(() => parseExperiment(withMinimal({ sealedOpening: 'false' })),
    (e: Error) => /sealedOpening/.test(e.message) && /true or false/.test(e.message))
  assert.equal(parseExperiment(withMinimal({ sealedOpening: false })).sealedOpening, false)
})

test('string fields are checked, not quietly dropped', () => {
  assert.throws(() => parseExperiment(withMinimal({ workingDir: 42 })), /workingDir/)
  assert.throws(() => parseExperiment(withMinimal({ project: ['x'] })), /project/)
  assert.throws(() => parseExperiment(withMinimal({
    agents: [{ name: 'A', persona: 'skeptic', brain: 'claude', model: 7 }] })), /model/)
})

// --- brain and persona must be things that exist ---

const known = { brains: ['claude', 'codex', 'agy'], personas: ['skeptic', 'mathematician', 'custom'] }

test('a mistyped brain is refused with the valid ones, when the caller knows them', () => {
  // This used to create an agent that never spoke and left nothing in the transcript.
  const text = withMinimal({ agents: [{ name: 'A', persona: 'skeptic', brain: 'claud' }] })
  assert.throws(() => parseExperiment(text, known),
    (e: Error) => /agents\[0\]/.test(e.message) && /"claud"/.test(e.message) && /claude, codex, agy/.test(e.message))
})

test('a mistyped persona is refused instead of silently becoming the first template', () => {
  const text = withMinimal({ agents: [{ name: 'A', persona: 'skeptik', brain: 'claude' }] })
  assert.throws(() => parseExperiment(text, known),
    (e: Error) => /"skeptik"/.test(e.message) && /did you mean "skeptic"/.test(e.message))
})

test('without a known list, brain and persona are not checked (the parser stays pure)', () => {
  const text = withMinimal({ agents: [{ name: 'A', persona: 'anything', brain: 'whatever' }] })
  assert.equal(parseExperiment(text).agents[0].brain, 'whatever')
})

test('the shipped examples pass the strict rules', () => {
  const conclave = readFileSync(new URL('../../../examples/conclave.jsonc', import.meta.url), 'utf8')
  assert.doesNotThrow(() => parseExperiment(conclave))
  const jsonl = readFileSync(new URL('../../../examples/personas.jsonl', import.meta.url), 'utf8')
  assert.doesNotThrow(() => parseExperiments(jsonl, true))
})

// --- examples in prose are part of the contract ---

test('every experiment example in the docs and the in-app sample validates', async () => {
  // Strict keys mean a stale example now fails for the new user who copies it, which
  // is exactly who reads them. Anything fenced as json/jsonc that has an "agents"
  // array is an experiment file.
  const { adapterIds } = await import('../adapters/registry.ts')
  const { ALL_PERSONAS } = await import('../deliberation/personas.ts')
  const known = { brains: adapterIds(), personas: ALL_PERSONAS.map(p => p.key) }

  const files = ['README.md', 'docs/manual.md', 'docs/other-platforms.md']
  const found: string[] = []
  for (const f of files) {
    const text = readFileSync(new URL(`../../../${f}`, import.meta.url), 'utf8')
    for (const m of text.matchAll(/```(?:jsonc?|json5)\n([\s\S]*?)```/g)) {
      if (/"agents"\s*:/.test(m[1])) found.push(`${f}: ${m[1].slice(0, 40).trim()}…`)
      if (/"agents"\s*:/.test(m[1])) {
        assert.doesNotThrow(() => parseExperiment(m[1], known), `${f} has an experiment example that no longer validates`)
      }
    }
  }

  const sample = readFileSync(new URL('../../../web/src/components/LoadExperiment.tsx', import.meta.url), 'utf8')
  const lit = sample.match(/const SAMPLE = `([\s\S]*?)`/)
  assert.ok(lit, 'the in-app sample moved; update this test')
  assert.doesNotThrow(() => parseExperiment(lit![1].replace(/…/g, 'x'), known), 'the in-app sample no longer validates')
  assert.ok(found.length >= 1, 'no experiment example found in the docs; the scan itself may be broken')
})
