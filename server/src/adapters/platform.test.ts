/**
 * Windows behaviour, asserted from a Mac.
 *
 * Every rule here is invisible on the platform it is written on, which is how
 * this project has repeatedly shipped bugs that only appear elsewhere. Passing
 * the platform in makes them testable now rather than on someone else's machine.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  binaryCandidates, checkCommandLine, commandLineLimit, executableSuffixes,
  needsShell, searchDirs, versionBinSubdirs, versionManagerRoots,
} from './platform.ts'

// --- finding the binary at all ---

test('a bare name is not a filename on Windows', () => {
  // `claude` is claude.cmd, `codex` is codex.exe. Looking for an extensionless
  // file finds neither, and every brain reports itself missing.
  const win = binaryCandidates('claude', 'win32', '.COM;.EXE;.BAT;.CMD')
  assert.ok(win.includes('claude.exe'))
  assert.ok(win.includes('claude.cmd'))
  assert.ok(!win.includes('claude'))
})

test('unix looks for the bare name and nothing else', () => {
  assert.deepEqual(binaryCandidates('claude', 'darwin'), ['claude'])
  assert.deepEqual(binaryCandidates('claude', 'linux'), ['claude'])
})

test('a real executable is preferred over a shim', () => {
  // Not cosmetic: a .exe spawns directly, which skips cmd.exe quoting and
  // raises the command-line ceiling from 8 KB to 32 KB.
  const order = executableSuffixes('win32', '.COM;.EXE;.BAT;.CMD')
  assert.ok(order.indexOf('.exe') < order.indexOf('.cmd'), order.join(','))
})

test('PATHEXT is honoured, including unusual entries', () => {
  const s = executableSuffixes('win32', '.EXE;.PS1;.CMD')
  assert.ok(s.includes('.ps1'))
  assert.ok(s.includes('.exe'))
})

test('a missing PATHEXT falls back to the Windows default', () => {
  const s = executableSuffixes('win32', undefined)
  for (const e of ['.exe', '.cmd', '.bat']) assert.ok(s.includes(e), `missing ${e}`)
})

// --- launching it ---

test('npm shims need a shell; native executables do not', () => {
  assert.equal(needsShell('C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd', 'win32'), true)
  assert.equal(needsShell('C:\\tools\\codex.exe', 'win32'), false)
  // Same filename on Unix must never be routed through a shell.
  assert.equal(needsShell('/usr/local/bin/claude.cmd', 'darwin'), false)
})

test('extension matching is case-insensitive', () => {
  assert.equal(needsShell('C:\\x\\CLAUDE.CMD', 'win32'), true)
})

// --- the command-line ceiling ---

test('unix has no practical command-line limit', () => {
  assert.equal(commandLineLimit('darwin', false), Number.POSITIVE_INFINITY)
  assert.equal(commandLineLimit('linux', true), Number.POSITIVE_INFINITY)
})

test('Windows caps the command line, and a shim caps it harder', () => {
  assert.equal(commandLineLimit('win32', false), 32767)
  assert.equal(commandLineLimit('win32', true), 8191)
})

test('an oversized prompt is refused with an explanation, not a spawn error', () => {
  // A five-round transcript passed as argv will exceed this. Windows would fail
  // with something naming neither the cause nor which agent produced it.
  const huge = 'x'.repeat(20_000)
  const viaShim = checkCommandLine('claude.cmd', ['-p', huge], 'win32', true)
  assert.equal(viaShim.ok, false)
  assert.match(viaShim.message!, /too long/i)
  assert.match(viaShim.message!, /8191/)

  // The same prompt fits when the brain is a native executable.
  assert.equal(checkCommandLine('codex.exe', ['-p', huge], 'win32', false).ok, true)
  // And is never a problem on Unix.
  assert.equal(checkCommandLine('claude', ['-p', huge], 'darwin', false).ok, true)
})

test('a normal prompt passes on every platform', () => {
  const normal = 'Is this oil whip or a hardening nonlinearity?'.repeat(20)
  for (const p of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
    assert.equal(checkCommandLine('claude', ['-p', normal], p, false).ok, true, `failed on ${p}`)
  }
})

// --- where to look ---

test('Windows search covers npm globals and the version managers', () => {
  const dirs = searchDirs('win32', 'C:\\Users\\alice', {
    PATH: 'C:\\Windows\\System32',
    APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
  })
  assert.ok(dirs.some(d => d.endsWith('Roaming\\npm')), 'npm global shims not searched')
  assert.ok(dirs.some(d => d.includes('WindowsApps')))
  assert.ok(dirs.includes('C:\\Windows\\System32'), 'PATH entries dropped')
  // Homebrew and /usr/bin are meaningless there.
  assert.ok(!dirs.some(d => d.includes('homebrew')))
})

test('Windows reads Path when PATH is absent', () => {
  const dirs = searchDirs('win32', 'C:\\Users\\x', { Path: 'C:\\Windows' })
  assert.ok(dirs.includes('C:\\Windows'))
})

test('unix search keeps the locations these CLIs actually install to', () => {
  const dirs = searchDirs('linux', '/home/alice', { PATH: '/usr/bin' })
  assert.ok(dirs.some(d => d.endsWith('/.local/bin')), 'agy, codex and cursor-agent live here')
  assert.ok(dirs.includes('/usr/bin'))
})

test('version managers are looked up per platform', () => {
  const win = versionManagerRoots('win32', 'C:\\Users\\x', { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' })
  assert.ok(win.some(d => d.toLowerCase().includes('nvm')))
  const unix = versionManagerRoots('linux', '/home/x', {})
  assert.ok(unix.some(d => d.includes('.nvm/versions/node')))
})

test('nvm-windows puts binaries in the version root, nvm-posix in bin', () => {
  // Getting this backwards finds nothing on either.
  assert.ok(versionBinSubdirs('win32').includes(''))
  assert.ok(versionBinSubdirs('darwin').includes('bin'))
})
