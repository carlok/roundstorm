/**
 * The experiment file: one JSON(C) document describing a whole run.
 *
 * Parsing and validation are kept pure so a bad file fails with a line the user
 * can act on, before anything is created in the database and before a single
 * model call is billed.
 */
import type { Mode, Style, Tier } from '../types.ts'

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
const TIERS: Tier[] = ['reasoning', 'research', 'workstation', 'full']

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

/** Parse and validate, or throw a ConfigError naming the offending field. */
export function parseExperiment(text: string): ExperimentConfig {
  let raw: unknown
  try {
    raw = JSON.parse(stripJsonc(text))
  } catch (err) {
    fail(`the file is not valid JSON: ${(err as Error).message}`)
  }
  return validateExperiment(raw)
}

export function validateExperiment(raw: unknown): ExperimentConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('expected a JSON object at the top level')
  }
  const c = raw as Record<string, unknown>

  const question = typeof c.question === 'string' ? c.question.trim() : ''
  if (!question) fail('"question" is required and must be a non-empty string')

  const room = c.room as Record<string, unknown> | undefined
  const roomName = typeof room?.name === 'string' ? room.name.trim() : ''
  if (!roomName) fail('"room.name" is required')

  const tier = room?.tier === undefined ? 'research' : room.tier
  if (!TIERS.includes(tier as Tier)) {
    fail(`"room.tier" must be one of ${TIERS.join(', ')} (got ${JSON.stringify(tier)})`)
  }

  if (!Array.isArray(c.agents) || c.agents.length === 0) {
    fail('"agents" must be a non-empty array')
  }
  const agents = (c.agents as unknown[]).map((a, i) => validateAgent(a, i))

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

  return {
    project: typeof c.project === 'string' ? c.project : undefined,
    workingDir: typeof c.workingDir === 'string' ? c.workingDir : null,
    room: { name: roomName, tier: tier as Tier },
    agents,
    question,
    mode: mode as Mode,
    rounds,
    style: style as Style,
    sealedOpening: c.sealedOpening === undefined ? true : !!c.sealedOpening,
  }
}

function validateAgent(raw: unknown, index: number): AgentSpec {
  const where = `agents[${index}]`
  if (!raw || typeof raw !== 'object') fail(`${where} must be an object`)
  const a = raw as Record<string, unknown>

  const name = typeof a.name === 'string' ? a.name.trim() : ''
  if (!name) fail(`${where}.name is required`)

  const brain = typeof a.brain === 'string' ? a.brain.trim() : ''
  if (!brain) fail(`${where}.brain is required (for example "claude", "codex", "agy")`)

  const persona = typeof a.persona === 'string' ? a.persona.trim() : ''
  if (!persona) fail(`${where}.persona is required (a template key, or "custom")`)

  const instructions = typeof a.instructions === 'string' ? a.instructions : ''
  if (persona === 'custom' && !instructions.trim()) {
    fail(`${where} uses "persona": "custom", so "instructions" must carry the behavioural contract`)
  }

  const tierCeiling = a.tierCeiling === undefined ? 'research' : a.tierCeiling
  if (!TIERS.includes(tierCeiling as Tier)) {
    fail(`${where}.tierCeiling must be one of ${TIERS.join(', ')}`)
  }

  return {
    name, brain, persona, instructions,
    role: typeof a.role === 'string' ? a.role : '',
    model: typeof a.model === 'string' && a.model.trim() ? a.model.trim() : null,
    color: typeof a.color === 'string' ? a.color : undefined,
    tierCeiling: tierCeiling as Tier,
  }
}

/** Split a .jsonl file into one config per non-empty line. */
export function parseExperiments(text: string, jsonl: boolean): ExperimentConfig[] {
  if (!jsonl) return [parseExperiment(text)]
  const out: ExperimentConfig[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('//')) continue
    try {
      out.push(parseExperiment(line))
    } catch (err) {
      throw new ConfigError(`line ${i + 1}: ${(err as Error).message}`)
    }
  }
  if (!out.length) throw new ConfigError('the .jsonl file contains no experiments')
  return out
}
