import { useEffect, useState } from 'react'
import type { Message } from '../types.ts'
import { api } from '../lib/api.ts'
import { describeTurn, type ContextLines, type TurnContextResponse } from '../lib/turnContext.ts'

/**
 * "What did Alice see?" (plan §5.3). The prompts themselves are not stored, only
 * a digest of what went in, so this shows the shape of the turn: which sections,
 * how big, what was trimmed, and the steer verbatim.
 */
export function TurnContextSheet({ message, author, onClose }: {
  message: Message
  author: string
  onClose: () => void
}) {
  const [lines, setLines] = useState<ContextLines | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api(`/api/messages/${message.id}/context`)
      .then(async r => {
        const body = await r.json().catch(() => ({}))
        if (!live) return
        if (!r.ok) setError(body.error ?? `could not load (${r.status})`)
        else setLines(describeTurn(body as TurnContextResponse))
      })
      .catch(() => { if (live) setError('the daemon did not answer') })
    return () => { live = false }
  }, [message.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <div className="sheet turn-context" onMouseDown={e => e.stopPropagation()} role="dialog"
           aria-label={`What ${author} saw`}>
        <h2>What {author} saw</h2>
        {error && <p className="muted">No record for this message: {error}.</p>}
        {!lines && !error && <p className="muted">Loading…</p>}
        {lines && (
          <>
            <ul className="tc-facts">{lines.facts.map(f => <li key={f}>{f}</li>)}</ul>
            {lines.sections.length > 0 && (
              <div className="tc-sections">
                {lines.sections.map(s => (
                  <div key={s.label} className="tc-section">
                    <span className="tc-label">{s.label}</span>
                    <span className="tc-bar"><span style={{ width: `${Math.max(2, s.share * 100)}%` }} /></span>
                    <span className="tc-size">{s.size}</span>
                  </div>
                ))}
              </div>
            )}
            {lines.steers.length > 0 && (
              <>
                <h3 className="tc-h">Steers it was given</h3>
                {lines.steers.map((s, i) => <blockquote key={i} className="tc-steer">{s}</blockquote>)}
              </>
            )}
            {lines.outcome.length > 0 && <p className="muted tc-outcome">{lines.outcome.join(' · ')}</p>}
          </>
        )}
        <div className="ask-actions tc-actions"><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  )
}
