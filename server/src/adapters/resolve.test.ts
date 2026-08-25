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

// --- streamProcess: the two ways a spawn silently loses its way ---

test('a spawned CLI is launched by absolute path, not by name', async () => {
  // A Finder-launched app inherits `/usr/bin:/bin:/usr/sbin:/sbin`. Spawning a
  // bare name there is ENOENT, and the agent just never speaks.
  const { streamProcess } = await import('./spawn.ts')
  const real = process.env.PATH
  const events: string[] = []
  try {
    process.env.PATH = '/nonexistent'
    for await (const e of streamProcess('sh', ['-c', 'echo {}'], new AbortController().signal, {
      onLine: () => {},
      onClose: (code, _err, push) => push({ type: 'activity', text: `closed ${code}` }),
    })) {
      events.push(e.type === 'error' ? `error:${e.message}` : e.type)
    }
  } finally {
    process.env.PATH = real
  }
  assert.ok(!events.some(e => e.startsWith('error:')),
    `sh should still resolve from the standard locations: ${events.join(', ')}`)
})

test('an adapter-supplied env is merged, never substituted', async () => {
  // codex passes CODEX_HOME. If that replaced the environment the child would
  // have no PATH at all — which is exactly how a conclave lost a participant for
  // five straight rounds while reporting it as a failure to reach consensus.
  const { streamProcess } = await import('./spawn.ts')
  let seen = ''
  for await (const e of streamProcess(
    'sh', ['-c', 'echo "$MARKER|$PATH"'], new AbortController().signal, {
      env: { MARKER: 'supplied' },
      onLine: () => {},
      onClose: (_c, _e, push) => push({ type: 'activity', text: 'done' }),
    })) {
    if (e.type === 'delta') seen = e.text
  }
  // stdout is parsed as NDJSON by onLine, so read it from the raw handler instead.
  const out: string[] = []
  for await (const e of streamProcess(
    'sh', ['-c', 'printf %s\\\\n "{\\"marker\\":\\"$MARKER\\",\\"haspath\\":\\"$PATH\\"}"'],
    new AbortController().signal, {
      env: { MARKER: 'supplied' },
      onLine: (line) => out.push(JSON.stringify(line)),
      onClose: (_c, _e, push) => push({ type: 'activity', text: 'done' }),
    })) { /* drain */ }

  const parsed = JSON.parse(out[0] ?? '{}')
  assert.equal(parsed.marker, 'supplied', 'the supplied variable did not reach the child')
  assert.ok(parsed.haspath && parsed.haspath.length > 0,
    'the child lost PATH: the supplied env replaced the environment instead of extending it')
  assert.ok(seen === '' || typeof seen === 'string')
})
