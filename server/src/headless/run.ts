/**
 * Run one experiment to completion, in process.
 *
 * No HTTP and no interface: this imports the scheduler directly, which is what
 * makes it usable from a script, a cron job, or CI. Everything it creates lands
 * in the same store the app reads, so a headless run is browsable afterwards
 * rather than being a separate world.
 */
import { writeFileSync } from 'node:fs'
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
function upsertAgent(
  spec: ExperimentConfig['agents'][number],
  onProgress: (line: string) => void = () => {},
): Agent {
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
  if (existing) {
    // Names are unique store-wide, so two unrelated configs that both say "Alice"
    // share one agent and the second silently rewrites the first. Reuse is the
    // point (it keeps reruns idempotent) but a change of identity should show.
    const was = `${existing.brain}/${existing.personaKey}`
    const now = `${fields.brain}/${fields.personaKey}`
    const extras = [
      existing.model !== fields.model ? `model ${existing.model ?? 'default'} → ${fields.model ?? 'default'}` : '',
      existing.tierCeiling !== fields.tierCeiling ? `ceiling ${existing.tierCeiling} → ${fields.tierCeiling}` : '',
    ].filter(Boolean)
    if (was !== now || extras.length) {
      onProgress(`reusing "${spec.name}": ${was} → ${now}${extras.length ? ` (${extras.join(', ')})` : ''}`)
    }
    return db.updateAgent(existing.id, fields)!
  }
  return db.createAgent(fields)
}

/**
 * Create the cast and the room described by a config, without running anything.
 *
 * Split out so the interface can import the same file the CLI runs: loading an
 * experiment there should set the room up and hand it over, not start billing.
 */
export function setupExperiment(
  cfg: ExperimentConfig,
  onProgress: (line: string) => void = () => {},
): { room: Room; agents: Agent[] } {
  const project = db.listProjects().find(p => p.name === (cfg.project ?? 'Research'))
    ?? db.createProject(cfg.project ?? 'Research', cfg.workingDir ?? null)
  if (cfg.workingDir && project.workingDir !== cfg.workingDir) {
    db.updateProject(project.id, { workingDir: cfg.workingDir })
  }

  const agents = cfg.agents.map(a => upsertAgent(a, onProgress))

  // Scoped to the project. Looking a room up by name alone meant two projects'
  // "Main room" collided and the second experiment rewrote the first's cast.
  const existingRoom = db.listRooms().find(r => r.name === cfg.room.name && r.projectId === project.id)
  const room = existingRoom ?? db.createRoom(
    project.id, cfg.room.name, 'room', agents.map(a => a.id), cfg.room.tier ?? 'research')
  if (existingRoom) {
    db.setRoomMembers(room.id, agents.map(a => a.id))
    db.setRoomTier(room.id, cfg.room.tier ?? 'research')
  }
  return { room: db.getRoom(room.id)!, agents }
}

export async function runExperiment(
  cfg: ExperimentConfig,
  onProgress: (line: string) => void = () => {},
): Promise<RunOutcome> {
  const started = Date.now()

  const { room, agents } = setupExperiment(cfg, onProgress)
  onProgress(`cast: ${agents.map(a => `${a.name}/${a.brain}`).join(', ')}`)

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
  const card = cardFor(room.id, deliberation.id)

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

/**
 * The result card this run produced, or null.
 *
 * Not `listResults(room).at(-1)`: that is the room's latest card, and when
 * synthesis returns nothing it is a *previous run's*. The CLI then printed an old
 * conclusion as if it were this one's and exited 0.
 */
export function cardFor(roomId: string, deliberationId: string): ResultCard | null {
  return db.listResults(roomId).filter(c => c.deliberationId === deliberationId).at(-1) ?? null
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
  // Nobody spoke. Whatever else was produced, that is a broken run, not a
  // conclusion: a missing brain leaves no visible failure, so counting failed
  // turns alone let it through as "no reliable conclusion".
  if (o.messages === 0) return 3
  return ['no_reliable_conclusion', 'conclave_failed'].includes(o.card.level) ? 2 : 0
}

export const levelLabel = (card: ResultCard | null): string =>
  card ? LEVEL_LABEL[card.level] : 'no result'

/**
 * Run experiments in order and keep everything that finished.
 *
 * An exception in experiment n used to escape the loop, so results 1..n-1 were
 * never rendered, not even to stdout. A failed experiment is now an outcome like
 * any other (exit 3 for it), and the rest still run.
 */
export async function runBatch(
  configs: ExperimentConfig[],
  runner: (cfg: ExperimentConfig, onProgress: (line: string) => void) => Promise<RunOutcome>,
  say: (line: string) => void,
): Promise<{ outcomes: RunOutcome[]; worst: number }> {
  const outcomes: RunOutcome[] = []
  let worst = 0
  for (const [i, cfg] of configs.entries()) {
    if (configs.length > 1) say(`experiment ${i + 1} of ${configs.length}: ${cfg.room.name}`)
    let outcome: RunOutcome
    try {
      outcome = await runner(cfg, say)
    } catch (err) {
      say(`experiment ${i + 1} (${cfg.room.name}) failed: ${err instanceof Error ? err.message : String(err)}`)
      outcome = {
        room: db.listRooms().find(r => r.name === cfg.room.name) ?? ({ name: cfg.room.name } as Room),
        agents: [], card: null, messages: 0, costUsd: 0, failedTurns: 0, ms: 0,
      }
    }
    outcomes.push(outcome)
    say(`${levelLabel(outcome.card)} — ${outcome.messages} turns, ${Math.round(outcome.ms / 1000)}s`)
    worst = Math.max(worst, exitCodeFor(outcome))
  }
  return { outcomes, worst }
}

/** Write the output file, returning a message instead of throwing. */
export function writeOutput(path: string, text: string): string | null {
  try {
    writeFileSync(path, text)
    return null
  } catch (err) {
    return `cannot write ${path}: ${err instanceof Error ? err.message : String(err)}`
  }
}
