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
import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { ConfigError, parseExperiments } from './config.ts'
import { adapterIds } from '../adapters/registry.ts'
import { terminateAll } from '../adapters/spawn.ts'
import { abortAllDeliberations } from '../deliberation/scheduler.ts'
import { ALL_PERSONAS } from '../deliberation/personas.ts'
import { renderOutcome, runBatch, runExperiment, writeOutput } from './run.ts'

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
  if (!opts) {
    process.stdout.write(USAGE)
    // Asking for help is not a usage error. `--help` used to exit 1 because it
    // had an argument, so `roundstorm --help && …` stopped and CI treated it as
    // a failure. A genuinely bad invocation still exits 1.
    const asked = process.argv.slice(2).some(a => a === '--help' || a === '-h')
    return asked || process.argv.length <= 2 ? 0 : 1
  }

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
    configs = parseExperiments(text, extname(path).toLowerCase() === '.jsonl', {
      brains: adapterIds(), personas: ALL_PERSONAS.map(p => p.key),
    })
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

  // Ctrl-C used to leave the deliberation `running` in the store and the brain
  // processes alive, still billing. The same two calls the daemon uses on shutdown.
  let interrupted = false
  process.once('SIGINT', () => {
    interrupted = true
    const stopped = abortAllDeliberations()
    const killed = terminateAll()
    process.stderr.write(`\ninterrupted: stopped ${stopped} deliberation(s), ended ${killed} brain process(es)\n`)
  })

  const { outcomes, worst } = await runBatch(configs, runExperiment, say)

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
    // A failed write must not turn a finished run into exit 3: the result is
    // already on stdout, and the run's own code is the one a script branches on.
    const problem = writeOutput(opts.out, rendered + '\n')
    if (problem) process.stderr.write(`${problem}\n`)
    else say(`written to ${opts.out}`)
  }
  return interrupted ? 130 : worst
}

main().then(
  code => { process.exitCode = code },
  err => { process.stderr.write(`${err?.stack ?? err}\n`); process.exitCode = 3 },
)
