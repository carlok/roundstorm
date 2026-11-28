import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backgroundNotice, unseenAfter } from './rooms.ts'

const rooms = [{ id: 'r1', name: 'Sensor choice' }]

test('a run elsewhere is announced with its room and outcome', () => {
  assert.equal(backgroundNotice(rooms, 'r1', { level: 'strong_consensus' }), 'Finished in “Sensor choice”: Strong consensus')
  assert.equal(backgroundNotice(rooms, 'r1', { status: 'stopped' }), 'The run in “Sensor choice” was stopped')
  assert.match(backgroundNotice(rooms, 'r1', { status: 'failed' })!, /failed/)
  assert.equal(backgroundNotice(rooms, 'r1', { status: 'complete' }), null, 'a completed run speaks through its result')
  assert.equal(backgroundNotice(rooms, 'nope', { level: 'strong_consensus' }), null)
})

test('only growth while scrolled up counts as new', () => {
  assert.equal(unseenAfter(10, 13, 0, false), 3)
  assert.equal(unseenAfter(13, 14, 3, false), 4)
  assert.equal(unseenAfter(14, 14, 4, false), 4, 'an in-place update is not new')
  assert.equal(unseenAfter(14, 16, 4, true), 0, 'at the bottom there is nothing unseen')
  assert.equal(unseenAfter(16, 2, 6, false), 0, 'a room switch resets it')
})
