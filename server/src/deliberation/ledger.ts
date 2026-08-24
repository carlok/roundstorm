/**
 * The positions ledger (plan §3, §7, §20).
 *
 * This is what makes consensus a computed fact rather than a narrated vibe.
 * The synthesiser reads the level off the ledger first and only then writes
 * prose about it, so it cannot claim agreement the record does not show.
 */
import * as db from '../db.ts'
import { nearest } from '../search/embeddings.ts'
import type { Agent, ConsensusLevel, Position } from '../types.ts'
import type { RawPositionOp } from './contract.ts'

/**
 * How close two position statements must be before one is treated as a restatement
 * of the other.
 *
 * Measured on real output rather than guessed: across five positions that were
 * genuinely the same claim ("hysteresis band alone is insufficient", four other
 * phrasings of it) pairwise similarity ran 0.73–0.99, while every pair of
 * genuinely distinct positions topped out at 0.60. 0.70 sits in that gap with
 * margin on both sides.
 */
const DUPLICATE_THRESHOLD = 0.70

export async function applyPositionOps(args: {
  roomId: string
  agent: Agent
  ops: RawPositionOp[]
  messageId: string
  round: number | null
  /** True when the agent could not see the other positions as it wrote. */
  blind?: boolean
}): Promise<void> {
  const { roomId, agent, ops, messageId, round, blind } = args

  for (const op of ops) {
    let row = op.label ? db.getPositionByLabel(roomId, op.label) : null
    let mergedInto: string | null = null

    if (!row && op.title) {
      // Agents restate a peer's position under a new title instead of endorsing
      // it, which fragments the ledger and makes a room in unanimous agreement
      // report as "no reliable conclusion". Telling them not to helps but does
      // not fix the sealed opening round, where nobody can see the others.
      // So: catch the restatement here and record it as an endorsement.
      const statement = `${op.title}. ${op.text || op.note}`.trim()
      const existing = db.listPositions(roomId)
      const hit = await nearest(
        statement,
        existing.map(p => ({ id: p.id, text: `${p.title}. ${p.text}`.trim() })),
        DUPLICATE_THRESHOLD)

      if (hit) {
        const target = existing.find(p => p.id === hit.id)!
        mergedInto = target.label
        row = { id: target.id, version: target.version }
        db.logEvent('position.merged', {
          roomId, agentId: agent.id,
          payload: {
            into: target.label, similarity: Number(hit.score.toFixed(3)),
            proposedTitle: op.title, messageId,
          },
        })
      } else {
        const created = db.createPosition(roomId, op.title, op.text || op.note, agent.id)
        row = { id: created.id, version: created.version }
      }
    }
    // A label that names nothing real is a hallucination, not a new position.
    if (!row) continue

    let version: number = row.version
    if (op.op === 'revise' && op.text) {
      version = db.revisePosition(row.id, op.text, op.title ?? undefined) || version
    }

    db.recordOp({
      positionId: row.id, version, agentId: agent.id,
      // A merged restatement is only an *endorsement* if the agent could
      // actually see what it is endorsing. In a sealed round nobody can, so
      // recording `endorse` there claims an agreement that never happened —
      // it was independent co-assertion. The consensus level comes out the
      // same either way; the provenance does not, and provenance is the whole
      // point of keeping a ledger.
      op: mergedInto
        ? (blind ? 'assert' : 'endorse')
        : (op.op === 'revise' ? 'assert' : op.op),
      note: mergedInto
        ? `${op.note}${op.note ? ' ' : ''}[${blind ? 'independently stated' : 'restated'} ${mergedInto} as "${op.title}"]`
        : op.note,
      messageId, round,
    })
  }
}

export interface LedgerSummary {
  positions: Position[]
  leading: Position | null
  level: ConsensusLevel
  headline: string
}

const SUPPORT = new Set(['assert', 'endorse'])

export function summarise(roomId: string, roster: Agent[]): LedgerSummary {
  const positions = db.listPositions(roomId)
  const live = positions.filter(p =>
    p.stances.some(s => s.op !== 'withdraw'))

  if (!live.length) {
    return {
      positions, leading: null,
      level: 'no_reliable_conclusion',
      headline: 'No position was put on the record',
    }
  }

  const score = (p: Position) => p.stances.filter(s => SUPPORT.has(s.op)).length
  const ranked = [...live].sort((a, b) => score(b) - score(a))
  const leading = ranked[0]

  const supporters = score(leading)
  const opposers = leading.stances.filter(s => s.op === 'oppose').length
  const unsure = leading.stances.filter(s => s.op === 'unsure').length
  const n = roster.length || 1

  // A second position with real backing is the interesting outcome, not a
  // failure — say so instead of averaging it away (plan §20).
  const rival = ranked[1] && score(ranked[1]) >= 2 ? ranked[1] : null

  let level: ConsensusLevel
  if (supporters === n && opposers === 0) level = 'strong_consensus'
  else if (rival && score(rival) >= supporters - 1) level = 'two_positions'
  else if (supporters >= n - 1 && opposers <= 1) level = 'consensus_with_reservations'
  else if (unsure >= Math.ceil(n / 2)) level = 'evidence_required'
  else if (supporters < 2) level = 'no_reliable_conclusion'
  else level = 'consensus_with_reservations'

  return { positions, leading, level, headline: LEVEL_LABEL[level] }
}

export const LEVEL_LABEL: Record<ConsensusLevel, string> = {
  strong_consensus: 'Strong consensus',
  consensus_with_reservations: 'Consensus with reservations',
  two_positions: 'Two competing positions remain',
  no_reliable_conclusion: 'No reliable conclusion',
  evidence_required: 'Additional evidence required',
  conclave_reached: 'Unanimous — conclave reached',
  conclave_failed: 'Conclave failed to reach consensus',
}

/** Rendered into every post-round prompt so agents argue about a shared record. */
export function renderLedger(roomId: string, roster: Agent[]): string {
  const positions = db.listPositions(roomId)
  if (!positions.length) return ''
  const nameOf = (id: string) => roster.find(a => a.id === id)?.name ?? 'someone'

  const lines = ['# Positions on the record', '']
  for (const p of positions) {
    lines.push(`**${p.label}** (v${p.version}) — ${p.title}`)
    if (p.text) lines.push(p.text)
    if (p.stances.length) {
      lines.push(p.stances
        .map(s => `${nameOf(s.agentId)}: ${s.op}${s.note ? ` (${s.note})` : ''}`)
        .join(' · '))
    } else {
      lines.push('_nobody has taken a stance yet_')
    }
    lines.push('')
  }
  return lines.join('\n')
}
