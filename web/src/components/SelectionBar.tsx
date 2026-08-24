import { useEffect, useState } from 'react'
import { copyText } from '../lib/clipboard.ts'

interface Pos { x: number; y: number; text: string }

/**
 * Select text → Quote / Copy / Ask about this (plan §2.3).
 * Citing one participant's sentence when addressing another is the single most
 * common thing a reader does with a transcript, so it gets one gesture.
 */
export function SelectionBar({ onQuote, onAsk }: {
  onQuote: (text: string) => void
  onAsk: (text: string) => void
}) {
  const [pos, setPos] = useState<Pos | null>(null)

  useEffect(() => {
    const update = () => {
      const sel = window.getSelection()
      const text = sel?.toString().trim() ?? ''
      if (!sel || sel.isCollapsed || text.length < 2) return setPos(null)
      const anchor = sel.anchorNode as HTMLElement | null
      const el = anchor?.nodeType === 3 ? anchor.parentElement : anchor
      if (!el?.closest('.transcript')) return setPos(null)
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      setPos({ x: rect.left + rect.width / 2, y: rect.top - 8, text })
    }
    document.addEventListener('selectionchange', update)
    document.addEventListener('scroll', () => setPos(null), true)
    return () => document.removeEventListener('selectionchange', update)
  }, [])

  if (!pos) return null

  const clear = () => {
    window.getSelection()?.removeAllRanges()
    setPos(null)
  }

  return (
    <div className="selbar" style={{ left: pos.x, top: pos.y }}
         onMouseDown={e => e.preventDefault()}>
      <button onClick={() => { onQuote(pos.text); clear() }}>Quote</button>
      <button onClick={() => { void copyText(pos.text); clear() }}>Copy</button>
      <button onClick={() => { onAsk(pos.text); clear() }}>Ask about this</button>
    </div>
  )
}
