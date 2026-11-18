/**
 * A direct message is a turn like any other as far as capabilities go. It used
 * to hand the adapter the room's tier and no working directory, skipping both the
 * agent's own ceiling and the working-directory check a deliberation applies.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ROUNDSTORM_DATA = mkdtempSync(join(tmpdir(), 'rs-dm-'))

const db = await import('../db.ts')
const { registerAdapter } = await import('../adapters/registry.ts')
const { makeStubBrain } = await import('../adapters/stub.ts')
const { replyInDm } = await import('./dm.ts')

let n = 0
async function dm(opts: { roomTier: 'full' | 'research'; ceiling: 'full' | 'research'; workingDir: string | null }) {
  const id = `stub-dm-${n++}`
  const stub = makeStubBrain({ id })
  const undo = registerAdapter(stub.adapter)
  const project = db.createProject(`DM ${n}`)
  if (opts.workingDir) db.updateProject(project.id, { workingDir: opts.workingDir })
  const agent = db.createAgent({
    name: `Solo-${n}`, role: '', avatarColor: '#000', personaKey: 'skeptic', personaExtra: '',
    brain: id, model: 'stub-1', tierCeiling: opts.ceiling,
  })
  const room = db.createRoom(project.id, `dm-${n}`, 'dm', [agent.id], opts.roomTier)
  const trigger = db.insertMessage({ roomId: room.id, authorType: 'human', body: 'explain round 3 to me' })
  await replyInDm(room, trigger)
  undo()
  return { call: stub.calls[0], room }
}

test('a DM never grants more than the agent\'s own ceiling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-dm-dir-'))
  const { call } = await dm({ roomTier: 'full', ceiling: 'research', workingDir: dir })
  assert.equal(call.tier, 'research', 'a Full chat gave a Research-capped agent write and shell')
  assert.equal(call.workingDir, null)
})

test('a DM at a file tier with no working directory is downgraded, not run unconfined', async () => {
  const { call, room } = await dm({ roomTier: 'full', ceiling: 'full', workingDir: null })
  assert.equal(call.tier, 'research')
  assert.ok(db.listEvents(room.id).some(e => e.type === 'tier.downgraded'))
})

test('a DM that may touch files is confined to the project directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-dm-dir-'))
  const { call } = await dm({ roomTier: 'full', ceiling: 'full', workingDir: dir })
  assert.equal(call.tier, 'full')
  assert.equal(call.workingDir, dir)
})
