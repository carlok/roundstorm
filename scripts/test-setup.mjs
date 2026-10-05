/**
 * Loaded into every test process (`--import`), before any test file.
 *
 * Importing almost anything under server/src pulls in db.ts, which opens a SQLite
 * file the moment it is imported. A test that did not set ROUNDSTORM_DATA first
 * therefore opened the *default* data directory — on a developer's machine that is
 * their real database, and on CI it is one file shared by every parallel test
 * process, which races to create and migrate it ("database is locked").
 *
 * So every process gets its own empty directory unless a test chooses another.
 * Tests that set ROUNDSTORM_DATA themselves simply overwrite this.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ROUNDSTORM_DATA ??= mkdtempSync(join(tmpdir(), 'rs-test-'))
