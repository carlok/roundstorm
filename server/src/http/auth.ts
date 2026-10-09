/**
 * An optional bearer token for the API and the event stream.
 *
 * What it is: a random per-launch secret the desktop shell generates, hands to the
 * daemon in `ROUNDSTORM_TOKEN`, and injects into its own page. When it is set the
 * daemon refuses `/api` and `/ws` without it. When it is not set, nothing changes,
 * so `node dist-server/index.mjs`, the headless CLI and every existing script keep
 * working exactly as before.
 *
 * What it is not: protection from malware running as you. That can read this
 * process's environment and memory, token or no token. What it does stop is
 * another process that can open a loopback socket but cannot read this one, another
 * user on a shared machine, and — the reason it matters most — a daemon bound
 * beyond loopback with `ROUNDSTORM_HOST`, which used to hand the whole network an
 * unauthenticated API that can start processes.
 */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { requestAllowed } from './origin.ts'

const configured = (): string | undefined => process.env.ROUNDSTORM_TOKEN?.trim() || undefined

export const tokenRequired = (): boolean => configured() !== undefined

/**
 * Is this the token? True when none is configured.
 *
 * Compared as bytes with `timingSafeEqual`, which throws when the lengths differ.
 * That is checked first, because letting it throw would turn a short wrong token
 * into a 500, and a 500 versus a 401 tells a caller how long the secret is.
 */
export function tokenOk(supplied: string | undefined): boolean {
  const expected = configured()
  if (!expected) return true
  if (!supplied) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Pull a token out of a request: `Authorization: Bearer …`, else `?token=…`.
 *
 * The query form is needed, not a convenience: an export link or `window.open` is
 * a plain navigation that cannot carry a header, and neither can a WebSocket.
 */
export function tokenFrom(authorization: string | undefined, url: string | undefined): string | undefined {
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? '')
  if (bearer) return bearer[1].trim()
  if (!url) return undefined
  try {
    return new URL(url, 'http://daemon.invalid').searchParams.get('token') ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Say a request was turned away, once per kind.
 *
 * A wrong or missing token is another way to get a blank window, and the daemon's
 * stdout is the only place the person debugging it can look.
 */
const warned = new Set<string>()
export function warnUnauthorised(kind: 'http' | 'ws'): void {
  if (warned.has(kind)) return
  warned.add(kind)
  console.warn(`refused a ${kind === 'ws' ? 'WebSocket' : 'HTTP'} request: ROUNDSTORM_TOKEN is set and the request carried none, or the wrong one.`)
}

/** The whole WebSocket upgrade decision, shared by the daemon and its tests. */
export function websocketAllowed(req: IncomingMessage): { ok: boolean; status: number; reason: string } {
  if (!requestAllowed(req.headers.origin, req.headers.host)) {
    return { ok: false, status: 403, reason: 'refused: unrecognised Origin or Host' }
  }
  if (!tokenOk(tokenFrom(req.headers.authorization, req.url))) {
    warnUnauthorised('ws')
    return { ok: false, status: 401, reason: 'unauthorised: missing or wrong token' }
  }
  return { ok: true, status: 200, reason: '' }
}
