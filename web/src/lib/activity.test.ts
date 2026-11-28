import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityFacets, filterActivity, NO_FILTER } from './activity.ts'
import type { LogEntry } from '../types.ts'

const e = (id: number, type: string, agentId: string | null, round?: number): LogEntry =>
  ({ id, ts: id, type, roomId: 'r', deliberationId: 'd', agentId, payload: round === undefined ? null : { round } })

const log = [
  e(1, 'turn.started', 'a1', 1), e(2, 'turn.completed', 'a1', 1), e(3, 'turn.started', 'a2', 1),
  e(4, 'tool.used', 'a2', 2), e(5, 'round.revealed', null, 1), e(6, 'room.cleared', null),
]

test('facets list what the log holds, in a stable order', () => {
  assert.deepEqual(activityFacets(log), {
    types: ['room.cleared', 'round.revealed', 'tool.used', 'turn.completed', 'turn.started'],
    rounds: [1, 2],
    agentIds: ['a1', 'a2'],
  })
})

test('filters combine, and an empty filter keeps everything', () => {
  assert.equal(filterActivity(log, NO_FILTER).length, log.length)
  assert.deepEqual(filterActivity(log, { ...NO_FILTER, agentId: 'a1' }).map(x => x.id), [1, 2])
  assert.deepEqual(filterActivity(log, { ...NO_FILTER, round: '1', type: 'turn.started' }).map(x => x.id), [1, 3])
  assert.deepEqual(filterActivity(log, { ...NO_FILTER, round: '2' }).map(x => x.id), [4])
})
