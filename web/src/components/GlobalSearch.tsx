import { useEffect, useRef, useState } from 'react'
import type { Message } from '../types.ts'
import { api } from '../lib/api.ts'

interface Hit { message: Message; roomId: string; roomName: string; snippet: string; score?: number }
interface Status { available: boolean; model: string; indexed: number; pending: number; note: string }

/**
 * ⇧⌘F across every room (plan §21).
 *
 * Keyword and semantic results are shown as separate lists on purpose. They
 * answer different questions — "find this phrase" versus "find where we
 * discussed this" — and blending them into one ranked list would hide which
 * kind of match you got. When no local embedder is running, that is stated
 * rather than silently falling back to keyword only.
 */
export function GlobalSearch({ onOpen, onClose }: {
  onOpen: (roomId: string, messageId: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [semantic, setSemantic] = useState<Hit[] | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => {
    void api('/api/search/status').then(r => r.json()).then(setStatus).catch(() => {})
  }, [])

  useEffect(() => {
    if (q.trim().length < 3) { setHits([]); setSemantic(null); return }
    const id = setTimeout(() => {
      setBusy(true)
      void api(`/api/search?q=${encodeURIComponent(q)}`)
        .then(r => r.json())
        .then(d => { setHits(d.hits ?? []); setSemantic(d.semantic ?? null) })
        .finally(() => setBusy(false))
    }, 220)
    return () => clearTimeout(id)
  }, [q])

  const reindex = async () => {
    setBusy(true)
    const d = await api('/api/search/index', { method: 'POST' }).then(r => r.json())
    setStatus(d.status)
    setBusy(false)
  }

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <div className="gsearch" onMouseDown={e => e.stopPropagation()}>
        <input
          ref={input} value={q} placeholder="Search every room…"
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') onClose() }}
        />

        <div className="gsearch-status">
          {status?.available
            ? <>Semantic search on · {status.model.split('/').pop()} · {status.indexed} indexed
                {status.pending > 0 && <> · <button className="linkish" onClick={reindex}>index {status.pending} more</button></>}
              </>
            : <>Semantic search off — start a local embedding server to search by meaning. Keyword search still works.</>}
          {busy && <span className="spin"> ◍</span>}
        </div>

        <div className="gsearch-body">
          {semantic && semantic.length > 0 && (
            <>
              <h4>By meaning</h4>
              {semantic.map(h => (
                <HitRow key={'s' + h.message.id} hit={h} onOpen={onOpen} showScore />
              ))}
            </>
          )}
          {hits.length > 0 && (
            <>
              <h4>Exact matches</h4>
              {hits.map(h => <HitRow key={'k' + h.message.id} hit={h} onOpen={onOpen} />)}
            </>
          )}
          {q.trim().length >= 3 && !busy && !hits.length && !semantic?.length && (
            <p className="muted tab-empty">Nothing found.</p>
          )}
        </div>
      </div>
    </div>
  )
}

function HitRow({ hit, onOpen, showScore }: {
  hit: Hit; onOpen: (roomId: string, messageId: string) => void; showScore?: boolean
}) {
  return (
    <button className="hitrow" onClick={() => onOpen(hit.roomId, hit.message.id)}>
      <div className="hitrow-meta">
        <span className="hitrow-room">{hit.roomName}</span>
        {hit.message.round != null && <span className="muted">Round {hit.message.round}</span>}
        {showScore && hit.score != null && <span className="muted">{hit.score.toFixed(2)}</span>}
      </div>
      <div className="hitrow-snippet">{hit.snippet}</div>
    </button>
  )
}
