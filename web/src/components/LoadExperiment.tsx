import { useRef, useState } from 'react'
import { api } from '../lib/api.ts'

const SAMPLE = `{
  "room": { "name": "Sensor choice", "tier": "reasoning" },
  "agents": [
    { "name": "Alice", "persona": "mathematician",   "brain": "claude" },
    { "name": "Bruno", "persona": "skeptic",         "brain": "claude" },
    { "name": "Curie", "persona": "experimentalist", "brain": "claude" }
  ],
  "question": "…something with two defensible answers…",
  "mode": "conclave",
  "rounds": 5
}`

/**
 * Load an experiment file into the interface.
 *
 * The same format and the same parser the headless runner uses, so a config that
 * works in CI works here. It sets up the cast and the room and stops there —
 * starting a run costs money, so that stays a separate, deliberate press.
 */
/** Everything the file said about the run, not just the question. */
export interface LoadedRun {
  question: string
  mode?: string
  rounds?: number
  style?: 'parallel' | 'pingpong'
  sealedOpening?: boolean
}

export function LoadExperiment({ onClose, onLoaded }: {
  onClose: () => void
  onLoaded: (roomId: string, run: LoadedRun) => void
}) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const readFile = async (file: File) => {
    setError(null)
    setText(await file.text())
  }

  const load = async () => {
    if (!text.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await api('/api/experiments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: text }),
      })
      const body = await res.json()
      if (!res.ok) { setError(body.error ?? 'could not load that file'); return }
      onLoaded(body.room.id, body.deliberation)
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <div className="sheet" onMouseDown={e => e.stopPropagation()}>
        <h2>Load an experiment</h2>
        <p className="muted">
          A JSONC file describing the cast, their personas and brains, the question and
          the rounds — the same format the headless runner takes. Comments are allowed.
        </p>

        <div
          className={`dropzone ${dragging ? 'over' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => {
            e.preventDefault(); setDragging(false)
            const f = e.dataTransfer.files[0]
            if (f) void readFile(f)
          }}
          onClick={() => fileInput.current?.click()}
        >
          {dragging ? 'Drop it here' : 'Drop a .jsonc file here, or click to choose one'}
          <input ref={fileInput} type="file" accept=".json,.jsonc,.txt" hidden
                 onChange={e => { const f = e.target.files?.[0]; if (f) void readFile(f) }} />
        </div>

        <label className="field">
          <span>Or paste it</span>
          <textarea
            rows={12} value={text} spellCheck={false}
            placeholder={SAMPLE}
            onChange={e => { setText(e.target.value); setError(null) }}
          />
        </label>

        {error && (
          <p className="config-error">
            {error}
          </p>
        )}

        <div className="sheet-foot">
          <div className="foot-left">
            <button className="linkish" onClick={() => setText(SAMPLE)}>Use the example</button>
          </div>
          <div>
            <button onClick={onClose}>Cancel</button>
            <button className="primary" disabled={busy || !text.trim()} onClick={load}>
              {busy ? 'Loading…' : 'Create the room'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
