/**
 * Cursor Agent adapter.
 *
 * The only installed brain with no schema flag, so this is the adapter that
 * keeps the prompt-and-parse path in §3 honest — it is exercised on every real
 * run rather than sitting as untested dead code.
 *
 * It is also the second multiplexer, and the one that widens the *model
 * families* on offer: Grok and Composer are reachable through nothing else here.
 * Some of its models are flagged NO ZDR (no zero-data-retention); the registry
 * carries that through to the brain picker (plan §19.7).
 */
import type { AdapterEvent, BrainAdapter, TurnRequest } from './types.ts'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { capture, clean, streamProcess, which } from './spawn.ts'
import { DATA_PATH } from '../db.ts'

export const cursorAdapter: BrainAdapter = {
  id: 'cursor',
  label: 'Cursor Agent',
  kind: 'cli',
  schemaEnforced: false,
  supportsSystemPrompt: false,
  note: 'Closed source, vendor account. Some models are marked NO ZDR.',

  available: () => which('cursor-agent'),

  async listModels() {
    const out = clean(await capture('cursor-agent', ['--list-models'], 30_000))
    const models = out.split('\n')
      .map(l => l.trim())
      .filter(l => / - /.test(l) && !l.startsWith('Available'))
      .map(l => {
        const i = l.indexOf(' - ')
        return { id: l.slice(0, i).trim(), label: l.slice(i + 3).trim() }
      })
      .filter(m => m.id && !m.id.includes(' '))
    return models.length ? models : [{ id: 'auto', label: 'Auto' }]
  },

  run(req, signal) {
    return runCursor(req, signal)
  },
}

function scratchWorkspace(): string {
  const dir = join(DATA_PATH, 'brains', 'cursor-workspace')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Tier to mode flags. Exported because this is the safety-critical part.
 *
 * Named permissive branch, defaulted restrictive. The other way round meant an
 * unrecognised tier matched neither test, got no `--mode` flag at all, and ran in
 * cursor-agent's default agent mode: write and bash.
 */
export function cursorTierArgs(tier: string): string[] {
  if (tier === 'full') return []            // agent mode, deliberately unflagged
  if (tier === 'workstation') return ['--mode', 'plan']
  return ['--mode', 'ask']
}

function runCursor(req: TurnRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
  // No --system-prompt, and no schema: the persona AND the output contract both
  // ride in the user prompt. composeContext already appends PROMPT_CONTRACT for
  // adapters that report schemaEnforced: false.
  const prompt = `${req.systemPrompt}\n\n---\n\n${req.userPrompt}`

  // cursor-agent refuses to start in an untrusted directory, printing a trust
  // prompt that a headless run can never answer. A dedicated empty workspace it
  // owns avoids the prompt and keeps reasoning-tier agents away from real files.
  const workspace = req.workingDir ?? scratchWorkspace()

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--workspace', workspace,
    // Answers the trust prompt. Safe here only because the tier flags below keep
    // it read-only; never pass this for the full tier without a real workspace.
    '--force',
    '--sandbox', 'enabled',
  ]
  // Always pin the model explicitly. Omitting --model does not mean "auto", it
  // means "whatever is in the user's cursor config" — which on a free plan is a
  // named model the account cannot use, and the turn dies with
  // "Named models unavailable". Never inherit a CLI's configured default.
  args.push('--model', req.model || 'auto')
  // Its read-only guarantee is a mode, not a kernel sandbox — advisory, and the
  // UI labels it as such. --print alone would grant write and bash.
  args.push(...cursorTierArgs(req.tier))

  let text = ''

  return streamProcess('cursor-agent', args, signal, {
    cwd: workspace,
    onLine: (raw, push) => {
      const ev = raw as any
      if (ev.type === 'thinking' && ev.subtype === 'delta') {
        push({ type: 'activity', text: 'Thinking' })
      } else if (ev.type === 'assistant' && ev.message?.content) {
        for (const b of ev.message.content) {
          if (b.type === 'text' && b.text) {
            text = b.text
            push({ type: 'delta', text: b.text })
          } else if (b.type === 'tool_use') {
            push({ type: 'tool', name: b.name ?? 'tool', detail: `Using ${b.name ?? 'a tool'}` })
          }
        }
      } else if (ev.type === 'result') {
        if (typeof ev.result === 'string' && ev.result) text = ev.result
        if (ev.is_error) push({ type: 'error', message: String(ev.result ?? 'cursor-agent error') })
      }
    },
    onClose: (code, stderr, push) => {
      if (!text) {
        push({ type: 'error', message: stderr.trim().slice(0, 400) || `cursor-agent exited ${code}` })
      } else {
        // No structured output: the scheduler extracts JSON from the prose and
        // degrades cleanly if there is none.
        push({ type: 'final', structured: null, text })
      }
    },
  })
}
