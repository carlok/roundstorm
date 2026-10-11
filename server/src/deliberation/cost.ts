/**
 * Cost is reported by some brains and not others, so an unknown cost is not a
 * zero. Summing `null` as 0 made a run of unpriced brains look free, and made a
 * persona-lab comparison between a priced and an unpriced arm look like a
 * saving. These helpers keep "unknown" distinct all the way to the display.
 */
export interface CostSummary {
  /** Sum of the turns that reported a cost; null when none did. */
  usd: number | null
  /** Turns that reported a cost. */
  priced: number
  /** Turns counted. */
  turns: number
}

export function sumCost(items: ReadonlyArray<{ costUsd: number | null }>): CostSummary {
  let usd = 0, priced = 0
  for (const it of items) {
    if (it.costUsd == null) continue
    usd += it.costUsd
    priced++
  }
  return { usd: priced ? Number(usd.toFixed(4)) : null, priced, turns: items.length }
}

/** "n/a", "$0.042", or "at least $0.042 (2 of 5 turns priced)". */
export function formatCost(c: CostSummary, digits = 3): string {
  if (c.usd == null) return 'n/a'
  const amount = `$${c.usd.toFixed(digits)}`
  return c.priced < c.turns ? `at least ${amount} (${c.priced} of ${c.turns} turns priced)` : amount
}
