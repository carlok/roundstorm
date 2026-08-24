/**
 * The packaged app gets `/usr/bin:/bin:/usr/sbin:/sbin` from Finder and nothing
 * else. Every brain lived outside that, so `spawn('claude')` returned ENOENT and
 * every agent failed its round while the brain list still showed a tick.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { delimiter } from 'node:path'
import { enrichedPath, resolveBin } from './resolve.ts'

test('a CLI is found even with a Finder-style stub PATH', () => {
  const real = process.env.PATH
  try {
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
    // `sh` lives in /bin, so it must resolve from the stub PATH alone.
    assert.ok(resolveBin('sh')?.endsWith('/sh'))
  } finally {
    process.env.PATH = real
  }
})

test('resolution returns an absolute path, never a bare name', () => {
  const p = resolveBin('sh')
  assert.ok(p && p.startsWith('/'), `got ${p}`)
})

test('something genuinely absent resolves to null rather than a guess', () => {
  assert.equal(resolveBin('definitely-not-a-real-binary-xyzzy'), null)
})

test('the enriched PATH covers the locations these tools actually install to', () => {
  const dirs = enrichedPath().split(delimiter)
  // ~/.local/bin holds agy, codex and cursor-agent on this machine; nvm holds claude.
  assert.ok(dirs.some(d => d.endsWith('/.local/bin')), 'missing ~/.local/bin')
  assert.ok(dirs.some(d => d.includes('/.nvm/versions/node/')), 'missing nvm bins')
  assert.ok(dirs.includes('/opt/homebrew/bin'))
})

test('the enriched PATH has no duplicates', () => {
  const dirs = enrichedPath().split(delimiter)
  assert.equal(dirs.length, new Set(dirs).size)
})
