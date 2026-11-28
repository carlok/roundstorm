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
export function GlobalSearch({ onOpen, onClose, room }: {
  onOpen: (roomId: string, messageId: string) => void
  onClose: () => void
  /** The open room, offered as a narrower scope. */
  room?: { id: string; name: string } | null
}) {
  const [q, setQ] = useState('')
  const [scope, setScope] = useState<'all' | 'room'>('all')
  const roomId = scope === 'room' && room ? room.id : null
  const [hits, setHits] = useState<Hit[]>([])
  const [semantic, setSemantic] = useState<Hit[] | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  // Keyboard selection over both lists, in the order they are shown, like ⌘K.
  const [sel, setSel] = useState(0)
  const results = [...(semantic ?? []), ...hits]
  useEffect(() => { setSel(0) }, [hits, semantic])
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => {
    void api('/api/search/status').then(r => r.json()).then(setStatus).catch(() => {})
  }, [])

  useEffect(() => {
    if (q.trim().length < 3) { setHits([]); setSemantic(null); return }
    const id = setTimeout(() => {
      setBusy(true)
      void api(`/api/search?q=${encodeURIComponent(q)}${roomId ? `&roomId=${encodeURIComponent(roomId)}` : ''}`)
        .then(r => r.json())
        .then(d => { setHits(d.hits ?? []); setSemantic(d.semantic ?? null) })
        .finally(() => setBusy(false))
    }, 220)
    return () => clearTimeout(id)
  }, [q, roomId])

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
          ref={input} value={q} placeholder={roomId ? `Search “${room!.name}”…` : 'Search every room…'}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, results.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)) }
            else if (e.key === 'Enter' && results[sel]) { e.preventDefault(); onOpen(results[sel].roomId, results[sel].message.id) }
          }}
        />

        {room && (
          <div className="gsearch-scope" role="radiogroup" aria-label="Search scope">
            <button className={scope === 'all' ? 'sel' : ''} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>Every room</button>
            <button className={scope === 'room' ? 'sel' : ''} aria-pressed={scope === 'room'} onClick={() => setScope('room')}>Only “{room.name}”</button>
          </div>
        )}
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
              {semantic.map((h, i) => (
                <HitRow key={'s' + h.message.id} hit={h} onOpen={onOpen} showScore selected={i === sel} />
              ))}
            </>
          )}
          {hits.length > 0 && (
            <>
              <h4>Exact matches</h4>
              {hits.map((h, i) => <HitRow key={'k' + h.message.id} hit={h} onOpen={onOpen}
                                          selected={(semantic?.length ?? 0) + i === sel} />)}
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

function HitRow({ hit, onOpen, showScore, selected }: {
  hit: Hit; onOpen: (roomId: string, messageId: string) => void; showScore?: boolean; selected?: boolean
}) {
  return (
    <button className={`hitrow${selected ? ' sel' : ''}`} aria-selected={selected}
            ref={el => { if (selected) el?.scrollIntoView({ block: 'nearest' }) }}
            onClick={() => onOpen(hit.roomId, hit.message.id)}>
      <div className="hitrow-meta">
        <span className="hitrow-room">{hit.roomName}</span>
        {hit.message.round != null && <span className="muted">Round {hit.message.round}</span>}
        {showScore && hit.score != null && <span className="muted">{hit.score.toFixed(2)}</span>}
      </div>
      <div className="hitrow-snippet">{hit.snippet}</div>
    </button>
  )
}
