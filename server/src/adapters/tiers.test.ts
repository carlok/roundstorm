/**
 * A capability tier must fail closed.
 *
 * Every tier lookup is a Record keyed by four names, and an unrecognised key
 * yields `undefined` rather than throwing. Two adapters tested for the
 * *restrictive* tiers and let everything else fall through to the permissive
 * default, so a stored tier of `"workstation "` — a trailing space, which need
 * not look like an attack — ran the agent with write and shell.
 *
 * The strings below are the point of the file: they are what an unvalidated
 * field actually contains, not what a well-formed one does.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cursorTierArgs } from './cursor.ts'
import { agyTierArgs } from './agy.ts'
import { codexSandboxFor } from './codex.ts'
import { claudeToolsFor } from './claude.ts'
import { TIER_ORDER } from '../types.ts'

/** Anything that is not one of the four names. */
const NOT_TIERS = [
  'workstation ',      // trailing space
  ' full',
  'Full',
  'nonsense',
  '',
  '__proto__',
  'constructor',
]

test('cursor gives an unrecognised tier the most restrictive mode', () => {
  for (const t of NOT_TIERS) {
    assert.deepEqual(cursorTierArgs(t), ['--mode', 'ask'], `tier ${JSON.stringify(t)}`)
  }
})

test('agy gives an unrecognised tier the sandbox', () => {
  for (const t of NOT_TIERS) {
    assert.deepEqual(agyTierArgs(t), ['--sandbox'], `tier ${JSON.stringify(t)}`)
  }
})

test('codex gives an unrecognised tier a read-only sandbox', () => {
  for (const t of NOT_TIERS) {
    assert.equal(codexSandboxFor(t), 'read-only', `tier ${JSON.stringify(t)}`)
  }
})

test('claude grants an unrecognised tier no tools at all', () => {
  for (const t of NOT_TIERS) {
    assert.deepEqual([...claudeToolsFor(t)], [], `tier ${JSON.stringify(t)}`)
  }
})

// --- the real tiers still do what they say ---

test('only the full tier gets an unflagged agent mode', () => {
  const unflagged = TIER_ORDER.filter(t => cursorTierArgs(t).length === 0)
  assert.deepEqual(unflagged, ['full'],
    'a tier below full was left without a mode flag, i.e. write and bash')
})

test('only the full tier gets write access from agy', () => {
  const writable = TIER_ORDER.filter(t => agyTierArgs(t).includes('accept-edits'))
  assert.deepEqual(writable, ['full'])
})

test('the tiers below workstation get no file tools from claude', () => {
  for (const t of ['reasoning', 'research'] as const) {
    const tools = claudeToolsFor(t)
    for (const forbidden of ['Write', 'Edit', 'Bash', 'NotebookEdit']) {
      assert.ok(!tools.includes(forbidden), `${t} was granted ${forbidden}`)
    }
  }
})

test('the reasoning tier gets no tools whatsoever, as the manual says', () => {
  assert.deepEqual([...claudeToolsFor('reasoning')], [])
})
