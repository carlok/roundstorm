import { useState } from 'react'
import type { Agent, Room, Tier } from '../types.ts'
import { Avatar } from './Avatar.tsx'
import { api } from '../lib/api.ts'

const TIERS: { key: Tier; label: string }[] = [
  { key: 'reasoning', label: '🔒 Reasoning only' },
  { key: 'research', label: '🌐 Research tools' },
  { key: 'workstation', label: '📖 Workstation (read-only)' },
  { key: 'full', label: '⚠️ Full local' },
]

/**
 * Build a room with an arbitrary cast (plan §11, §17).
 *
 * Also used to edit an existing room's cast, because "add Noether to this" is a
 * thing you decide two rounds in, not up front.
 */
export function RoomEditor({ room, agents, projectId, projectWorkingDir, onClose, onSaved }: {
  room: Room | null
  agents: Agent[]
  projectId: string
  /** Project-wide, but surfaced here because this is where the tier is chosen. */
  projectWorkingDir: string | null
  onClose: () => void
  onSaved: (roomId?: string) => void
}) {
  const [name, setName] = useState(room?.name ?? '')
  const [picked, setPicked] = useState<string[]>(room?.memberIds ?? [])
  const [tier, setTier] = useState<Tier>(room?.tier ?? 'research')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const toggle = (id: string) =>
    setPicked(v => v.includes(id) ? v.filter(x => x !== id) : [...v, id])

  const save = async () => {
    if (!name.trim() || !picked.length) return
    setBusy(true)
    // Working directory is project-wide; save it whenever it changed.
    if ((workDir.trim() || null) !== (projectWorkingDir ?? null)) {
      await api(`/api/projects/${projectId}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workingDir: workDir.trim() || null }),
      })
    }
    if (room) {
      await api(`/api/rooms/${room.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ memberIds: picked, tier, name: name.trim() }),
      })
      onSaved(room.id)
    } else {
      const created = await api('/api/rooms', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId, name: name.trim(),
          kind: picked.length === 1 ? 'dm' : 'room',
          memberIds: picked, tier,
        }),
      }).then(r => r.json())
      onSaved(created.id)
    }
    setBusy(false)
    onClose()
  }

  const [failed, setFailed] = useState<string | null>(null)
  const [workDir, setWorkDir] = useState(projectWorkingDir ?? '')

  // The file tiers are refused without a directory, so say so before the user
  // saves rather than letting a run silently downgrade itself.
  const needsDir = tier === 'workstation' || tier === 'full'
  const missingDir = needsDir && !workDir.trim()

  /** Two-step, for the same reason as in the agent editor. */
  const remove = async () => {
    if (!room) return
    if (!confirming) return setConfirming(true)
    setBusy(true)
    const res = await api(`/api/rooms/${room.id}`, { method: 'DELETE' })
    setBusy(false)
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: 'could not delete' }))
      setFailed(error)
      setConfirming(false)
      return
    }
    onSaved()
    onClose()
  }

  // A cast drawn from one brain is a different experiment from a mixed one, and
  // it is worth knowing which you just built.
  const brains = [...new Set(picked
    .map(id => agents.find(a => a.id === id)?.brain)
    .filter(Boolean))] as string[]

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <div className="sheet" onMouseDown={e => e.stopPropagation()}>
        <h2>{room ? `Cast of ${room.name}` : 'New room'}</h2>

        <label className="field">
          <span>Name</span>
          <input value={name} autoFocus onChange={e => setName(e.target.value)}
                 placeholder="Topological dynamics" />
        </label>

        <div className="field">
          <span>Cast — {picked.length} selected</span>
          <div className="castpick">
            {agents.map(a => (
              <button key={a.id}
                      className={`castrow ${picked.includes(a.id) ? 'on' : ''}`}
                      onClick={() => toggle(a.id)}>
                <Avatar name={a.name} color={a.avatarColor} size={24}
                        dim={!picked.includes(a.id)} />
                <span className="castrow-name">{a.name}</span>
                <small>{a.personaKey === 'custom' ? a.role || 'custom' : a.personaKey}</small>
                <small className="castrow-brain">{a.brain}</small>
              </button>
            ))}
          </div>
          <small>
            {picked.length === 0 ? 'Pick at least one.'
              : picked.length === 1 ? 'One researcher makes this a direct message — plain chat, no rounds.'
              : `${brains.length === 1 ? `All on ${brains[0]}` : `Mixed brains: ${brains.join(', ')}`}.`}
          </small>
        </div>

        <label className="field">
          <span>What agents here may do</span>
          <select value={tier} onChange={e => setTier(e.target.value as Tier)}>
            {TIERS.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          <small>Each researcher is still capped by its own ceiling.</small>
        </label>

        {needsDir && (
          <label className="field">
            <span>Working directory</span>
            <input value={workDir} onChange={e => setWorkDir(e.target.value)}
                   placeholder="/Users/you/research/rotor-study" spellCheck={false} />
            <small>
              {missingDir
                ? 'Required. Reading and writing are refused without one, and the room falls back to Research — with no directory the CLI would run wherever the daemon happens to be.'
                : tier === 'full'
                  ? 'Agents may write files and run commands here. Point it somewhere you would not mind a shell being opened.'
                  : 'Agents may read files here. No writes.'}
            </small>
            <small className="field-aside">Applies to the whole project, not just this room.</small>
          </label>
        )}

        <div className="sheet-foot">
          <div className="foot-left">
            {room && (
              <>
                <button className="linkish danger" disabled={busy} onClick={remove}>
                  {confirming ? 'Really delete?' : 'Delete room'}
                </button>
                {confirming && (
                  <small className="foot-note">
                    Destroys the transcript, positions and sources. Cannot be undone.
                  </small>
                )}
                {failed && <small className="foot-note error">{failed}</small>}
              </>
            )}
          </div>
          <div>
            <button onClick={onClose}>Cancel</button>
            <button className="primary"
                    disabled={busy || !picked.length || !name.trim() || missingDir}
                    onClick={save}>
              {room ? 'Save' : 'Create room'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
