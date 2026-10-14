/**
 * Claude's event translation, from lines as the CLI emits them. Nothing here
 * starts a process: the pump is covered in spawn.test.ts, and what is left is
 * the part that decides what a turn says, what it cost and whether it counts
 * as failed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claudeTranslator, claudeArgs } from './claude.ts'
import type { AdapterEvent, TurnRequest } from './types.ts'

function translate(lines: unknown[], close: { code: number | null; stderr?: string } = { code: 0 }) {
  const t = claudeTranslator()
  const events: AdapterEvent[] = []
  const push = (e: AdapterEvent) => events.push(e)
  for (const l of lines) t.onLine(l, push)
  t.onClose(close.code, close.stderr ?? '', push)
  return events
}

const assistant = (...content: unknown[]) => ({ type: 'assistant', message: { content } })

test('a structured turn arrives in the final event, with its cost', () => {
  const turn = { stance: 'assert', body: 'hello' }
  const events = translate([
    { type: 'system', subtype: 'thinking_tokens' },
    assistant({ type: 'tool_use', name: 'StructuredOutput', input: turn }),
    { type: 'result', total_cost_usd: 0.0123, is_error: false },
  ])
  assert.deepEqual(events[0], { type: 'activity', text: 'Thinking' })
  assert.deepEqual(events[1], { type: 'tool', name: 'StructuredOutput', detail: 'Composing its turn' })
  assert.deepEqual(events.at(-1), { type: 'final', structured: turn, text: '', costUsd: 0.0123 })
})

test('a reply split around a tool call keeps every block', () => {
  const events = translate([
    assistant({ type: 'text', text: 'Before. ' }),
    assistant({ type: 'tool_use', name: 'WebSearch', input: {} }),
    assistant({ type: 'text', text: 'After.' }),
  ])
  const final = events.at(-1) as Extract<AdapterEvent, { type: 'final' }>
  assert.equal(final.text, 'Before. After.', 'the text before the tool call was lost')
  assert.deepEqual(events.filter(e => e.type === 'delta').map(e => (e as any).text), ['Before. ', 'After.'])
  assert.ok(events.some(e => e.type === 'tool' && e.detail === 'Searching the web'))
})

test('an unknown tool is described by name rather than dropped', () => {
  const events = translate([assistant({ type: 'tool_use', name: 'Teleport', input: {} })])
  assert.ok(events.some(e => e.type === 'tool' && e.detail === 'Using Teleport'))
})

test('a denied tool is surfaced as activity', () => {
  const events = translate([{ type: 'system', subtype: 'permission_denied', tool_name: 'Bash' }])
  assert.deepEqual(events[0], { type: 'activity', text: 'Blocked: Bash' })
})

test('a result flagged as an error emits an error and still closes with a final', () => {
  const events = translate([{ type: 'result', total_cost_usd: 0.01, is_error: true, result: 'rate limited' }])
  assert.deepEqual(events[0], { type: 'error', message: 'rate limited' })
  assert.equal(events.at(-1)?.type, 'final')
})

test('a non-zero exit with nothing produced reports stderr, trimmed', () => {
  const events = translate([], { code: 1, stderr: `  boom${'!'.repeat(600)}  ` })
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'error')
  assert.equal((events[0] as any).message.length, 500)
  assert.match((events[0] as any).message, /^boom/)
})

test('a non-zero exit with no stderr names the exit code', () => {
  assert.deepEqual(translate([], { code: 2 }), [{ type: 'error', message: 'claude exited 2' }])
})

test('a non-zero exit after the model spoke is still a result', () => {
  const events = translate([assistant({ type: 'text', text: 'partial' })], { code: 1 })
  assert.equal(events.at(-1)?.type, 'final')
})

test('a signal-killed process (code null) is not reported as a crash', () => {
  assert.equal(translate([], { code: null }).at(-1)?.type, 'final')
})

test('lines it does not know are ignored', () => {
  assert.deepEqual(translate([{ type: 'user' }, { type: 'system', subtype: 'init' }]).map(e => e.type), ['final'])
})

// --- the argv ---

const req = (over: Partial<TurnRequest> = {}): TurnRequest => ({
  systemPrompt: 'sys', userPrompt: 'q', model: null, tier: 'reasoning', workingDir: null,
  schema: { type: 'object' }, ...over,
})

test('the argv carries the isolation flags at every tier', () => {
  for (const tier of ['reasoning', 'research', 'workstation', 'full'] as const) {
    const a = claudeArgs(req({ tier, workingDir: '/tmp' }))
    const at = (f: string) => a[a.indexOf(f) + 1]
    assert.equal(at('--setting-sources'), '', tier)
    assert.ok(a.includes('--strict-mcp-config'), tier)
    assert.equal(at('--system-prompt'), 'sys', tier)
    assert.ok(a.includes('--json-schema'), tier)
  }
})

test('--add-dir is only passed above the reasoning tier, and only with a directory', () => {
  assert.ok(!claudeArgs(req({ tier: 'reasoning', workingDir: '/x' })).includes('--add-dir'))
  assert.ok(!claudeArgs(req({ tier: 'full', workingDir: null })).includes('--add-dir'))
  assert.ok(claudeArgs(req({ tier: 'full', workingDir: '/x' })).includes('--add-dir'))
})

test('a model is passed only when one is chosen', () => {
  assert.ok(!claudeArgs(req()).includes('--model'))
  const a = claudeArgs(req({ model: 'm-1' }))
  assert.equal(a[a.indexOf('--model') + 1], 'm-1')
})
