/**
 * Claude Code adapter.
 *
 * The flag set here is not arbitrary — it was measured (see plan §4.2):
 *
 *   --setting-sources ''   no user hooks, no global CLAUDE.md, no skills
 *   --strict-mcp-config    no MCP servers
 *   --system-prompt        replaces Claude Code's default prompt with the persona
 *   --disallowed-tools     an explicit list, NOT '*'
 *
 * That last one matters twice over. `--json-schema` is implemented as a
 * StructuredOutput tool the model must call, so `--disallowed-tools '*'` denies
 * the very mechanism the contract depends on and the run burns four turns
 * failing. And trimming the advertised toolset takes a turn from ~18.7k input
 * tokens to ~2.3k, which at five agents times five rounds is the whole cost
 * profile of the product.
 */
import { spawn } from 'node:child_process'
import type { AdapterEvent, BrainAdapter, TurnRequest } from './types.ts'
import type { Tier } from '../types.ts'
import { resolveBin, spawnEnv } from './resolve.ts'
import { checkCommandLine, needsShell } from './platform.ts'
import { terminate } from './spawn.ts'

const ALL_TOOLS = [
  'Task', 'Artifact', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'DesignSync',
  'Edit', 'EnterWorktree', 'ExitWorktree', 'Glob', 'Grep', 'ListAgents', 'Monitor',
  'NotebookEdit', 'PushNotification', 'Read', 'RemoteTrigger', 'ReportFindings',
  'ScheduleWakeup', 'SendMessage', 'Skill', 'TaskCreate', 'TaskGet', 'TaskList',
  'TaskOutput', 'TaskStop', 'TaskUpdate', 'ToolSearch', 'WebFetch', 'WebSearch', 'Write',
]

/** Tools each tier keeps. StructuredOutput is never denied — it carries the contract. */
const TIER_TOOLS: Record<Tier, string[]> = {
  reasoning: [],
  research: ['WebSearch', 'WebFetch'],
  workstation: ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep'],
  full: ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'NotebookEdit'],
}

const HUMAN_TOOL_LABEL: Record<string, string> = {
  WebSearch: 'Searching the web',
  WebFetch: 'Reading a page',
  Read: 'Reading a file',
  Glob: 'Looking for files',
  Grep: 'Searching files',
  Bash: 'Running a command',
  Write: 'Writing a file',
  Edit: 'Editing a file',
  StructuredOutput: 'Composing its turn',
}

export const claudeAdapter: BrainAdapter = {
  id: 'claude',
  label: 'Claude Code',
  kind: 'cli',
  schemaEnforced: true,
  supportsSystemPrompt: true,
  note: 'Local CLI, your own subscription.',

  async available() {
    return await which('claude')
  },

  async listModels() {
    return [
      { id: 'claude-opus-5', label: 'Claude Opus 5' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'claude-fable-5', label: 'Claude Fable 5' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    ]
  },

  run(req, signal) {
    return runClaude(req, signal)
  },
}

async function* runClaude(req: TurnRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
  const keep = new Set(TIER_TOOLS[req.tier])
  const deny = ALL_TOOLS.filter(t => !keep.has(t))

  const args = [
    '-p', req.userPrompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--system-prompt', req.systemPrompt,
    '--json-schema', JSON.stringify(req.schema),
  ]
  if (deny.length) args.push('--disallowed-tools', ...deny)
  if (req.model) args.push('--model', req.model)
  if (req.tier !== 'reasoning' && req.workingDir) args.push('--add-dir', req.workingDir)

  const bin = resolveBin('claude')
  if (!bin) {
    yield {
      type: 'error',
      message: 'The claude CLI is not installed, or Roundstorm cannot find it.',
    }
    return
  }

  // claude is an npm package, so on Windows it resolves to claude.cmd and can
  // only be launched through a shell — which also lowers the command-line
  // ceiling to 8 KB, and the prompt is passed as an argument.
  const viaShell = needsShell(bin, process.platform)
  const length = checkCommandLine(bin, args, process.platform, viaShell)
  if (!length.ok) {
    yield { type: 'error', message: length.message! }
    return
  }

  const child = spawn(bin, args, {
    cwd: req.workingDir ?? undefined,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: spawnEnv({ CLAUDE_CODE_ENTRYPOINT: 'roundstorm' }),
    shell: viaShell,
    windowsHide: true,
  })

  const onAbort = () => terminate(child)
  signal.addEventListener('abort', onAbort, { once: true })

  const queue: AdapterEvent[] = []
  let resolveNext: (() => void) | null = null
  let done = false
  let stderr = ''

  const push = (e: AdapterEvent) => {
    queue.push(e)
    resolveNext?.()
    resolveNext = null
  }

  let structured: unknown = null
  let text = ''
  let costUsd: number | undefined
  let buf = ''

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let ev: any
      try { ev = JSON.parse(line) } catch { continue }

      if (ev.type === 'system' && ev.subtype === 'thinking_tokens') {
        push({ type: 'activity', text: 'Thinking' })
      } else if (ev.type === 'assistant' && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === 'text' && block.text) {
            text = block.text
            push({ type: 'delta', text: block.text })
          } else if (block.type === 'tool_use') {
            if (block.name === 'StructuredOutput') {
              structured = block.input
            }
            push({
              type: 'tool',
              name: block.name,
              detail: HUMAN_TOOL_LABEL[block.name] ?? `Using ${block.name}`,
            })
          }
        }
      } else if (ev.type === 'system' && ev.subtype === 'permission_denied') {
        push({ type: 'activity', text: `Blocked: ${ev.tool_name}` })
      } else if (typeof ev.total_cost_usd === 'number') {
        costUsd = ev.total_cost_usd
        if (ev.is_error) push({ type: 'error', message: ev.result ?? 'claude reported an error' })
      }
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', d => { stderr += d })

  child.on('error', err => {
    push({ type: 'error', message: `spawn failed: ${err.message}` })
    done = true
    resolveNext?.()
  })

  child.on('close', code => {
    if (code !== 0 && code !== null && !structured && !text) {
      push({ type: 'error', message: stderr.trim().slice(0, 500) || `claude exited ${code}` })
    } else {
      push({ type: 'final', structured, text, costUsd })
    }
    done = true
    resolveNext?.()
  })

  try {
    while (true) {
      while (queue.length) yield queue.shift()!
      if (done) break
      await new Promise<void>(r => { resolveNext = r })
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    terminate(child)
  }
}

export const which = async (bin: string): Promise<boolean> => resolveBin(bin) !== null
