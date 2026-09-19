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

export const apiUrl = (path: string) => `${API_BASE}${path}`

export function wsUrl(): string {
  if (API_BASE) return `${API_BASE.replace(/^http/, 'ws')}/ws`
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws`
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
