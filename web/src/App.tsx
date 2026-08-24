import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRoundstorm } from './store.ts'
import { Avatar } from './components/Avatar.tsx'
import { MessageView } from './components/MessageView.tsx'
import { ControlBar } from './components/ControlBar.tsx'
import { StartSheet } from './components/StartSheet.tsx'
import { SelectionBar } from './components/SelectionBar.tsx'
import { SearchBar } from './components/SearchBar.tsx'
import { ContextMenu, type MenuItem } from './components/ContextMenu.tsx'
import { Palette, type Command } from './components/Palette.tsx'
import { Inspector } from './components/Inspector.tsx'
import { ResultCardView } from './components/ResultCardView.tsx'
import { GlobalSearch } from './components/GlobalSearch.tsx'
import { PersonaLab } from './components/PersonaLab.tsx'
import { AgentEditor } from './components/AgentEditor.tsx'
import { RoomEditor } from './components/RoomEditor.tsx'
import { Ask, type AskSpec } from './components/Ask.tsx'
import { Manual } from './components/Manual.tsx'
import { copyText, messageToMarkdown, resultToMarkdown, transcriptToMarkdown } from './lib/clipboard.ts'
import { apiUrl } from './lib/api.ts'
import { installMathCopy } from './lib/mathcopy.ts'
import { applyTitlebarInset } from './lib/api.ts'
import type { Agent, Message, Room, Tier } from './types.ts'

const TIER_LABEL: Record<Tier, string> = {
  reasoning: '🔒 Reasoning only',
  research: '🌐 Research tools',
  workstation: '📖 Workstation (read-only)',
  full: '⚠️ Full local',
}

export function App() {
  const rs = useRoundstorm()
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const [draft, setDraft] = useState('')
  const [sheet, setSheet] = useState(false)
  const [palette, setPalette] = useState(false)
  const [search, setSearch] = useState(false)
  const [query, setQuery] = useState('')
  const [hitIndex, setHitIndex] = useState(0)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [showInspector, setShowInspector] = useState(true)
  const [globalSearch, setGlobalSearch] = useState(false)
  const [lab, setLab] = useState(false)
  // null = closed; { agent: null } = creating a new one.
  const [agentSheet, setAgentSheet] = useState<{ agent: Agent | null } | null>(null)
  const [roomSheet, setRoomSheet] = useState<{ room: Room | null } | null>(null)
  const [ask, setAsk] = useState<AskSpec | null>(null)
  const [manual, setManual] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return [] as Message[]
    return rs.messages.filter(m => m.body.toLowerCase().includes(q))
  }, [query, rs.messages])

  const flash = useCallback((text: string) => {
    setToast(text)
    setTimeout(() => setToast(null), 1600)
  }, [])

  const roster = useMemo(
    () => (rs.room?.memberIds ?? []).map(id => rs.agentById(id)).filter(Boolean) as NonNullable<ReturnType<typeof rs.agentById>>[],
    [rs.room, rs.agentById])

  // Auto-scroll only when already at the bottom. Reading round 2 while round 3
  // lands must not yank the viewport (plan §2.3).
  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [rs.messages])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const jump = useCallback((id: string) => {
    const el = document.getElementById(`m-${id}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('flash')
    setTimeout(() => el.classList.remove('flash'), 1200)
  }, [])

  const stepHit = useCallback((delta: number) => {
    if (!hits.length) return
    const next = (hitIndex + delta + hits.length) % hits.length
    setHitIndex(next)
    jump(hits[next].id)
  }, [hits, hitIndex, jump])

  useEffect(() => { setHitIndex(0) }, [query])

  useEffect(installMathCopy, [])
  useEffect(applyTitlebarInset, [])

  // Keyboard surface. ⌘F searches the room, ⌘K opens the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setGlobalSearch(true) }
      else if (meta && e.key === 'f') { e.preventDefault(); setSearch(true) }
      else if (meta && e.key === 'k') { e.preventDefault(); setPalette(p => !p) }
      else if (e.key === '?' && e.shiftKey && !isTyping(e.target)) { e.preventDefault(); setManual(true) }
      else if (e.key === 'Escape') { setSearch(false); setMenu(null); setGlobalSearch(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /**
   * Room actions were only reachable through a button labelled "Cast", which
   * reads as "edit the participants" and hid rename and delete completely.
   * Rooms now carry their own menu, on right-click and on a visible ⋯.
   */
  const openRoomMenu = useCallback((room: Room, x: number, y: number) => {
    const rename = () => setAsk({
      title: `Rename “${room.name}”`,
      defaultValue: room.name,
      placeholder: 'Room name',
      confirmLabel: 'Rename',
      onConfirm: async next => {
        if (next === room.name) return
        await fetch(apiUrl(`/api/rooms/${room.id}`), {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: next }),
        })
        await rs.refreshBoot()
      },
    })

    const del = () => setAsk({
      title: `Delete “${room.name}”?`,
      detail: 'This destroys its transcript, positions and sources. It cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        const res = await fetch(apiUrl(`/api/rooms/${room.id}`), { method: 'DELETE' })
        if (!res.ok) {
          const { error } = await res.json().catch(() => ({ error: 'could not delete' }))
          return flash(error)
        }
        if (rs.roomId === room.id) rs.setRoomId(null)
        await rs.refreshBoot()
      },
    })

    setMenu({ x, y, items: [
      { label: 'Open', onSelect: () => rs.setRoomId(room.id) },
      { label: 'Rename…', onSelect: rename },
      { label: 'Edit cast…', onSelect: () => setRoomSheet({ room }) },
      { label: `Export ${room.kind === 'dm' ? 'chat' : 'room'} as Markdown`,
        onSelect: () => { window.open(apiUrl(`/api/rooms/${room.id}/export?format=markdown`), '_blank') } },
      { label: 'Delete room…', danger: true, onSelect: del },
    ] })
  }, [rs, flash])

  const openMenu = useCallback((m: Message, x: number, y: number) => {
    const agent = rs.agentById(m.authorId)
    setMenu({ x, y, items: [
      { label: 'Reply', onSelect: () => setReplyTo(m) },
      { label: 'Copy text', onSelect: () => { void copyText(m.body); flash('Copied') } },
      { label: 'Copy as Markdown', onSelect: () => { void copyText(messageToMarkdown(m, agent)); flash('Copied as Markdown') } },
      { label: 'Quote in composer', onSelect: () => setDraft(d => quote(m.body) + d) },
      { label: 'Take this to a side room…', onSelect: () => setAsk({
        title: 'Take this to a side room',
        detail: 'The selected message is copied in as context, and the new room keeps a link back.',
        defaultValue: 'Side: ' + m.body.trim().slice(0, 40),
        placeholder: 'Room name',
        confirmLabel: 'Create',
        onConfirm: name => void rs.fork(name, rs.room?.memberIds ?? [], [m.id]),
      }) },
      ...(m.claims.length ? [{
        label: `Copy ${m.claims.length} claim${m.claims.length === 1 ? '' : 's'}`,
        onSelect: () => {
          void copyText(m.claims.map(c => `[${c.basis}] ${c.text}`).join('\n'))
          flash('Claims copied')
        },
      }] : []),
    ] })
  }, [rs, flash])

  const submit = () => {
    const body = draft.trim()
    if (!body) return
    void rs.send(body, replyTo?.id ?? null)
    setDraft('')
    setReplyTo(null)
    pinned.current = true
  }

  const commands: Command[] = useMemo(() => {
    if (!rs.boot) return []

    // Actions first, rooms after. The palette shows a bounded list, and once a
    // project accumulates a dozen rooms an actions-last ordering pushes every
    // action off the end — which defeats the point of the palette.
    const actions: Command[] = [
      { id: 'search', label: 'Search this room', hint: '⌘F', run: () => setSearch(true) },
      { id: 'gsearch', label: 'Search every room', hint: '⇧⌘F', run: () => setGlobalSearch(true) },
      { id: 'manual', label: 'How Roundstorm works — the manual', hint: '?', run: () => setManual(true) },
      { id: 'lab', label: 'Persona lab — compare brains', hint: 'experiment', run: () => setLab(true) },
      { id: 'new-room', label: 'New room…', hint: 'action', run: () => setRoomSheet({ room: null }) },
      { id: 'new-agent', label: 'New researcher…', hint: 'action', run: () => setAgentSheet({ agent: null }) },
      { id: 'cast', label: 'Edit this room\u2019s cast…', hint: 'action', run: () => setRoomSheet({ room: rs.room }) },
      { id: 'copy-transcript', label: 'Copy transcript as Markdown', hint: 'action',
        run: () => {
          void copyText(transcriptToMarkdown(rs.messages, rs.agentById))
          flash('Transcript copied')
        } },
    ]
    if (rs.room?.kind === 'room' && !rs.active) {
      actions.push({ id: 'delib', label: 'Start a deliberation…', hint: 'action', run: () => setSheet(true) })
    }
    if (rs.active) {
      actions.push(
        { id: 'x1', label: 'Add 1 round', hint: 'action', run: () => void rs.extend(1) },
        { id: 'x3', label: 'Add 3 rounds', hint: 'action', run: () => void rs.extend(3) },
        { id: 'stop', label: 'Stop the deliberation', hint: 'action', run: () => void rs.stop() },
      )
    }

    const rooms: Command[] = rs.boot.rooms.map(r => ({
      id: `room-${r.id}`,
      label: r.kind === 'dm' ? `DM · ${r.name}` : r.name,
      hint: 'room',
      run: () => rs.setRoomId(r.id),
    }))

    return [...actions, ...rooms]
  }, [rs, flash])

  // An unexplained blank window is the worst possible failure mode for a
  // desktop app, so say what is happening and what to do if it stalls.
  if (!rs.boot) {
    return (
      <div className="booting">
        <div className="booting-inner">
          <p>Starting Roundstorm…</p>
          <small>Waiting for the local daemon on 127.0.0.1:8787.</small>
          {rs.error && (
            <small className="booting-error">
              {rs.error}<br />
              Run <code>npm run dev:daemon</code>, or check that Node 22+ is installed.
            </small>
          )}
        </div>
      </div>
    )
  }

  const rooms = rs.boot.rooms.filter(r => r.kind === 'room')
  const dms = rs.boot.rooms.filter(r => r.kind === 'dm')

  return (
    <div className={`app ${showInspector ? 'with-inspector' : ''}`}>
      <div className="titlebar-drag" />
      <aside className="pane-left">
        <div className="pane-title">
          Rooms
          <button className="pane-add" title="New room"
                  onClick={() => setRoomSheet({ room: null })}>+</button>
        </div>
        {rooms.map(r => (
          <div key={r.id} className={`room-row ${r.id === rs.roomId ? 'sel' : ''}`}
               onContextMenu={e => { e.preventDefault(); openRoomMenu(r, e.clientX, e.clientY) }}>
            <button className="room-item" onClick={() => rs.setRoomId(r.id)}>{r.name}</button>
            <button className="row-more" title="Rename, edit cast, delete"
                    onClick={e => { e.stopPropagation(); openRoomMenu(r, e.clientX, e.clientY) }}>⋯</button>
          </div>
        ))}

        <div className="pane-title">Direct messages</div>
        {dms.map(r => {
          const a = rs.agentById(r.memberIds[0])
          return (
            <div key={r.id} className={`room-row ${r.id === rs.roomId ? 'sel' : ''}`}
                 onContextMenu={e => { e.preventDefault(); openRoomMenu(r, e.clientX, e.clientY) }}>
              <button className="room-item dm" onClick={() => rs.setRoomId(r.id)}>
                {a && <Avatar name={a.name} color={a.avatarColor} size={20} />}
                <span>{r.name}</span>
              </button>
              <button className="row-more" title="Rename, edit cast, delete"
                      onClick={e => { e.stopPropagation(); openRoomMenu(r, e.clientX, e.clientY) }}>⋯</button>
            </div>
          )
        })}

        <div className="pane-title">
          Agents
          <button className="pane-add" title="New researcher"
                  onClick={() => setAgentSheet({ agent: null })}>+</button>
        </div>
        {rs.boot.agents.map(a => (
          <div key={a.id} className="room-row">
            <button className="agent-item"
                    title={`${a.role || a.personaKey} · ${a.brain}${a.model ? ` · ${a.model}` : ''} — click to configure`}
                    onClick={() => setAgentSheet({ agent: a })}>
              <Avatar name={a.name} color={a.avatarColor} size={22} />
              <div className="agent-meta">
                <span>{a.name}</span>
                <small>{a.personaKey === 'custom' ? a.role || 'custom' : a.personaKey} · {a.brain}</small>
              </div>
            </button>
            <button className="row-more" title="Configure or delete"
                    onClick={e => {
                      e.stopPropagation()
                      setMenu({ x: e.clientX, y: e.clientY, items: [
                        { label: 'Configure…', onSelect: () => setAgentSheet({ agent: a }) },
                        { label: 'Duplicate', onSelect: async () => {
                          await fetch(apiUrl(`/api/agents/${a.id}/duplicate`), { method: 'POST' })
                          await rs.refreshBoot()
                        } },
                        { label: 'Delete…', danger: true, onSelect: () => setAsk({
                          title: `Delete ${a.name}?`,
                          detail: 'It leaves every room. Messages it already wrote stay in the transcripts.',
                          confirmLabel: 'Delete', danger: true,
                          onConfirm: async () => {
                            await fetch(apiUrl(`/api/agents/${a.id}`), { method: 'DELETE' })
                            await rs.refreshBoot()
                          },
                        }) },
                      ] })
                    }}>⋯</button>
          </div>
        ))}
      </aside>

      <main className="pane-main">
        <header className="room-head">
          <div>
            <h1>{rs.room?.name ?? 'No room'}</h1>
            <div className="room-sub">
              {roster.map(a => a.name).join(' · ') || 'no agents'}
            </div>
          </div>
          <div className="room-actions">
            <select value={rs.room?.tier ?? 'research'}
                    onChange={e => void rs.setRoomTier(e.target.value)}
                    title="What agents in this room are allowed to do">
              {(Object.keys(TIER_LABEL) as Tier[]).map(t =>
                <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
            </select>
            {rs.room && (
              <button className="ghost"
                      onClick={e => openRoomMenu(rs.room!, e.clientX, e.clientY)}
                      title="Rename, edit the cast, export or delete this room">
                Room ⌄
              </button>
            )}
            {rs.room?.kind === 'room' && !rs.active && (
              <button className="primary" onClick={() => setSheet(true)}>Deliberate…</button>
            )}
            <button className="ghost" onClick={() => setManual(true)}
                    title="How Roundstorm works — modes, rounds, conclave (shift-?)">
              Manual
            </button>
            <button className="ghost icon"
                    onClick={() => setShowInspector(v => !v)}
                    aria-label={showInspector ? 'Hide the inspector' : 'Show the inspector'}
                    title={showInspector ? 'Hide the inspector panel' : 'Show the inspector panel'}>
              {showInspector ? '⇥' : '⇤'}
            </button>
          </div>
        </header>

        {search && (
          <SearchBar
            query={query} setQuery={setQuery} hits={hits.length} index={hitIndex}
            onStep={stepHit} onClose={() => { setSearch(false); setQuery('') }}
          />
        )}

        {rs.active && (
          <ControlBar
            deliberation={rs.active} roster={roster} activity={rs.activity}
            onExtend={by => void rs.extend(by)} onStop={() => void rs.stop()}
            onInterrupt={() => {
              if (!draft.trim()) return flash('Write your steer first, then interrupt')
              void rs.send(draft.trim(), null).then(() => { setDraft(''); void rs.interrupt() })
            }}
          />
        )}

        <div className="transcript" ref={scroller} onScroll={onScroll}>
          {rs.messages.length === 0 && (
            <div className="empty">
              <p>Write the question once. They do the arguing.</p>
              <p className="empty-sub">
                Ask something hard, then hit <strong>Deliberate…</strong> and pick a number of rounds.
              </p>
              <p className="empty-sub">
                Give it a question with two defensible answers — that is what makes a
                room worth running. <button className="linkish" onClick={() => setManual(true)}>
                Read the manual</button>
              </p>
            </div>
          )}
          {withRoundDividers(rs.messages).map(item => {
            if (item.kind === 'msg' && item.message.body.startsWith('__result__:')) {
              const card = rs.results.find(r => r.id === item.message.body.slice(11))
              return card
                ? <ResultCardView key={card.id} card={card}
                    onCopy={c => { void copyText(resultToMarkdown(c)); flash('Result copied') }} />
                : null
            }
            return item.kind === 'divider' ? (
              <div key={`d-${item.round}`} className="round-divider">
                <span>Round {item.round}</span>
              </div>
            ) : (
              <MessageView
                key={item.message.id}
                message={item.message}
                agent={rs.agentById(item.message.authorId)}
                replyTarget={rs.messages.find(m => m.id === item.message.replyTo) ?? null}
                replyAgent={rs.agentById(
                  rs.messages.find(m => m.id === item.message.replyTo)?.authorId ?? null)}
                onReply={setReplyTo}
                onJump={jump}
                onMenu={openMenu}
                highlight={search ? query : undefined}
                isHit={hits[hitIndex]?.id === item.message.id}
              />
            )
          })}
          {sealedPending(rs) && (
            <div className="sealed-note">
              Sealed opening round — each participant is committing a position without
              seeing the others. They are revealed together.
            </div>
          )}
        </div>

        <div className="composer">
          {replyTo && (
            <div className="composer-reply">
              <span>Replying to {rs.agentById(replyTo.authorId)?.name ?? 'you'}</span>
              <button onClick={() => setReplyTo(null)}>✕</button>
            </div>
          )}
          <textarea
            rows={2} value={draft} placeholder={rs.active
              ? 'Steer the discussion — your message goes to the top of the next round…'
              : 'Message the room…'}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || !e.shiftKey)) { e.preventDefault(); submit() }
            }}
          />
          <button className="primary" onClick={submit}>Send</button>
        </div>

        {rs.error && (
          <div className="error-toast" onClick={() => rs.setError(null)}>{rs.error}</div>
        )}
        {toast && <div className="toast">{toast}</div>}
      </main>

      <SelectionBar
        onQuote={text => setDraft(d => quote(text) + d)}
        onAsk={text => setDraft(quote(text) + '\n')}
      />

      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {ask && <Ask spec={ask} onClose={() => setAsk(null)} />}
      {manual && <Manual onClose={() => setManual(false)} />}
      {palette && <Palette commands={commands} onClose={() => setPalette(false)} />}

      {globalSearch && (
        <GlobalSearch
          onClose={() => setGlobalSearch(false)}
          onOpen={(rid, mid) => {
            setGlobalSearch(false)
            rs.setRoomId(rid)
            // The room has to load before the anchor exists.
            setTimeout(() => jump(mid), 600)
          }}
        />
      )}

      {agentSheet && rs.boot && (
        <AgentEditor
          agent={agentSheet.agent} personas={rs.boot.personas} brains={rs.boot.brains}
          onClose={() => setAgentSheet(null)}
          onSaved={() => void rs.refreshBoot()}
        />
      )}

      {roomSheet && rs.boot && (
        <RoomEditor
          room={roomSheet.room} agents={rs.boot.agents}
          projectId={rs.boot.projects[0]?.id ?? ''}
          onClose={() => setRoomSheet(null)}
          onSaved={async id => { await rs.refreshBoot(); if (id) rs.setRoomId(id) }}
        />
      )}

      {lab && rs.boot && (
        <PersonaLab
          personas={rs.boot.personas} brains={rs.boot.brains}
          projectId={rs.boot.projects[0]?.id ?? ''}
          rooms={rs.boot.rooms.filter(r => r.kind === 'room').map(r => ({ id: r.id, name: r.name }))}
          onClose={() => { setLab(false); void rs.refreshBoot() }}
          onGoToRoom={rs.setRoomId}
        />
      )}

      {showInspector && (
        <Inspector
          positions={rs.positions} sources={rs.sources} roster={roster}
          roomId={rs.roomId} agentById={rs.agentById}
          onCite={t => setDraft(d => `${t}: ` + d)}
        />
      )}

      {sheet && rs.room && (
        <StartSheet
          room={rs.room} roster={roster} modes={rs.boot.modes}
          onClose={() => setSheet(false)}
          onStart={opts => { setSheet(false); void rs.startDeliberation(opts) }}
        />
      )}
    </div>
  )
}

/** Shortcuts must not fire while the user is composing. */
const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

const quote = (text: string) =>
  text.trim().split('\n').map(l => `> ${l}`).join('\n') + '\n\n'

type Item =
  | { kind: 'divider'; round: number }
  | { kind: 'msg'; message: Message }

function withRoundDividers(messages: Message[]): Item[] {
  const out: Item[] = []
  let last: number | null = null
  for (const m of messages) {
    if (m.round != null && m.round !== last) {
      out.push({ kind: 'divider', round: m.round })
      last = m.round
    }
    out.push({ kind: 'msg', message: m })
  }
  return out
}

function sealedPending(rs: ReturnType<typeof useRoundstorm>): boolean {
  return !!rs.active && rs.active.sealedOpening && rs.active.currentRound === 1
    && !rs.messages.some(m => m.round === 1 && m.deliberationId === rs.active!.id)
}
