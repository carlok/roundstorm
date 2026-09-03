/**
 * Conclave (plan §7).
 *
 * The mode people will talk about and the easiest to get wrong. A conclave that
 * rubber-stamps is worse than no conclave, so unanimity is a *computed* fact
 * over the ledger and three mechanisms stand between the room and fake
 * agreement:
 *
 *  1. Endorsement is expensive. To endorse you must restate the position in
 *     your own words AND name the concession you made. A bare "agreed" is
 *     rejected by the contract and re-requested.
 *  2. The devil's seat rotates and cannot pass. Someone is always obliged to
 *     attack the current draft, so it never happens that everyone is agreeable
 *     in the same round by accident.
 *  3. Endorsements expire on revision. Materially changing the proposal
 *     invalidates every yes collected against the old version.
 *
 * And on the cap: report failure. Never soften it into agreement.
 */
import type { Agent, Deliberation, Message, Room } from '../types.ts'
import * as db from '../db.ts'
import { bus } from '../bus.ts'

export interface TurnRunner {
  (args: {
    agent: Agent; room: Room; roster: Agent[]; deliberation: Deliberation
    round: number; history: Message[]; steers: Message[]; sealed: boolean
    signal: AbortSignal; extraInstruction?: string
  }): Promise<void>
}

export interface ConclaveOutcome {
  reached: boolean
  rounds: number
  positionId: string | null
  version: number
  holdouts: string[]
}

export async function runConclave(
  deliberationId: string, signal: AbortSignal, runTurn: TurnRunner,
): Promise<ConclaveOutcome> {
  const cap = () => {
    const d = db.getDeliberation(deliberationId)
    // `rounds` is the emergency maximum here, not a target. Keep a floor so a
    // conclave started at "3 rounds" still gets room to actually negotiate.
    return Math.max(4, d?.rounds ?? 8)
  }

  let outcome: ConclaveOutcome = {
    reached: false, rounds: 0, positionId: null, version: 0, holdouts: [],
  }

  for (let round = 1; round <= cap(); round++) {
    const d = db.getDeliberation(deliberationId)
    if (!d || d.status !== 'running' || signal.aborted) break

    const room = db.getRoom(d.roomId)
    if (!room) break
    const roster = room.memberIds.map(id => db.getAgent(id)).filter((a): a is Agent => !!a)
    if (roster.length < 2) break

    db.updateDeliberation(d.id, { currentRound: round })
    bus.emit({ type: 'deliberation', deliberation: db.getDeliberation(d.id)! })

    // Both seats rotate, so no agent is permanently the author or the attacker.
    const chair = roster[(round - 1) % roster.length]
    const devil = roster[round % roster.length]

    const history = db.listMessages(d.roomId, false).filter(m => m.round == null || m.round < round)

    // Chair first: the room needs something concrete to attack.
    await runTurn({
      agent: chair, room, roster, deliberation: d, round, history, steers: [],
      sealed: false, signal,
      extraInstruction: chairInstruction(round),
    })
    if (signal.aborted) break

    const afterChair = db.listMessages(d.roomId, false)
    const rest = roster.filter(a => a.id !== chair.id)

    await Promise.all(rest.map(agent => runTurn({
      agent, room, roster, deliberation: d, round,
      history: afterChair, steers: [], sealed: false, signal,
      extraInstruction: agent.id === devil.id ? DEVIL_INSTRUCTION : endorseInstruction(),
    })))
    if (signal.aborted) break

    const check = tally(d.roomId, roster, d.id)
    outcome = { ...check, rounds: round }
    db.logEvent('conclave.round', {
      roomId: d.roomId, deliberationId: d.id,
      payload: {
        round, chair: chair.name, devil: devil.name,
        reached: check.reached, holdouts: check.holdouts,
      },
    })

    if (check.reached) {
      db.logEvent('conclave.reached', {
        roomId: d.roomId, deliberationId: d.id,
        payload: { round, positionId: check.positionId, version: check.version },
      })
      return outcome
    }
  }

  db.logEvent('conclave.failed', {
    roomId: db.getDeliberation(deliberationId)?.roomId, deliberationId,
    payload: { rounds: outcome.rounds, holdouts: outcome.holdouts },
  })
  return outcome
}

/**
 * Unanimity means every participant supports the SAME position at its CURRENT
 * version. Version matters: a revision wipes prior endorsements, so a yes
 * collected against v3 does not count toward v4.
 */
function tally(roomId: string, roster: Agent[], deliberationId: string): Omit<ConclaveOutcome, 'rounds'> {
  // Scoped to this run. Unscoped, a second conclave in a room whose first one
  // reached unanimity found that old position still endorsed by everyone and
  // returned `reached` at round 1 — the run did not just get a wrong label, it
  // stopped before anyone spoke.
  const positions = db.listPositions(roomId, { deliberationId })
  for (const p of positions) {
    const supporting = p.stances.filter(
      s => (s.op === 'endorse' || s.op === 'assert') && s.version === p.version)
    const ids = new Set(supporting.map(s => s.agentId))
    if (roster.every(a => ids.has(a.id))) {
      return { reached: true, positionId: p.id, version: p.version, holdouts: [] }
    }
  }
  const best = positions
    .map(p => ({
      p,
      n: p.stances.filter(s => (s.op === 'endorse' || s.op === 'assert') && s.version === p.version).length,
    }))
    .sort((a, b) => b.n - a.n)[0]

  const holdouts = best
    ? roster.filter(a => !best.p.stances.some(
        s => s.agentId === a.id && (s.op === 'endorse' || s.op === 'assert') && s.version === best.p.version))
        .map(a => a.name)
    : roster.map(a => a.name)

  return {
    reached: false,
    positionId: best?.p.id ?? null,
    version: best?.p.version ?? 0,
    holdouts,
  }
}

const chairInstruction = (round: number) => `
You hold the chair this round. Draft — or revise — the single proposal the room is being asked to accept.

${round === 1
  ? 'Write the first proposal. State it as one clear position that could be endorsed or rejected as it stands.'
  : 'Take the objections raised against the current proposal and revise it. Say what you changed and why. If an objection cannot be accommodated, say so plainly rather than papering over it.'}

Record it with position_ops: ${round === 1 ? 'open a new position with a title, op "assert"' : 'op "revise" on the existing position, with the full revised text'}.
`.trim()

/**
 * The devil's duty is to ATTACK, not to dissent.
 *
 * The first version of this instruction told the devil to record `oppose`. That
 * makes unanimity structurally impossible: someone holds the seat every round,
 * so there is always at least one standing objection and the conclave can only
 * ever run to its cap. Observed in a real run — the holdout was the current
 * devil in four rounds out of five.
 *
 * So: mount the strongest attack available, then judge honestly whether it
 * landed. A devil whose own best objection fails is allowed to endorse.
 */
const DEVIL_INSTRUCTION = `
You hold the devil's seat this round. You are REQUIRED to attack the current proposal before doing anything else, and you may not pass.

First, mount the strongest attack available: a counterexample, an unstated assumption, a case where the procedure fails, a claim it cannot support. Even if you think the proposal is broadly right, go after its weakest load-bearing part — that is the job, and it is what stops this room agreeing with itself by accident.

Then judge your own attack honestly:

- If it lands and the proposal cannot survive it as written, use op "oppose" and name exactly what would have to change.
- If, having made the strongest case you can, the proposal survives it, say so and use op "endorse" — restating the proposal in your own words and naming the concession you made.

Attacking is compulsory. Dissenting is not. Do not oppose merely because you hold this seat.
`.trim()

const endorseInstruction = () => `
Decide on the current proposal.

To ENDORSE you must do two things in your message, or the endorsement does not count:
  1. Restate the proposal in your own words — not a paraphrase of the chair's sentence.
  2. Name the concession you made to get here: what you gave up, or what you were wrong about.

If you cannot do both honestly, do not endorse. Use op "oppose" and say precisely what would have to change. Holding out is a legitimate outcome; agreeing to be agreeable is not.

Record it with position_ops on the proposal's label: op "endorse" or "oppose".
`.trim()
