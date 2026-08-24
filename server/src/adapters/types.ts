import type { Tier } from '../types.ts'

export type AdapterEvent =
  | { type: 'activity'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; detail?: string }
  | { type: 'final'; structured: unknown; text: string; costUsd?: number }
  | { type: 'error'; message: string }

export interface TurnRequest {
  systemPrompt: string
  userPrompt: string
  model: string | null
  tier: Tier
  workingDir: string | null
  /** JSON Schema for the turn contract; adapters that cannot enforce it fall back to prompting. */
  schema: unknown
}

export interface BrainAdapter {
  id: string
  label: string
  kind: 'cli' | 'http'
  /** False means the turn contract must be prompted and parsed (plan §3). */
  schemaEnforced: boolean
  /** False means the persona has to be folded into the user prompt (cursor-agent). */
  supportsSystemPrompt: boolean
  /** True when the provider rejects or mangles `additionalProperties: false`. */
  relaxedSchema?: boolean
  /** True when the provider enforces OpenAI strict mode (all props required). */
  strictSchema?: boolean
  /** Vendor-account / data-retention note surfaced in the brain picker (plan §19.7). */
  note?: string
  available(): Promise<boolean>
  listModels(): Promise<{ id: string; label: string }[]>
  run(req: TurnRequest, signal: AbortSignal): AsyncIterable<AdapterEvent>
}
