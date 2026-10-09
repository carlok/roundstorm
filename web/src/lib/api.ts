/**
 * Where the daemon lives.
 *
 * In dev the Vite proxy forwards `/api` and `/ws`, so relative URLs work. In the
 * packaged app there is no proxy: the page is served from `tauri://localhost`
 * and a relative `/api/bootstrap` resolves against that origin, 404s, and the UI
 * never boots — a black window with no error. So the base has to be absolute
 * whenever we are not on the dev server.
 */
const DEV_ORIGINS = ['localhost:5273', '127.0.0.1:5273']

function resolveBase(): string {
  if (typeof window === 'undefined') return ''
  const { protocol, host } = window.location
  // Dev server: keep relative so the proxy stays in charge.
  if (protocol.startsWith('http') && DEV_ORIGINS.includes(host)) return ''
  // Served over http by the daemon itself — on whatever port it was given, and
  // possibly over the LAN. Relative is both correct and same-origin. This used to
  // return the hardcoded address below, so a daemon on any other port served a UI
  // that called port 8787 and quietly failed.
  if (protocol.startsWith('http')) return ''
  // tauri:// and file://, where a relative /api resolves against an origin that
  // serves no API: the black-window case. Only here is an absolute address right.
  return 'http://127.0.0.1:8787'
}

export const API_BASE = resolveBase()

/**
 * Add the daemon's token to a URL as `?token=`.
 *
 * A query parameter rather than a header because the places that need it cannot set
 * one: an export link and `window.open` are plain navigations, and so is a
 * WebSocket handshake. Applying it in `apiUrl` and `wsUrl` means every call that
 * already goes through them — including the raw `fetch(apiUrl(...))` sites — picks
 * it up without being touched. Any `token` already on the URL is replaced.
 */
export function appendToken(url: string, token: string | null): string {
  if (!token) return url
  const [base, query = ''] = url.split('?', 2)
  const kept = query.split('&').filter(p => p && !p.startsWith('token='))
  kept.push(`token=${encodeURIComponent(token)}`)
  return `${base}?${kept.join('&')}`
}

/** `#token=…` out of a URL fragment, for a browser user who set ROUNDSTORM_TOKEN. */
export function tokenFromHash(hash: string): string | null {
  const m = /(?:^#|&)token=([^&]*)/.exec(hash)
  if (!m || !m[1]) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return null
  }
}

const STORAGE_KEY = 'roundstorm-token'
let cachedToken: string | null | undefined

/**
 * Where this page's token comes from.
 *
 * In the desktop app the shell injects `window.__ROUNDSTORM_TOKEN__` before any
 * page script runs. In a browser, the person who set ROUNDSTORM_TOKEN opens the
 * interface once as `/#token=…`; it is kept in sessionStorage for the tab and the
 * fragment is removed from the address bar so it does not sit in history.
 * Read lazily and cached: this runs on every request.
 */
export function currentToken(): string | null {
  if (cachedToken !== undefined) return cachedToken
  if (typeof window === 'undefined') return (cachedToken = null)
  const injected = (window as { __ROUNDSTORM_TOKEN__?: unknown }).__ROUNDSTORM_TOKEN__
  if (typeof injected === 'string' && injected) return (cachedToken = injected)
  try {
    const fromHash = tokenFromHash(window.location.hash)
    if (fromHash) {
      window.sessionStorage.setItem(STORAGE_KEY, fromHash)
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
      return (cachedToken = fromHash)
    }
    return (cachedToken = window.sessionStorage.getItem(STORAGE_KEY))
  } catch {
    return (cachedToken = null)   // storage blocked: behave as if there is no token
  }
}

export const apiUrl = (path: string) => appendToken(`${API_BASE}${path}`, currentToken())

export function wsUrl(): string {
  const base = API_BASE
    ? `${API_BASE.replace(/^http/, 'ws')}/ws`
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
  return appendToken(base, currentToken())
}

/** fetch against the daemon, wherever it is. */
export const api = (path: string, init?: RequestInit) => fetch(apiUrl(path), init)

/**
 * Reserve room for the macOS traffic-light buttons.
 *
 * With a transparent title bar they are painted over the page, so without an
 * inset they sit on top of the first controls in the sidebar and swallow their
 * clicks. Only applies in the desktop shell; a browser has its own chrome.
 */
export function applyTitlebarInset(): void {
  if (typeof window === 'undefined') return
  const inDesktop = !!(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    || location.protocol === 'tauri:'
  if (inDesktop) document.documentElement.style.setProperty('--titlebar', '30px')
}
