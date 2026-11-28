import type React from 'react'
import { useEffect, useState } from 'react'
import type { Agent, LogEntry, MemoryCard, Position, Source } from '../types.ts'
import { Avatar } from './Avatar.tsx'
import { api, apiUrl } from '../lib/api.ts'
import { activityFacets, filterActivity, NO_FILTER, type ActivityFilter } from '../lib/activity.ts'

type Tab = 'positions' | 'sources' | 'memory' | 'activity'

const OP_MARK: Record<string, string> = {
  assert: '✔', endorse: '✔', oppose: '✖', unsure: '~', withdraw: '·', revise: '✎',
}

/**
 * The right pane (plan §2.1). Positions is the tab that matters: it is where a
 * reader sees who actually stands where, without reconstructing it from prose.
 */
export function Inspector({ positions, sources, roster, roomId, agentById, onCite, onSourcesChanged }: {
  positions: Position[]
  sources: Source[]
  roster: Agent[]
  roomId: string | null
  agentById: (id: string | null) => Agent | null
  onCite: (text: string) => void
  onSourcesChanged: () => void
}) {
  const [tab, setTab] = useState<Tab>('positions')
  const [memory, setMemory] = useState<MemoryCard[]>([])
  const [events, setEvents] = useState<LogEntry[]>([])
  const [backingUp, setBackingUp] = useState(false)
  const [backupResult, setBackupResult] = useState<string | null>(null)
  const [filter, setFilter] = useState<ActivityFilter>(NO_FILTER)
  const [adding, setAdding] = useState(false)
  const [srcTitle, setSrcTitle] = useState('')
  const [srcUrl, setSrcUrl] = useState('')
  const [srcText, setSrcText] = useState('')
  const [srcError, setSrcError] = useState<string | null>(null)

  // Evidence from the researcher: a URL, or pasted text. It goes into every
  // prompt in this room from the next turn on.
  const addSource = async () => {
    if (!roomId) return
    const r = await api(`/api/rooms/${roomId}/sources`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: srcTitle, url: srcUrl || null, snapshot: srcText || null }),
    })
    if (!r.ok) { setSrcError((await r.json().catch(() => ({}))).error ?? 'could not add'); return }
    setSrcTitle(''); setSrcUrl(''); setSrcText(''); setSrcError(null); setAdding(false)
    onSourcesChanged()
  }

  const saveExport = async (format: 'markdown' | 'json') => {
    if (!roomId) return
    const r = await api(`/api/rooms/${roomId}/export`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format }),
    })
    const d = await r.json().catch(() => ({}))
    setBackupResult(r.ok ? `Saved to ${d.path}` : d.error ?? 'Export failed')
  }
  // Where the database actually is. The note used to hardcode the macOS path,
  // which is wrong on Linux and Windows and under ROUNDSTORM_DATA.
  const [dataDir, setDataDir] = useState<string | null>(null)
  useEffect(() => {
    api('/health').then(r => r.json()).then(h => setDataDir(typeof h?.data === 'string' ? h.data : null))
      .catch(() => setDataDir(null))
  }, [])

  const backup = async () => {
    setBackingUp(true)
    setBackupResult(null)
    try {
      const r = await api('/api/backup', { method: 'POST' })
      const d = await r.json()
      setBackupResult(r.ok
        ? `Saved ${(d.bytes / 1024).toFixed(0)} KB to ${d.path}`
        : d.error ?? 'Backup failed')
    } catch (e) {
      setBackupResult(`Backup failed: ${String(e)}`)
    } finally {
      setBackingUp(false)
    }
  }

  const [remembered, setRemembered] = useState<MemoryCard[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const rosterKey = roster.map(a => a.id).join(',')

  const loadMemory = () => {
    void api('/api/memory?status=proposed').then(r => r.json())
      .then(d => setMemory(d.cards ?? []))
    // Accepted cards were invisible: they shape every prompt, and the only way to
    // remove one was to clear a whole room.
    const ids = new Set(roster.map(a => a.id))
    void api('/api/memory?status=accepted').then(r => r.json())
      .then(d => setRemembered((d.cards ?? []).filter((c: MemoryCard) => ids.has(c.agentId))))
  }
  useEffect(loadMemory, [positions.length, roomId, rosterKey])

  useEffect(() => {
    if (tab !== 'activity' || !roomId) return
    void api(`/api/events?roomId=${roomId}`).then(r => r.json())
      .then(d => setEvents((d.events ?? []).reverse()))
  }, [tab, roomId, positions.length])

  const [memError, setMemError] = useState<string | null>(null)
  const review = async (id: string, status: 'accepted' | 'rejected', text?: string) => {
    const r = await api(`/api/memory/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(text === undefined ? { status } : { status, text }),
    })
    if (!r.ok) {
      setMemError((await r.json().catch(() => ({}))).error ?? 'could not save')
      return
    }
    setMemError(null)
    setEditing(null)
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
          <>
            {adding ? (
              <div className="src-form">
                <input placeholder="Title (required)" value={srcTitle} aria-label="Source title"
                       onChange={e => setSrcTitle(e.target.value)} />
                <input placeholder="https://… (optional)" value={srcUrl} aria-label="Source URL"
                       onChange={e => setSrcUrl(e.target.value)} />
                <textarea placeholder="Paste data or an excerpt (optional). The agents see it from the next turn."
                          rows={4} value={srcText} aria-label="Source text" onChange={e => setSrcText(e.target.value)} />
                {srcError && <p className="mem-error">{srcError}</p>}
                <div className="memcard-actions">
                  <button disabled={!srcTitle.trim()} onClick={() => void addSource()}>Add</button>
                  <button className="linkish" onClick={() => { setAdding(false); setSrcError(null) }}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="linkish src-add" disabled={!roomId} onClick={() => setAdding(true)}>+ Add a source or evidence</button>
            )}
            {sources.length ? sources.map(s => (
              <div key={s.id} className="src">
                <div><span className="pos-label">{s.label}</span> {s.title}</div>
                {s.url && <a href={s.url} target="_blank" rel="noreferrer">{s.url}</a>}
                {!s.foundBy && s.snapshot && <p className="src-snapshot">{s.snapshot.slice(0, 280)}{s.snapshot.length > 280 ? '…' : ''}</p>}
                <small className="muted">
                  {s.kind}{s.foundBy ? ` · found by ${agentById(s.foundBy)?.name ?? '?'}` : ' · added by you'}
                </small>
                <button className="linkish" onClick={() => onCite(`${s.label} (${s.title})`)}>cite in composer</button>
              </div>
            )) : !adding && <Empty>No sources gathered yet.</Empty>}
          </>
        )}

        {tab === 'memory' && (
          <>
            {memError && <p className="mem-error">{memError}</p>}
            <h4 className="mem-h">Waiting for you</h4>
            {memory.length ? (
              <>
                <p className="muted inbox-note">
                  Agents propose; nothing is remembered until you keep it. Edit a card first if it is nearly right.
                </p>
                {memory.map(c => (
                  <MemCard key={c.id} card={c} agent={agentById(c.agentId)}
                           editing={editing === c.id} onEdit={() => setEditing(c.id)} onCancel={() => setEditing(null)}
                           actions={[
                             { label: 'Keep', primary: true, run: text => review(c.id, 'accepted', text) },
                             { label: 'Discard', run: () => review(c.id, 'rejected') },
                           ]} />
                ))}
              </>
            ) : <Empty>Nothing waiting. Proposals appear here after a deliberation.</Empty>}

            <h4 className="mem-h">What this room's researchers remember</h4>
            {remembered.length ? (
              <>
                <p className="muted inbox-note">
                  Up to 25 of these go into every prompt in this project. Correct one, or forget it.
                </p>
                {remembered.map(c => (
                  <MemCard key={c.id} card={c} agent={agentById(c.agentId)}
                           editing={editing === c.id} onEdit={() => setEditing(c.id)} onCancel={() => setEditing(null)}
                           actions={[
                             { label: 'Save', primary: true, editOnly: true, run: text => review(c.id, 'accepted', text) },
                             { label: 'Forget', run: () => review(c.id, 'rejected') },
                           ]} />
                ))}
              </>
            ) : <Empty>Nothing remembered yet.</Empty>}
          </>
        )}

        {tab === 'activity' && (
          <>
            <div className="log-actions">
              {/* Saved server-side, like the backup below: following a download
                  link can navigate the desktop app away from its own UI. */}
              <button className="linkish" onClick={() => void saveExport('markdown')}>Save this room as Markdown</button>
              <button className="linkish" onClick={() => void saveExport('json')}>…as JSON</button>
              <a href={apiUrl(`/api/events/export?roomId=${roomId}`)} download="roundstorm-log.jsonl">
                This room's log
              </a>
            </div>
            <div className="log-actions">
              {/* Saved server-side rather than downloaded: a WKWebView does not
                  handle content-disposition the way a browser does, and following
                  such a link can navigate the app away from its own UI. */}
              <button className="backup-link" disabled={backingUp} onClick={backup}>
                {backingUp ? 'Saving…' : '⬇ Back up everything'}
              </button>
            </div>
            {backupResult && <p className="backup-done">{backupResult}</p>}
            <p className="muted backup-note">
              A consistent snapshot of every room, transcript, position, source and
              memory card, saved to your Downloads folder. Restore by quitting Roundstorm
              and putting it back as <code>roundstorm.db</code> in
              {dataDir ? <> <code>{dataDir}</code>.</> : ' the data folder (see the README).'}
            </p>
            {events.length > 0 && <LogFilters events={events} filter={filter} onChange={setFilter} agentById={agentById} />}
            {filterActivity(events, filter).slice(0, 200).map(e => (
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

/** One memory card, with its actions and an optional inline editor. */
function MemCard({ card, agent, editing, onEdit, onCancel, actions }: {
  card: MemoryCard
  agent: Agent | null
  editing: boolean
  onEdit: () => void
  onCancel: () => void
  actions: { label: string; primary?: boolean; editOnly?: boolean; run: (text?: string) => void | Promise<void> }[]
}) {
  const [text, setText] = useState(card.text)
  return (
    <div className="memcard">
      <div className="memcard-head">
        {agent && <Avatar name={agent.name} color={agent.avatarColor} size={16} />}
        <span>{agent?.name ?? '?'}</span>
        <span className="chip">{card.type}</span>
      </div>
      {editing
        ? <textarea className="memcard-edit" value={text} rows={3} autoFocus
                    aria-label="Edit memory card" onChange={e => setText(e.target.value)} />
        : <p>{card.text}</p>}
      <div className="memcard-actions">
        {actions.filter(a => editing || !a.editOnly).map(a => (
          <button key={a.label} className={a.primary ? '' : 'linkish'}
                  onClick={() => void a.run(editing && text.trim() !== card.text ? text.trim() : undefined)}>
            {a.label}
          </button>
        ))}
        {editing
          ? <button className="linkish" onClick={() => { setText(card.text); onCancel() }}>Cancel</button>
          : <button className="linkish" onClick={onEdit}>Edit</button>}
      </div>
    </div>
  )
}

/** Narrow the activity log to one agent, round or kind of event (plan §12). */
function LogFilters({ events, filter, onChange, agentById }: {
  events: LogEntry[]
  filter: ActivityFilter
  onChange: (f: ActivityFilter) => void
  agentById: (id: string | null) => Agent | null
}) {
  const facets = activityFacets(events)
  return (
    <div className="log-filters">
      <select aria-label="Filter by agent" value={filter.agentId} onChange={e => onChange({ ...filter, agentId: e.target.value })}>
        <option value="">Every agent</option>
        {facets.agentIds.map(id => <option key={id} value={id}>{agentById(id)?.name ?? id.slice(0, 6)}</option>)}
      </select>
      <select aria-label="Filter by round" value={filter.round} onChange={e => onChange({ ...filter, round: e.target.value })}>
        <option value="">Every round</option>
        {facets.rounds.map(r => <option key={r} value={String(r)}>Round {r}</option>)}
      </select>
      <select aria-label="Filter by event" value={filter.type} onChange={e => onChange({ ...filter, type: e.target.value })}>
        <option value="">Every event</option>
        {facets.types.map(t => <option key={t} value={t}>{t}</option>)}
      </select>
    </div>
  )
}
