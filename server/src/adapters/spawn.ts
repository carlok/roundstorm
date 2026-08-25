import { spawn } from 'node:child_process'
import type { AdapterEvent } from './types.ts'
import { resolveBin, spawnEnv } from './resolve.ts'

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

  const child = spawn(bin, args, {
    cwd: opts.cwd,
    // stdin must be closed: codex otherwise blocks on "Reading additional input from stdin".
    stdio: ['ignore', 'pipe', 'pipe'],
    // MERGE, never replace. An adapter that supplies one variable — codex sets
    // CODEX_HOME — would otherwise hand the child an environment with no PATH,
    // and these CLIs shell out to node and git themselves.
    env: { ...spawnEnv(), ...(opts.env ?? {}) },
  })

  const onAbort = () => child.kill('SIGTERM')
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
    push({ type: 'error', message: `${cmd} failed to start: ${err.message}` })
    done = true
    wake?.()
  })

  child.on('close', code => {
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
    if (!child.killed) child.kill('SIGTERM')
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
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'], env: spawnEnv() })
    let out = ''
    const timer = setTimeout(() => { p.kill('SIGKILL'); resolve(out) }, timeoutMs)
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', d => { out += d })
    p.on('close', () => { clearTimeout(timer); resolve(out) })
    p.on('error', () => { clearTimeout(timer); resolve('') })
  })
}

/** Strip ANSI escapes and terminal control noise from CLI output. */
export const clean = (s: string) =>
  s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
