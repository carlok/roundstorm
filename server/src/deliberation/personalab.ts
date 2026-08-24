/**
 * Persona lab (plan §5.1).
 *
 * "Same persona, different brains" is a real research question, not a demo
 * trick: does a Skeptic on Gemini object to the same things as a Skeptic on
 * Claude? The lab makes that comparison a first-class operation — clone a
 * room's cast with the brains permuted, run the identical question, and diff
 * the outcomes.
 *
 * Everything here is assembled from records that already exist. The comparison
 * is only trustworthy because the ledger and the claim bases were captured at
 * the time, rather than re-derived from prose afterwards.
 */
import * as db from '../db.ts'
import type { Agent, Basis, Room, Stance } from '../types.ts'
import { summarise } from './ledger.ts'

export interface ArmSpec {
  /** Display name for this arm, e.g. "all Claude" or "mixed brains". */
  name: string
  /** personaKey → { brain, model } for this arm. */
  assignment: Record<string, { brain: string; model: string | null }>
}

/**
 * Build the rooms for a comparison. Each arm gets its own room and its own cast,
 * so nothing is shared but the question and the personas.
 */
export function createExperiment(args: {
  projectId: string
  title: string
  personaKeys: string[]
  arms: ArmSpec[]
  tier?: Room['tier']
}): { rooms: Room[]; agents: Agent[] } {
  const rooms: Room[] = []
  const agents: Agent[] = []

  for (const arm of args.arms) {
    const cast = args.personaKeys.map((key, i) => {
      const brain = arm.assignment[key] ?? { brain: 'claude', model: null }
      return db.createAgent({
        // Each experiment gets its own cast, so names must not collide with a
        // previous run's.
        name: db.uniqueAgentName(`${capitalise(key)} · ${arm.name}`),
        role: key,
        avatarColor: COLORS[i % COLORS.length],
        personaKey: key,
        personaExtra: '',
        brain: brain.brain,
        model: brain.model,
        tierCeiling: args.tier ?? 'research',
      })
    })
    agents.push(...cast)
    rooms.push(db.createRoom(
      args.projectId, `${args.title} — ${arm.name}`, 'room',
      cast.map(a => a.id), args.tier ?? 'research'))
  }

  return { rooms, agents }
}

export interface ArmReport {
  roomId: string
  roomName: string
  cast: { name: string; persona: string; brain: string; model: string | null }[]
  level: string
  conclusion: string
  positions: { label: string; title: string; support: number; oppose: number }[]
  stanceMix: Record<string, number>
  basisMix: Record<string, number>
  turns: number
  degraded: number
  concessions: number
  /** Agents who ended a round backing a position other than the one they opened. */
  mindChanges: number
  /** Positions carrying opposition — how contested the question actually was. */
  contested: number
  costUsd: number
  medianWords: number
}

/**
 * One arm, reduced to the things worth comparing across arms.
 *
 * Mind changes are counted from the *ledger*, not from the stance field. An
 * earlier version counted only `stance: concede` and reported "nobody changed
 * their mind" over records that plainly showed agents abandoning their opening
 * position — they had written `endorse` instead, because the ledger instruction
 * asks them to endorse. The record of what an agent did outranks the word it
 * chose for it.
 */
export function reportArm(roomId: string): ArmReport | null {
  const room = db.getRoom(roomId)
  if (!room) return null
  const roster = room.memberIds.map(id => db.getAgent(id)).filter((a): a is Agent => !!a)
  const messages = db.listMessages(roomId).filter(m => m.authorType === 'agent')
  const ledger = summarise(roomId, roster)
  const results = db.listResults(roomId)

  const stanceMix: Record<string, number> = {}
  const basisMix: Record<string, number> = {}
  let degraded = 0, cost = 0
  const wordCounts: number[] = []

  for (const m of messages) {
    if (m.stance) stanceMix[m.stance] = (stanceMix[m.stance] ?? 0) + 1
    for (const c of m.claims) basisMix[c.basis] = (basisMix[c.basis] ?? 0) + 1
    if (m.degraded) degraded++
    cost += m.costUsd ?? 0
    wordCounts.push(m.body.trim().split(/\s+/).length)
  }

  wordCounts.sort((a, b) => a - b)

  return {
    mindChanges: countMindChanges(roomId, messages),
    contested: ledger.positions.filter(p => p.stances.some(s => s.op === 'oppose')).length,
    roomId, roomName: room.name,
    cast: roster.map(a => ({
      name: a.name, persona: a.personaKey, brain: a.brain, model: a.model,
    })),
    level: ledger.headline,
    conclusion: results[results.length - 1]?.conclusion ?? '',
    positions: ledger.positions.map(p => ({
      label: p.label, title: p.title,
      support: p.stances.filter(s => s.op === 'assert' || s.op === 'endorse').length,
      oppose: p.stances.filter(s => s.op === 'oppose').length,
    })),
    stanceMix, basisMix,
    turns: messages.length,
    degraded,
    concessions: (stanceMix['concede'] ?? 0),
    costUsd: Number(cost.toFixed(4)),
    medianWords: wordCounts.length ? wordCounts[Math.floor(wordCounts.length / 2)] : 0,
  }
}

export interface Comparison {
  arms: ArmReport[]
  /** Lines a reader can act on. Deliberately blunt and few. */
  observations: string[]
}

export function compare(roomIds: string[]): Comparison {
  const arms = roomIds.map(reportArm).filter((a): a is ArmReport => !!a)
  return { arms, observations: observe(arms) }
}

function observe(arms: ArmReport[]): string[] {
  if (arms.length < 2) return []
  const out: string[] = []

  const levels = [...new Set(arms.map(a => a.level))]
  out.push(levels.length === 1
    ? `Every arm reached the same outcome: ${levels[0].toLowerCase()}.`
    : `The arms disagreed about the outcome: ${arms.map(a => `${a.roomName} → ${a.level.toLowerCase()}`).join('; ')}.`)

  // Whether anyone moved is only meaningful if there was something to move on.
  // Reporting "nobody changed their mind" after a question every agent answered
  // the same way in round one blames the brains for the experiment's design.
  const anyContest = arms.some(a => a.contested > 0)
  const moves = arms.map(a => ({ name: a.roomName, n: a.mindChanges, c: a.concessions }))
  const totalMoves = moves.reduce((s, m) => s + m.n, 0)

  if (totalMoves === 0) {
    out.push(anyContest
      ? 'Positions were contested but nobody moved: every agent ended on the position it opened with.'
      : 'Nobody opposed anything in any arm — the question was not contested, so there was nothing to change anyone\'s mind about. Try a question with two live answers.')
  } else {
    const top = [...moves].sort((x, y) => y.n - x.n)
    out.push(`Agents who moved: ${top.map(m => `${m.name} ${m.n}${m.c ? ` (${m.c} conceded)` : ''}`).join(', ')}.`)
  }

  const spread = (k: keyof ArmReport) => {
    const vals = arms.map(a => Number(a[k]))
    return { min: Math.min(...vals), max: Math.max(...vals) }
  }
  const words = spread('medianWords')
  if (words.max > words.min * 1.6) {
    out.push(`Turn length varied a lot between arms: median ${words.min} to ${words.max} words.`)
  }

  const cost = spread('costUsd')
  if (cost.max > 0) out.push(`Cost per arm ranged $${cost.min.toFixed(2)}–$${cost.max.toFixed(2)}.`)

  const degraded = arms.filter(a => a.degraded > 0)
  if (degraded.length) {
    out.push(`Unstructured turns (contract not parsed): ${degraded.map(a => `${a.roomName} ${a.degraded}/${a.turns}`).join(', ')}. Treat those arms' ledgers as thinner, not wrong.`)
  }

  const evidence = arms.map(a => ({
    name: a.roomName,
    r: total(a.basisMix) ? ((a.basisMix.sourced ?? 0) + (a.basisMix.computed ?? 0)) / total(a.basisMix) : 0,
  })).sort((x, y) => y.r - x.r)
  if (evidence.length > 1 && evidence[0].r - evidence[evidence.length - 1].r > 0.15) {
    out.push(`${evidence[0].name} leaned hardest on computed or sourced claims (${pct(evidence[0].r)}), ${evidence[evidence.length - 1].name} least (${pct(evidence[evidence.length - 1].r)}).`)
  }

  return out
}

/**
 * An agent changed its mind if the position it backs at the end is not the one
 * it opened with, OR if it ever conceded.
 *
 * Both signals are needed, and each covers the other's blind spot. The ledger
 * misses movement inside a merged position: when de-duplication collapses the
 * room onto one entry, an agent's first recorded op is already the merged
 * position, so the trajectory that led there is erased. The stance field misses
 * the agent that switches sides while calling it an endorsement. Counting
 * either signal alone under-reports — observed on a run where three agents
 * conceded in prose and the ledger showed zero movement.
 */
function countMindChanges(roomId: string, messages: { authorId: string | null; stance: string | null }[]): number {
  const positions = db.listPositions(roomId)
  const first = new Map<string, string>()
  const last = new Map<string, string>()
  const abandoned = new Set<string>()

  const ops = positions.flatMap(p =>
    p.stances.map(s => ({ agentId: s.agentId, label: p.label, op: s.op, round: s.round ?? 0 })))
  ops.sort((a, b) => a.round - b.round)

  for (const o of ops) {
    if (o.op === 'withdraw') { abandoned.add(o.agentId); continue }
    if (o.op === 'oppose') continue
    if (!first.has(o.agentId)) first.set(o.agentId, o.label)
    last.set(o.agentId, o.label)
  }

  const moved = new Set<string>()
  for (const [agentId, opened] of first) {
    if (abandoned.has(agentId) || last.get(agentId) !== opened) moved.add(agentId)
  }
  for (const m of messages) {
    if (m.stance === 'concede' && m.authorId) moved.add(m.authorId)
  }
  return moved.size
}

const total = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0)
const pct = (r: number) => `${Math.round(r * 100)}%`
const capitalise = (s: string) => s.replace(/(^|_)([a-z])/g, (_, p, c) => (p ? ' ' : '') + c.toUpperCase())

const COLORS = ['#5b8def', '#e0616f', '#3fa87a', '#9b6dd6', '#d68c3f', '#4bb0c4']
