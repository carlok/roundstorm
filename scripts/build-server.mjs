/**
 * Bundle the daemon into one file.
 *
 * There is nothing to keep external any more: storage is Node's built-in
 * SQLite, so the whole daemon is pure JavaScript and the output is a single
 * .mjs with no node_modules beside it.
 */
import { build } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist-server')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

await build({
  entryPoints: [join(root, 'server/src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: join(out, 'index.mjs'),
  // Express and its dependencies are CommonJS and call require() at runtime.
  // ESM output has no require, so one has to be provided or the bundle dies on
  // the first import with 'Dynamic require of "path" is not supported'.
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      "const require = __cr(import.meta.url);",
    ].join('\n'),
  },
  logLevel: 'warning',
})

console.log('daemon bundled to dist-server/index.mjs (no native dependencies)')
