/**
 * Codex CLI adapter.
 *
 * Two measured quirks drive this file (plan §4.2):
 *
 *  - stdin must be closed or `codex exec` blocks on "Reading additional input
 *    from stdin" and never returns. streamProcess always passes stdio 'ignore'.
 *  - `--ignore-user-config` does NOT stop the operator's skills from loading.
 *    Only a clean CODEX_HOME does, and that costs 21.3k → 13.8k input tokens
 *    per turn. But CODEX_HOME also carries auth, so the isolated home symlinks
 *    auth.json back to the real one; a token refresh then propagates instead of
 *    going stale the way a copy would.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AdapterEvent, BrainAdapter, TurnRequest } from './types.ts'
import { streamProcess, which } from './spawn.ts'
import { DATA_PATH } from '../db.ts'
import type { Tier } from '../types.ts'

const SANDBOX: Record<Tier, string> = {
  reasoning: 'read-only',
  research: 'read-only',
  workstation: 'read-only',
  full: 'workspace-write',
}

/** A CODEX_HOME with no skills, no rules, no config — but the real credentials. */
function isolatedHome(): string {
  const home = join(DATA_PATH, 'brains', 'codex-home')
  mkdirSync(home, { recursive: true })
  const link = join(home, 'auth.json')
  const real = join(homedir(), '.codex', 'auth.json')
  try {
    if (existsSync(link)) rmSync(link)
    if (existsSync(real)) symlinkSync(real, link)
  } catch { /* fall back to whatever is already there */ }
  return home
}

export const codexAdapter: BrainAdapter = {
  id: 'codex',
  label: 'Codex',
  kind: 'cli',
  schemaEnforced: true,
  supportsSystemPrompt: false,
  strictSchema: true,
  note: 'Local CLI, your own subscription.',

  available: () => which('codex'),

  async listModels() {
    // Codex has no model-list command, and guessing ids is actively harmful:
    // a wrong id 400s at request time with "not supported when using Codex with
    // a ChatGPT account", which surfaces as a dead agent mid-round. So offer the
    // account default (empty id => omit --model) plus whatever the user's own
    // config already proves is valid for their account.
    const models = [{ id: '', label: 'Account default' }]
    const configured = readConfiguredModel()
    if (configured) models.push({ id: configured, label: configured })
    return models
  },

  run(req, signal) {
    return runCodex(req, signal)
  },
}

function runCodex(req: TurnRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
  // Codex has no --system-prompt, so the persona rides at the top of the prompt.
  const prompt = `${req.systemPrompt}\n\n---\n\n${req.userPrompt}`
  const schemaPath = writeSchema(req.schema)

  const args = [
    'exec', prompt,
    '--json',
    '--sandbox', SANDBOX[req.tier],
    '--skip-git-repo-check',
    '--ephemeral',
    '--output-schema', schemaPath,
  ]
  if (req.model) args.push('--model', req.model)
  if (req.workingDir) args.push('--cd', req.workingDir)

  let finalText = ''
  let failure: string | null = null

  return streamProcess('codex', args, signal, {
    cwd: req.workingDir ?? undefined,
    env: { CODEX_HOME: isolatedHome() },
    onLine: (raw, push) => {
      const ev = raw as any
      if (ev.type === 'turn.started') push({ type: 'activity', text: 'Thinking' })
      else if (ev.type === 'turn.failed') failure = describe(ev.error)
      else if (ev.type === 'error' && ev.message) failure ??= describe(ev.message)
      else if (ev.type === 'item.completed' && ev.item) {
        const item = ev.item
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          finalText = item.text
          push({ type: 'delta', text: item.text })
        } else if (item.type === 'command_execution') {
          push({ type: 'tool', name: 'Bash', detail: 'Running a command' })
        } else if (item.type === 'file_change') {
          push({ type: 'tool', name: 'Edit', detail: 'Editing a file' })
        } else if (item.type === 'web_search') {
          push({ type: 'tool', name: 'WebSearch', detail: 'Searching the web' })
        } else if (item.type === 'reasoning') {
          push({ type: 'activity', text: 'Thinking' })
        }
      }
    },
    onClose: (code, stderr, push) => {
      if (!finalText) {
        // "Reading additional input from stdin" is codex's normal stderr chatter;
        // reporting it as the error hides the real cause.
        const noise = /Reading additional input from stdin/
        const tail = stderr.split('\n').filter(l => l.trim() && !noise.test(l)).join(' ').trim()
        push({ type: 'error', message: failure ?? tail.slice(0, 400) ?? `codex exited ${code}` })
      } else {
        // The schema-constrained answer arrives as the agent_message text.
        let structured: unknown = null
        try { structured = JSON.parse(finalText) } catch { /* let coerceTurn extract it */ }
        push({ type: 'final', structured, text: finalText })
      }
    },
  })
}

/** Unwrap codex's nested {"error":{"message":"{json}"}} envelopes into one line. */
function describe(err: unknown): string {
  const raw = typeof err === 'string' ? err
    : (err as any)?.message ?? JSON.stringify(err)
  try {
    const inner = JSON.parse(raw)
    return inner?.error?.message ?? inner?.message ?? raw
  } catch {
    return String(raw)
  }
}

function readConfiguredModel(): string | null {
  try {
    const text = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8')
    const m = text.match(/^\s*model\s*=\s*"([^"]+)"/m)
    return m ? m[1] : null
  } catch {
    return null
  }
}

function writeSchema(schema: unknown): string {
  const dir = join(DATA_PATH, 'brains')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'turn-schema.json')
  // Stable path, rewritten each turn — no temp-file litter to clean up.
  writeFileSync(path, JSON.stringify(schema))
  return path
}
