/**
 * Filtering the activity log by agent, round and event type (plan §12). Pure, so
 * it is tested without a browser.
 */
import type { LogEntry } from '../types.ts'

export interface ActivityFilter { agentId: string; type: string; round: string }
export const NO_FILTER: ActivityFilter = { agentId: '', type: '', round: '' }

const roundOf = (e: LogEntry): number | null => {
  const r = (e.payload as { round?: unknown } | null)?.round
  return typeof r === 'number' ? r : null
}

/** The values worth offering in each filter, from what the log actually holds. */
export function activityFacets(events: LogEntry[]): { types: string[]; rounds: number[]; agentIds: string[] } {
  const types = new Set<string>(), rounds = new Set<number>(), agents = new Set<string>()
  for (const e of events) {
    types.add(e.type)
    const r = roundOf(e)
    if (r != null) rounds.add(r)
    if (e.agentId) agents.add(e.agentId)
  }
  return {
    types: [...types].sort(),
    rounds: [...rounds].sort((a, b) => a - b),
    agentIds: [...agents],
  }
}

export function filterActivity(events: LogEntry[], f: ActivityFilter): LogEntry[] {
  return events.filter(e =>
    (!f.agentId || e.agentId === f.agentId)
    && (!f.type || e.type === f.type)
    && (!f.round || roundOf(e) === Number(f.round)))
}
