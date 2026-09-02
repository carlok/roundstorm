/**
 * What happens to a deliberation the process never finished.
 *
 * A crash — or a `kill -9`, or the desktop shell quitting mid-round — leaves the
 * row at `running`. Nothing is driving it, but `activeDeliberation` still finds
 * it, and every route that guards on one refuses: the room cannot deliberate,
 * cannot be cleared, cannot be deleted. There is no way out from the interface,
 * which is what makes this worth a startup pass and a test.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ROUNDSTORM_DATA = mkdtempSync(join(tmpdir(), 'rs-recover-'))
const db = await import('./db.ts')

const project = db.createProject('Recovery tests')
let n = 0

function stuckRoom(status: 'running' | 'stopping') {
  const agent = db.createAgent({
    name: `A-${status}-${n++}`, role: 'analyst', avatarColor: '#888', personaKey: 'analyst',
    personaExtra: '', brain: 'stub', model: 'm', tierCeiling: 'reasoning',
  } as any)
  const room = db.createRoom(project.id, `Room ${status} ${n}`, 'room', [agent.id], 'reasoning')
  const d = db.createDeliberation({
    roomId: room.id, mode: 'deliberation', rounds: 4, style: 'parallel',
    sealedOpening: false, status: 'running', currentRound: 0,
    question: 'q', tier: 'reasoning',
  } as any)
  db.updateDeliberation(d.id, { status, currentRound: 2 })
  return { room, d }
}

test('a deliberation left running is closed at startup, not left to brick the room', () => {
  const { room, d } = stuckRoom('running')
  assert.ok(db.activeDeliberation(room.id), 'precondition: the room starts out blocked')

  const recovered = db.reconcileDeliberations()

  assert.deepEqual(recovered.map(r => r.id), [d.id])
  assert.equal(db.getDeliberation(d.id)!.status, 'stopped')
  assert.equal(db.activeDeliberation(room.id), undefined, 'the room is usable again')
  assert.ok(db.getDeliberation(d.id)!.endedAt, 'it was left without an end time')
})

test('the room is told, rather than the run just appearing to have finished', () => {
  const { room } = stuckRoom('running')
  db.reconcileDeliberations()

  const note = db.listMessages(room.id).find(m => m.authorType === 'system')
  assert.ok(note, 'nothing in the transcript explains the gap')
  assert.match(note!.body, /interrupted at round 2/)
})

test('a deliberation caught mid-stop is closed too', () => {
  const { room } = stuckRoom('stopping')
  db.reconcileDeliberations()
  assert.equal(db.activeDeliberation(room.id), undefined)
})

test('finished deliberations are left alone', () => {
  const { room, d } = stuckRoom('running')
  db.updateDeliberation(d.id, { status: 'complete' })

  assert.deepEqual(db.reconcileDeliberations().map(r => r.roomId).filter(id => id === room.id), [])
  assert.equal(db.getDeliberation(d.id)!.status, 'complete')
  assert.equal(db.listMessages(room.id).filter(m => m.authorType === 'system').length, 0,
    'a completed run was annotated as if it had crashed')
})
