import { test } from 'node:test'
import assert from 'node:assert/strict'
import { schemaFor } from './registry.ts'
import { TURN_SCHEMA } from '../deliberation/contract.ts'
import type { BrainAdapter } from './types.ts'

const fake = (over: Partial<BrainAdapter>): BrainAdapter => ({
  id: 'x', label: 'X', kind: 'cli', schemaEnforced: true, supportsSystemPrompt: true,
  available: async () => true, listModels: async () => [],
  run: () => { throw new Error('unused') },
  ...over,
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
