// Shared vocabulary between daemon and UI. See plan §3 (turn contract) and §9 (tiers).

export type Tier = 'reasoning' | 'research' | 'workstation' | 'full'

export const TIER_ORDER: Tier[] = ['reasoning', 'research', 'workstation', 'full']

/**
 * Is this a tier?
 *
 * Every tier lookup is a Record keyed by the four names, and an unrecognised key
 * yields `undefined` rather than throwing — which in two adapters meant the
 * restrictive branch was skipped and the permissive default applied. So the
 * string has to be checked before it is stored, and the lookups have to fail
 * closed anyway. Both, not either.
 */
export const isTier = (v: unknown): v is Tier =>
  typeof v === 'string' && (TIER_ORDER as readonly string[]).includes(v)
export const TIER_LABEL: Record<Tier, string> = {
  reasoning: 'Reasoning only',
  research: 'Research tools',
  workstation: 'Workstation (read-only)',
  full: 'Full local',
}

export type Mode = 'brainstorm' | 'critique' | 'deliberation' | 'consensus' | 'research_plan' | 'conclave'
export type Style = 'parallel' | 'pingpong'

export type Stance = 'propose' | 'support' | 'object' | 'refine' | 'question' | 'concede' | 'endorse'
export type Basis = 'reasoned' | 'computed' | 'sourced' | 'recalled'

export interface Claim {
  text: string
  basis: Basis
  refs?: string[]
  confidence?: 'low' | 'medium' | 'high'
}

/** The structured half of an agent turn (plan §3). `body` is what the bubble renders. */
export interface Turn {
  body: string
  stance: Stance
  reply_to?: string | null
  addressed_to?: string[]
  claims: Claim[]
}

export interface Agent {
  id: string
  name: string
  role: string
  avatarColor: string
  personaKey: string
  personaExtra: string
  brain: string
  model: string | null
  tierCeiling: Tier
  createdAt: number
}

export interface Room {
  id: string
  projectId: string
  name: string
  kind: 'room' | 'dm'
  tier: Tier
  createdAt: number
  memberIds: string[]
}

export interface Project {
  id: string
  name: string
  workingDir: string | null
  defaultTier: Tier
  createdAt: number
}

export interface Message {
  id: string
  roomId: string
  authorType: 'human' | 'agent' | 'system'
  authorId: string | null
  body: string
  replyTo: string | null
  round: number | null
  deliberationId: string | null
  sealed: boolean
  priority: boolean
  stance: Stance | null
  claims: Claim[]
  degraded: boolean
  brain: string | null
  model: string | null
  costUsd: number | null
  createdAt: number
  seq: number
}

export interface Deliberation {
  id: string
  roomId: string
  mode: Mode
  rounds: number
  style: Style
  sealedOpening: boolean
  status: 'running' | 'stopping' | 'stopped' | 'complete' | 'failed'
  currentRound: number
  question: string
  tier: Tier
  createdAt: number
  endedAt: number | null
}

/** Per-agent live state inside a running deliberation (plan §12, §18). */
export interface AgentActivity {
  agentId: string
  state: 'idle' | 'waiting' | 'thinking' | 'tool' | 'writing' | 'done' | 'error'
  detail: string
  round: number | null
  startedAt: number | null
}

export type ServerEvent =
  | { type: 'message'; message: Message }
  | { type: 'message.updated'; message: Message }
  | { type: 'activity'; roomId: string; activity: AgentActivity }
  | { type: 'deliberation'; deliberation: Deliberation }
  | { type: 'reveal'; roomId: string; deliberationId: string; round: number }
  | { type: 'log'; entry: LogEntry }
  | { type: 'result'; result: ResultCard }
  | { type: 'memory'; card: MemoryCard }

export interface LogEntry {
  id: number
  ts: number
  type: string
  roomId: string | null
  deliberationId: string | null
  agentId: string | null
  payload: unknown
}

// ---------- positions ledger (plan §3, §7, §20) ----------

export type PositionOp = 'assert' | 'revise' | 'withdraw' | 'endorse' | 'oppose' | 'unsure'

export interface PositionStanceRow {
  agentId: string
  op: PositionOp
  note: string
  version: number
  round: number | null
}

export interface Position {
  id: string
  roomId: string
  /** Room-scoped short handle (P1, P2…) — agents cannot cite a UUID reliably. */
  label: string
  title: string
  version: number
  text: string
  createdBy: string | null
  createdAt: number
  updatedAt: number
  /** Latest op per agent, which is what the panel and the consensus level read. */
  stances: PositionStanceRow[]
}

export type ConsensusLevel =
  | 'strong_consensus'
  | 'consensus_with_reservations'
  | 'two_positions'
  | 'no_reliable_conclusion'
  | 'evidence_required'
  | 'conclave_reached'
  | 'conclave_failed'

export interface ResultCard {
  id: string
  deliberationId: string
  roomId: string
  level: ConsensusLevel
  createdAt: number
  conclusion: string
  why: string
  commonGround: string[]
  disagreement: string[]
  alternatives: string[]
  evidence: string[]
  unknowns: string[]
  nextSteps: string[]
  /** Conclave only. */
  proposalVersion?: number
  failureReason?: string
}

export interface MemoryCard {
  id: string
  agentId: string
  projectId: string | null
  roomId: string | null
  scope: 'agent' | 'project' | 'room'
  type: 'definition' | 'decision' | 'assumption' | 'rejected-hypothesis'
      | 'result' | 'open-question' | 'reference' | 'own-position' | 'user-preference'
  text: string
  status: 'proposed' | 'accepted' | 'rejected'
  sourceMessageId: string | null
  createdAt: number
  lastUsed: number | null
}

export interface Source {
  id: string
  roomId: string
  label: string
  url: string | null
  title: string
  kind: 'web' | 'file' | 'calculation' | 'dataset' | 'note'
  snapshot: string | null
  foundBy: string | null
  createdAt: number
}
