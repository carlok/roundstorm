/**
 * The command line, as a stranger meets it: run the real entry point and look at
 * the exit code, because that is the contract scripts and CI depend on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

/** These drive `sh` and Unix paths. Windows is covered by the pure functions in platform.test.ts (see #37). */
const UNIX_ONLY = { skip: process.platform === 'win32' ? 'needs sh and Unix paths' : false }

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
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

// --- Ctrl-C ---

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const until = async (what: string, ok: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 50))
  }
}

test('Ctrl-C ends a run in flight: exit 130, nothing left running, no brain process left', UNIX_ONLY, async () => {
  // Wired by reading the code only, until now: it needs a deliberation in flight.
  // The fixture gives the CLI a brain that starts a process and never answers.
  const dir = mkdtempSync(join(tmpdir(), 'rs-sigint-'))
  const pidFile = join(dir, 'brain.pid')
  const cfg = join(dir, 'exp.jsonc')
  writeFileSync(cfg, JSON.stringify({
    room: { name: 'Hung', tier: 'reasoning' },
    agents: [{ name: 'Alice', persona: 'skeptic', brain: 'claude' }],
    question: 'Will this ever answer?', rounds: 1,
  }))

  const cli = spawn(process.execPath, [
    '--experimental-strip-types', '--disable-warning=ExperimentalWarning',
    '--import', './server/src/headless/hang-brain.fixture.ts',
    'server/src/headless/cli.ts', cfg,
  ], { env: { ...process.env, ROUNDSTORM_DATA: dir, FIXTURE_PIDFILE: pidFile }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  cli.stderr.on('data', d => { stderr += d })
  const exited = new Promise<number | null>(resolve => cli.once('exit', code => resolve(code)))

  try {
    await until('the brain to start', () => existsSync(pidFile))
    const brainPid = Number(readFileSync(pidFile, 'utf8'))
    assert.ok(alive(brainPid), 'the fixture brain process did not start')

    cli.kill('SIGINT')
    const code = await Promise.race([
      exited,
      new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 20_000)),
    ])
    assert.equal(code, 130, `expected exit 130, got ${code}\n${stderr}`)
    assert.match(stderr, /interrupted: stopped \d+ deliberation/)

    await until('the brain process to end', () => !alive(brainPid), 5_000)

    const store = new DatabaseSync(join(dir, 'roundstorm.db'), { readOnly: true })
    const rows = store.prepare('SELECT status FROM deliberations').all() as { status: string }[]
    store.close()
    assert.equal(rows.length, 1)
    assert.ok(!['running', 'stopping'].includes(rows[0].status),
      `the deliberation was left "${rows[0].status}" in the store`)
  } finally {
    if (cli.exitCode === null) cli.kill('SIGKILL')
  }
})

// --- listing, overrides and the full transcript (#89) ---

test('--list-brains and --list-personas print what a config may name, and need no file', () => {
  const brains = run('--list-brains')
  assert.equal(brains.status, 0)
  assert.ok(brains.stdout.split('\n').includes('claude'))
  const personas = run('--list-personas')
  assert.equal(personas.status, 0)
  assert.match(personas.stdout, /^skeptic\s+/m)
})

test('--rounds overrides the config, and refuses nonsense', () => {
  const r = run('--dry-run', '--rounds', '1', 'examples/conclave.jsonc')
  assert.equal(r.status, 0)
  assert.match(r.stdout, /, 1 rounds,/)
  for (const bad of ['0', '21', '2.5', 'lots']) {
    const b = run('--rounds', bad, 'examples/conclave.jsonc')
    assert.equal(b.status, 1, `--rounds ${bad} was accepted`)
    assert.match(b.stderr, /--rounds must be/)
  }
})

test('--transcript adds the whole discussion to the result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-transcript-'))
  const cfg = join(dir, 'exp.jsonc')
  writeFileSync(cfg, JSON.stringify({
    room: { name: 'Transcript room', tier: 'reasoning' },
    agents: [{ name: 'Alice', persona: 'skeptic', brain: 'claude' }],
    question: 'Will the whole discussion come out?', rounds: 3,
  }))
  const r = spawnSync(process.execPath, [
    '--experimental-strip-types', '--disable-warning=ExperimentalWarning',
    '--import', './server/src/headless/answer-brain.fixture.ts',
    'server/src/headless/cli.ts', cfg, '--rounds', '2', '--transcript', '--quiet',
  ], { encoding: 'utf8', env: { ...process.env, ROUNDSTORM_DATA: dir } })
  // 2 is "no reliable conclusion": the stub records no positions. 3 would be a broken run.
  assert.ok(r.status === 0 || r.status === 2, `exit ${r.status}: ${r.stderr}`)
  assert.ok(r.stdout.includes('FIXTURE-TURN-1') && r.stdout.includes('FIXTURE-TURN-2'), 'the turns are missing')
  assert.ok(!r.stdout.includes('FIXTURE-TURN-3'), '--rounds 2 did not override rounds: 3')
  assert.match(r.stdout, /Will the whole discussion come out\?/)
})
