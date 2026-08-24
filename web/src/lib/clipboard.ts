import type { Agent, Message, ResultCard } from '../types.ts'

const LEVEL_LABEL: Record<string, string> = {
  strong_consensus: 'Strong consensus',
  consensus_with_reservations: 'Consensus with reservations',
  two_positions: 'Two competing positions remain',
  no_reliable_conclusion: 'No reliable conclusion',
  evidence_required: 'Additional evidence required',
  conclave_reached: 'Unanimous — conclave reached',
  conclave_failed: 'Conclave failed to reach consensus',
}

export function resultToMarkdown(c: ResultCard): string {
  const list = (title: string, items: string[]) =>
    items.length ? `\n### ${title}\n\n${items.map(i => `- ${i}`).join('\n')}\n` : ''
  return [
    `## Result — ${LEVEL_LABEL[c.level] ?? c.level}`,
    c.failureReason ? `\n> ${c.failureReason}\n` : '',
    `\n### Best current conclusion\n\n${c.conclusion}\n`,
    c.why ? `\n### Why\n\n${c.why}\n` : '',
    list('Common ground', c.commonGround),
    list('Remaining disagreement', c.disagreement),
    list('Alternative hypotheses', c.alternatives),
    list('Evidence', c.evidence),
    list('Unknowns', c.unknowns),
    list('Recommended next steps', c.nextSteps),
  ].filter(Boolean).join('')
}

/**
 * Copy semantics matter more here than in an ordinary chat app: people move
 * equations and derivations out of this transcript into papers and notebooks.
 * ⌘C must yield source, not glyphs, and never the UI's own chips.
 */
export function messageToMarkdown(m: Message, agent: Agent | null): string {
  const who = m.authorType === 'human' ? 'You' : agent?.name ?? 'Unknown'
  const brain = agent ? ` (${agent.brain}${agent.model ? `/${agent.model}` : ''})` : ''
  const round = m.round != null ? ` · Round ${m.round}` : ''
  const claims = m.claims.length
    ? '\n\n' + m.claims.map(c => `- [${c.basis}] ${c.text}`).join('\n')
    : ''
  return `**${who}**${brain}${round}\n\n${m.body.trim()}${claims}`
}

export function transcriptToMarkdown(
  messages: Message[], agentOf: (id: string | null) => Agent | null,
): string {
  const out: string[] = []
  let round: number | null = null
  for (const m of messages) {
    if (m.round !== round && m.round != null) {
      out.push(`\n## Round ${m.round}\n`)
      round = m.round
    }
    out.push(messageToMarkdown(m, agentOf(m.authorId)))
  }
  return out.join('\n\n')
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // The async clipboard API needs a secure context; this keeps ⌘C working
    // over plain http://localhost.
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}
