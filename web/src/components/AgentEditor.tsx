import { useMemo, useState } from 'react'
import type { Agent, BrainInfo, Persona, Tier } from '../types.ts'
import { Avatar } from './Avatar.tsx'
import { api } from '../lib/api.ts'

const TIERS: { key: Tier; label: string }[] = [
  { key: 'reasoning', label: '🔒 Reasoning only' },
  { key: 'research', label: '🌐 Research tools' },
  { key: 'workstation', label: '📖 Workstation (read-only)' },
  { key: 'full', label: '⚠️ Full local' },
]

const COLORS = ['#5b8def', '#e0616f', '#3fa87a', '#9b6dd6', '#d68c3f',
                '#4bb0c4', '#c95fa8', '#7a8a9e']

/**
 * Configure one researcher (plan §4.1, §5.1).
 *
 * The brain picker is deliberately flat — every (brain, model) pair is one
 * choice — because "which model" and "which harness" are the same decision from
 * the user's side, and Claude-via-`claude` really does behave differently from
 * Claude-via-`agy`.
 */
export function AgentEditor({ agent, personas, brains, onClose, onSaved }: {
  agent: Agent | null
  personas: Persona[]
  brains: BrainInfo[]
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(agent?.name ?? '')
  const [role, setRole] = useState(agent?.role ?? '')
  const [color, setColor] = useState(agent?.avatarColor ?? COLORS[0])
  const [personaKey, setPersonaKey] = useState(agent?.personaKey ?? 'skeptic')
  const [extra, setExtra] = useState(agent?.personaExtra ?? '')
  const [brain, setBrain] = useState(agent?.brain ?? 'claude')
  const [model, setModel] = useState(agent?.model ?? '')
  const [tier, setTier] = useState<Tier>(agent?.tierCeiling ?? 'research')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const persona = personas.find(p => p.key === personaKey)
  const isCustom = personaKey === 'custom'

  const options = useMemo(
    () => brains.flatMap(b => b.available
      ? b.models.map(m => ({ brain: b.id, model: m.id, label: `${m.label} · ${b.label}` }))
      : []),
    [brains])

  const save = async () => {
    if (!name.trim()) return
    setBusy(true)
    const body = {
      name: name.trim(), role: role.trim(), avatarColor: color,
      personaKey, personaExtra: extra,
      brain, model: model || null, tierCeiling: tier,
    }
    await api(agent ? `/api/agents/${agent.id}` : '/api/agents', {
      method: agent ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    setBusy(false)
    onSaved()
    onClose()
  }

  const duplicate = async () => {
    if (!agent) return
    setBusy(true)
    await api(`/api/agents/${agent.id}/duplicate`, { method: 'POST' })
    setBusy(false)
    onSaved()
    onClose()
  }

  /**
   * Two-step rather than a native confirm: WKWebView's dialog support is
   * inconsistent, and a nested modal inside this sheet would be worse. The
   * second click commits.
   */
  const remove = async () => {
    if (!agent) return
    if (!confirming) return setConfirming(true)
    setBusy(true)
    await api(`/api/agents/${agent.id}`, { method: 'DELETE' })
    setBusy(false)
    onSaved()
    onClose()
  }

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <div className="sheet" onMouseDown={e => e.stopPropagation()}>
        <h2>{agent ? `Edit ${agent.name}` : 'New researcher'}</h2>

        <div className="ae-head">
          <Avatar name={name || '?'} color={color} size={44} />
          <div className="ae-colors">
            {COLORS.map(c => (
              <button key={c} className={`swatch ${c === color ? 'on' : ''}`}
                      style={{ background: c }} onClick={() => setColor(c)}
                      aria-label={`colour ${c}`} />
            ))}
          </div>
        </div>

        <label className="field">
          <span>Name</span>
          <input value={name} autoFocus onChange={e => setName(e.target.value)}
                 placeholder="Alice" />
        </label>

        <label className="field">
          <span>Role</span>
          <input value={role} onChange={e => setRole(e.target.value)}
                 placeholder="mathematical analyst" />
          <small>Shown next to the name. Also how a custom persona is labelled.</small>
        </label>

        <label className="field">
          <span>Persona</span>
          <select value={personaKey} onChange={e => setPersonaKey(e.target.value)}>
            {personas.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          <small>{persona?.blurb}</small>
        </label>

        {!isCustom && persona?.contract && (
          <div className="field">
            <span>Its standing instructions</span>
            <pre className="ae-contract">{persona.contract}</pre>
            <small>
              This is the behavioural contract, not flavour text. Pick <em>Custom</em> to replace it.
            </small>
          </div>
        )}

        <label className="field">
          <span>{isCustom ? 'Behavioural contract' : 'Additional instructions'}</span>
          <textarea rows={isCustom ? 8 : 3} value={extra}
                    onChange={e => setExtra(e.target.value)}
                    placeholder={isCustom
                      ? 'Tell this researcher how to behave. Give it a checklist to run before answering, and name the failure mode it must avoid — that last part is what stops a persona decaying into a caricature by round three.'
                      : 'Anything to add on top of the template.'} />
        </label>

        <label className="field">
          <span>Brain</span>
          <select value={`${brain}|${model}`}
                  onChange={e => {
                    const [b, m] = e.target.value.split('|')
                    setBrain(b); setModel(m)
                  }}>
            {!options.some(o => o.brain === brain && o.model === (model || '')) && (
              <option value={`${brain}|${model}`}>{brain}{model ? ` · ${model}` : ''} (unavailable)</option>
            )}
            {options.map(o => (
              <option key={`${o.brain}|${o.model}`} value={`${o.brain}|${o.model}`}>{o.label}</option>
            ))}
          </select>
          <small>
            {brains.find(b => b.id === brain)?.note}
            {brains.find(b => b.id === brain)?.schemaEnforced === false
              && ' · no schema enforcement, so its turns are parsed rather than guaranteed'}
          </small>
        </label>

        <label className="field">
          <span>Capability ceiling</span>
          <select value={tier} onChange={e => setTier(e.target.value as Tier)}>
            {TIERS.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          <small>A room can never grant this researcher more than this.</small>
        </label>

        <div className="sheet-foot">
          <div className="foot-left">
            {agent && (
              <>
                <button className="linkish" disabled={busy} onClick={duplicate}>
                  Duplicate
                </button>
                <button className="linkish danger" disabled={busy} onClick={remove}>
                  {confirming ? 'Really delete?' : 'Delete'}
                </button>
                {confirming && (
                  <small className="foot-note">
                    Leaves every room; its past messages stay in the transcripts.
                  </small>
                )}
              </>
            )}
          </div>
          <div>
            <button onClick={onClose}>Cancel</button>
            <button className="primary" disabled={busy || !name.trim()} onClick={save}>
              {agent ? 'Save' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
