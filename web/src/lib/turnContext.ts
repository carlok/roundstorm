/**
 * "What did Alice see?" — turning the recorded digest of a turn into lines a
 * reader can scan. Pure, so it is tested without a browser.
 */
export interface TurnContextResponse {
  context: {
    round?: number; brain?: string; model?: string | null; tier?: string
    sections?: { name: string; chars: number }[]
    omittedMessages?: number
    systemPromptBytes?: number; userPromptBytes?: number
    promptDigest?: string; steers?: string[]; dm?: boolean
  } | null
  outcome: {
    stance?: string; claims?: number; degraded?: boolean; degradeReason?: string
    costUsd?: number | null; ms?: number
  } | null
  downgraded: { requested?: string; granted?: string; reason?: string } | null
}

const SECTION_LABEL: Record<string, string> = {
  question: 'Question and round',
  memory: 'Its memory',
  ledger: 'Positions ledger',
  sources: 'Sources',
  transcript: 'Discussion so far',
  steer: 'Your steer',
  instruction: 'Turn instruction',
}

const size = (chars: number) =>
  chars >= 10_000 ? `${Math.round(chars / 1000)}k chars` : `${chars.toLocaleString('en-US')} chars`

export interface ContextLines {
  facts: string[]
  sections: { label: string; size: string; share: number }[]
  steers: string[]
  outcome: string[]
}

export function describeTurn(r: TurnContextResponse): ContextLines {
  const c = r.context ?? {}
  const facts: string[] = []
  if (c.round) facts.push(`Round ${c.round}`)
  else if (c.dm) facts.push('Direct message')
  if (c.brain) facts.push(`${c.brain}${c.model ? ` · ${c.model}` : ''}`)
  if (c.tier) {
    facts.push(r.downgraded
      ? `Tier ${c.tier} (asked for ${r.downgraded.requested}: ${r.downgraded.reason ?? 'downgraded'})`
      : `Tier ${c.tier}`)
  }
  if (c.omittedMessages) {
    facts.push(`${c.omittedMessages} earlier message${c.omittedMessages === 1 ? '' : 's'} reduced to one line each to fit`)
  }
  if (c.userPromptBytes !== undefined) {
    facts.push(`Prompt ${size((c.systemPromptBytes ?? 0) + c.userPromptBytes)}${c.promptDigest ? ` · digest ${c.promptDigest}` : ''}`)
  }

  const total = (c.sections ?? []).reduce((n, s) => n + s.chars, 0) || 1
  const sections = (c.sections ?? []).map(s => ({
    label: SECTION_LABEL[s.name] ?? s.name, size: size(s.chars), share: s.chars / total,
  }))

  const o = r.outcome ?? {}
  const outcome: string[] = []
  if (o.stance) outcome.push(`Stance: ${o.stance}`)
  if (o.claims !== undefined) outcome.push(`${o.claims} claim${o.claims === 1 ? '' : 's'}`)
  if (o.degraded) outcome.push(`Unstructured${o.degradeReason ? ` (${o.degradeReason})` : ''}`)
  if (typeof o.costUsd === 'number') outcome.push(`$${o.costUsd.toFixed(4)}`)
  if (typeof o.ms === 'number') outcome.push(`${(o.ms / 1000).toFixed(1)}s`)

  return { facts, sections, steers: c.steers ?? [], outcome }
}
