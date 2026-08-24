/**
 * Bundle the daemon into one JS file for packaging.
 *
 * better-sqlite3 is a native addon and cannot be bundled, so it stays external
 * and its prebuilt binary is copied alongside. That single native dependency is
 * the only thing standing between this and a self-contained binary; Node's
 * built-in `node:sqlite` would remove it, but it is still flagged experimental
 * and swapping a working storage layer onto an unstable API is not a trade
 * worth making for packaging convenience.
 */
import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
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
  external: ['better-sqlite3'],
  // Bare ESM cannot use require(); better-sqlite3 is CJS, so give the bundle a
  // require it can reach.
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      "const require = __cr(import.meta.url);",
    ].join('\n'),
  },
  logLevel: 'warning',
})

// Ship the native dependency next to the bundle.
mkdirSync(join(out, 'node_modules'), { recursive: true })
for (const dep of ['better-sqlite3', 'bindings', 'file-uri-to-path', 'prebuild-install']) {
  try {
    cpSync(join(root, 'node_modules', dep), join(out, 'node_modules', dep), { recursive: true })
  } catch { /* optional transitive deps */ }
}

console.log('daemon bundled to dist-server/index.mjs')
