import { useEffect } from 'react'

export interface MenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
}

export function ContextMenu({ x, y, items, onClose }: {
  x: number; y: number; items: MenuItem[]; onClose: () => void
}) {
  useEffect(() => {
    const close = () => onClose()
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    // Capture phase so a click anywhere dismisses before it does anything else.
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [onClose])

  return (
    <div className="ctxmenu"
         style={{ left: Math.min(x, window.innerWidth - 220), top: Math.min(y, window.innerHeight - items.length * 30 - 12) }}
         onMouseDown={e => e.stopPropagation()}>
      {items.map(it => (
        <button key={it.label} className={it.danger ? 'danger' : ''}
                onClick={() => { it.onSelect(); onClose() }}>
          {it.label}
        </button>
      ))}
    </div>
  )
}
