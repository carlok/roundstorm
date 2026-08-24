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
}

export interface Persona { key: string; label: string; blurb: string; contract: string }
export interface BrainInfo {
  id: string; label: string; kind: 'cli' | 'http'
  schemaEnforced: boolean; note?: string; available: boolean
  models: { id: string; label: string }[]
}
export interface ModeInfo { key: string; label: string; blurb: string }
