/**
 * The HTTP brains against a stand-in server: retries on 429/5xx, Retry-After,
 * the per-request timeout, and never retrying past an abort.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { makeCompatAdapter, retryDelay } from './openai-compat.ts'
import type { AdapterEvent, TurnRequest } from './types.ts'

let server: Server
let base = ''
let script: { status: number; headers?: Record<string, string>; delayMs?: number }[] = []
let seen: any[] = []

before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      seen.push(JSON.parse(body || '{}'))
      const step = script.shift() ?? { status: 200 }
      setTimeout(() => {
        if (res.destroyed) return
        res.writeHead(step.status, { 'content-type': 'application/json', ...(step.headers ?? {}) })
        res.end(step.status === 200
          ? JSON.stringify({ choices: [{ message: { content: JSON.stringify({ body: 'ok', stance: 'propose', claims: [] }) } }] })
          : JSON.stringify({ error: 'busy' }))
      }, step.delayMs ?? 0)
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as any).port}/v1`
})
after(() => { server.closeAllConnections(); server.close() })

const req: TurnRequest = { systemPrompt: 's', userPrompt: 'u', model: null, tier: 'reasoning', workingDir: null, schema: { type: 'object' } }

async function run(over: Partial<Parameters<typeof makeCompatAdapter>[0]> = {}, signal = new AbortController().signal) {
  const a = makeCompatAdapter({ id: 'stand-in', label: 'S', baseUrl: base, responseFormat: 'json_schema', ...over })
  const events: AdapterEvent[] = []
  for await (const e of a.run(req, signal)) events.push(e)
  return events
}

test('a 429 is retried after what Retry-After asks, then the turn succeeds', async () => {
  script = [{ status: 429, headers: { 'retry-after': '0' } }, { status: 200 }]
  seen = []
  const events = await run()
  assert.equal(seen.length, 2, 'the rate-limited request was not retried')
  assert.ok(events.some(e => e.type === 'activity' && /429, retrying/.test(e.text)))
  assert.equal(events.at(-1)?.type, 'final')
})

test('persistent 5xx gives up after two retries and says why', async () => {
  script = [{ status: 503, headers: { 'retry-after': '0' } }, { status: 503, headers: { 'retry-after': '0' } }, { status: 503, headers: { 'retry-after': '0' } }]
  seen = []
  const events = await run()
  assert.equal(seen.length, 3)
  assert.match((events.at(-1) as any).message, /stand-in 503/)
})

test('a 400 is not retried: the request itself is wrong', async () => {
  script = [{ status: 400 }]
  seen = []
  const events = await run()
  assert.equal(seen.length, 1)
  assert.equal(events.at(-1)?.type, 'error')
})

test('the per-request timeout applies, and an abort during the backoff stops at once', async () => {
  script = [{ status: 200, delayMs: 400 }, { status: 200, delayMs: 400 }, { status: 200, delayMs: 400 }]
  const timedOut = await run({ timeoutMs: 50 })
  assert.match((timedOut.at(-1) as any).message, /did not answer within/)

  script = [{ status: 503, headers: { 'retry-after': '10' } }]
  const ac = new AbortController()
  const t0 = Date.now()
  setTimeout(() => ac.abort(), 100)
  const cancelled = await run({}, ac.signal)
  assert.ok(Date.now() - t0 < 2_000, 'the backoff ignored the abort')
  assert.deepEqual(cancelled.at(-1), { type: 'error', message: 'cancelled' })
})

test('max_tokens comes from the spec, and an empty model id falls back', async () => {
  script = [{ status: 200 }]
  seen = []
  await run({ maxTokens: 8000, staticModels: [{ id: 'fallback-model', label: 'F' }] })
  assert.equal(seen[0].max_tokens, 8000)
  assert.equal(seen[0].model, 'fallback-model')
})

test('retry delays follow Retry-After when given, and back off when not', () => {
  assert.equal(retryDelay('3', 0), 3_000)
  assert.equal(retryDelay('600', 0), 20_000, 'a long Retry-After is capped')
  assert.equal(retryDelay(new Date(10_000).toUTCString(), 0, 5_000), 5_000)
  assert.deepEqual([0, 1, 2].map(n => retryDelay(null, n)), [1_000, 2_000, 4_000])
  assert.equal(retryDelay('soon', 1), 2_000, 'an unreadable header falls back to backoff')
})
