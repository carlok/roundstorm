export type {
  Agent, AgentActivity, Basis, Claim, ConsensusLevel, Deliberation, LogEntry,
  MemoryCard, Message, Mode, Position, PositionOp, PositionStanceRow, Project,
  ResultCard, Room, ServerEvent, Source, Stance, Style, Tier, Turn,
} from '../../server/src/types.ts'

export interface LedgerSummary {
  positions: import('../../server/src/types.ts').Position[]
  leading: import('../../server/src/types.ts').Position | null
  level: import('../../server/src/types.ts').ConsensusLevel
  headline: string
  /** The leading position at its current version: who backs it, who holds out. */
  standing?: {
    label: string; version: number; title: string
    backers: string[]; holdouts: string[]; n: number
  } | null
}

export interface Persona { key: string; label: string; blurb: string; contract: string }
export interface BrainInfo {
  id: string; label: string; kind: 'cli' | 'http'
  schemaEnforced: boolean; note?: string; available: boolean
  models: { id: string; label: string }[]
}
export interface ModeInfo { key: string; label: string; blurb: string }
