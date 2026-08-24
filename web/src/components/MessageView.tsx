import { useMemo } from 'react'
import type { Agent, Message } from '../types.ts'
import { Avatar } from './Avatar.tsx'
import { Markdown } from './Markdown.tsx'

const BASIS_TITLE: Record<string, string> = {
  reasoned: 'The agent derived this',
  computed: 'The agent ran something to get this',
  sourced: 'The agent retrieved this from a source',
  recalled: 'From memory of earlier work',
}

export function MessageView({
  message, agent, replyTarget, replyAgent, onReply, onJump, onMenu, highlight, isHit,
}: {
  message: Message
  agent: Agent | null
  replyTarget: Message | null
  replyAgent: Agent | null
  onReply: (m: Message) => void
  onJump: (id: string) => void
  onMenu: (m: Message, x: number, y: number) => void
  highlight?: string
  isHit?: boolean
}) {
  const time = useMemo(
    () => new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    [message.createdAt])

  if (message.authorType === 'system') {
    return <div className="system-note" id={`m-${message.id}`}>{message.body}</div>
  }

  const isHuman = message.authorType === 'human'
  const name = isHuman ? 'You' : agent?.name ?? 'Unknown'
  const color = isHuman ? '#6b7280' : agent?.avatarColor ?? '#888'

  // Distinct bases only — the chip row says what kind of thing this message is,
  // not how many claims it contains (plan §2.2).
  const bases = [...new Set(message.claims.map(c => c.basis))]

  return (
    <div className={`msg ${isHuman ? 'msg-human' : ''} ${isHit ? 'hit' : ''}`}
         id={`m-${message.id}`}
         onContextMenu={e => { e.preventDefault(); onMenu(message, e.clientX, e.clientY) }}>
      <Avatar name={name} color={color} />
      <div className="msg-main">
        <div className="msg-head">
          <span className="msg-name" style={{ color }}>{name}</span>
          {agent && <span className="msg-brain">{agent.brain}{agent.model ? ` · ${shortModel(agent.model)}` : ''}</span>}
          {message.round != null && <span className="msg-round">Round {message.round}</span>}
          {message.priority && <span className="chip chip-priority">priority</span>}
          <span className="msg-time">{time}</span>
          <button className="msg-reply" onClick={() => onReply(message)} title="Reply">↩</button>
          <button className="msg-reply"
                  onClick={e => onMenu(message, e.clientX, e.clientY)} title="More">⋯</button>
        </div>

        {replyTarget && (
          <button className="quote" onClick={() => onJump(replyTarget.id)}>
            <span className="quote-name" style={{ color: replyAgent?.avatarColor ?? '#6b7280' }}>
              {replyAgent?.name ?? 'You'}
              {replyTarget.round != null ? ` · Round ${replyTarget.round}` : ''}
            </span>
            <span className="quote-body">{firstLine(replyTarget.body)}</span>
          </button>
        )}

        <div className="msg-body"><Markdown highlight={highlight}>{message.body}</Markdown></div>

        {(bases.length > 0 || message.degraded) && (
          <div className="chips">
            {bases.map(b => (
              <span key={b} className={`chip chip-${b}`} title={BASIS_TITLE[b]}>⟨{b}⟩</span>
            ))}
            {message.claims.length > 0 && (
              <span className="chip chip-count" title={message.claims.map(c => `[${c.basis}] ${c.text}`).join('\n')}>
                {message.claims.length} claim{message.claims.length === 1 ? '' : 's'}
              </span>
            )}
            {message.degraded && (
              <span className="chip chip-degraded" title="The turn contract could not be parsed; the message is shown as-is.">
                unstructured
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const firstLine = (s: string) => {
  const line = s.trim().split('\n').find(l => l.trim()) ?? ''
  return line.length > 120 ? line.slice(0, 120) + '…' : line
}

const shortModel = (m: string) =>
  m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
