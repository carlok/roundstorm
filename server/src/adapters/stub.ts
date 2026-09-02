/**
 * A brain that answers instantly from a script.
 *
 * Used only by tests. Real adapters spawn a process and cost money, so without
 * this the scheduler could not be exercised at all — and the scheduler is where
 * round isolation, sealed openings, turn deadlines, cancellation and human
 * steering live.
 *
 * It records the context it was given, which is what makes isolation assertable:
 * what an agent was *shown* is a fact, where what it said is not.
 */
import type { AdapterEvent, BrainAdapter, TurnRequest } from './types.ts'

export interface StubCall {
  systemPrompt: string
  userPrompt: string
  model: string | null
  tier: string
  workingDir: string | null
}

export interface StubBrain {
  adapter: BrainAdapter
  /** Every request this brain has been handed, in order. */
  calls: StubCall[]
  /** Prompts only, for the common "was X visible to anyone?" assertion. */
  prompts: () => string[]
  reset: () => void
}

export interface StubOptions {
  id?: string
  /** Body for turn n; falls back to a generic line. */
  reply?: (call: StubCall, index: number) => string
  /** Structured turn to return. Overrides `reply` when given. */
  turn?: (call: StubCall, index: number) => unknown
  /** Never resolve, so the per-turn deadline is what ends it. */
  hang?: boolean
  /** Fail the way a missing CLI does. */
  fail?: string
  /** Artificial delay in ms, for ordering and cancellation tests. */
  delayMs?: number
}

export function makeStubBrain(opts: StubOptions = {}): StubBrain {
  const calls: StubCall[] = []

  const adapter: BrainAdapter = {
    id: opts.id ?? 'stub',
    label: 'Stub',
    kind: 'http',
    schemaEnforced: true,
    supportsSystemPrompt: true,
    note: 'test double',
    available: async () => true,
    listModels: async () => [{ id: 'stub-1', label: 'Stub 1' }],
    run(req: TurnRequest, signal: AbortSignal) {
      const index = calls.length
      calls.push({
        systemPrompt: req.systemPrompt,
        userPrompt: req.userPrompt,
        model: req.model,
        tier: req.tier,
        workingDir: req.workingDir,
      })
      return generate(opts, calls[index], index, signal)
    },
  }

  return {
    adapter,
    calls,
    prompts: () => calls.map(c => c.userPrompt),
    reset: () => { calls.length = 0 },
  }
}

async function* generate(
  opts: StubOptions, call: StubCall, index: number, signal: AbortSignal,
): AsyncIterable<AdapterEvent> {
  yield { type: 'activity', text: 'Thinking' }

  if (opts.fail) {
    yield { type: 'error', message: opts.fail }
    return
  }

  if (opts.hang) {
    // Resolve only on abort, so the caller's deadline is what ends the turn.
    await new Promise<void>(resolve => {
      if (signal.aborted) return resolve()
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
    return
  }

  if (opts.delayMs) {
    await new Promise<void>(resolve => {
      const t = setTimeout(resolve, opts.delayMs)
      signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
    })
    if (signal.aborted) return
  }

  const structured = opts.turn
    ? opts.turn(call, index)
    : {
        body: opts.reply ? opts.reply(call, index) : `stub turn ${index + 1}`,
        stance: 'propose',
        reply_to: '',
        claims: [{ text: `claim ${index + 1}`, basis: 'reasoned' }],
      }

  yield { type: 'final', structured, text: JSON.stringify(structured) }
}
