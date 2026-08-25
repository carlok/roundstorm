import type React from 'react'
import { useEffect, useState } from 'react'
import type { Agent, LogEntry, MemoryCard, Position, Source } from '../types.ts'
import { Avatar } from './Avatar.tsx'
import { api, apiUrl } from '../lib/api.ts'

type Tab = 'positions' | 'sources' | 'memory' | 'activity'

const OP_MARK: Record<string, string> = {
  assert: '✔', endorse: '✔', oppose: '✖', unsure: '~', withdraw: '·', revise: '✎',
}

/**
 * The right pane (plan §2.1). Positions is the tab that matters: it is where a
 * reader sees who actually stands where, without reconstructing it from prose.
 */
export function Inspector({ positions, sources, roster, roomId, agentById, onCite }: {
  positions: Position[]
  sources: Source[]
  roster: Agent[]
  roomId: string | null
  agentById: (id: string | null) => Agent | null
  onCite: (text: string) => void
}) {
  const [tab, setTab] = useState<Tab>('positions')
  const [memory, setMemory] = useState<MemoryCard[]>([])
  const [events, setEvents] = useState<LogEntry[]>([])

  const loadMemory = () => {
    void api('/api/memory?status=proposed').then(r => r.json())
      .then(d => setMemory(d.cards ?? []))
  }
  useEffect(loadMemory, [positions.length, roomId])

  useEffect(() => {
    if (tab !== 'activity' || !roomId) return
    void api(`/api/events?roomId=${roomId}`).then(r => r.json())
      .then(d => setEvents((d.events ?? []).slice(-160).reverse()))
  }, [tab, roomId, positions.length])

  const review = async (id: string, status: 'accepted' | 'rejected') => {
    await api(`/api/memory/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    loadMemory()
  }

  return (
    <aside className="pane-right">
      <div className="tabs">
        {(['positions', 'sources', 'memory', 'activity'] as Tab[]).map(t => (
          <button key={t} className={t === tab ? 'sel' : ''} onClick={() => setTab(t)}>
            {t === 'memory' && memory.length
              ? <>Memory <span className="badge">{memory.length}</span></>
              : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <div className="tab-body">
        {tab === 'positions' && (
          positions.length ? positions.map(p => (
            <div key={p.id} className="pos">
              <div className="pos-head">
                <span className="pos-label">{p.label}</span>
                <span className="pos-title">{p.title}</span>
                {p.version > 1 && <span className="chip">v{p.version}</span>}
              </div>
              {p.text && <p className="pos-text">{p.text}</p>}
              <div className="pos-stances">
                {p.stances.length ? p.stances.map(s => {
                  const a = agentById(s.agentId)
                  return (
                    <div key={s.agentId} className={`stance stance-${s.op}`} title={s.note}>
                      {a && <Avatar name={a.name} color={a.avatarColor} size={16} />}
                      <span>{a?.name ?? '?'}</span>
                      <span className="stance-op">{OP_MARK[s.op] ?? s.op}</span>
                    </div>
                  )
                }) : <span className="muted">nobody has taken a stance yet</span>}
              </div>
              <button className="linkish" onClick={() => onCite(`${p.label} (${p.title})`)}>
                cite in composer
              </button>
            </div>
          )) : <Empty>No positions on the record yet. They appear as agents commit to one.</Empty>
        )}

        {tab === 'sources' && (
          sources.length ? sources.map(s => (
            <div key={s.id} className="src">
              <div><span className="pos-label">{s.label}</span> {s.title}</div>
              {s.url && <a href={s.url} target="_blank" rel="noreferrer">{s.url}</a>}
              <small className="muted">
                {s.kind}{s.foundBy ? ` · found by ${agentById(s.foundBy)?.name ?? '?'}` : ''}
              </small>
            </div>
          )) : <Empty>No sources gathered yet.</Empty>
        )}

        {tab === 'memory' && (
          memory.length ? (
            <>
              <p className="muted inbox-note">
                Agents propose; nothing is remembered until you keep it.
              </p>
              {memory.map(c => {
                const a = agentById(c.agentId)
                return (
                  <div key={c.id} className="memcard">
                    <div className="memcard-head">
                      {a && <Avatar name={a.name} color={a.avatarColor} size={16} />}
                      <span>{a?.name ?? '?'}</span>
                      <span className="chip">{c.type}</span>
                    </div>
                    <p>{c.text}</p>
                    <div className="memcard-actions">
                      <button onClick={() => void review(c.id, 'accepted')}>Keep</button>
                      <button className="linkish" onClick={() => void review(c.id, 'rejected')}>Discard</button>
                    </div>
                  </div>
                )
              })}
            </>
          ) : <Empty>Nothing waiting. Proposals appear here after a deliberation.</Empty>
        )}

        {tab === 'activity' && (
          <>
            <div className="log-actions">
              <a href={apiUrl(`/api/rooms/${roomId}/export?format=markdown`)} download="roundstorm.md">
                This room as Markdown
              </a>
              <a href={apiUrl(`/api/events/export?roomId=${roomId}`)} download="roundstorm-log.jsonl">
                This room's log
              </a>
            </div>
            <div className="log-actions">
              {/* Everything, as one openable SQLite file — the thing to keep if
                  you keep only one. */}
              <a className="backup-link" href={apiUrl('/api/backup')}>
                ⬇ Back up everything
              </a>
            </div>
            <p className="muted backup-note">
              A consistent snapshot of every room, transcript, position, source and
              memory card. Restore by putting it back as
              <code>~/Library/Application Support/Roundstorm/roundstorm.db</code>.
            </p>
            {events.map(e => (
              <div key={e.id} className="logline">
                <span className="log-time">
                  {new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <span className="log-type">{e.type}</span>
                <span className="log-agent">{agentById(e.agentId)?.name ?? ''}</span>
              </div>
            ))}
            {!events.length && <Empty>Nothing logged in this room yet.</Empty>}
          </>
        )}
      </div>
    </aside>
  )
}

const Empty = ({ children }: { children: React.ReactNode }) =>
  <p className="muted tab-empty">{children}</p>
