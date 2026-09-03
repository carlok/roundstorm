import { claudeAdapter } from './claude.ts'
import { codexAdapter } from './codex.ts'
import { agyAdapter } from './agy.ts'
import { cursorAdapter } from './cursor.ts'
import { deepseekAdapter, lmStudioAdapter, ollamaAdapter } from './openai-compat.ts'
import { which } from './spawn.ts'
import type { BrainAdapter } from './types.ts'

const ADAPTERS: BrainAdapter[] = [
  claudeAdapter, codexAdapter, agyAdapter, cursorAdapter,
  deepseekAdapter, lmStudioAdapter, ollamaAdapter,
]

export const getAdapter = (id: string): BrainAdapter | undefined =>
  ADAPTERS.find(a => a.id === id)

/**
 * Add a brain at runtime.
 *
 * This exists so the scheduler can be tested at all. Every path through it calls
 * a brain, so without a way to substitute one, testing round isolation, the
 * sealed opening, the turn deadline, cancellation or steering meant spending real
 * money and minutes — which is why that file sat at 17% while holding most of the
 * logic that can fail silently.
 *
 * Replaces an existing adapter with the same id, so a test can shadow a real one.
 */
export function registerAdapter(adapter: BrainAdapter): () => void {
  const previous = ADAPTERS.findIndex(a => a.id === adapter.id)
  const removed = previous >= 0 ? ADAPTERS.splice(previous, 1, adapter)[0] : undefined
  if (previous < 0) ADAPTERS.push(adapter)
  cache = null
  return () => {
    const at = ADAPTERS.findIndex(a => a.id === adapter.id)
    if (at < 0) return
    if (removed) ADAPTERS.splice(at, 1, removed)
    else ADAPTERS.splice(at, 1)
    cache = null
  }
}

export interface BrainInfo {
  id: string
  label: string
  kind: 'cli' | 'http'
  schemaEnforced: boolean
  supportsSystemPrompt: boolean
  note?: string
  available: boolean
  models: { id: string; label: string }[]
  /** Set when the adapter is reachable but enumeration came back empty. */
  warning?: string
}

let cache: BrainInfo[] | null = null

/**
 * Adapter self-test plus multiplexer enumeration (plan §19.5, §20).
 *
 * Model lists for `agy` and `cursor-agent` are live network calls, and those two
 * binaries are where most of the available brains actually live. A model
 * vanishing from that list should degrade an agent visibly here, at boot, rather
 * than fail three rounds into a deliberation.
 */
export async function probeBrains(force = false): Promise<BrainInfo[]> {
  if (cache && !force) return cache

  cache = await Promise.all(ADAPTERS.map(async a => {
    // An adapter that *throws* is a different thing from a CLI that is not
    // installed, and reporting both as unavailable hid every bug in a probe
    // behind "install it". Say which one happened.
    let available = false
    let broke: string | undefined
    try {
      available = await a.available()
    } catch (e) {
      broke = e instanceof Error ? e.message : String(e)
    }
    let models: Awaited<ReturnType<BrainAdapter['listModels']>> = []
    if (available) {
      try {
        models = await a.listModels()
      } catch (e) {
        broke = e instanceof Error ? e.message : String(e)
      }
    }
    return {
      id: a.id, label: a.label, kind: a.kind,
      schemaEnforced: a.schemaEnforced,
      supportsSystemPrompt: a.supportsSystemPrompt,
      note: a.note, available, models,
      warning: broke ? `probe failed: ${broke.slice(0, 160)}`
        : available && models.length === 0 ? 'reachable but returned no models'
        : undefined,
    }
  }))
  return cache
}

/** Every (brain, model) pair as a selectable brain — multiplexers expand here. */
export async function listBrainOptions(): Promise<
  { brainId: string; brainLabel: string; modelId: string; label: string; available: boolean }[]
> {
  const brains = await probeBrains()
  return brains.flatMap(b =>
    b.models.map(m => ({
      brainId: b.id,
      brainLabel: b.label,
      modelId: m.id,
      label: `${m.label} · ${b.label}`,
      available: b.available,
    })))
}

/**
 * Brains disagree about JSON Schema, so each gets the dialect it accepts.
 *
 *  - agy appends its own `toolAction`/`toolSummary` keys to the output object,
 *    so it must not be sent `additionalProperties: false`.
 *  - codex validates against OpenAI strict mode, which demands that EVERY
 *    property appear in `required` and that every object closes with
 *    `additionalProperties: false`. An optional field is a hard 400, and the
 *    agent simply does not answer that round.
 */
export function schemaFor(adapter: BrainAdapter, schema: unknown): unknown {
  if (adapter.strictSchema) return strict(schema)
  if (adapter.relaxedSchema) return relax(schema)
  return schema
}

/** OpenAI strict mode: all properties required, additionalProperties false. */
function strict(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strict)
  if (!node || typeof node !== 'object') return node
  const src = node as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) out[k] = strict(v)
  if (src.type === 'object' && src.properties && typeof src.properties === 'object') {
    out.required = Object.keys(src.properties as Record<string, unknown>)
    out.additionalProperties = false
  }
  return out
}

function relax(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(relax)
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'additionalProperties') continue
      out[k] = relax(v)
    }
    return out
  }
  return node
}

export { which }
