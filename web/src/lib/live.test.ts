import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roundLine, runCost, standingLine } from './live.ts'
import type { Message } from '../types.ts'

const standing = (backers: string[], holdouts: string[]) => ({
  positions: [], leading: null, level: 'consensus_with_reservations' as const, headline: '',
  standing: { label: 'P2', version: 3, title: 'Oil whip', backers, holdouts, n: backers.length + holdouts.length },
})

test('the standing line names the leader, its version and who holds out', () => {
  assert.equal(standingLine(standing(['A', 'B', 'C'], ['Bruno']), 'deliberation'),
    'P2 v3 · Oil whip · 3 of 4 back it · holding out: Bruno')
  assert.equal(standingLine(standing(['A', 'B'], []), 'deliberation'), 'P2 v3 · Oil whip · 2 of 2 back it')
})

test('a conclave line counts endorsements of the current version', () => {
  assert.match(standingLine(standing(['A'], ['B']), 'conclave')!, /1 of 2 endorse this version/)
})

test('many holdouts are shortened, and nothing on the record is no line at all', () => {
  assert.match(standingLine(standing([], ['A', 'B', 'C', 'D', 'E']), 'deliberation')!, /holding out: A, B, C \+2$/)
  assert.equal(standingLine(null, 'deliberation'), null)
  assert.equal(standingLine({ ...standing([], []), standing: null }, 'deliberation'), null)
})

test('a conclave states its cap, other modes their round count', () => {
  assert.equal(roundLine({ mode: 'conclave', rounds: 3, currentRound: 2 }), 'Round 2 of at most 4')
  assert.equal(roundLine({ mode: 'deliberation', rounds: 5, currentRound: 0 }), 'Round 1 of 5')
})

const m = (deliberationId: string, costUsd: number | null, authorType: Message['authorType'] = 'agent') =>
  ({ deliberationId, costUsd, authorType }) as Message

test('run cost counts only this run\'s agent turns, and says when it is a floor', () => {
  assert.equal(runCost([m('d1', 0.01), m('d1', 0.02), m('d2', 5)], 'd1'), '$0.030')
  assert.equal(runCost([m('d1', 0.01), m('d1', null)], 'd1'), 'at least $0.010 (1 of 2 turns priced)')
  assert.equal(runCost([m('d1', null)], 'd1'), 'n/a')
  assert.equal(runCost([m('d1', 9, 'human')], 'd1'), 'n/a')
})
