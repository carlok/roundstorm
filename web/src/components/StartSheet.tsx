import { useState } from 'react'
import type { Agent, ModeInfo, Room } from '../types.ts'
import { Avatar } from './Avatar.tsx'

/** One sheet, sensible defaults, no schema editing (plan §2.5). */
/** What an experiment file asked for, when the sheet was opened by loading one. */
export interface StartPreset {
  mode?: string
  rounds?: number
  style?: 'parallel' | 'pingpong'
  sealedOpening?: boolean
}

export function StartSheet({ room, roster, modes, lastQuestion, preset, onStart, onClose }: {
  room: Room
  roster: Agent[]
  modes: ModeInfo[]
  /** Last thing the human said in this room, if anything. */
  lastQuestion: string
  /**
   * An experiment file's settings. Loading a file used to carry only the
   * question across, so `"mode": "conclave", "rounds": 5` silently became a
   * four-round deliberation — the run looked right and was not the experiment.
   * They are still shown in the form rather than started, so the file's choices
   * are visible and editable before anything is spent.
   */
  preset?: StartPreset
  onStart: (opts: Record<string, unknown>) => void
  onClose: () => void
}) {
  const [mode, setMode] = useState(preset?.mode ?? 'deliberation')
  const [rounds, setRounds] = useState(preset?.rounds ?? 4)
  const [style, setStyle] = useState<'parallel' | 'pingpong'>(preset?.style ?? 'parallel')
  const [sealedOpening, setSealed] = useState(preset?.sealedOpening ?? true)
  // Prefilled rather than left blank with a note saying the blank means
  // something. If you already typed the question into the composer, it is here;
  // if you did not, this is the only place you need to type it.
  const [question, setQuestion] = useState(lastQuestion)

  const blurb = modes.find(m => m.key === mode)?.blurb ?? ''
  // Rough, but shown before the button because deliberations cost real time and
  // real money and the user deserves to see that up front (plan §2.5).
  const turns = roster.length * rounds
  const minutes = Math.round((turns * (style === 'parallel' ? 12 : 20)) / (style === 'parallel' ? roster.length : 1) / 60)

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <h2>New deliberation</h2>

        <label className="field">
          <span>Question</span>
          <textarea
            autoFocus rows={4} value={question} onChange={e => setQuestion(e.target.value)}
            placeholder="What should they argue about? Give it a question with two defensible answers."
          />
          <small>
            {lastQuestion
              ? 'Taken from your last message. Edit it, or replace it entirely.'
              : 'You do not need to send anything first — this is the question they get.'}
          </small>
        </label>

        <label className="field">
          <span>Mode</span>
          <select value={mode} onChange={e => setMode(e.target.value)}>
            {modes.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
          <small>{blurb}</small>
        </label>

        <label className="field">
          <span>Rounds — {rounds}</span>
          <input type="range" min={1} max={10} value={rounds}
                 onChange={e => setRounds(Number(e.target.value))} />
        </label>

        <div className="field">
          <span>Discussion style</span>
          <div className="radios">
            <label><input type="radio" checked={style === 'parallel'}
                          onChange={() => setStyle('parallel')} /> Parallel</label>
            <label><input type="radio" checked={style === 'pingpong'}
                          onChange={() => setStyle('pingpong')} /> Conversation / ping-pong</label>
          </div>
          <small>
            {style === 'parallel'
              ? 'Everyone answers at once from the same starting point. Faster, keeps them independent.'
              : 'They speak in sequence and can react within the round. Slower, deeper chains.'}
          </small>
        </div>

        <div className="field">
          <label className="check">
            <input type="checkbox" checked={sealedOpening}
                   onChange={e => setSealed(e.target.checked)} />
            Sealed first round
          </label>
          <small>Each participant commits a position before seeing anyone else's. Reduces anchoring.</small>
        </div>

        <div className="field">
          <span>Cast — {roster.length}</span>
          <div className="cast">
            {roster.map(a => (
              <div key={a.id} className="cast-chip">
                <Avatar name={a.name} color={a.avatarColor} size={22} />
                <span>{a.name}</span>
                <small>{a.brain}</small>
              </div>
            ))}
          </div>
        </div>

        <div className="sheet-foot">
          <span className="estimate">
            {turns} turns · roughly {Math.max(1, minutes)} min · tier: {room.tier}
          </span>
          <div>
            <button onClick={onClose}>Cancel</button>
            <button className="primary" disabled={!question.trim()}
                    onClick={() => onStart({ mode, rounds, style, sealedOpening, question })}>
              Start
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
