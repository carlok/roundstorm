/**
 * Who is allowed to talk to this daemon over HTTP and WebSocket.
 *
 * The threat model used to be one sentence — "it binds to loopback" — and that is
 * not a threat model against a *browser*. The CORS header reflected whatever
 * `Origin` arrived, so any page the user happened to visit could call the API
 * cross-origin and read the responses: every transcript, every position, every
 * memory card. The WebSocket was worse, because handshakes are exempt from CORS
 * entirely and every socket is subscribed to the whole event bus — a page could
 * stream the room live without touching `/api` at all.
 *
 * This is not authentication. Every local process still has full access, and
 * `ROUNDSTORM_HOST` still hands the LAN an unauthenticated API. It closes the one
 * door a website can walk through.
 */

const envList = (name: string): string[] =>
  (process.env[name] ?? '').split(',').map(s => s.trim()).filter(Boolean)

/**
 * Origins that are this app, whatever machine it is on.
 *
 * Tauri v2 serves the packaged page from `tauri://localhost` on macOS, Linux and
 * iOS, and from `http(s)://tauri.localhost` on Windows and Android.
 */
const STATIC_ORIGINS = (): Set<string> => new Set([
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'http://localhost:5273',   // vite dev server
  'http://127.0.0.1:5273',
  ...envList('ROUNDSTORM_ALLOWED_ORIGINS'),
])

/** Hostname out of a Host header: no port, no brackets. */
function hostnameOf(header: string): string {
  const s = header.trim().toLowerCase()
  if (s.startsWith('[')) return s.slice(1, s.indexOf(']'))   // [::1]:8787
  const i = s.lastIndexOf(':')
  return i === -1 ? s : s.slice(0, i)
}

/**
 * Refuse a Host the daemon was not reached by directly.
 *
 * This is the DNS-rebinding guard, and it is the reason the origin check alone is
 * not enough: an attacker's domain can be re-pointed at 127.0.0.1, at which point
 * the page's requests are *same-origin* by the browser's reckoning and no origin
 * rule can tell them apart. Rebinding needs a name, so names are what we refuse.
 */
export function hostAllowed(host: string | undefined): boolean {
  const n = hostnameOf(host ?? '')
  if (!n) return false                                  // HTTP/1.1 requires Host
  // Exact match only. Chrome resolves *.localhost to loopback, so allowing the
  // suffix would make `evil.localhost` a free bypass.
  if (n === 'localhost') return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(n)) return true     // IPv4 literal
  if (n.includes(':')) return true                       // IPv6 literal
  return envList('ROUNDSTORM_ALLOWED_HOSTS').map(h => h.toLowerCase()).includes(n)
}

export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  // No Origin is curl, the headless CLI, and another agent driving the API — all
  // documented uses. A browser always sends one on a cross-origin fetch, and the
  // no-Origin requests it does make are GETs whose responses it cannot read.
  if (origin === undefined || origin === '') return true
  // The sandboxed-iframe and data:-URL value. An attacker page can produce it at
  // will, so it is the one string that must never be treated as unknown-benign.
  if (origin === 'null') return false
  if (STATIC_ORIGINS().has(origin)) return true
  try {
    const u = new URL(origin)
    // Same-origin: the daemon serving its own UI. This is what keeps a LAN user
    // on ROUNDSTORM_HOST=0.0.0.0 working without listing their address.
    return (u.protocol === 'http:' || u.protocol === 'https:')
      && u.host === (host ?? '').trim().toLowerCase()
  } catch {
    return false
  }
}

export const requestAllowed = (origin: string | undefined, host: string | undefined): boolean =>
  hostAllowed(host) && originAllowed(origin, host)

/**
 * Say what was refused, once per distinct pair.
 *
 * If the guess about Tauri's origin is wrong the packaged app shows a blank
 * window, and the daemon's stdout is redirected to a log file the user can read.
 * One line naming the origin turns a bisect into a `tail`.
 */
const warned = new Set<string>()
export function warnRefused(origin: string | undefined, host: string | undefined): void {
  const key = `${origin ?? '-'} ${host ?? '-'}`
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`refused a request from origin=${origin ?? '(none)'} host=${host ?? '(none)'}`)
  console.warn('if that is this app, set ROUNDSTORM_ALLOWED_ORIGINS to it and restart.')
}

/** Tests only: the warning is once-per-process by design. */
export const resetWarnings = () => warned.clear()
