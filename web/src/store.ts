import { useCallback, useEffect, useRef, useState } from 'react'
import { apiUrl, wsUrl } from './lib/api.ts'
import type {
  Agent, AgentActivity, BrainInfo, Deliberation, LedgerSummary, Message, ModeInfo,
  Persona, Position, Project, ResultCard, Room, ServerEvent, Source,
} from './types.ts'

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(url), {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText)
  return res.json() as Promise<T>
}

export interface Bootstrap {
  projects: Project[]
  rooms: Room[]
  agents: Agent[]
  personas: Persona[]
  brains: BrainInfo[]
  modes: ModeInfo[]
}

export function useRoundstorm() {
  const [boot, setBoot] = useState<Bootstrap | null>(null)
  const [roomId, setRoomId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [active, setActive] = useState<Deliberation | null>(null)
  const [activity, setActivity] = useState<Record<string, AgentActivity>>({})
  const [positions, setPositions] = useState<Position[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [results, setResults] = useState<ResultCard[]>([])
  const [ledger, setLedger] = useState<LedgerSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const roomRef = useRef<string | null>(null)
  roomRef.current = roomId

  const [starting, setStarting] = useState(true)

  const refreshBoot = useCallback(async () => {
    const b = await json<Bootstrap>('/api/bootstrap')
    setBoot(b)
    setRoomId(cur => cur ?? b.rooms.find(r => r.kind === 'room')?.id ?? b.rooms[0]?.id ?? null)
  }, [])

  /**
   * The desktop app launches the daemon and the window at the same moment, so
   * the first fetch usually loses that race. A single attempt leaves the window
   * blank for ever with nothing to explain it — which is exactly what a user
   * sees as "it doesn't start". Retry until it answers.
   */
  useEffect(() => {
    let cancelled = false
    let attempts = 0

    const tick = async () => {
      if (cancelled) return
      try {
        await refreshBoot()
        if (!cancelled) setStarting(false)
      } catch {
        attempts++
        if (cancelled) return
        // Give up complaining silently after a while, but keep trying: the
        // daemon may just be slow to probe its brains on a cold start.
        if (attempts === 12) {
          setError('The Roundstorm daemon is not responding on 127.0.0.1:8787.')
        }
        setTimeout(tick, Math.min(500 * attempts, 3000))
      }
    }

    void tick()
    return () => { cancelled = true }
  }, [refreshBoot])

  const loadRoom = useCallback(async (id: string) => {
    const d = await json<{
      messages: Message[]; active: Deliberation | null; positions: Position[]
      sources: Source[]; results: ResultCard[]; ledger: LedgerSummary | null
    }>(`/api/rooms/${id}/messages`)
    setMessages(d.messages)
    setActive(d.active)
    setPositions(d.positions ?? [])
    setSources(d.sources ?? [])
    setResults(d.results ?? [])
    setLedger(d.ledger ?? null)
    setActivity({})
  }, [])

  useEffect(() => { if (roomId) void loadRoom(roomId) }, [roomId, loadRoom])

  // Push channel. Everything the daemon does arrives here; the UI never polls.
  useEffect(() => {
    let ws: WebSocket
    let closed = false
    let retry: ReturnType<typeof setTimeout>

    const connect = () => {
      if (closed) return
      ws = new WebSocket(wsUrl())
      // Same race as bootstrap, and it also covers the daemon being restarted
      // underneath a running window.
      ws.onclose = () => { if (!closed) retry = setTimeout(connect, 1500) }
      ws.onerror = () => ws.close()
      wire(ws)
    }

    const wire = (ws: WebSocket) => {
    ws.onmessage = ev => {
      const e = JSON.parse(ev.data) as ServerEvent
      if (e.type === 'message' || e.type === 'message.updated') {
        if (e.message.roomId !== roomRef.current) return
        setMessages(prev => {
          const i = prev.findIndex(m => m.id === e.message.id)
          if (i === -1) return [...prev, e.message]
          const next = prev.slice()
          next[i] = e.message
          return next
        })
      } else if (e.type === 'activity') {
        if (e.roomId !== roomRef.current) return
        setActivity(prev => ({ ...prev, [e.activity.agentId]: e.activity }))
      } else if (e.type === 'result') {
        if (e.result.roomId !== roomRef.current) return
        setResults(prev => [...prev.filter(r => r.id !== e.result.id), e.result])
      } else if (e.type === 'deliberation') {
        setActive(prev => {
          if (e.deliberation.roomId !== roomRef.current) return prev
          const finished = !['running', 'stopping'].includes(e.deliberation.status)
          return finished ? null : e.deliberation
        })
        if (e.deliberation.roomId === roomRef.current
            && !['running', 'stopping'].includes(e.deliberation.status)) {
          setActivity({})
          // The ledger and cards only settle once the run ends.
          if (roomRef.current) void loadRoom(roomRef.current)
        }
      }
    }
    }

    connect()
    return () => { closed = true; clearTimeout(retry); ws?.close() }
  }, [loadRoom])

  const send = useCallback(async (body: string, replyTo: string | null) => {
    if (!roomId) return
    try {
      await json(`/api/rooms/${roomId}/messages`, {
        method: 'POST', body: JSON.stringify({ body, replyTo }),
      })
    } catch (e) { setError(String(e)) }
  }, [roomId])

  const startDeliberation = useCallback(async (opts: Record<string, unknown>) => {
    if (!roomId) return
    try {
      const d = await json<Deliberation>(`/api/rooms/${roomId}/deliberations`, {
        method: 'POST', body: JSON.stringify(opts),
      })
      setActive(d)
    } catch (e) { setError(String(e)) }
  }, [roomId])

  const stop = useCallback(async () => {
    if (active) await json(`/api/deliberations/${active.id}/stop`, { method: 'POST' })
  }, [active])

  const extend = useCallback(async (by: number) => {
    if (active) {
      const d = await json<Deliberation>(`/api/deliberations/${active.id}/extend`, {
        method: 'POST', body: JSON.stringify({ by }),
      })
      setActive(d)
    }
  }, [active])

  const setRoomTier = useCallback(async (tier: string) => {
    if (!roomId) return
    await json(`/api/rooms/${roomId}`, { method: 'PATCH', body: JSON.stringify({ tier }) })
    await refreshBoot()
  }, [roomId, refreshBoot])

  const updateAgent = useCallback(async (id: string, patch: Record<string, unknown>) => {
    await json(`/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
    await refreshBoot()
  }, [refreshBoot])

  const interrupt = useCallback(async () => {
    if (active) await json(`/api/deliberations/${active.id}/interrupt`, { method: 'POST' })
  }, [active])

  const fork = useCallback(async (name: string, memberIds: string[], messageIds: string[]) => {
    if (!roomId) return
    const child = await json<Room>(`/api/rooms/${roomId}/fork`, {
      method: 'POST', body: JSON.stringify({ name, memberIds, messageIds }),
    })
    await refreshBoot()
    setRoomId(child.id)
  }, [roomId, refreshBoot])

  const room = boot?.rooms.find(r => r.id === roomId) ?? null
  const agentById = useCallback(
    (id: string | null) => boot?.agents.find(a => a.id === id) ?? null, [boot])

  return {
    boot, room, roomId, setRoomId, messages, active, activity, error, setError, starting,
    positions, sources, results, ledger,
    send, startDeliberation, stop, extend, interrupt, fork,
    setRoomTier, updateAgent, agentById, refreshBoot,
  }
}
