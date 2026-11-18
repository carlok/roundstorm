/**
 * The two live lines in the control bar: where the room stands, and what the run
 * has cost so far. Pure, so they are tested without a browser.
 */
import type { Deliberation, Message } from '../types.ts'
import type { LedgerSummary } from '../types.ts'
import { formatCost, sumCost } from '../../../server/src/deliberation/cost.ts'
import { conclaveCap } from '../../../server/src/types.ts'

/** "Round 3 of 5", or for a conclave "Round 3 of at most 8". */
export function roundLine(d: Pick<Deliberation, 'mode' | 'rounds' | 'currentRound'>): string {
  const now = Math.max(1, d.currentRound)
  return d.mode === 'conclave' ? `Round ${now} of at most ${conclaveCap(d.rounds)}` : `Round ${now} of ${d.rounds}`
}

/**
 * "P2 v3 · Oil whip · 3 of 4 back it · holding out: Bruno".
 * Null when nothing is on the record yet. Support counts at the current version,
 * which for a conclave is exactly what unanimity is measured against, so it says so.
 */
export function standingLine(summary: LedgerSummary | null, mode: Deliberation['mode']): string | null {
  const s = summary?.standing
  if (!s) return null
  const verb = mode === 'conclave' ? 'endorse this version' : 'back it'
  const head = `${s.label} v${s.version} · ${s.title} · ${s.backers.length} of ${s.n} ${verb}`
  if (!s.holdouts.length) return head
  const names = s.holdouts.length > 3 ? `${s.holdouts.slice(0, 3).join(', ')} +${s.holdouts.length - 3}` : s.holdouts.join(', ')
  return `${head} · holding out: ${names}`
}

/** Cost of this run's agent turns: "n/a" when no brain reports one, "at least …" when some do not. */
export function runCost(messages: Message[], deliberationId: string): string {
  return formatCost(sumCost(messages.filter(m => m.deliberationId === deliberationId && m.authorType === 'agent')))
}
