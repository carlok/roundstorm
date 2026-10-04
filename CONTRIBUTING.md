# Contributing

Small project, small rules. Most of them exist because breaking them fails
silently.

## Running things

```bash
npm install
npm run typecheck
npm test            # unit and integration; no brain, no network, no spend
npm run test:ui     # builds the bundle and drives headless Chrome over it
```

Node **22.13 or newer**. `node:sqlite` is the only storage and it needs that
version; 22.12 throws `No such built-in module`.

`npm test` skips four ledger tests unless an embedding server is running at
`127.0.0.1:1234` (LM Studio with a nomic-embed model). They cover position
de-duplication, so run them once if you touch `server/src/deliberation/ledger.ts`.

## The three rules a change can break without noticing

**1. The `CREATE TABLE` block in `server/src/db.ts` is frozen.** It is the v0
baseline. `IF NOT EXISTS` adds a new table to an old database and never a new
column, so a column added there makes the daemon die at import on anyone's
existing data, before it listens. Every schema change is a migration in
`server/src/sqlite/migrate.ts`, with a test against an old-schema fixture
(`migrate.test.ts`, `legacy-db.test.ts`).

**2. Tier values go through `isTier`.** A tier decides what an agent may do to the
machine. Never index a `Record` with an unchecked string: `'__proto__'` returns
`Object.prototype`, which is truthy, so `?? fallback` does not fire. See
`server/src/types.ts` and `adapters/tiers.test.ts`. Unknown means *most
restrictive*, never a permissive default.

**3. A bare `return` in a test is a pass, not a skip.** Use `t.skip(...)`. Four
tests once reported green with no coverage for exactly this reason.

## Testing without spending money

`server/src/adapters/stub.ts` is a brain that answers instantly and records what
it was shown. `registerAdapter()` swaps it in. That is how
`deliberation/scheduler.test.ts` asserts round isolation, steering and deadlines:
what an agent was *given* is a fact; what it said is not.

## Before you open a PR

- `npm run typecheck && npm test` is green.
- If you touched anything under `web/src`, run `npm run test:ui`.
- If you touched `src-tauri/` or the daemon's origin handling, build the app
  (`npm run app:build`) and launch it. `tauri dev` loads from `localhost:5273` and
  cannot reproduce the packaged `tauri://localhost` origin, so a blank window only
  shows up in a release build.
- Security-relevant? Read [SECURITY.md](SECURITY.md) first, and report real
  vulnerabilities privately rather than in a PR.
