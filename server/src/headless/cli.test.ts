/**
 * The command line, as a stranger meets it: run the real entry point and look at
 * the exit code, because that is the contract scripts and CI depend on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = (...args: string[]) => spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'server/src/headless/cli.ts', ...args],
  { encoding: 'utf8', env: { ...process.env, ROUNDSTORM_DATA: mkdtempSync(join(tmpdir(), 'rs-cli-')) } })

test('--help prints usage and succeeds', () => {
  const r = run('--help')
  assert.equal(r.status, 0, '--help exited non-zero, which fails `cmd --help && next`')
  assert.match(r.stdout, /run a deliberation from a config file/)
})

test('-h is the same', () => {
  assert.equal(run('-h').status, 0)
})

test('an unknown option is a usage error', () => {
  const r = run('--nonsense', 'examples/conclave.jsonc')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /unknown option/)
})

test('a missing file is a usage error, not a crash', () => {
  const r = run('definitely-not-here.jsonc')
  assert.equal(r.status, 1)
})

test('--dry-run validates a shipped example without running anything', () => {
  // The example files are the first thing a new user copies, and a dry run is how
  // they find out whether theirs parses. It must never reach a brain.
  const r = run('examples/conclave.jsonc', '--dry-run')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /conclave, 5 rounds/)
})

test('an invalid config exits 1 and names the problem', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-cli-cfg-'))
  const bad = join(dir, 'bad.jsonc')
  writeFileSync(bad, '{ "question": "q", "agents": [] }')
  const r = run(bad, '--dry-run')
  assert.equal(r.status, 1)
  assert.ok(r.stderr.length > 0, 'a rejected config said nothing')
})
