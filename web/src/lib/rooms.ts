/**
 * Room-level awareness that is not about the open room: what to tell the user
 * when a run elsewhere ends, and how many messages arrived while they were
 * scrolled up. Pure, so it is tested without a browser.
 */
import type { ConsensusLevel, Room } from '../types.ts'
import { LEVEL_LABEL } from '../../../server/src/types.ts'

/** "Finished in “Sensor choice”: Strong consensus", or null for an unknown room. */
export function backgroundNotice(
  rooms: Pick<Room, 'id' | 'name'>[], roomId: string,
  what: { level?: ConsensusLevel; status?: string },
): string | null {
  const room = rooms.find(r => r.id === roomId)
  if (!room) return null
  if (what.level) return `Finished in “${room.name}”: ${LEVEL_LABEL[what.level] ?? what.level}`
  if (what.status === 'stopped') return `The run in “${room.name}” was stopped`
  if (what.status === 'failed') return `The run in “${room.name}” failed; its activity log says why`
  return null
}

/**
 * New messages since the reader scrolled away from the bottom. Counts only
 * growth of the list, so a reveal that updates sealed turns in place is not
 * "new", and a shorter list (a room switch, a clear) resets it.
 */
export function unseenAfter(prevCount: number, nextCount: number, unseen: number, atBottom: boolean): number {
  if (atBottom || nextCount < prevCount) return 0
  return unseen + (nextCount - prevCount)
}
