/**
 * Test fixture, preloaded with `node --import` into a spawned CLI (see
 * cli.test.ts). It shadows the `claude` brain with a stub that answers at once
 * with a recognisable body, so a full run completes without a real CLI.
 */
import { registerAdapter } from '../adapters/registry.ts'
import { makeStubBrain } from '../adapters/stub.ts'

registerAdapter(makeStubBrain({ id: 'claude', reply: (_c, i) => `FIXTURE-TURN-${i + 1}` }).adapter)
