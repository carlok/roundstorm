import { useEffect, useRef } from 'react'

/** ⌘F within the room. A long transcript is unusable without it (plan §2.3). */
export function SearchBar({ query, setQuery, hits, index, onStep, onClose }: {
  query: string
  setQuery: (s: string) => void
  hits: number
  index: number
  onStep: (delta: number) => void
  onClose: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus(); input.current?.select() }, [])

  return (
    <div className="searchbar">
      <input
        ref={input} value={query} placeholder="Search this room…"
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape') onClose()
          else if (e.key === 'Enter') { e.preventDefault(); onStep(e.shiftKey ? -1 : 1) }
        }}
      />
      <span className="search-count">
        {query ? (hits ? `${index + 1} / ${hits}` : 'no matches') : ''}
      </span>
      <button onClick={() => onStep(-1)} disabled={!hits} title="Previous (⇧⏎)">↑</button>
      <button onClick={() => onStep(1)} disabled={!hits} title="Next (⏎)">↓</button>
      <button onClick={onClose} title="Close (esc)">✕</button>
    </div>
  )
}
