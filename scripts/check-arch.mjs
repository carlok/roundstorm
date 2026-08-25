/**
 * Guard against shipping a mixed-architecture bundle.
 *
 * The app is arm64-only. Two things have to agree about that: every Mach-O in
 * the bundle, and the declared minimum macOS version. Declaring 10.15 while
 * shipping arm64-only code is a contradiction — Catalina predates Apple Silicon
 * — and macOS reports the app as having a non-Apple-Silicon component.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const app = process.argv[2]
  ?? 'src-tauri/target/release/bundle/macos/Roundstorm.app'

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = join(dir, e.name)
  return e.isDirectory() ? walk(p) : [p]
})

const problems = []

for (const file of walk(app)) {
  let kind = ''
  try {
    if (statSync(file).size < 4) continue
    kind = execFileSync('file', ['-b', file], { encoding: 'utf8' })
  } catch { continue }
  if (!kind.includes('Mach-O')) continue
  if (/x86_64|i386/.test(kind)) problems.push(`${file}: ${kind.trim()}`)
}

const plist = join(app, 'Contents/Info.plist')
const min = execFileSync('plutil', ['-extract', 'LSMinimumSystemVersion', 'raw', plist], { encoding: 'utf8' }).trim()
if (Number.parseFloat(min) < 11) {
  problems.push(`Info.plist declares LSMinimumSystemVersion ${min}; arm64 requires 11.0 or later`)
}

if (problems.length) {
  console.error('Architecture check failed:')
  for (const p of problems) console.error('  ' + p)
  process.exit(1)
}
console.log(`Architecture check passed: arm64-only, minimum macOS ${min}`)
