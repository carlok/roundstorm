/**
 * The shared process pump, in the two ways it lost work.
 *
 * A brain is a subprocess whose stdout is NDJSON. Both defects here are invisible
 * from the outside: the turn simply comes back empty, or the process stays alive
 * after the app is gone.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { streamProcess, terminateAll, liveChildCount } from './spawn.ts'
import type { AdapterEvent } from './types.ts'

const collect = async (script: string, opts?: Partial<Parameters<typeof streamProcess>[3]>) => {
  const seen: unknown[] = []
  const events: AdapterEvent[] = []
  for await (const e of streamProcess('sh', ['-c', script], new AbortController().signal, {
    onLine: (line, push) => { seen.push(line); push({ type: 'delta', text: 'line' }) },
    onClose: (code, _err, push) => push({ type: 'activity', text: `closed ${code}` }),
    ...opts,
  })) events.push(e)
  return { seen, events }
}

test('the last line is not lost when a CLI ends without a trailing newline', async () => {
  // `buf` only drained on '\n', so a CLI whose final JSON has no newline after it
  // — which is exactly where the result object lives — had that line silently
  // dropped. The turn then looked empty and the agent was reported as failing.
  const { seen } = await collect('printf \'{"a":1}\\n{"final":true}\'')
  assert.deepEqual(seen, [{ a: 1 }, { final: true }],
    'the unterminated final line was dropped')
})

test('a normal newline-terminated stream is unchanged', async () => {
  const { seen } = await collect('printf \'{"a":1}\\n{"b":2}\\n\'')
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }])
})

test('a trailing fragment that is not JSON is ignored rather than thrown', async () => {
  const { seen, events } = await collect('printf \'{"a":1}\\nnot json\'')
  assert.deepEqual(seen, [{ a: 1 }])
  assert.ok(events.some(e => e.type === 'activity'), 'the close event never arrived')
})

test('a finished process is no longer tracked', async () => {
  await collect('printf \'{"a":1}\\n\'')
  assert.equal(liveChildCount(), 0, 'a completed child was left in the registry')
})

test('terminateAll ends a brain the daemon is still holding', async () => {
  // Quitting the app used to leave `claude`/`codex`/`cursor-agent` running
  // against the user's account: terminate() was only ever wired to a turn's
  // AbortSignal, and nothing reached the children on shutdown.
  const ac = new AbortController()
  const run = (async () => {
    for await (const _e of streamProcess('sh', ['-c', 'sleep 30'], ac.signal, {
      onLine: () => {}, onClose: () => {},
    })) { /* drain */ }
  })()

  // Let the child actually start before asking for its pid.
  for (let i = 0; i < 50 && liveChildCount() === 0; i++) await new Promise(r => setTimeout(r, 20))
  assert.equal(liveChildCount(), 1, 'the child was never registered')

  assert.equal(terminateAll(), 1)
  assert.equal(liveChildCount(), 0)
  await run
})
