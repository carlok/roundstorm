import type { Agent, AgentActivity, Deliberation } from '../types.ts'
import { Avatar } from './Avatar.tsx'

const STATE_LABEL: Record<AgentActivity['state'], string> = {
  idle: '', waiting: 'Waiting', thinking: 'Thinking', tool: 'Working',
  writing: 'Writing', done: 'Complete', error: 'Error',
}

/**
 * Replaces every orchestration concept the user would otherwise have to learn
 * (plan §2.4). [+1 round] is expected to be the most-used button in the product.
 */
export function ControlBar({ deliberation, roster, activity, onExtend, onStop, onInterrupt }: {
  deliberation: Deliberation
  roster: Agent[]
  activity: Record<string, AgentActivity>
  onExtend: (by: number) => void
  onStop: () => void
  onInterrupt: () => void
}) {
  const sealed = deliberation.sealedOpening && deliberation.currentRound === 1
  return (
    <div className="controlbar">
      <div className="controlbar-top">
        <span className="cb-mode">{label(deliberation.mode)}</span>
        <span className="cb-sep">·</span>
        <span>Round {Math.max(1, deliberation.currentRound)} of {deliberation.rounds}</span>
        <span className="cb-sep">·</span>
        <span>{deliberation.style === 'parallel' ? 'Parallel' : 'Ping-pong'}</span>
        {sealed && <span className="chip chip-sealed">sealed round</span>}
        {deliberation.status === 'stopping' && <span className="chip chip-degraded">stopping…</span>}
        <div className="cb-actions">
          <button onClick={() => onExtend(1)}>+1 round</button>
          <button onClick={() => onExtend(3)}>+3</button>
        <button onClick={onInterrupt}
                title="Send your message and restart this round with it. The in-flight turns are discarded.">
          Interrupt now
        </button>
          <button className="danger" onClick={onStop}>Stop</button>
        </div>
      </div>
      <div className="controlbar-agents">
        {roster.map(a => {
          const act = activity[a.id]
          const state = act?.state ?? 'waiting'
          return (
            <div key={a.id} className={`cb-agent cb-${state}`} title={act?.detail || STATE_LABEL[state]}>
              <Avatar name={a.name} color={a.avatarColor} size={20} dim={state === 'waiting'} />
              <span className="cb-agent-name">{a.name}</span>
              <span className="cb-agent-state">
                {state === 'done' ? '✔' : state === 'error' ? '✖'
                  : state === 'waiting' ? '·' : <span className="spin">◍</span>}
              </span>
              <span className="cb-agent-detail">{act?.detail || STATE_LABEL[state]}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const label = (m: string) =>
  m.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')
