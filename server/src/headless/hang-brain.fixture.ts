/**
 * Test fixture, preloaded with `node --import` into a spawned CLI (see
 * cli.test.ts). It shadows the `claude` brain with one that starts a real child
 * process and then never answers, so the CLI is mid-deliberation, holding a
 * brain process, when the test sends it Ctrl-C.
 *
 * Preloading shares the module instance the CLI imports, so no hook is needed
 * in production code.
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { registerAdapter } from '../adapters/registry.ts'
import { makeStubBrain } from '../adapters/stub.ts'
import { trackChild } from '../adapters/spawn.ts'

const pidFile = process.env.FIXTURE_PIDFILE
const hang = makeStubBrain({ id: 'claude', hang: true })

registerAdapter({
  ...hang.adapter,
  run(req, signal) {
    if (pidFile) {
      const child = trackChild(spawn('sleep', ['120'], { stdio: 'ignore' }))
      writeFileSync(pidFile, String(child.pid))
    }
    return hang.adapter.run(req, signal)
  },
})
