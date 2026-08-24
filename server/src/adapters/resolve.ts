/**
 * Find CLI brains by absolute path.
 *
 * A GUI app launched from Finder inherits `/usr/bin:/bin:/usr/sbin:/sbin` and
 * nothing else — no nvm, no `~/.local/bin`, no Homebrew. So `spawn('claude')`
 * dies with ENOENT in the packaged app while working perfectly from a terminal,
 * and every agent reports "could not answer this round".
 *
 * Relying on PATH is the bug. Resolve once, cache, and spawn the absolute path.
 */
import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const cache = new Map<string, string | null>()

/** Directories worth searching, most specific first. */
function searchDirs(): string[] {
  const home = homedir()
  const dirs: string[] = []

  // Whatever PATH we did get, honour it first.
  for (const d of (process.env.PATH ?? '').split(delimiter)) {
    if (d) dirs.push(d)
  }

  dirs.push(
    join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, 'bin'),
    '/usr/bin',
    '/bin',
  )

  // Node version managers install CLI tools into each version's bin directory.
  for (const base of [join(home, '.nvm', 'versions', 'node'), join(home, '.fnm', 'node-versions')]) {
    try {
      for (const entry of readdirSync(base)) {
        dirs.push(join(base, entry, 'bin'))
        dirs.push(join(base, entry, 'installation', 'bin'))
      }
    } catch { /* manager not installed */ }
  }

  return dirs
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Absolute path to `name`, or null if it is genuinely not installed. */
export function resolveBin(name: string): string | null {
  if (cache.has(name)) return cache.get(name)!
  let found: string | null = null
  for (const dir of searchDirs()) {
    const candidate = join(dir, name)
    if (isExecutable(candidate)) { found = candidate; break }
  }
  cache.set(name, found)
  return found
}

export const hasBin = (name: string): boolean => resolveBin(name) !== null

/**
 * PATH to hand a spawned CLI. These tools shell out themselves — `claude` needs
 * node, `codex` needs git — so an inherited stub PATH breaks them one level
 * down even once we have spawned them by absolute path.
 */
export function enrichedPath(): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of searchDirs()) {
    if (d && !seen.has(d)) { seen.add(d); out.push(d) }
  }
  return out.join(delimiter)
}

/** Environment for a spawned brain: the caller's, with a usable PATH. */
export function spawnEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, PATH: enrichedPath(), ...extra }
}
