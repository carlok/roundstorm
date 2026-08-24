/**
 * OpenAI-compatible HTTP brains: DeepSeek, LM Studio, Ollama.
 *
 * This is the escape hatch from plan §19.7. Every CLI brain is a closed-source
 * vendor binary that can be deprecated out from under the product; a brain that
 * needs nothing but an HTTP endpoint is a reliability feature. The local variant
 * needs no account at all.
 */
import type { AdapterEvent, BrainAdapter, TurnRequest } from './types.ts'

export interface CompatSpec {
  id: string
  label: string
  baseUrl: string
  apiKeyEnv?: string
  note?: string
  /** Local servers list what they actually hold; hosted ones are hardcoded. */
  staticModels?: { id: string; label: string }[]
  /** Local endpoints answer /v1/models without auth, so availability is testable. */
  probe?: boolean
  timeoutMs?: number
  /**
   * How this server wants structured output. Not cosmetic: LM Studio rejects
   * `json_object` outright ("must be 'json_schema' or 'text'"), while DeepSeek
   * only offers `json_object`. Getting it wrong is a 400 and a dead agent.
   */
  responseFormat: 'json_schema' | 'json_object' | 'text'
}

export function makeCompatAdapter(spec: CompatSpec): BrainAdapter {
  const key = () => (spec.apiKeyEnv ? process.env[spec.apiKeyEnv] : undefined)
  const headers = () => {
    const h: Record<string, string> = { 'content-type': 'application/json' }
    const k = key()
    if (k) h.authorization = `Bearer ${k}`
    return h
  }

  return {
    id: spec.id,
    label: spec.label,
    kind: 'http',
    // Only json_schema is real enforcement. json_object constrains the shape but
    // not the fields, so the prompt still has to carry the contract — the same
    // prompt-and-parse path cursor-agent uses.
    schemaEnforced: spec.responseFormat === 'json_schema',
    strictSchema: spec.responseFormat === 'json_schema',
    supportsSystemPrompt: true,
    note: spec.note,

    async available() {
      if (spec.apiKeyEnv && !key()) return false
      if (!spec.probe) return true
      try {
        const res = await fetch(`${spec.baseUrl}/models`, {
          headers: headers(), signal: AbortSignal.timeout(2500),
        })
        return res.ok
      } catch {
        return false
      }
    },

    async listModels() {
      if (spec.staticModels) return spec.staticModels
      try {
        const res = await fetch(`${spec.baseUrl}/models`, {
          headers: headers(), signal: AbortSignal.timeout(4000),
        })
        if (!res.ok) return []
        const body = await res.json() as any
        return (body?.data ?? [])
          .map((m: any) => ({ id: String(m.id), label: String(m.id) }))
          // Embedding models cannot hold a turn; offering them as brains would
          // produce an agent that fails every round.
          .filter((m: { id: string }) => !/embed/i.test(m.id))
      } catch {
        return []
      }
    },

    run(req, signal) {
      return runCompat(spec, headers(), req, signal)
    },
  }
}

function responseFormat(spec: CompatSpec, schema: unknown) {
  if (spec.responseFormat === 'text') return undefined
  if (spec.responseFormat === 'json_object') return { type: 'json_object' }
  return {
    type: 'json_schema',
    json_schema: { name: 'roundstorm_turn', strict: true, schema },
  }
}

async function* runCompat(
  spec: CompatSpec, headers: Record<string, string>,
  req: TurnRequest, signal: AbortSignal,
): AsyncIterable<AdapterEvent> {
  if (spec.apiKeyEnv && !process.env[spec.apiKeyEnv]) {
    yield { type: 'error', message: `${spec.apiKeyEnv} is not set` }
    return
  }

  yield { type: 'activity', text: 'Thinking' }

  // With json_schema the server enforces the shape, so repeating it in the
  // prompt is wasted tokens. Without it, the prompt is the only contract there is.
  const system = spec.responseFormat === 'json_schema'
    ? req.systemPrompt
    : `${req.systemPrompt}

## Output format
Reply with a single JSON object matching this schema, and nothing else:
${JSON.stringify(req.schema)}`

  let res: Response
  try {
    res = await fetch(`${spec.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify({
        model: req.model ?? spec.staticModels?.[0]?.id,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: req.userPrompt },
        ],
        response_format: responseFormat(spec, req.schema),
        max_tokens: 4000,
      }),
    })
  } catch (err) {
    const aborted = signal.aborted
    yield { type: 'error', message: aborted ? 'cancelled' : `${spec.id} request failed: ${String(err)}` }
    return
  }

  if (!res.ok) {
    yield { type: 'error', message: `${spec.id} ${res.status}: ${(await res.text()).slice(0, 300)}` }
    return
  }

  const body = await res.json() as any
  const text: string = body?.choices?.[0]?.message?.content ?? ''
  if (!text.trim()) {
    yield { type: 'error', message: `${spec.id} returned no content` }
    return
  }

  yield { type: 'delta', text }
  let structured: unknown = null
  try { structured = JSON.parse(text) } catch { /* coerceTurn will try harder */ }
  yield { type: 'final', structured, text }
}

export const deepseekAdapter = makeCompatAdapter({
  id: 'deepseek',
  label: 'DeepSeek',
  baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  note: 'HTTP API, your own key. Set DEEPSEEK_API_KEY.',
  responseFormat: 'json_object',
  staticModels: [
    { id: 'deepseek-chat', label: 'DeepSeek Chat' },
    { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
  ],
})

export const lmStudioAdapter = makeCompatAdapter({
  id: 'lmstudio',
  label: 'LM Studio (local)',
  baseUrl: process.env.LMSTUDIO_BASE_URL ?? 'http://127.0.0.1:1234/v1',
  note: 'Fully local. No account, no network, nothing to deprecate.',
  responseFormat: 'json_schema',
  probe: true,
})

export const ollamaAdapter = makeCompatAdapter({
  id: 'ollama',
  label: 'Ollama (local)',
  baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1',
  note: 'Fully local. No account, no network, nothing to deprecate.',
  responseFormat: 'json_schema',
  probe: true,
})
