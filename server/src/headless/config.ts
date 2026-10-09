/**
 * The experiment file: one JSON(C) document describing a whole run.
 *
 * Parsing and validation are kept pure so a bad file fails with a line the user
 * can act on, before anything is created in the database and before a single
 * model call is billed.
 */
import type { Mode, Style, Tier } from '../types.ts'
import { TIER_ORDER, isTier } from '../types.ts'

export interface AgentSpec {
  name: string
  persona: string
  /** Free text appended to the persona, or the whole contract when persona is "custom". */
  instructions?: string
  role?: string
  brain: string
  model?: string | null
  color?: string
  tierCeiling?: Tier
}

export interface ExperimentConfig {
  project?: string
  workingDir?: string | null
  room: { name: string; tier?: Tier }
  agents: AgentSpec[]
  question: string
  mode?: Mode
  rounds?: number
  style?: Style
  sealedOpening?: boolean
}

const MODES: Mode[] = ['brainstorm', 'critique', 'deliberation', 'consensus', 'research_plan', 'conclave']
const STYLES: Style[] = ['parallel', 'pingpong']

/**
 * Strip comments and trailing commas so a config can be commented.
 *
 * String-aware, because a `//` inside a question — a URL, say — is not a comment
 * and silently truncating one would be a miserable bug to chase.
 */
export function stripJsonc(text: string): string {
  let out = ''
  let inString = false, escaped = false
  let inLine = false, inBlock = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1]
    if (inLine) { if (c === '\n') { inLine = false; out += c } ; continue }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i++ } ; continue }
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; out += c; continue }
    if (c === '/' && next === '/') { inLine = true; i++; continue }
    if (c === '/' && next === '*') { inBlock = true; i++; continue }
    out += c
  }
  // Trailing commas before a close brace or bracket.
  return out.replace(/,(\s*[}\]])/g, '$1')
}

export class ConfigError extends Error {}

const fail = (msg: string): never => { throw new ConfigError(msg) }

/** Brains and personas the caller knows about. Optional, so this module stays pure. */
export interface KnownNames {
  brains?: readonly string[]
  personas?: readonly string[]
}

/** Case- and separator-insensitive, so `sealed_opening` finds `sealedOpening`. */
const squash = (s: string) => s.toLowerCase().replace(/[_\-\s]/g, '')

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1, d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return d[a.length][b.length]
}

/** The valid name this one was probably meant to be, if any is close. */
function nearest(name: string, valid: readonly string[]): string | null {
  const exact = valid.find(v => squash(v) === squash(name))
  if (exact) return exact
  let best: { v: string; d: number } | null = null
  for (const v of valid) {
    const d = editDistance(squash(name), squash(v))
    if (d <= 2 && (!best || d < best.d)) best = { v, d }
  }
  return best ? best.v : null
}

/**
 * Refuse keys nobody reads.
 *
 * A config used to be read field by field, so a key it did not know was dropped
 * without a word: `"round": 5` parsed cleanly and the default of 3 won, and the
 * run looked like the experiment that had been written and was not. For a file
 * whose whole purpose is to describe an experiment exactly, a typo has to be loud.
 */
function rejectUnknownKeys(obj: Record<string, unknown>, valid: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (valid.includes(key)) continue
    const guess = nearest(key, valid)
    const prefix = where ? `${where}: ` : ''
    fail(guess
      ? `${prefix}unknown key "${key}" — did you mean "${guess}"?`
      : `${prefix}unknown key "${key}"; valid keys are ${valid.join(', ')}`)
  }
}

const TOP_KEYS = ['project', 'workingDir', 'room', 'agents', 'question', 'mode', 'rounds', 'style', 'sealedOpening'] as const
const ROOM_KEYS = ['name', 'tier'] as const
const AGENT_KEYS = ['name', 'persona', 'instructions', 'role', 'brain', 'model', 'color', 'tierCeiling'] as const

/** An optional string: absent is fine, present-but-wrong is an error rather than a shrug. */
function optionalString(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') fail(`"${name}" must be a string (got ${JSON.stringify(v)})`)
  return v as string
}

/** Parse and validate, or throw a ConfigError naming the offending field. */
export function parseExperiment(text: string, known: KnownNames = {}): ExperimentConfig {
  let raw: unknown
  try {
    raw = JSON.parse(stripJsonc(text))
  } catch (err) {
    fail(`the file is not valid JSON: ${(err as Error).message}`)
  }
  return validateExperiment(raw, known)
}

export function validateExperiment(raw: unknown, known: KnownNames = {}): ExperimentConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('expected a JSON object at the top level')
  }
  const c = raw as Record<string, unknown>
  rejectUnknownKeys(c, TOP_KEYS, '')

  const question = typeof c.question === 'string' ? c.question.trim() : ''
  if (!question) fail('"question" is required and must be a non-empty string')

  const room = c.room as Record<string, unknown> | undefined
  if (room && typeof room === 'object') rejectUnknownKeys(room, ROOM_KEYS, 'room')
  const roomName = typeof room?.name === 'string' ? room.name.trim() : ''
  if (!roomName) fail('"room.name" is required')

  const tier = room?.tier === undefined ? 'research' : room.tier
  if (!isTier(tier)) {
    fail(`"room.tier" must be one of ${TIER_ORDER.join(', ')} (got ${JSON.stringify(tier)})`)
  }

  if (!Array.isArray(c.agents) || c.agents.length === 0) {
    fail('"agents" must be a non-empty array')
  }
  const agents = (c.agents as unknown[]).map((a, i) => validateAgent(a, i, known))

  const seen = new Set<string>()
  for (const a of agents) {
    if (seen.has(a.name)) fail(`two agents are both called "${a.name}"; names must be unique`)
    seen.add(a.name)
  }

  const mode = c.mode === undefined ? 'deliberation' : c.mode
  if (!MODES.includes(mode as Mode)) {
    fail(`"mode" must be one of ${MODES.join(', ')} (got ${JSON.stringify(mode)})`)
  }

  const style = c.style === undefined ? 'parallel' : c.style
  if (!STYLES.includes(style as Style)) {
    fail(`"style" must be "parallel" or "pingpong" (got ${JSON.stringify(style)})`)
  }

  const roundsRaw = c.rounds === undefined ? 3 : c.rounds
  if (typeof roundsRaw !== 'number' || !Number.isInteger(roundsRaw) || roundsRaw < 1 || roundsRaw > 20) {
    fail(`"rounds" must be a whole number between 1 and 20 (got ${JSON.stringify(roundsRaw)})`)
  }
  const rounds = roundsRaw as number

  // A conclave with one participant has nobody to negotiate with; it would run to
  // its cap and report failure, having billed for every round.
  if (mode === 'conclave' && agents.length < 2) {
    fail('"mode": "conclave" needs at least two agents — one cannot reach unanimity alone')
  }

  // `!!"false"` is true, so `"sealedOpening": "false"` used to turn sealing ON.
  if (c.sealedOpening !== undefined && typeof c.sealedOpening !== 'boolean') {
    fail(`"sealedOpening" must be true or false (got ${JSON.stringify(c.sealedOpening)})`)
  }
  const project = optionalString(c.project, 'project')
  const workingDir = optionalString(c.workingDir, 'workingDir')

  return {
    project,
    workingDir: workingDir ?? null,
    room: { name: roomName, tier: tier as Tier },
    agents,
    question,
    mode: mode as Mode,
    rounds,
    style: style as Style,
    sealedOpening: c.sealedOpening === undefined ? true : (c.sealedOpening as boolean),
  }
}

function validateAgent(raw: unknown, index: number, known: KnownNames): AgentSpec {
  const where = `agents[${index}]`
  if (!raw || typeof raw !== 'object') fail(`${where} must be an object`)
  const a = raw as Record<string, unknown>
  rejectUnknownKeys(a, AGENT_KEYS, where)

  const name = typeof a.name === 'string' ? a.name.trim() : ''
  if (!name) fail(`${where}.name is required`)

  const brain = typeof a.brain === 'string' ? a.brain.trim() : ''
  if (!brain) fail(`${where}.brain is required (for example "claude", "codex", "agy")`)

  const persona = typeof a.persona === 'string' ? a.persona.trim() : ''
  if (!persona) fail(`${where}.persona is required (a template key, or "custom")`)

  // Only checkable when the caller knows the registry. A mistyped brain used to
  // create an agent that never spoke and left nothing in the transcript, and a
  // mistyped persona silently became the first template.
  if (known.brains && !known.brains.includes(brain)) {
    fail(`${where}.brain "${brain}" is not a known brain; known brains: ${known.brains.join(', ')}`)
  }
  if (known.personas && !known.personas.includes(persona)) {
    const guess = nearest(persona, known.personas)
    fail(`${where}.persona "${persona}" is not a known persona`
      + (guess ? ` — did you mean "${guess}"?` : `; known personas: ${known.personas.join(', ')}`))
  }

  const instructions = optionalString(a.instructions, `${where}.instructions`) ?? ''
  if (persona === 'custom' && !instructions.trim()) {
    fail(`${where} uses "persona": "custom", so "instructions" must carry the behavioural contract`)
  }

  const tierCeiling = a.tierCeiling === undefined ? 'research' : a.tierCeiling
  if (!isTier(tierCeiling)) {
    fail(`${where}.tierCeiling must be one of ${TIER_ORDER.join(', ')}`)
  }

  return {
    name, brain, persona, instructions,
    role: optionalString(a.role, `${where}.role`) ?? '',
    model: optionalString(a.model, `${where}.model`)?.trim() || null,
    color: optionalString(a.color, `${where}.color`),
    tierCeiling: tierCeiling as Tier,
  }
}

/** Split a .jsonl file into one config per non-empty line. */
export function parseExperiments(text: string, jsonl: boolean, known: KnownNames = {}): ExperimentConfig[] {
  if (!jsonl) return [parseExperiment(text, known)]
  const out: ExperimentConfig[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('//')) continue
    try {
      out.push(parseExperiment(line, known))
    } catch (err) {
      throw new ConfigError(`line ${i + 1}: ${(err as Error).message}`)
    }
  }
  if (!out.length) throw new ConfigError('the .jsonl file contains no experiments')
  return out
}
