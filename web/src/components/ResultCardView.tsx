import type React from 'react'
import { useState } from 'react'
import type { ResultCard } from '../types.ts'
import { Markdown } from './Markdown.tsx'

const LEVEL_LABEL: Record<string, string> = {
  strong_consensus: 'Strong consensus',
  consensus_with_reservations: 'Consensus with reservations',
  two_positions: 'Two competing positions remain',
  no_reliable_conclusion: 'No reliable conclusion',
  evidence_required: 'Additional evidence required',
  conclave_reached: 'Unanimous — conclave reached',
  conclave_failed: 'Conclave failed to reach consensus',
}

/**
 * Pinned at the end of the transcript (plan §13). "Two positions remain" and
 * "conclave failed" are first-class outcomes here, styled as results rather
 * than as errors — an unresolved disagreement is a legitimate research finding.
 */
export function ResultCardView({ card, onCopy }: { card: ResultCard; onCopy: (c: ResultCard) => void }) {
  const [open, setOpen] = useState(true)
  const tone = card.level === 'conclave_failed' ? 'warn'
    : card.level === 'strong_consensus' || card.level === 'conclave_reached' ? 'good' : 'neutral'

  return (
    <div className={`resultcard tone-${tone}`}>
      <button className="result-head" onClick={() => setOpen(o => !o)}>
        <span className="result-kicker">Result</span>
        <span className="result-level">{LEVEL_LABEL[card.level] ?? card.level}</span>
        <span className="result-toggle">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="result-body">
          {card.failureReason && <p className="result-fail">{card.failureReason}</p>}

          <Section title="Best current conclusion">
            <Markdown>{card.conclusion}</Markdown>
          </Section>
          {card.why && <Section title="Why"><Markdown>{card.why}</Markdown></Section>}

          <List title="Common ground" items={card.commonGround} />
          <List title="Remaining disagreement" items={card.disagreement} />
          <List title="Alternative hypotheses" items={card.alternatives} />
          <List title="Evidence" items={card.evidence} />
          <List title="Unknowns" items={card.unknowns} />
          <List title="Recommended next steps" items={card.nextSteps} />

          {card.endorsements?.length ? (
            <Section title="Endorsements">
              <ul>{card.endorsements.map((e, i) => (
                <li key={i}>{e.restatement}{e.concession ? ` — conceded: ${e.concession}` : ''}</li>
              ))}</ul>
            </Section>
          ) : null}

          <div className="result-actions">
            <button onClick={() => onCopy(card)}>Copy as Markdown</button>
          </div>
        </div>
      )}
    </div>
  )
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="result-section"><h4>{title}</h4>{children}</div>
)

const List = ({ title, items }: { title: string; items: string[] }) =>
  items.length ? (
    <div className="result-section">
      <h4>{title}</h4>
      <ul>{items.map((it, i) => <li key={i}>{it}</li>)}</ul>
    </div>
  ) : null
