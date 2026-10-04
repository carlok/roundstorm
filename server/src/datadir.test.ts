/**
 * Where the research is stored, per platform.
 *
 * Asserted by passing the platform in rather than by running on it: these are the
 * branches a Linux or Windows user would take, and getting them wrong is the kind
 * of bug that *works* — the data lands somewhere real, just somewhere no backup
 * tool or user would ever look.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// db.ts opens a database at import time. Point it somewhere disposable, or this
// test file touches the user's real store — and fails outright if the app is
// running and holding it.
process.env.ROUNDSTORM_DATA = mkdtempSync(join(tmpdir(), 'rs-datadir-'))

const { defaultDataDirFor } = await import('./db.ts')

test('macOS uses Application Support', () => {
  assert.equal(
    defaultDataDirFor('darwin', '/Users/alice'),
    '/Users/alice/Library/Application Support/Roundstorm')
})

test('Linux follows XDG, and honours XDG_DATA_HOME when set', () => {
  assert.equal(
    defaultDataDirFor('linux', '/home/alice'),
    '/home/alice/.local/share/roundstorm')
  assert.equal(
    defaultDataDirFor('linux', '/home/alice', { XDG_DATA_HOME: '/data/xdg' }),
    '/data/xdg/roundstorm')
})

test('Windows uses APPDATA, with a sane fallback if it is unset', () => {
  assert.match(
    defaultDataDirFor('win32', 'C:\\Users\\alice', { APPDATA: 'C:\\Users\\alice\\AppData\\Roaming' }),
    /AppData[\\/]Roaming[\\/]Roundstorm$/)
  assert.match(
    defaultDataDirFor('win32', 'C:\\Users\\alice'),
    /AppData[\\/]Roaming[\\/]Roundstorm$/)
})

test('no platform reuses the macOS convention', () => {
  // Creating a literal ~/Library/Application Support on Linux would "work",
  // which is exactly why it has to be asserted against.
  for (const p of ['linux', 'win32', 'freebsd'] as NodeJS.Platform[]) {
    assert.ok(!defaultDataDirFor(p, '/home/x').includes('Application Support'),
      `${p} fell through to the macOS path`)
  }
})

test('an unknown platform gets the XDG layout rather than throwing', () => {
  assert.equal(defaultDataDirFor('freebsd', '/home/x'), '/home/x/.local/share/roundstorm')
})
