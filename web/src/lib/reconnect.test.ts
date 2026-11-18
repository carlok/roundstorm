import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconnectDelay } from './reconnect.ts'

test('reconnects back off from 1.5 s and stop growing at 10 s', () => {
  assert.deepEqual([0, 1, 2, 3, 10].map(reconnectDelay), [1_500, 3_000, 6_000, 10_000, 10_000])
  assert.equal(reconnectDelay(-1), 1_500)
})
