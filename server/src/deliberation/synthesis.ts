/**
 * Final synthesis (plan §13, §20).
 *
 * The consensus level is COMPUTED from the ledger before any model runs, and
 * the synthesiser is told what it is rather than asked to judge it. That is the
 * mechanism that stops a tidy-sounding "the room agreed" from being written over
 * a record showing a 2–2 split.
 *
 * The synthesiser is also a neutral agent that took no side in the debate.
 */
import type { Agent, ConsensusLevel, Deliberation, ResultCard } from '../types.ts'
import * as db from '../db.ts'
import { bus } from '../bus.ts'
import { getAdapter, schemaFor } from '../adapters/registry.ts'
import { LEVEL_LABEL, summarise } from './ledger.ts'
import { MODE_LABEL } from './context.ts'
import { extractJson } from './contract.ts'

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    conclusion: { type: 'string', description: 'The strongest position the discussion actually supports. One short paragraph.' },
    why: { type: 'string', description: 'The reasoning that survived criticism. Name who raised what.' },
    commonGround: { type: 'array', items: { type: 'string' } },
    disagreement: { type: 'array', items: { type: 'string' }, description: 'What still divides them, stated sharply. Leave empty only if genuinely nothing does.' },
    alternatives: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } },
    unknowns: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
  },
  required: ['conclusion', 'why', 'commonGround', 'disagreement',
             'alternatives', 'evidence', 'unknowns', 'nextSteps'],
  additionalProperties: false,
} as const

export async function synthesise(deliberationId: string, signal: AbortSignal): Promise<ResultCard | null> {
  const d = db.getDeliberation(deliberationId)
  if (!d) return null
  const room = db.getRoom(d.roomId)
  if (!room) return null

  const roster = room.memberIds.map(id => db.getAgent(id)).filter((a): a is Agent => !!a)
  const messages = db.listMessages(d.roomId).filter(m => m.deliberationId === d.id)
  if (!messages.length) return null

  const ledger = summarise(d.roomId, roster)
  const level = resolveLevel(d, ledger.level)

  const card = await narrate({ d, room: room.name, roster, messages, level, ledger, signal })
  db.saveResult(card)
  db.logEvent('synthesis.completed', {
    roomId: d.roomId, deliberationId: d.id,
    payload: { level, positions: ledger.positions.length },
  })

  // The card lands in the transcript as a pinned message so it is where the
  // reader already is, not in a panel they have to go find.
  const m = db.insertMessage({
    roomId: d.roomId, authorType: 'system', body: `__result__:${card.id}`,
    deliberationId: d.id,
  })
  bus.emit({ type: 'message', message: m })
  bus.emit({ type: 'result', result: card })

  // Index the finished discussion for semantic search. Fire-and-forget: a
  // missing embedder must never fail a deliberation that already succeeded.
  void import('../search/embeddings.ts')
    .then(m => m.indexPending())
    .then(r => { if (r.indexed) db.logEvent('search.indexed', { roomId: d.roomId, payload: r }) })
    .catch(() => {})

  return card
}

/** Conclave overrides the ordinary vocabulary — and must be able to report failure. */
function resolveLevel(d: Deliberation, computed: ConsensusLevel): ConsensusLevel {
  if (d.mode !== 'conclave') return computed
  return computed === 'strong_consensus' ? 'conclave_reached' : 'conclave_failed'
}

/**
 * Guard the card's most visible field against a weak synthesiser.
 *
 * A small local model asked to summarise a room will sometimes echo the
 * agreement level back as the conclusion ("Consensus with reservations"), which
 * says nothing while looking like an answer. The ledger's leading position title
 * is always the better fallback, since it is what the room actually converged on.
 */
function pickConclusion(value: unknown, fallback: string, level: ConsensusLevel): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return fallback
  const echoesLevel = text.toLowerCase() === LEVEL_LABEL[level].toLowerCase()
  const tooShort = text.split(/\s+/).length < 6
  return echoesLevel || tooShort ? fallback : text
}

async function narrate(args: {
  d: Deliberation
  room: string
  roster: Agent[]
  messages: ReturnType<typeof db.listMessages>
  level: ConsensusLevel
  ledger: ReturnType<typeof summarise>
  signal: AbortSignal
}): Promise<ResultCard> {
  const { d, room, roster, messages, level, ledger, signal } = args

  const base: ResultCard = {
    id: db.uid(), deliberationId: d.id, roomId: d.roomId, level,
    createdAt: Date.now(),
    conclusion: ledger.leading?.title ?? 'The discussion did not settle on a position.',
    why: '', commonGround: [], disagreement: [], alternatives: [],
    evidence: [], unknowns: [], nextSteps: [],
    proposalVersion: ledger.leading?.version,
    failureReason: level === 'conclave_failed'
      ? `No position was endorsed by every participant within ${d.rounds} rounds.`
      : undefined,
  }

  // The report is parsed, not read, so prefer a brain that enforces the schema
  // over whichever agent happens to sit first in the roster. Among equals the
  // room's own brains are fine — a synthesiser has no position to defend, it
  // narrates the ledger it is handed.
  const brains = [...new Set(roster.map(a => a.brain))]
  const adapter = brains.map(getAdapter).filter(a => a != null)
    .sort((a, b) => Number(b!.schemaEnforced) - Number(a!.schemaEnforced))[0]
    ?? getAdapter('claude')
  if (!adapter) return base

  const nameOf = (id: string | null) => roster.find(a => a.id === id)?.name ?? 'Human'
  const transcript = messages
    .filter(m => m.authorType !== 'system')
    .map(m => `### ${nameOf(m.authorId)}${m.round ? ` · Round ${m.round}` : ''}\n${m.body}`)
    .join('\n\n')
    .slice(0, 90_000)

  const sources = db.listSources(d.roomId)

  const systemPrompt = `You are a neutral rapporteur. You took no part in the discussion you are summarising and you have no position to defend.

Report what the room actually established. Do not smooth over disagreement, do not invent agreement, and do not add conclusions of your own that nobody argued for.

Write for a researcher who will read this instead of the transcript, and who may act on it.`

  const userPrompt = `# Deliberation to summarise

Room: ${room}
Mode: ${MODE_LABEL[d.mode]}
Question: ${d.question}
Participants: ${roster.map(a => a.name).join(', ')}

## The agreement level has already been computed from the record

**${LEVEL_LABEL[level]}**

This is not your judgement to make — it was derived from who endorsed and opposed what. Write a summary consistent with it. ${
  level === 'two_positions'
    ? 'Two positions genuinely survived. Present both; do not pick a winner the record does not support.'
    : level === 'conclave_failed'
    ? 'The conclave did NOT reach unanimity. Say so plainly and name who held out and why.'
    : level === 'no_reliable_conclusion'
    ? 'The discussion did not settle anything reliable. Say that rather than manufacturing a conclusion.'
    : ''}

## Positions on the record

${ledger.positions.map(p =>
  `**${p.label}** (v${p.version}) ${p.title}\n${p.text}\n` +
  p.stances.map(s => `- ${nameOf(s.agentId)}: ${s.op}${s.note ? ` — ${s.note}` : ''}`).join('\n')
).join('\n\n') || '_none recorded_'}

${sources.length ? `## Sources gathered\n${sources.map(s => `- ${s.label} ${s.title}${s.url ? ` (${s.url})` : ''}`).join('\n')}` : ''}

## Transcript

${transcript}`

  let structured: unknown = null
  let text = ''
  try {
    for await (const ev of adapter.run({
      systemPrompt, userPrompt,
      model: roster.find(a => a.brain === adapter.id)?.model ?? null,
      tier: 'reasoning', workingDir: null,
      schema: schemaFor(adapter, RESULT_SCHEMA),
    }, signal)) {
      if (ev.type === 'final') { structured = ev.structured; text = ev.text }
      else if (ev.type === 'delta') text = ev.text
    }
  } catch {
    return base
  }

  const v = (structured ?? extractJson(text)) as Record<string, unknown> | null
  if (!v || typeof v !== 'object') return base

  const arr = (k: string): string[] =>
    Array.isArray(v[k]) ? (v[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []

  return {
    ...base,
    conclusion: pickConclusion(v.conclusion, base.conclusion, level),
    why: typeof v.why === 'string' ? v.why : '',
    commonGround: arr('commonGround'),
    disagreement: arr('disagreement'),
    alternatives: arr('alternatives'),
    evidence: arr('evidence'),
    unknowns: arr('unknowns'),
    nextSteps: arr('nextSteps'),
  }
}

/** Exposed for tests; the guard is the interesting part, not the plumbing. */
export const pickConclusionForTest = pickConclusion
