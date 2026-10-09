/**
 * The bearer token: what it accepts, and that it does not throw on the way to
 * refusing.
 *
 * `crypto.timingSafeEqual` throws on buffers of different length, so the obvious
 * implementation turns a short wrong token into a 500 instead of a 401 — and a
 * 500 is also a timing oracle for the length. The length mismatch cases below are
 * the point of this file.
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { tokenFrom, tokenOk, tokenRequired } from './auth.ts'

beforeEach(() => { process.env.ROUNDSTORM_TOKEN = 'correct-horse-battery' })
afterEach(() => { delete process.env.ROUNDSTORM_TOKEN })

test('without a configured token nothing is enforced', () => {
  delete process.env.ROUNDSTORM_TOKEN
  assert.equal(tokenRequired(), false)
  assert.equal(tokenOk(undefined), true)
  assert.equal(tokenOk('anything'), true)
})

test('a blank configured token is treated as none, not as "the empty string"', () => {
  process.env.ROUNDSTORM_TOKEN = '   '
  assert.equal(tokenRequired(), false)
  assert.equal(tokenOk(undefined), true)
})

test('the right token is accepted, and only the right one', () => {
  assert.equal(tokenRequired(), true)
  assert.equal(tokenOk('correct-horse-battery'), true)
  assert.equal(tokenOk('correct-horse-batterY'), false)
  assert.equal(tokenOk(undefined), false)
  assert.equal(tokenOk(''), false)
})

test('a token of the wrong length is refused rather than thrown on', () => {
  for (const wrong of ['x', 'correct-horse', 'correct-horse-battery-staple', 'a'.repeat(5000)]) {
    assert.doesNotThrow(() => tokenOk(wrong))
    assert.equal(tokenOk(wrong), false, wrong.slice(0, 20))
  }
})

test('a multi-byte token is compared as bytes, not characters', () => {
  // Same string length, different byte length: a length check on .length would pass
  // it through to timingSafeEqual, which throws.
  process.env.ROUNDSTORM_TOKEN = 'abcdef'
  assert.doesNotThrow(() => tokenOk('ééé'))
  assert.equal(tokenOk('ééé'), false)
})

test('the token is read from an Authorization: Bearer header', () => {
  assert.equal(tokenFrom('Bearer abc123', '/api/x'), 'abc123')
  assert.equal(tokenFrom('bearer abc123', '/api/x'), 'abc123')
  assert.equal(tokenFrom('Basic abc123', '/api/x'), undefined, 'a different scheme is not a bearer token')
})

test('the token is read from the query string, where a link or a WebSocket cannot set a header', () => {
  assert.equal(tokenFrom(undefined, '/api/rooms/1/export?format=markdown&token=abc%20123'), 'abc 123')
  assert.equal(tokenFrom(undefined, '/ws?token=abc'), 'abc')
  assert.equal(tokenFrom(undefined, '/api/x'), undefined)
})

test('a header wins over the query when both are present', () => {
  assert.equal(tokenFrom('Bearer fromheader', '/x?token=fromquery'), 'fromheader')
})

test('a malformed URL does not throw', () => {
  assert.doesNotThrow(() => tokenFrom(undefined, 'http://[::bad'))
  assert.equal(tokenFrom(undefined, undefined), undefined)
})
