/**
 * Antigravity CLI adapter.
 *
 * `agy` is a multiplexer, not a brain: `agy models` lists Gemini 3.x, Claude
 * Sonnet/Opus and GPT-OSS behind one binary. The registry enumerates it so each
 * model registers as its own brain (plan §4.2) — Gemini-via-agy and
 * Claude-via-agy are different brains from Claude-via-claude, because the
 * harness around the model differs even when the weights do not.
 *
 * Quirk: agy appends its own `toolAction`/`toolSummary` keys to schema-shaped
 * output, so the turn schema must not carry `additionalProperties: false`.
 */
import type { AdapterEvent, BrainAdapter, TurnRequest } from './types.ts'
import { capture, clean, streamProcess, which } from './spawn.ts'
import type { Tier } from '../types.ts'

export const agyAdapter: BrainAdapter = {
  id: 'agy',
  label: 'Antigravity',
  kind: 'cli',
  schemaEnforced: true,
  supportsSystemPrompt: false,
  relaxedSchema: true,
  note: 'Closed source, vendor account required.',

  available: () => which('agy'),

  async listModels() {
    const out = clean(await capture('agy', ['models']))
    const models = out.split('\n')
      .map(l => l.trim())
      .filter(l => l.includes('\t'))
      .map(l => {
        const [id, label] = l.split('\t')
        return { id: id.trim(), label: (label ?? id).trim() }
      })
      .filter(m => m.id && !m.id.includes(' '))
    return models.length ? models : [{ id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' }]
  },

  run(req, signal) {
    return runAgy(req, signal)
  },
}

function runAgy(req: TurnRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
  const prompt = `${req.systemPrompt}\n\n---\n\n${req.userPrompt}`

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--json-schema', JSON.stringify(req.schema),
    '--disable-slash-commands',
  ]
  if (req.model) args.push('--model', req.model)
  if (req.tier === 'reasoning' || req.tier === 'research') args.push('--sandbox')
  else if (req.tier === 'workstation') args.push('--mode', 'plan')
  else args.push('--mode', 'accept-edits')
  if (req.tier !== 'reasoning' && req.workingDir) args.push('--add-dir', req.workingDir)

  let response = ''
  let failed: string | null = null

  return streamProcess('agy', args, signal, {
    cwd: req.workingDir ?? undefined,
    onLine: (raw, push) => {
      const ev = raw as any
      if (ev.event === 'step_update' && ev.step_update) {
        const st = ev.step_update
        if (st.step_type === 'agent_response') {
          if (typeof st.text_delta === 'string') response = st.text_delta
          push({ type: 'activity', text: 'Writing' })
        } else if (st.step_type === 'tool_use' || st.step_type === 'tool_call') {
          push({ type: 'tool', name: st.tool_name ?? 'tool', detail: st.tool_summary ?? 'Working' })
        } else if (st.step_type === 'checkpoint' || st.step_type === 'thinking') {
          push({ type: 'activity', text: 'Thinking' })
        }
      } else if (ev.event === 'result' && ev.result) {
        if (ev.result.status === 'SUCCESS' && typeof ev.result.response === 'string') {
          response = ev.result.response
        } else if (ev.result.status && ev.result.status !== 'SUCCESS') {
          failed = String(ev.result.error ?? ev.result.status)
        }
      }
    },
    onClose: (code, stderr, push) => {
      if (!response) {
        push({ type: 'error', message: failed ?? stderr.trim().slice(0, 400) ?? `agy exited ${code}` })
        return
      }
      let structured: unknown = null
      try { structured = JSON.parse(response) } catch { /* coerceTurn will try harder */ }
      push({ type: 'final', structured, text: response })
    },
  })
}

/** agy has no per-tool deny list; the coarse dials are all it exposes. */
export const AGY_TIER_NOTE: Record<Tier, string> = {
  reasoning: 'sandboxed',
  research: 'sandboxed',
  workstation: 'plan mode (read-only)',
  full: 'accept-edits',
}
