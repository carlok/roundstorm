/**
 * Event translation for the CLI brains other than Claude, from lines shaped like
 * what each CLI emits. Nothing is spawned; spawn.test.ts covers the pump.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cursorTranslator } from './cursor.ts'
import { codexTranslator } from './codex.ts'
import { agyTranslator } from './agy.ts'
import type { AdapterEvent } from './types.ts'
import type { StreamOpts } from './spawn.ts'

function run(t: Pick<StreamOpts, 'onLine' | 'onClose'>, lines: unknown[], code: number | null = 0, stderr = '') {
  const events: AdapterEvent[] = []
  const push = (e: AdapterEvent) => events.push(e)
  for (const l of lines) t.onLine(l, push)
  t.onClose(code, stderr, push)
  return events
}
const types = (es: AdapterEvent[]) => es.map(e => e.type)

// --- cursor-agent ---

test('cursor: an error result is an error, not the agent\'s answer', () => {
  const es = run(cursorTranslator(), [{ type: 'result', is_error: true, result: 'Quota exceeded' }], 1)
  assert.deepEqual(es, [{ type: 'error', message: 'Quota exceeded' }], 'the error text became the reply, or was reported twice')
})

test('cursor: an error after the model spoke keeps the text and reports the error', () => {
  const es = run(cursorTranslator(), [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Half an answer' }] } },
    { type: 'result', is_error: true, result: 'connection reset' },
  ])
  assert.deepEqual(types(es), ['delta', 'error', 'final'])
  assert.equal((es.at(-1) as any).text, 'Half an answer')
})

test('cursor: a clean result is the final text', () => {
  const es = run(cursorTranslator(), [
    { type: 'thinking', subtype: 'delta' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'grep' }, { type: 'text', text: 'draft' }] } },
    { type: 'result', is_error: false, result: 'The final answer' },
  ])
  assert.deepEqual(types(es), ['activity', 'tool', 'delta', 'final'])
  assert.deepEqual(es.at(-1), { type: 'final', structured: null, text: 'The final answer' })
})

test('cursor: nothing at all reports stderr or the exit code', () => {
  assert.deepEqual(run(cursorTranslator(), [], 2, ''), [{ type: 'error', message: 'cursor-agent exited 2' }])
  assert.deepEqual(run(cursorTranslator(), [], 1, ' not logged in '), [{ type: 'error', message: 'not logged in' }])
})

// --- codex ---

const codexMsg = (text: string) => ({ type: 'item.completed', item: { type: 'agent_message', text } })

test('codex: a failure after a preamble is reported, so the turn is not stored as clean', () => {
  const es = run(codexTranslator(), [
    { type: 'turn.started' },
    codexMsg('Let me look'),
    { type: 'turn.failed', error: { message: '{"error":{"message":"usage limit reached"}}' } },
  ])
  assert.deepEqual(types(es), ['activity', 'delta', 'error', 'final'])
  assert.equal((es[2] as any).message, 'usage limit reached')
})

test('codex: a structured answer is parsed out of the agent message', () => {
  const es = run(codexTranslator(), [codexMsg('{"body":"hi","stance":"propose","claims":[]}')])
  assert.deepEqual((es.at(-1) as any).structured, { body: 'hi', stance: 'propose', claims: [] })
})

test('codex: tool items become tool events, and stdin chatter is not the error', () => {
  const es = run(codexTranslator(), [
    { type: 'item.completed', item: { type: 'command_execution' } },
    { type: 'item.completed', item: { type: 'file_change' } },
    { type: 'item.completed', item: { type: 'web_search' } },
    { type: 'item.completed', item: { type: 'reasoning' } },
  ], 1, 'Reading additional input from stdin...\nreal problem here')
  assert.deepEqual(types(es), ['tool', 'tool', 'tool', 'activity', 'error'])
  assert.equal((es.at(-1) as any).message, 'real problem here')
})

test('codex: an error line without text names the failure', () => {
  const es = run(codexTranslator(), [{ type: 'error', message: 'model not found' }], 1)
  assert.deepEqual(es, [{ type: 'error', message: 'model not found' }])
})

// --- agy ---

const agyResult = (r: object) => ({ event: 'result', result: r })

test('agy: a failed result after partial output is reported', () => {
  const es = run(agyTranslator(), [
    { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'partial' } },
    agyResult({ status: 'ERROR', error: 'quota' }),
  ])
  assert.deepEqual(types(es), ['activity', 'error', 'final'])
  assert.equal((es[1] as any).message, 'quota')
})

test('agy: a successful result is parsed', () => {
  const es = run(agyTranslator(), [
    { event: 'step_update', step_update: { step_type: 'thinking' } },
    { event: 'step_update', step_update: { step_type: 'tool_call', tool_name: 'search', tool_summary: 'Searching' } },
    agyResult({ status: 'SUCCESS', response: '{"body":"x","stance":"propose","claims":[]}' }),
  ])
  assert.deepEqual(types(es), ['activity', 'tool', 'final'])
  assert.equal((es.at(-1) as any).structured.body, 'x')
})

test('agy: no response at all reports why', () => {
  assert.deepEqual(run(agyTranslator(), [agyResult({ status: 'CANCELLED' })], 1),
    [{ type: 'error', message: 'CANCELLED' }])
  assert.deepEqual(run(agyTranslator(), [], 3), [{ type: 'error', message: 'agy exited 3' }])
})

// --- codex schema file (#82) ---

test('codex schema files are named by content, so two schemas never share a path', async () => {
  const { writeSchema } = await import('./codex.ts')
  const { readFileSync } = await import('node:fs')
  const a = writeSchema({ type: 'object', title: 'turn' })
  const b = writeSchema({ type: 'object', title: 'result' })
  assert.notEqual(a, b, 'a synthesis and a turn would overwrite each other')
  assert.equal(writeSchema({ type: 'object', title: 'turn' }), a)
  assert.deepEqual(JSON.parse(readFileSync(b, 'utf8')), { type: 'object', title: 'result' })
})
