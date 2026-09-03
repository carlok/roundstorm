/**
 * The embedder is optional, and the important thing is that its absence is
 * *visible*. A missing embedder used to look identical to "nothing matched",
 * which silently turned position de-duplication off and made a room in complete
 * agreement report as having reached no reliable conclusion.
 *
 * Note the test glob in package.json did not cover `server/src/search/` at all
 * until this file existed — a test written here would never have run.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ROUNDSTORM_DATA = mkdtempSync(join(tmpdir(), 'rs-embed-'))
// Somewhere nothing is listening, so the unreachable path is the one under test.
process.env.ROUNDSTORM_EMBED_URL = 'http://127.0.0.1:9'

const { nearest, semanticSearch, indexPending } = await import('./embeddings.ts')

test('an unreachable embedder is reported as unavailable, not as no match', async () => {
  const r = await nearest('a bearing clearance problem',
    [{ id: 'p1', text: 'a bearing clearance problem' }], 0.7)
  assert.equal(r.hit, null)
  assert.equal(r.available, false,
    'the caller cannot tell "the embedder is down" from "nothing was similar"')
})

test('no candidates is a real answer, not an outage', async () => {
  const r = await nearest('anything', [], 0.7)
  assert.deepEqual(r, { hit: null, available: true })
})

test('search reports unavailable rather than quietly returning nothing', async () => {
  assert.equal(await semanticSearch('anything', 5), null)
})

test('indexing says it was skipped instead of claiming success', async () => {
  const r = await indexPending()
  assert.equal(r.skipped, true)
  assert.equal(r.indexed, 0)
})
