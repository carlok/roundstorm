/**
 * The class of bug that kept reaching the user rather than the tests.
 *
 * Every one of them was the same shape: a control that renders correctly and
 * cannot be clicked, because something invisible sits on top of it. The
 * transparent titlebar strip ate the Rooms `+`, then the Inspector tabs. Reading
 * the DOM never showed it — the button is there, styled, in the tree. Only
 * asking the browser "what would a click at this point actually hit?" shows it,
 * so that is what this does, against the real built bundle.
 *
 * Not in `npm test`: it needs a build, a daemon and a Chrome. `npm run test:ui`.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'

const CHROME = process.env.ROUNDSTORM_CHROME
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 45_617
const ORIGIN = `http://127.0.0.1:${PORT}`

let daemon: ChildProcess
let browser: Browser
let page: Page

before(async () => {
  assert.ok(existsSync('dist-web/index.html'),
    'run `npm run build:web` first — this checks the built bundle, not the dev server')
  assert.ok(existsSync(CHROME), `no Chrome at ${CHROME}; set ROUNDSTORM_CHROME`)

  daemon = spawn(process.execPath, ['--experimental-strip-types', 'server/src/index.ts'], {
    env: {
      ...process.env,
      ROUNDSTORM_PORT: String(PORT),
      ROUNDSTORM_DATA: mkdtempSync(join(tmpdir(), 'rs-ui-')),
    },
    stdio: 'ignore',
  })

  const deadline = Date.now() + 30_000
  for (;;) {
    try { if ((await fetch(`${ORIGIN}/health`)).ok) break } catch { /* not up yet */ }
    assert.ok(Date.now() < deadline, 'the daemon never came up')
    await new Promise(r => setTimeout(r, 200))
  }

  browser = await puppeteer.launch({ executablePath: CHROME, headless: true })
  page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 860 })
  await page.goto(ORIGIN, { waitUntil: 'networkidle0' })
})

after(async () => {
  await browser?.close()
  daemon?.kill()
})

/**
 * Controls whose centre point belongs to something else.
 *
 * A control counts as covered only when the hit element is neither itself nor
 * inside it nor an ancestor of it — a `<label>` wrapping its input is how the
 * markup is meant to work, not a defect. `within` scopes the sweep, because
 * behind an open modal every control is covered on purpose.
 *
 * Passed as source text rather than a function: tsx compiles with keepNames, and
 * the `__name` helper it injects does not exist in the page.
 */
const covered = (within = 'body'): Promise<{ label: string; blockedBy: string }[]> =>
  page.evaluate(`(() => {
    const out = []
    const sel = 'button, a[href], input, select, textarea, [role="button"], [role="tab"]'
    const root = document.querySelector(${JSON.stringify(within)}) || document.body
    const describe = n => n.tagName.toLowerCase() +
      (typeof n.className === 'string' && n.className.trim()
        ? '.' + n.className.trim().split(/\\s+/).join('.') : '')
    for (const el of root.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) continue
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      if (style.pointerEvents === 'none') continue

      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      if (!hit || el.contains(hit) || hit.contains(el)) continue

      const text = (el.textContent || '').trim().slice(0, 30) ||
        el.getAttribute('title') || el.getAttribute('aria-label') || ''
      out.push({ label: describe(el) + ' "' + text + '"', blockedBy: describe(hit) })
    }
    return out
  })()`) as Promise<{ label: string; blockedBy: string }[]>

const report = (bad: { label: string; blockedBy: string }[]) =>
  bad.map(b => `  ${b.label} ← ${b.blockedBy}`).join('\n')

test('the sweep can actually see a covered control', async () => {
  // Without this the suite passes just as happily when the detector is broken or
  // the page rendered nothing — which is how the original titlebar bug survived
  // a green test run. Cover a real control on purpose and insist it is reported.
  const label = await page.evaluate(`(() => {
    const el = document.querySelector('button')
    if (!el) return null
    const r = el.getBoundingClientRect()
    const veil = document.createElement('div')
    veil.id = 'sweep-self-test'
    veil.style.cssText = 'position:fixed;z-index:9999;background:transparent;left:' +
      r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px'
    document.body.appendChild(veil)
    return (el.textContent || '').trim().slice(0, 30)
  })()`) as string | null

  assert.ok(label !== null, 'the page rendered no buttons at all — the sweep would pass vacuously')
  const swept = await page.evaluate(
    `document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="tab"]').length`)
  assert.ok(Number(swept) >= 8, `only ${swept} controls on the page; the UI probably failed to render`)
  const bad = await covered()
  assert.ok(bad.some(b => b.blockedBy.includes('div')),
    `the detector missed a control it was told to cover (${label})`)

  await page.evaluate(`document.getElementById('sweep-self-test')?.remove()`)
})

test('no control is covered by something invisible', async () => {
  const bad = await covered()
  assert.deepEqual(bad, [], `unclickable:\n${report(bad)}`)
})

test('the command palette opens and its own controls are reachable', async () => {
  await page.keyboard.down('Meta')
  await page.keyboard.press('KeyK')
  await page.keyboard.up('Meta')
  await page.waitForSelector('.palette, [class*="palette"]', { timeout: 3000 })

  // Scoped to the palette: behind an open modal, being covered is the point.
  const bad = await covered('.palette, [class*="palette"]')
  assert.deepEqual(bad, [], `unclickable inside the palette:\n${report(bad)}`)
})

test('no palette entry is truncated by its own row', async () => {
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.palette *, [class*="palette"] *')]
      .filter(el => el.children.length === 0 && el.scrollWidth > el.clientWidth + 1)
      .map(el => (el.textContent ?? '').trim().slice(0, 40)))
  assert.deepEqual(clipped, [], `clipped palette text: ${clipped.join(' | ')}`)
  await page.keyboard.press('Escape')
})

test('the page does not scroll sideways', async () => {
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    widest: [...document.querySelectorAll<HTMLElement>('body *')]
      .filter(el => el.getBoundingClientRect().right > innerWidth + 1)
      .map(el => el.tagName.toLowerCase() + '.' + String(el.className)).slice(0, 5),
  }))
  assert.equal(overflow.doc, 0, `the body scrolls sideways; past the edge: ${overflow.widest.join(', ')}`)
})
