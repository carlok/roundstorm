/**
 * Bundle the daemon into one file.
 *
 * There is nothing to keep external any more: storage is Node's built-in
 * SQLite, so the whole daemon is pure JavaScript and the output is a single
 * .mjs with no node_modules beside it.
 */
import { build } from 'esbuild'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist-server')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

await build({
  // Two entry points: the daemon, and the headless runner that drives the same
  // scheduler from a config file without any server at all.
  entryPoints: [
    join(root, 'server/src/index.ts'),
    join(root, 'server/src/headless/cli.ts'),
  ],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outdir: out,
  outExtension: { '.js': '.mjs' },
  entryNames: '[name]',
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

// A package.json next to the bundle, so Node's search for the nearest one stops here.
//
// Loading an ES module makes Node walk up the directory tree reading every
// package.json it finds. Inside the packaged app that walk leaves the bundle and,
// when the app was built or is run from the project tree, enters ~/Documents — which
// macOS protects with a permission prompt. Nobody sees the prompt, `open()` blocks
// at 0% CPU, and the daemon does not come up for minutes. Measured: the identical
// bundle starts in 4s from /tmp and took over 4 minutes from inside ~/Documents.
// A normal install in /Applications never walks into a protected folder, but this
// also stops a stray package.json elsewhere on the machine from changing how the
// daemon is loaded, so it is correct regardless of where the app lives.
writeFileSync(join(out, 'package.json'),
  JSON.stringify({ name: 'roundstorm-daemon', private: true, type: 'module' }, null, 2) + '\n')

console.log('bundled to dist-server/{index,cli}.mjs (no native dependencies)')
