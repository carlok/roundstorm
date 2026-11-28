import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adapterIds, BRAIN_CACHE_MS, probeBrains, registerAdapter, schemaFor } from './registry.ts'
import { TURN_SCHEMA } from '../deliberation/contract.ts'
import type { BrainAdapter } from './types.ts'

const fake = (over: Partial<BrainAdapter>): BrainAdapter => ({
  id: 'x', label: 'X', kind: 'cli', schemaEnforced: true, supportsSystemPrompt: true,
  available: async () => true, listModels: async () => [],
  run: () => { throw new Error('unused') },
  ...over,
})

test('the brain list is cached until the expiry boundary', async (t) => {
  const ids = adapterIds()
  const primary = ids[0]!
  let probes = 0
  const restore = ids.map(id => registerAdapter(fake({
    id,
    available: async () => id === primary,
    listModels: async () => {
      probes += 1
      return [{ id: `model-${probes}`, label: `Model ${probes}` }]
    },
  })))
  t.after(() => restore.reverse().forEach(undo => undo()))

  const first = await probeBrains(false, 1000)
  const cached = await probeBrains(false, 1000 + BRAIN_CACHE_MS - 1)
  assert.strictEqual(cached, first)
  assert.equal(probes, 1)
  assert.deepEqual(first.find(brain => brain.id === primary)?.models.map(model => model.id), ['model-1'])

  const refreshed = await probeBrains(false, 1000 + BRAIN_CACHE_MS)
  assert.equal(probes, 2)
  assert.deepEqual(refreshed.find(brain => brain.id === primary)?.models.map(model => model.id), ['model-2'])
})

test('the default dialect is the schema untouched', () => {
  assert.deepEqual(schemaFor(fake({}), TURN_SCHEMA), TURN_SCHEMA)
})

test('relaxed dialect drops additionalProperties everywhere (agy appends its own keys)', () => {
  const s = JSON.stringify(schemaFor(fake({ relaxedSchema: true }), TURN_SCHEMA))
  assert.ok(!s.includes('additionalProperties'))
  assert.ok(s.includes('"stance"'))
})

test('strict dialect makes every property required and closes every object', () => {
  // OpenAI strict mode rejects optional properties outright; codex 400s and the
  // agent silently misses the round.
  const s = schemaFor(fake({ strictSchema: true }), TURN_SCHEMA) as any
  // The contract has grown (position_ops, memory); assert the invariant, which
  // is that EVERY declared property is required, not a frozen list.
  assert.deepEqual(s.required.sort(), Object.keys(s.properties).sort())
  assert.equal(s.additionalProperties, false)
  const item = s.properties.claims.items
  assert.deepEqual(item.required.sort(), ['basis', 'confidence', 'refs', 'text'])
  assert.equal(item.additionalProperties, false)
})

test('strict dialect leaves non-object nodes alone', () => {
  const s = schemaFor(fake({ strictSchema: true }), TURN_SCHEMA) as any
  assert.equal(s.properties.stance.type, 'string')
  assert.ok(Array.isArray(s.properties.stance.enum))
})
