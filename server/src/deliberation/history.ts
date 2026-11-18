/**
 * The transcript an agent is shown, as a set of messages (rendering and the
 * size budget live in context.ts).
 */
import type { Deliberation, Message } from '../types.ts'
import * as db from '../db.ts'

/**
 * What an agent may see of the room's transcript before taking a turn in `round`.
 *
 * Filtering on the round number alone mixed runs: in a room's second deliberation,
 * round 3 showed the FIRST run's rounds 1 and 2 but not its rounds 3 to 5, under
 * duplicate "Round 1" headings, so how much of the earlier run an agent saw grew
 * with the round number. Now: every earlier run in full (the renderer labels it as
 * earlier), this run's rounds before `round`, and, in ping-pong, what has already
 * been said in this round. System lines (failure notices, result-card pointers) are
 * for the reader, not for the agents: rendered into a prompt they appeared under
 * the failing agent's own name.
 */
export function historyFor(d: Deliberation, round: number, opts: { sameRound?: boolean } = {}): Message[] {
  return db.listMessages(d.roomId, false).filter(m => {
    if (m.authorType === 'system') return false
    if (m.deliberationId !== d.id) return true
    if (m.round == null) return true
    return m.round < round || (!!opts.sameRound && m.round === round)
  })
}
