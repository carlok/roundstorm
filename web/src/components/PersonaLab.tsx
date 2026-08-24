import { useState } from 'react'
import type { BrainInfo, Persona } from '../types.ts'
import { api } from '../lib/api.ts'

interface ArmReport {
  roomId: string; roomName: string
  cast: { name: string; persona: string; brain: string; model: string | null }[]
  level: string; conclusion: string
  positions: { label: string; title: string; support: number; oppose: number }[]
  stanceMix: Record<string, number>; basisMix: Record<string, number>
  turns: number; degraded: number; concessions: number
  mindChanges: number; contested: number; costUsd: number; medianWords: number
}

/**
 * Persona lab (plan §5.1).
 *
 * The experiment the brief singles out: hold the personas fixed, vary the
 * brains, run the same question, and see what actually differs. It is worth
 * having as a product surface because doing it by hand — building two casts,
 * keeping the question identical, then comparing forty messages — is exactly
 * the manual bookkeeping this app exists to remove.
 */
export function PersonaLab({ personas, brains, projectId, rooms, onClose, onGoToRoom }: {
  personas: Persona[]
  brains: BrainInfo[]
  projectId: string
  rooms: { id: string; name: string }[]
  onClose: () => void
  onGoToRoom: (id: string) => void
}) {
  const [tab, setTab] = useState<'setup' | 'compare'>('setup')
  const [title, setTitle] = useState('Brain comparison')
  const [picked, setPicked] = useState<string[]>(['skeptic', 'mathematician', 'experimentalist'])
  const [selected, setSelected] = useState<string[]>([])
  const [report, setReport] = useState<{ arms: ArmReport[]; observations: string[] } | null>(null)
  const [busy, setBusy] = useState(false)

  const usable = brains.filter(b => b.available && b.models.length)

  const create = async () => {
    if (usable.length < 2) return
    setBusy(true)
    // Arm A: every persona on one brain. Arm B: personas spread across brains.
    // That is the actual comparison — homogeneous versus heterogeneous — rather
    // than an arbitrary permutation.
    const single = usable[0]
    const armA = Object.fromEntries(picked.map(k =>
      [k, { brain: single.id, model: single.models[0].id }]))
    const armB = Object.fromEntries(picked.map((k, i) => {
      const b = usable[i % usable.length]
      return [k, { brain: b.id, model: b.models[0].id }]
    }))
    await api('/api/lab/experiments', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId, title, personaKeys: picked,
        arms: [
          { name: `all ${single.label}`, assignment: armA },
          { name: 'mixed brains', assignment: armB },
        ],
      }),
    })
    setBusy(false)
    onClose()
  }

  const runCompare = async () => {
    if (selected.length < 2) return
    setBusy(true)
    const d = await api(`/api/lab/compare?rooms=${selected.join(',')}`).then(r => r.json())
    setReport(d)
    setBusy(false)
  }

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <div className="lab" onMouseDown={e => e.stopPropagation()}>
        <div className="tabs">
          <button className={tab === 'setup' ? 'sel' : ''} onClick={() => setTab('setup')}>Set up</button>
          <button className={tab === 'compare' ? 'sel' : ''} onClick={() => setTab('compare')}>Compare</button>
        </div>

        {tab === 'setup' && (
          <div className="lab-body">
            <p className="muted">
              Same personas, different brains, same question. Two rooms are created;
              ask each the identical question, then come back to Compare.
            </p>

            <label className="field">
              <span>Experiment name</span>
              <input value={title} onChange={e => setTitle(e.target.value)} />
            </label>

            <div className="field">
              <span>Personas — {picked.length}</span>
              <div className="chipgrid">
                {personas.map(p => (
                  <button key={p.key}
                          className={`pchip ${picked.includes(p.key) ? 'on' : ''}`}
                          title={p.blurb}
                          onClick={() => setPicked(v =>
                            v.includes(p.key) ? v.filter(x => x !== p.key) : [...v, p.key])}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <span>Brains available — {usable.length}</span>
              <small>
                {usable.length < 2
                  ? 'A comparison needs at least two working brains.'
                  : `Arm A: everyone on ${usable[0].label}. Arm B: spread across ${usable.map(b => b.label).join(', ')}.`}
              </small>
            </div>

            <div className="sheet-foot">
              <span className="estimate">{picked.length} agents × 2 rooms</span>
              <div>
                <button onClick={onClose}>Cancel</button>
                <button className="primary" disabled={busy || usable.length < 2 || !picked.length}
                        onClick={create}>Create rooms</button>
              </div>
            </div>
          </div>
        )}

        {tab === 'compare' && (
          <div className="lab-body">
            <div className="field">
              <span>Pick the rooms to compare</span>
              <div className="chipgrid">
                {rooms.map(r => (
                  <button key={r.id}
                          className={`pchip ${selected.includes(r.id) ? 'on' : ''}`}
                          onClick={() => setSelected(v =>
                            v.includes(r.id) ? v.filter(x => x !== r.id) : [...v, r.id])}>
                    {r.name}
                  </button>
                ))}
              </div>
            </div>
            <button className="primary" disabled={busy || selected.length < 2} onClick={runCompare}>
              Compare {selected.length || ''}
            </button>

            {report && (
              <>
                {report.observations.length > 0 && (
                  <div className="lab-obs">
                    {report.observations.map((o, i) => <p key={i}>{o}</p>)}
                  </div>
                )}
                <div className="lab-grid">
                  {report.arms.map(a => (
                    <div key={a.roomId} className="lab-arm">
                      <button className="lab-arm-name" onClick={() => { onGoToRoom(a.roomId); onClose() }}>
                        {a.roomName}
                      </button>
                      <div className="lab-level">{a.level}</div>
                      <dl>
                        <Row k="Brains" v={[...new Set(a.cast.map(c => c.brain))].join(', ')} />
                        <Row k="Turns" v={String(a.turns)} />
                        <Row k="Changed position" v={String(a.mindChanges)} />
                        <Row k="Contested" v={a.contested ? `${a.contested} position${a.contested === 1 ? '' : 's'}` : 'nothing opposed'} />
                        <Row k="Median words" v={String(a.medianWords)} />
                        <Row k="Unstructured" v={String(a.degraded)} />
                        <Row k="Cost" v={a.costUsd ? `$${a.costUsd.toFixed(3)}` : '—'} />
                        <Row k="Stances" v={mix(a.stanceMix)} />
                        <Row k="Claim basis" v={mix(a.basisMix)} />
                      </dl>
                      {a.positions.length > 0 && (
                        <ul className="lab-pos">
                          {a.positions.map(p => (
                            <li key={p.label}>
                              <b>{p.label}</b> {p.title.slice(0, 60)}
                              <span className="muted"> +{p.support}/−{p.oppose}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const Row = ({ k, v }: { k: string; v: string }) => (
  <><dt>{k}</dt><dd>{v || '—'}</dd></>
)

const mix = (m: Record<string, number>) =>
  Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')
