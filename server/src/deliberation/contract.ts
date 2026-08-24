/**
 * The turn contract (plan §3).
 *
 * Two paths, because brains differ:
 *   - schema-enforced (claude/agy/codex/deepseek): the provider constrains the
 *     final response to TURN_SCHEMA and we read it straight off.
 *   - prompt-and-parse (cursor-agent): we ask for a fenced JSON block, parse
 *     leniently, and degrade rather than fail.
 *
 * Degradation is the invariant that matters: a turn we cannot parse still
 * renders as a readable message. Only the ledger gets thinner.
 */
import type { Basis, Claim, MemoryCard, PositionOp, Stance, Turn } from '../types.ts'

const STANCES: Stance[] = ['propose', 'support', 'object', 'refine', 'question', 'concede', 'endorse']
const BASES: Basis[] = ['reasoned', 'computed', 'sourced', 'recalled']

export const TURN_SCHEMA = {
  type: 'object',
  properties: {
    body: {
      type: 'string',
      description: 'Your message to the room, in Markdown. This is what other participants read.',
    },
    stance: {
      type: 'string',
      enum: STANCES,
      description: 'Your posture toward the discussion so far. Use "concede" whenever you have given up a position you previously held, even if you are also endorsing someone else\'s — conceding is the more informative of the two and it is what tells a reader the discussion moved.',
    },
    reply_to: {
      type: 'string',
      description: 'Message id you are replying to, or "" if addressing the room generally.',
    },
    position_ops: {
      type: 'array',
      description: 'Where you now stand on the named positions in this room. Cite an existing position by its label (P1, P2…), or give a title to open a new one.',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Existing position label like "P1", or "" to open a new one.' },
          title: { type: 'string', description: 'Short name for a NEW position. Required when label is "".' },
          op: {
            type: 'string',
            enum: ['assert', 'revise', 'withdraw', 'endorse', 'oppose', 'unsure'],
            description: 'assert = this is my position; endorse = I accept someone else\'s; oppose = I reject it; unsure = I cannot judge yet.',
          },
          note: { type: 'string', description: 'One line: why.' },
          text: { type: 'string', description: 'The position statement itself, when asserting or revising.' },
        },
        required: ['op', 'note'],
        additionalProperties: false,
      },
    },
    memory: {
      type: 'array',
      description: 'Things worth remembering beyond this room. Proposed only — a human reviews every card before it is kept.',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['definition', 'decision', 'assumption', 'rejected-hypothesis',
                   'result', 'open-question', 'reference', 'own-position', 'user-preference'],
          },
          text: { type: 'string' },
        },
        required: ['type', 'text'],
        additionalProperties: false,
      },
    },
    claims: {
      type: 'array',
      description: 'The load-bearing assertions in your message, separated from the prose.',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          basis: {
            type: 'string',
            enum: BASES,
            description: 'reasoned = you derived it; computed = you ran something; sourced = you retrieved it; recalled = from memory of prior work.',
          },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          refs: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'basis'],
        additionalProperties: false,
      },
    },
  },
  required: ['body', 'stance', 'claims'],
  additionalProperties: false,
} as const

/** Instruction appended for brains that cannot enforce a schema. */
export const PROMPT_CONTRACT = `
## Output format

Reply with your message, then a fenced JSON block describing its structure:

\`\`\`json
{
  "body": "<your message in Markdown — repeat it here in full>",
  "stance": "propose | support | object | refine | question | concede | endorse",
  "reply_to": "<message id you are replying to, or \\"\\">",
  "claims": [
    { "text": "<a load-bearing assertion>", "basis": "reasoned | computed | sourced | recalled", "confidence": "low | medium | high" }
  ]
}
\`\`\`

Mark a claim "sourced" only if you actually retrieved the source in this session.
`.trim()

export interface RawPositionOp {
  label: string | null
  title: string | null
  op: PositionOp
  note: string
  text: string
}

export interface RawMemoryProposal {
  type: MemoryCard['type']
  text: string
}

export interface ParsedTurn {
  turn: Turn
  positionOps: RawPositionOp[]
  memory: RawMemoryProposal[]
  degraded: boolean
  reason?: string
}

/** Normalise anything a brain hands back into a valid Turn. Never throws. */
export function coerceTurn(value: unknown, fallbackBody: string): ParsedTurn {
  if (!value || typeof value !== 'object') {
    return degrade(fallbackBody, 'no structured output')
  }
  const v = value as Record<string, unknown>
  const body = typeof v.body === 'string' && v.body.trim() ? v.body : fallbackBody
  if (!body.trim()) return degrade(fallbackBody, 'empty body')

  const stance: Stance = STANCES.includes(v.stance as Stance) ? (v.stance as Stance) : 'propose'
  const replyTo = typeof v.reply_to === 'string' && v.reply_to.trim() ? v.reply_to.trim() : null

  const rawClaims = Array.isArray(v.claims) ? v.claims : []
  const claims: Claim[] = rawClaims.flatMap((c): Claim[] => {
    if (!c || typeof c !== 'object') return []
    const o = c as Record<string, unknown>
    if (typeof o.text !== 'string' || !o.text.trim()) return []
    let basis: Basis = BASES.includes(o.basis as Basis) ? (o.basis as Basis) : 'reasoned'
    const refs = Array.isArray(o.refs) ? o.refs.filter((r): r is string => typeof r === 'string') : []
    // Plan §10: a claim marked "sourced" with no refs is downgraded, so agents
    // cannot launder speculation as evidence by adjective choice.
    if (basis === 'sourced' && refs.length === 0) basis = 'reasoned'
    const confidence = ['low', 'medium', 'high'].includes(o.confidence as string)
      ? (o.confidence as Claim['confidence']) : undefined
    return [{ text: o.text, basis, refs: refs.length ? refs : undefined, confidence }]
  })

  const degraded = claims.length === 0
  return {
    turn: { body, stance, reply_to: replyTo, claims },
    positionOps: coercePositionOps(v.position_ops),
    memory: coerceMemory(v.memory),
    degraded,
    reason: degraded ? 'no claims extracted' : undefined,
  }
}

const OPS: PositionOp[] = ['assert', 'revise', 'withdraw', 'endorse', 'oppose', 'unsure']

function coercePositionOps(value: unknown): RawPositionOp[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw): RawPositionOp[] => {
    if (!raw || typeof raw !== 'object') return []
    const o = raw as Record<string, unknown>
    if (!OPS.includes(o.op as PositionOp)) return []
    const label = typeof o.label === 'string' && /^P\d+$/i.test(o.label.trim())
      ? o.label.trim().toUpperCase() : null
    const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : null
    // An op that names neither an existing position nor a new title is unusable.
    if (!label && !title) return []
    return [{
      label, title,
      op: o.op as PositionOp,
      note: typeof o.note === 'string' ? o.note.trim() : '',
      text: typeof o.text === 'string' ? o.text.trim() : '',
    }]
  })
}

const MEMORY_TYPES = new Set<MemoryCard['type']>([
  'definition', 'decision', 'assumption', 'rejected-hypothesis',
  'result', 'open-question', 'reference', 'own-position', 'user-preference',
])

function coerceMemory(value: unknown): RawMemoryProposal[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw): RawMemoryProposal[] => {
    if (!raw || typeof raw !== 'object') return []
    const o = raw as Record<string, unknown>
    if (typeof o.text !== 'string' || o.text.trim().length < 8) return []
    const type = MEMORY_TYPES.has(o.type as MemoryCard['type'])
      ? (o.type as MemoryCard['type']) : 'result'
    return [{ type, text: o.text.trim().slice(0, 600) }]
  })
}

function degrade(body: string, reason: string): ParsedTurn {
  const text = body.trim() || '(the agent returned nothing)'
  return {
    turn: { body: text, stance: 'propose', reply_to: null, claims: [] },
    positionOps: [], memory: [], degraded: true, reason,
  }
}

/**
 * Pull a turn object out of prose.
 *
 * Naively taking the last `{` finds the *innermost* brace — with agy, which
 * emits prose followed by the JSON, that is the final claim object rather than
 * the turn, and the whole ledger silently comes back empty. So: try every brace
 * position, keep every balanced object that parses, and prefer the one that
 * actually looks like a turn.
 */
export function extractJson(text: string): unknown {
  const candidates: unknown[] = []

  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)]
  for (const m of fences) {
    try { candidates.push(JSON.parse(m[1])) } catch { /* next */ }
  }

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    const parsed = parseBalanced(text, i)
    if (parsed !== undefined) candidates.push(parsed)
  }

  const turnish = candidates.filter(isTurnShaped)
  if (turnish.length) return turnish[turnish.length - 1]
  return candidates.length ? candidates[candidates.length - 1] : null
}

const isTurnShaped = (v: unknown): boolean =>
  !!v && typeof v === 'object' && !Array.isArray(v)
  && ('body' in (v as object) || 'stance' in (v as object) || 'claims' in (v as object))

/** Parse the brace-balanced object starting at `start`, or undefined. */
function parseBalanced(text: string, start: number): unknown | undefined {
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)) } catch { return undefined }
    }
  }
  return undefined
}

/**
 * Strip the contract JSON so it never leaks into the rendered bubble — fenced
 * or, as agy emits it, a bare object appended to the prose.
 */
export function stripJsonBlock(text: string): string {
  let out = text.replace(/```(?:json)?\s*\n[\s\S]*?```\s*$/g, '').trim()
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== '{') continue
    const parsed = parseBalanced(out, i)
    if (parsed !== undefined && isTurnShaped(parsed)) return out.slice(0, i).trim()
  }
  return out
}
