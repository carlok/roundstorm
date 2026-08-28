/**
 * The platform-dependent parts of launching a CLI, as pure functions.
 *
 * Kept separate and parameterised by platform so the Windows behaviour can be
 * asserted from a Mac. Every rule here is something that only shows up on the
 * platform it describes, which is exactly the kind of thing this project has
 * repeatedly got wrong by assuming.
 */
import path from 'node:path'

/**
 * Path rules for the *target* platform, not the host.
 *
 * `node:path`'s bare exports follow whatever machine you are on, so splitting a
 * Windows PATH or PATHEXT with them yields `:` here and shreds `C:\...` into
 * pieces. That is precisely the bug this module exists to prevent, so it must
 * not contain it.
 */
const rules = (platform: NodeJS.Platform) => platform === 'win32' ? path.win32 : path.posix

/** Executable suffixes to try for a bare name, in preference order. */
export function executableSuffixes(platform: NodeJS.Platform, pathext = process.env.PATHEXT): string[] {
  if (platform !== 'win32') return ['']
  // Prefer a real executable over a shim: a .exe can be spawned directly, which
  // both avoids cmd.exe quoting and raises the command-line ceiling from 8 KB
  // to 32 KB. PATHEXT is the authority on what else counts.
  const fromEnv = (pathext ?? '.COM;.EXE;.BAT;.CMD')
    .split(rules('win32').delimiter)
    .map(e => e.trim().toLowerCase())
    .filter(Boolean)
  const preferred = ['.exe', '.cmd', '.bat']
  return [...new Set([...preferred.filter(p => fromEnv.includes(p)), ...fromEnv])]
}

/** Every filename to look for when resolving `name` on `platform`. */
export const binaryCandidates = (name: string, platform: NodeJS.Platform, pathext?: string): string[] =>
  executableSuffixes(platform, pathext).map(suffix => name + suffix)

/**
 * Whether this path can only be launched through a shell.
 *
 * Since the fix for CVE-2024-27980, Node refuses to spawn `.cmd` and `.bat`
 * directly on Windows — npm installs its CLIs as exactly those shims, so a
 * `claude.cmd` needs `shell: true` while a `codex.exe` does not.
 */
export function needsShell(binPath: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false
  return ['.cmd', '.bat'].includes(rules(platform).extname(binPath).toLowerCase())
}

/**
 * Maximum bytes of command line, per platform.
 *
 * Windows enforces this in the kernel: 32767 for CreateProcess, and 8191 when it
 * goes through cmd.exe. Every adapter passes the whole prompt as an argument, so
 * a long transcript hits this — and the resulting error names neither the cause
 * nor the culprit.
 */
export function commandLineLimit(platform: NodeJS.Platform, viaShell: boolean): number {
  if (platform !== 'win32') return Number.POSITIVE_INFINITY
  return viaShell ? 8191 : 32767
}

export interface LengthCheck {
  ok: boolean
  bytes: number
  limit: number
  message?: string
}

/** Would this argv exceed the platform's command-line ceiling? */
export function checkCommandLine(
  bin: string, args: string[], platform: NodeJS.Platform, viaShell: boolean,
): LengthCheck {
  const limit = commandLineLimit(platform, viaShell)
  // Rough but conservative: the kernel counts the joined, quoted line.
  const bytes = Buffer.byteLength([bin, ...args].join(' '), 'utf8')
  if (bytes <= limit) return { ok: true, bytes, limit }
  return {
    ok: false, bytes, limit,
    message: `the prompt is too long for this platform's command line `
      + `(${bytes} bytes, limit ${limit}${viaShell ? ' via a .cmd shim' : ''}). `
      + `Shorten the discussion, use fewer rounds, or pick a brain that is `
      + `installed as a native executable rather than an npm shim.`,
  }
}

/** Directories worth searching for a CLI, most specific first. */
export function searchDirs(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  const { join, delimiter } = rules(platform)
  const dirs: string[] = []
  for (const d of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (d) dirs.push(d)
  }

  if (platform === 'win32') {
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming')
    const localAppData = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    dirs.push(
      join(appData, 'npm'),                       // npm global shims
      join(localAppData, 'Programs'),
      join(localAppData, 'Microsoft', 'WindowsApps'),
      join(home, '.local', 'bin'),
      join(home, '.bun', 'bin'),
      join(home, '.cargo', 'bin'),
      join(env.ProgramFiles ?? 'C:\\Program Files', 'nodejs'),
    )
    // nvm-windows and Volta keep versioned installs of their own.
    dirs.push(join(appData, 'nvm'), join(localAppData, 'Volta', 'bin'))
    return dirs
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
  return dirs
}

/** Version-manager directories whose children each hold a bin directory. */
export function versionManagerRoots(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  const { join } = rules(platform)
  if (platform === 'win32') {
    return [env.NVM_HOME ?? join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'nvm')]
  }
  return [join(home, '.nvm', 'versions', 'node'), join(home, '.fnm', 'node-versions')]
}

/** Where a versioned install keeps its binaries, relative to the version dir. */
export const versionBinSubdirs = (platform: NodeJS.Platform): string[] =>
  platform === 'win32' ? ['', 'bin'] : ['bin', rules(platform).join('installation', 'bin')]
