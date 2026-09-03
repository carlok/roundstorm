import { spawn, spawnSync } from 'node:child_process'
import type { AdapterEvent } from './types.ts'
import { resolveBin, spawnEnv } from './resolve.ts'
import { checkCommandLine, needsShell } from './platform.ts'

/**
 * End a child and everything it started.
 *
 * The brains spawn their own processes — `claude` runs node, `codex` runs git.
 * On Unix a SIGTERM to the child is enough in practice. Windows has no SIGTERM
 * at all (Node emulates it as an immediate TerminateProcess) and killing a
 * parent there leaves its children running, so the tree has to be taken down
 * explicitly or a cancelled turn keeps burning tokens invisibly.
 *
 * Known limit on Unix: this signals the direct child only. A CLI that leaves an
 * orphaned grandchild behind would survive, and taking the whole group down needs
 * `detached: true` plus `kill(-pid)` — a change to process-group semantics that
 * wants a real brain run to verify, not a unit test. Untested either way, so it
 * is recorded here rather than assumed solved.
 */
export function terminate(child: { pid?: number; killed: boolean; kill: (s?: NodeJS.Signals) => boolean }): void {
  if (child.killed || !child.pid) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      return
    } catch { /* fall through to the best Node can do */ }
  }
  try { child.kill('SIGTERM') } catch { /* already gone */ }
}

/**
 * Every brain process this daemon has running.
 *
 * `terminate` was only ever wired to a turn's AbortSignal, so quitting the app —
 * or having it orphaned and exit — left `claude`, `codex` and `cursor-agent`
 * running against the user's account with nothing left to read their output.
 * A registry is the only way a shutdown can reach them.
 */
const live = new Set<Parameters<typeof terminate>[0]>()

export function trackChild<T extends Parameters<typeof terminate>[0]>(child: T): T {
  live.add(child)
  return child
}

export const untrackChild = (child: Parameters<typeof terminate>[0]) => live.delete(child)

/** Kill every tracked brain process. Called on shutdown; safe to call twice. */
export function terminateAll(): number {
  const n = live.size
  for (const child of live) terminate(child)
  live.clear()
  return n
}

/** For tests and status output. */
export const liveChildCount = () => live.size

export interface StreamOpts {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Called per NDJSON line; push events, and stash the final result on `state`. */
  onLine: (line: unknown, push: (e: AdapterEvent) => void) => void
  /** Called on close to emit the final event. */
  onClose: (code: number | null, stderr: string, push: (e: AdapterEvent) => void) => void
}

/**
 * Every CLI brain is "spawn a process, read NDJSON off stdout, translate to
 * AdapterEvents, kill it on abort". Only the line translation differs, so it is
 * the only thing an adapter has to write.
 */
export async function* streamProcess(
  cmd: string, args: string[], signal: AbortSignal, opts: StreamOpts,
): AsyncIterable<AdapterEvent> {
  // Resolve to an absolute path. A Finder-launched app inherits almost no PATH,
  // so a bare name is an ENOENT waiting to happen.
  const bin = resolveBin(cmd)
  if (!bin) {
    yield {
      type: 'error',
      message: `${cmd} is not installed, or Roundstorm cannot find it. Looked on PATH plus the usual install locations.`,
    }
    return
  }

  // npm installs its CLIs as .cmd shims, which Node has refused to spawn
  // directly since the fix for CVE-2024-27980.
  const viaShell = needsShell(bin, process.platform)

  // Check before spawning: over the ceiling, Windows fails with an error that
  // names neither the cause nor which agent produced the oversized prompt.
  const length = checkCommandLine(bin, args, process.platform, viaShell)
  if (!length.ok) {
    yield { type: 'error', message: length.message! }
    return
  }

  const child = spawn(bin, args, {
    cwd: opts.cwd,
    // stdin must be closed: codex otherwise blocks on "Reading additional input from stdin".
    stdio: ['ignore', 'pipe', 'pipe'],
    // MERGE, never replace. An adapter that supplies one variable — codex sets
    // CODEX_HOME — would otherwise hand the child an environment with no PATH,
    // and these CLIs shell out to node and git themselves.
    env: { ...spawnEnv(), ...(opts.env ?? {}) },
    shell: viaShell,
    windowsHide: true,
  })

  trackChild(child)
  const onAbort = () => terminate(child)
  signal.addEventListener('abort', onAbort, { once: true })

  const queue: AdapterEvent[] = []
  let wake: (() => void) | null = null
  let done = false
  let stderr = ''
  let buf = ''

  const push = (e: AdapterEvent) => {
    queue.push(e)
    wake?.()
    wake = null
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line || line[0] !== '{') continue
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { continue }
      try { opts.onLine(parsed, push) } catch { /* one bad line must not kill the turn */ }
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', d => { stderr += d })

  child.on('error', err => {
    untrackChild(child)
    push({ type: 'error', message: `${cmd} failed to start: ${err.message}` })
    done = true
    wake?.()
  })

  child.on('close', code => {
    untrackChild(child)
    // The last line has no trailing newline when a CLI ends without one, and the
    // loop above only drains on '\n' — so the final result object was dropped and
    // the turn looked empty. Flush it before onClose reads the outcome.
    const tail = buf.trim()
    buf = ''
    if (tail && tail[0] === '{') {
      try { opts.onLine(JSON.parse(tail), push) } catch { /* not our line */ }
    }
    try { opts.onClose(code, stderr, push) } catch (e) {
      push({ type: 'error', message: String(e) })
    }
    done = true
    wake?.()
  })

  try {
    while (true) {
      while (queue.length) yield queue.shift()!
      if (done) return
      await new Promise<void>(r => { wake = r })
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    terminate(child)
  }
}

/**
 * Availability uses the same resolver the spawn does, so the brain list can
 * never claim a CLI is present that the scheduler then fails to launch.
 */
export async function which(bin: string): Promise<boolean> {
  return resolveBin(bin) !== null
}

/** Run a command and collect stdout. Used for model enumeration. */
export function capture(cmd: string, args: string[], timeoutMs = 25_000): Promise<string> {
  return new Promise(resolve => {
    const bin = resolveBin(cmd)
    if (!bin) return resolve('')
    const p = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: spawnEnv(),
      shell: needsShell(bin, process.platform),
      windowsHide: true,
    })
    let out = ''
    const timer = setTimeout(() => { terminate(p); resolve(out) }, timeoutMs)
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', d => { out += d })
    p.on('close', () => { clearTimeout(timer); resolve(out) })
    p.on('error', () => { clearTimeout(timer); resolve('') })
  })
}

/** Strip ANSI escapes and terminal control noise from CLI output. */
export const clean = (s: string) =>
  s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
