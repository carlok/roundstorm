/**
 * Export (plan §12, §13). A conclusion whose provenance cannot be reconstructed
 * is not usable in a paper, so exports carry the ledger and the sources, not
 * just the prose.
 */
import type { Agent, Deliberation, Message, Position, ResultCard, Room, Source } from '../types.ts'
import { LEVEL_LABEL } from './ledger.ts'

export interface ExportPayload {
  room: Room
  agents: Agent[]
  messages: Message[]
  positions: Position[]
  sources: Source[]
  results: ResultCard[]
  deliberations: Deliberation[]
}

export function renderResultMarkdown(p: ExportPayload): string {
  const nameOf = (id: string | null) =>
    id ? p.agents.find(a => a.id === id)?.name ?? 'Unknown' : 'You'
  const brainOf = (id: string | null) => {
    const a = p.agents.find(x => x.id === id)
    return a ? ` *(${a.brain}${a.model ? `/${a.model}` : ''})*` : ''
  }

  const out: string[] = [`# ${p.room.name}`, '']

  for (const card of p.results) out.push(renderCard(card, nameOf), '')

  if (p.positions.length) {
    out.push('## Positions', '')
    for (const pos of p.positions) {
      out.push(`### ${pos.label} — ${pos.title} (v${pos.version})`)
      if (pos.text) out.push('', pos.text)
      out.push('')
      for (const s of pos.stances) {
        out.push(`- **${nameOf(s.agentId)}**: ${s.op}${s.note ? ` — ${s.note}` : ''}`)
      }
      out.push('')
    }
  }

  if (p.sources.length) {
    out.push('## Sources', '')
    for (const s of p.sources) {
      out.push(`- **${s.label}** ${s.title}${s.url ? ` — <${s.url}>` : ''}`)
    }
    out.push('')
  }

  out.push('## Transcript', '')
  let round: number | null = null
  for (const m of p.messages) {
    if (m.body.startsWith('__result__:')) continue
    if (m.round !== round && m.round != null) {
      out.push(`### Round ${m.round}`, '')
      round = m.round
    }
    out.push(`**${nameOf(m.authorId)}**${brainOf(m.authorId)}`, '', m.body.trim(), '')
    if (m.claims.length) {
      out.push(...m.claims.map(c => `- [${c.basis}] ${c.text}`), '')
    }
  }
  return out.join('\n')
}

export function renderCard(card: ResultCard, nameOf: (id: string | null) => string): string {
  const section = (title: string, items: string[]) =>
    items.length ? [`### ${title}`, '', ...items.map(i => `- ${i}`), ''].join('\n') : ''

  return [
    `## Result — ${LEVEL_LABEL[card.level]}`,
    '',
    card.failureReason ? `> ${card.failureReason}\n` : '',
    '### Best current conclusion', '', card.conclusion, '',
    card.why ? ['### Why', '', card.why, ''].join('\n') : '',
    section('Common ground', card.commonGround),
    section('Remaining disagreement', card.disagreement),
    section('Alternatives', card.alternatives),
    section('Evidence', card.evidence),
    section('Unknowns', card.unknowns),
    section('Recommended next steps', card.nextSteps),
    card.endorsements?.length
      ? ['### Endorsements', '',
         ...card.endorsements.map(e =>
           `- **${nameOf(e.agentId)}**: ${e.restatement}${e.concession ? ` *(conceded: ${e.concession})*` : ''}`),
         ''].join('\n')
      : '',
  ].filter(Boolean).join('\n')
}
