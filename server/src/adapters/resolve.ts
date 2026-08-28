/**
 * Find CLI brains by absolute path.
 *
 * Relying on PATH is the bug. A GUI app launched from Finder inherits
 * `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else — no nvm, no `~/.local/bin`,
 * no Homebrew — so `spawn('claude')` dies with ENOENT while working perfectly
 * from a terminal. Resolve once, cache, and spawn the absolute path.
 *
 * On Windows there is a second half to the same problem: a bare name is not a
 * filename. `claude` is `claude.cmd`, `codex` is `codex.exe`, and which suffixes
 * count is whatever PATHEXT says.
 */
import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { binaryCandidates, searchDirs, versionBinSubdirs, versionManagerRoots } from './platform.ts'

const cache = new Map<string, string | null>()

function allSearchDirs(): string[] {
  const home = homedir()
  const dirs = searchDirs(process.platform, home, process.env)
  for (const base of versionManagerRoots(process.platform, home, process.env)) {
    try {
      for (const entry of readdirSync(base)) {
        for (const sub of versionBinSubdirs(process.platform)) {
          dirs.push(sub ? join(base, entry, sub) : join(base, entry))
        }
      }
    } catch { /* that manager is not installed */ }
  }
  return dirs
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    // The executable bit is meaningless on Windows — being a file with a
    // PATHEXT suffix is the whole test there.
    if (process.platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Absolute path to `name`, or null if it is genuinely not installed. */
export function resolveBin(name: string): string | null {
  if (cache.has(name)) return cache.get(name)!
  let found: string | null = null
  const names = binaryCandidates(name, process.platform)
  outer: for (const dir of allSearchDirs()) {
    for (const candidate of names) {
      const full = join(dir, candidate)
      if (isExecutable(full)) { found = full; break outer }
    }
  }
  cache.set(name, found)
  return found
}

export const hasBin = (name: string): boolean => resolveBin(name) !== null

/** Discard cached lookups. Only useful in tests and after an install. */
export const forgetResolved = (): void => cache.clear()

/**
 * PATH to hand a spawned CLI. These tools shell out themselves — `claude` needs
 * node, `codex` needs git — so an inherited stub PATH breaks them one level down
 * even once we have spawned them by absolute path.
 */
export function enrichedPath(): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of allSearchDirs()) {
    if (d && !seen.has(d)) { seen.add(d); out.push(d) }
  }
  return out.join(delimiter)
}

/**
 * Environment for a spawned brain: the caller's, with a usable PATH.
 *
 * Windows looks up `Path`, not `PATH`, and the two can both be present with
 * different values, so set whichever key the environment already uses.
 */
export function spawnEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const path = enrichedPath()
  const key = process.platform === 'win32' && process.env.Path !== undefined && process.env.PATH === undefined
    ? 'Path' : 'PATH'
  return { ...process.env, [key]: path, ...extra }
}
