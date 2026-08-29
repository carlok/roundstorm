/**
 * Headless entry point: run experiments from a config file.
 *
 *   node dist-server/cli.mjs experiment.jsonc
 *   node dist-server/cli.mjs batch.jsonl --json --out results.json
 *
 * No interface, no HTTP server, no platform-specific anything — this is the same
 * code the app runs, driven from a file. It replaces scripts/ask.sh, which
 * needed bash, curl and jq and therefore did not run on Windows at all.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { ConfigError, parseExperiments } from './config.ts'
import { exitCodeFor, levelLabel, renderOutcome, runExperiment, type RunOutcome } from './run.ts'

const USAGE = `roundstorm — run a deliberation from a config file

  node dist-server/cli.mjs <file.jsonc|file.jsonl> [options]

  --json          print the result as JSON instead of Markdown
  --out <file>    write the output to a file as well as stdout
  --quiet         suppress progress lines on stderr
  --dry-run       validate the file and print the plan without running anything

Exit codes: 0 concluded · 2 no reliable conclusion (or a conclave that failed)
            3 the run itself broke · 1 bad usage or invalid config
`

interface Options { file: string; json: boolean; out?: string; quiet: boolean; dryRun: boolean }

function parseArgs(argv: string[]): Options | null {
  const args = argv.slice(2)
  if (!args.length || args.includes('--help') || args.includes('-h')) return null
  const opts: Options = { file: '', json: false, quiet: false, dryRun: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--json') opts.json = true
    else if (a === '--quiet') opts.quiet = true
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--out') opts.out = args[++i]
    else if (a.startsWith('-')) { process.stderr.write(`unknown option ${a}\n`); return null }
    else opts.file = a
  }
  return opts.file ? opts : null
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv)
  if (!opts) { process.stdout.write(USAGE); return process.argv.length > 2 ? 1 : 0 }

  const path = resolve(opts.file)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    process.stderr.write(`cannot read ${path}\n`)
    return 1
  }

  let configs
  try {
    configs = parseExperiments(text, extname(path).toLowerCase() === '.jsonl')
  } catch (err) {
    // Config problems are the user's to fix, so say which field and stop before
    // anything is created or billed.
    process.stderr.write(err instanceof ConfigError ? `${opts.file}: ${err.message}\n` : String(err) + '\n')
    return 1
  }

  const say = (line: string) => { if (!opts.quiet) process.stderr.write(`  ${line}\n`) }

  if (opts.dryRun) {
    for (const c of configs) {
      process.stdout.write(
        `${c.room.name}: ${c.mode}, ${c.rounds} rounds, ${c.style}`
        + `${c.sealedOpening ? ', sealed opening' : ''}, tier ${c.room.tier}\n`
        + c.agents.map(a => `  ${a.name} — ${a.persona} on ${a.brain}${a.model ? ` (${a.model})` : ''}\n`).join(''))
    }
    return 0
  }

  const outcomes: RunOutcome[] = []
  let worst = 0
  for (const [i, cfg] of configs.entries()) {
    if (configs.length > 1) say(`experiment ${i + 1} of ${configs.length}: ${cfg.room.name}`)
    const outcome = await runExperiment(cfg, say)
    outcomes.push(outcome)
    say(`${levelLabel(outcome.card)} — ${outcome.messages} turns, ${Math.round(outcome.ms / 1000)}s`)
    worst = Math.max(worst, exitCodeFor(outcome))
  }

  const rendered = opts.json
    ? JSON.stringify(outcomes.map(o => ({
        room: o.room.name,
        level: o.card?.level ?? null,
        conclusion: o.card?.conclusion ?? null,
        why: o.card?.why ?? null,
        commonGround: o.card?.commonGround ?? [],
        disagreement: o.card?.disagreement ?? [],
        nextSteps: o.card?.nextSteps ?? [],
        turns: o.messages,
        failedTurns: o.failedTurns,
        costUsd: o.costUsd,
        ms: o.ms,
      })), null, 2)
    : outcomes.map(renderOutcome).join('\n\n---\n\n')

  process.stdout.write(rendered + '\n')
  if (opts.out) {
    writeFileSync(opts.out, rendered + '\n')
    say(`written to ${opts.out}`)
  }
  return worst
}

main().then(
  code => { process.exitCode = code },
  err => { process.stderr.write(`${err?.stack ?? err}\n`); process.exitCode = 3 },
)
