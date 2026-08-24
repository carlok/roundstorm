import { useEffect, useMemo, useRef, useState } from 'react'

export interface Command {
  id: string
  label: string
  hint?: string
  run: () => void
}

/** ⌘K: jump to a room or agent, start a deliberation, add rounds, stop (plan §2.3). */
export function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return commands.slice(0, 12)
    return commands
      .filter(c => (c.label + ' ' + (c.hint ?? '')).toLowerCase().includes(needle))
      .slice(0, 12)
  }, [q, commands])

  useEffect(() => { setSel(0) }, [q])

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={e => e.stopPropagation()}>
        <input
          ref={input} value={q} placeholder="Jump to a room, an agent, or an action…"
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, shown.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)) }
            else if (e.key === 'Enter' && shown[sel]) { shown[sel].run(); onClose() }
          }}
        />
        <div className="palette-list">
          {shown.map((c, i) => (
            <button key={c.id} className={i === sel ? 'sel' : ''}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => { c.run(); onClose() }}>
              <span>{c.label}</span>
              {c.hint && <small>{c.hint}</small>}
            </button>
          ))}
          {!shown.length && <div className="palette-empty">Nothing matches.</div>}
        </div>
      </div>
    </div>
  )
}
