/**
 * How the page finds and presents the daemon's token.
 *
 * The page cannot be unit-tested, so the two decisions that matter are pure:
 * where a token comes from, and how it is attached to a URL. Getting the second
 * wrong blanks the packaged app, so the awkward cases are the ones listed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendToken, tokenFromHash } from './api.ts'

test('no token leaves a URL alone', () => {
  assert.equal(appendToken('http://127.0.0.1:8787/api/x', null), 'http://127.0.0.1:8787/api/x')
  assert.equal(appendToken('/api/x', ''), '/api/x')
})

test('a token becomes the first query parameter on a bare path', () => {
  assert.equal(appendToken('/api/x', 'abc'), '/api/x?token=abc')
})

test('a token is appended with & when the URL already has a query', () => {
  assert.equal(appendToken('/api/rooms/1/export?format=markdown', 'abc'), '/api/rooms/1/export?format=markdown&token=abc')
})

test('a token is encoded, so a value with reserved characters cannot break the URL', () => {
  assert.equal(appendToken('/api/x', 'a b&c=d#e'), '/api/x?token=a%20b%26c%3Dd%23e')
})

test('an existing token parameter is replaced rather than duplicated', () => {
  assert.equal(appendToken('/api/x?token=old&a=1', 'new'), '/api/x?a=1&token=new')
})

test('a WebSocket URL takes the token the same way', () => {
  assert.equal(appendToken('ws://127.0.0.1:8787/ws', 'abc'), 'ws://127.0.0.1:8787/ws?token=abc')
})

test('the token is read out of a URL fragment', () => {
  assert.equal(tokenFromHash('#token=abc123'), 'abc123')
  assert.equal(tokenFromHash('#a=1&token=abc123&b=2'), 'abc123')
  assert.equal(tokenFromHash('#token=a%20b'), 'a b')
})

test('no fragment, or none with a token, yields nothing', () => {
  assert.equal(tokenFromHash(''), null)
  assert.equal(tokenFromHash('#section-3'), null)
  assert.equal(tokenFromHash('#token='), null)
})

test('a malformed fragment does not throw', () => {
  assert.doesNotThrow(() => tokenFromHash('#token=%E0%A4%A'))
})
