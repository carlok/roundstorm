import { test } from 'node:test'
import assert from 'node:assert/strict'
import { messageToMarkdown, transcriptToMarkdown } from './clipboard.ts'
import type { Agent, Message } from '../types.ts'

const agent = (name: string): Agent => ({
  id: `a-${name}`, name, role: '', avatarColor: '#000', personaKey: 'skeptic',
  personaExtra: '', brain: 'claude', model: 'claude-sonnet-5',
  tierCeiling: 'research', createdAt: 0,
})

const msg = (over: Partial<Message>): Message => ({
  id: 'm1', roomId: 'r', authorType: 'agent', authorId: 'a-Alice', body: 'Body text.',
  replyTo: null, round: 2, deliberationId: 'd', sealed: false, priority: false,
  stance: 'propose', claims: [], degraded: false, brain: 'claude',
  model: 'claude-sonnet-5', costUsd: null, createdAt: 0, seq: 1, ...over,
})

test('a copied message carries who said it, on what brain, in which round', () => {
  const md = messageToMarkdown(msg({}), agent('Alice'))
  assert.ok(md.includes('**Alice**'))
  assert.ok(md.includes('claude/claude-sonnet-5'))
  assert.ok(md.includes('Round 2'))
  assert.ok(md.includes('Body text.'))
})

test('claims are appended with their basis, so provenance survives the paste', () => {
  const md = messageToMarkdown(msg({
    claims: [{ text: 'onset scales as sqrt(Re)', basis: 'computed' }],
  }), agent('Curie'))
  assert.ok(md.includes('- [computed] onset scales as sqrt(Re)'))
})

test('a human message copies without a brain attribution', () => {
  const md = messageToMarkdown(msg({ authorType: 'human', authorId: null, round: null }), null)
  assert.ok(md.startsWith('**You**'))
  assert.ok(!md.includes('claude'))
  assert.ok(!md.includes('Round'))
})

test('a copied transcript is split by round dividers', () => {
  const md = transcriptToMarkdown(
    [msg({ id: 'a', round: 1 }), msg({ id: 'b', round: 1 }), msg({ id: 'c', round: 2 })],
    () => agent('Alice'))
  assert.equal((md.match(/## Round/g) ?? []).length, 2)
  assert.ok(md.indexOf('## Round 1') < md.indexOf('## Round 2'))
})
