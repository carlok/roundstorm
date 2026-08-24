import { useEffect, useRef, useState } from 'react'

/**
 * In-app confirm and prompt.
 *
 * WKWebView — which is what the desktop shell renders in — does not implement
 * `window.prompt` at all: it returns null without showing anything, so a rename
 * built on it silently does nothing. `confirm` fares better but is inconsistent
 * across shells. Owning both removes a class of bug that only ever appears in
 * the packaged app, which is the hardest place to notice it.
 */
export interface AskSpec {
  title: string
  detail?: string
  /** Present for a prompt, absent for a confirm. */
  defaultValue?: string
  placeholder?: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: (value: string) => void
}

export function Ask({ spec, onClose }: { spec: AskSpec; onClose: () => void }) {
  const isPrompt = spec.defaultValue !== undefined
  const [value, setValue] = useState(spec.defaultValue ?? '')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => { input.current?.select() }, [])

  const confirm = () => {
    if (isPrompt && !value.trim()) return
    spec.onConfirm(value.trim())
    onClose()
  }

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <div className="ask" onMouseDown={e => e.stopPropagation()}>
        <h3>{spec.title}</h3>
        {spec.detail && <p className="ask-detail">{spec.detail}</p>}
        {isPrompt && (
          <input
            ref={input} value={value} autoFocus placeholder={spec.placeholder}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') confirm()
              else if (e.key === 'Escape') onClose()
            }}
          />
        )}
        <div className="ask-actions">
          <button onClick={onClose}>Cancel</button>
          <button className={spec.danger ? 'primary danger-btn' : 'primary'}
                  autoFocus={!isPrompt}
                  disabled={isPrompt && !value.trim()}
                  onClick={confirm}>
            {spec.confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}
