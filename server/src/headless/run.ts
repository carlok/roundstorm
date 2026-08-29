/**
 * Run one experiment to completion, in process.
 *
 * No HTTP and no interface: this imports the scheduler directly, which is what
 * makes it usable from a script, a cron job, or CI. Everything it creates lands
 * in the same store the app reads, so a headless run is browsable afterwards
 * rather than being a separate world.
 */
import * as db from '../db.ts'
import { startDeliberation } from '../deliberation/scheduler.ts'
import { LEVEL_LABEL } from '../deliberation/ledger.ts'
import { renderCard } from '../deliberation/export.ts'
import type { Agent, ResultCard, Room } from '../types.ts'
import type { ExperimentConfig } from './config.ts'

export interface RunOutcome {
  room: Room
  agents: Agent[]
  card: ResultCard | null
  messages: number
  costUsd: number
  failedTurns: number
  ms: number
}

/**
 * Reuse an agent of the same name rather than accumulating near-duplicates.
 *
 * Names are unique across the whole store, so a second run of the same file
 * would otherwise produce "Alice 2". Reusing and updating keeps repeated runs
 * idempotent, which is what a config file implies.
 */
function upsertAgent(spec: ExperimentConfig['agents'][number]): Agent {
  const existing = db.listAgents().find(a => a.name === spec.name)
  const fields = {
    name: spec.name,
    role: spec.role ?? '',
    avatarColor: spec.color ?? '#5b8def',
    personaKey: spec.persona,
    personaExtra: spec.instructions ?? '',
    brain: spec.brain,
    model: spec.model ?? null,
    tierCeiling: spec.tierCeiling ?? 'research',
  }
  return existing
    ? db.updateAgent(existing.id, fields)!
    : db.createAgent(fields)
}

export async function runExperiment(
  cfg: ExperimentConfig,
  onProgress: (line: string) => void = () => {},
): Promise<RunOutcome> {
  const started = Date.now()

  const project = db.listProjects().find(p => p.name === (cfg.project ?? 'Research'))
    ?? db.createProject(cfg.project ?? 'Research', cfg.workingDir ?? null)
  if (cfg.workingDir && project.workingDir !== cfg.workingDir) {
    db.updateProject(project.id, { workingDir: cfg.workingDir })
  }

  const agents = cfg.agents.map(upsertAgent)
  onProgress(`cast: ${agents.map(a => `${a.name}/${a.brain}`).join(', ')}`)

  const existingRoom = db.listRooms().find(r => r.name === cfg.room.name)
  const room = existingRoom ?? db.createRoom(
    project.id, cfg.room.name, 'room', agents.map(a => a.id), cfg.room.tier ?? 'research')
  if (existingRoom) {
    db.setRoomMembers(room.id, agents.map(a => a.id))
    db.setRoomTier(room.id, cfg.room.tier ?? 'research')
  }

  // The question belongs in the transcript, same as it would from the interface.
  db.insertMessage({ roomId: room.id, authorType: 'human', body: cfg.question })

  const deliberation = db.createDeliberation({
    roomId: room.id,
    mode: cfg.mode ?? 'deliberation',
    rounds: cfg.rounds ?? 3,
    style: cfg.style ?? 'parallel',
    sealedOpening: cfg.sealedOpening ?? true,
    status: 'running',
    currentRound: 0,
    question: cfg.question,
    tier: cfg.room.tier ?? 'research',
  })

  onProgress(`${deliberation.mode}, ${deliberation.rounds} rounds, ${deliberation.style}`)
  await startDeliberation(deliberation)

  const messages = db.listMessages(room.id).filter(m => m.deliberationId === deliberation.id)
  const card = db.listResults(room.id).at(-1) ?? null

  return {
    room: db.getRoom(room.id)!,
    agents,
    card,
    messages: messages.filter(m => m.authorType === 'agent').length,
    costUsd: Number(messages.reduce((s, m) => s + (m.costUsd ?? 0), 0).toFixed(4)),
    // A turn that could not start is reported as a system message; counting them
    // separately stops a run that half-failed from looking like a clean result.
    failedTurns: messages.filter(m => m.authorType === 'system' && !m.body.startsWith('__result__')).length,
    ms: Date.now() - started,
  }
}

export function renderOutcome(o: RunOutcome): string {
  const nameOf = (id: string | null) => o.agents.find(a => a.id === id)?.name ?? 'Unknown'
  const head = [
    `# ${o.room.name}`,
    '',
    `${o.messages} turns · ${Math.round(o.ms / 1000)}s`
      + (o.costUsd ? ` · $${o.costUsd.toFixed(3)}` : '')
      + (o.failedTurns ? ` · ${o.failedTurns} turn(s) failed` : ''),
    '',
  ].join('\n')
  return o.card ? head + renderCard(o.card, nameOf) : head + '_No result was produced._\n'
}

/**
 * Exit code, so a script can branch without parsing prose.
 *
 * 0 the room reached a conclusion, 2 it genuinely did not, 3 the run itself
 * broke. "Two positions remain" is a real answer and is deliberately not an
 * error; a conclave that failed to converge is reported as 2 because the mode
 * promised convergence.
 */
export function exitCodeFor(o: RunOutcome): number {
  if (!o.card) return 3
  if (o.failedTurns > 0 && o.messages === 0) return 3
  return ['no_reliable_conclusion', 'conclave_failed'].includes(o.card.level) ? 2 : 0
}

export const levelLabel = (card: ResultCard | null): string =>
  card ? LEVEL_LABEL[card.level] : 'no result'
