/**
 * The rule that decides whether a request is this app or a website.
 *
 * Pure predicates, so the risky part is assertable without a browser. The cases
 * that matter are the denials: each one was reachable before this existed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hostAllowed, originAllowed, requestAllowed } from './origin.ts'

const LOOPBACK = '127.0.0.1:8787'

// --- what must keep working ---

test('the packaged app is allowed on every platform Tauri targets', () => {
  for (const o of ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']) {
    assert.equal(originAllowed(o, LOOPBACK), true, o)
  }
})

test('the dev server is allowed under either spelling of loopback', () => {
  assert.equal(originAllowed('http://localhost:5273', 'localhost:5273'), true)
  assert.equal(originAllowed('http://127.0.0.1:5273', '127.0.0.1:5273'), true)
})

test('a request with no Origin is allowed: that is curl and the CLI', () => {
  // The README documents driving the daemon over HTTP, and a browser always
  // sends Origin on a cross-origin fetch. The no-Origin requests it does make are
  // GETs whose responses it cannot read.
  assert.equal(originAllowed(undefined, LOOPBACK), true)
  assert.equal(originAllowed('', LOOPBACK), true)
})

test('a LAN user reaching the daemon it is serving from is same-origin', () => {
  // ROUNDSTORM_HOST=0.0.0.0 is documented and warned about. The daemon serves its
  // own UI there, so the browser's Origin matches the Host it typed.
  assert.equal(requestAllowed('http://192.168.1.5:8787', '192.168.1.5:8787'), true)
})

test('an explicitly configured origin is allowed', () => {
  process.env.ROUNDSTORM_ALLOWED_ORIGINS = 'https://my-thing.example'
  try {
    assert.equal(originAllowed('https://my-thing.example', LOOPBACK), true)
  } finally {
    delete process.env.ROUNDSTORM_ALLOWED_ORIGINS
  }
})

// --- what must not ---

test('a website is refused', () => {
  assert.equal(originAllowed('https://evil.example', LOOPBACK), false)
  assert.equal(originAllowed('http://evil.example', LOOPBACK), false)
})

test('the literal string null is refused', () => {
  // A sandboxed iframe or a data: URL serialises its origin as "null", and an
  // attacker page can produce one at will. Treating it as "no browser" would
  // reopen the hole through the front door.
  assert.equal(originAllowed('null', LOOPBACK), false)
})

test('a subdomain of localhost is refused', () => {
  // Chrome resolves *.localhost to loopback, so a suffix match would be free.
  assert.equal(originAllowed('http://evil.localhost', LOOPBACK), false)
  assert.equal(hostAllowed('evil.localhost'), false)
})

test('an origin that merely contains an allowed one is refused', () => {
  assert.equal(originAllowed('http://tauri.localhost.evil.com', LOOPBACK), false)
  assert.equal(originAllowed('https://evil.com/?tauri://localhost', LOOPBACK), false)
})

test('a rebound name is refused by the Host check', () => {
  // DNS rebinding makes the page same-origin by the browser's reckoning, so no
  // origin rule can catch it. Rebinding needs a name; names are what we refuse.
  assert.equal(hostAllowed('evil.com'), false)
  assert.equal(requestAllowed('http://evil.com', 'evil.com'), false,
    'a rebound host passed because origin and host matched each other')
})

test('a missing Host is refused', () => {
  assert.equal(hostAllowed(undefined), false)
  assert.equal(hostAllowed(''), false)
})

// --- host shapes ---

test('IP literals and exact localhost are accepted as hosts', () => {
  for (const h of ['127.0.0.1:8787', '127.0.0.1', 'localhost', 'localhost:8787',
                   '[::1]:8787', '192.168.1.5:8787']) {
    assert.equal(hostAllowed(h), true, h)
  }
})

test('the host check ignores case and surrounding space', () => {
  assert.equal(hostAllowed('  LOCALHOST:8787 '), true)
})
