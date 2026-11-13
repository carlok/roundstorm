# Roundstorm — notes for coding agents

Human-oriented setup and contribution rules live in [README.md](README.md) and
[CONTRIBUTING.md](CONTRIBUTING.md). This file is for autonomous agents editing the
repository.

If you have **context-mode** MCP tools in your environment, follow
[CLAUDE.md](CLAUDE.md) for command and tool routing. Nothing here overrides those
rules.

## Setup

- **Node ≥ 22.16** (`engines` in `package.json`). `node:sqlite` with `backup()` is
  required; older 22.x releases break the daemon.
- From the repo root:

```bash
npm install   # or npm ci in CI-like environments
npm run typecheck
```

## Tests and coverage (same commands as CI)

| Command | Purpose |
|--------|---------|
| `npm run typecheck` | TypeScript, no emit |
| `npm test` | Unit/integration tests — no brain, no network, no spend (see CONTRIBUTING) |
| `npm run coverage` | Same suite as `npm test` with Node's experimental coverage report |
| `npm run test:ui` | Builds the web bundle and runs the headless Chrome UI sweep (macOS-oriented) |

CI (`.github/workflows/ci.yml`) runs `typecheck` and `npm test` on Ubuntu and macOS,
publishes `npm run coverage` in the job summary, runs `test:ui` on macOS, and
`cargo check --locked` under `src-tauri/` after `npm run build`.

Optional: four ledger tests need an embedding server at `127.0.0.1:1234` if you touch
`server/src/deliberation/ledger.ts` — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Layout

```
server/src/
  index.ts              daemon: http + ws
  db.ts                 SQLite schema and queries (frozen CREATE TABLE — see CONTRIBUTING)
  api.ts                REST surface
  bus.ts                server → UI event fanout
  adapters/             brain adapters behind one interface
  deliberation/         scheduler, contract, ledger, conclave, personas
  http/                 auth, origin, gate
  sqlite/               migrations and node:sqlite adapter
  search/               embeddings
  headless/             CLI entry
web/src/                React UI (Vite)
src-tauri/              desktop shell (Tauri / Rust)
scripts/                build and test helpers
docs/                   design notes and manual (user-facing)
examples/               sample room JSON
```

## Conventions that fail silently

Read [CONTRIBUTING.md](CONTRIBUTING.md) before schema, tier, or test changes:

1. **Schema** — never add columns only in `db.ts`; migrate in `server/src/sqlite/migrate.ts` with tests.
2. **Tiers** — validate with `isTier`; unknown tiers are most restrictive.
3. **Tests** — use `t.skip(...)`, not a bare `return` that looks like a pass.

Use `server/src/adapters/stub.ts` via `registerAdapter()` to test scheduling without
calling real CLIs.

## Agent workflow (required)

**Before each commit**, when your change touches behaviour that can be tested:

1. Run `npm run typecheck && npm test` (and `npm run test:ui` if you changed `web/src/`).
2. Run `npm run coverage` and **try to increase** statement/branch coverage for the
   code you changed (add or extend tests). CI reports coverage for visibility; there is
   no enforced threshold, but shrinking coverage without reason is not acceptable.

**Never commit:**

- Secrets, API keys, tokens, or personal paths from your machine.
- Host-specific configuration meant only for your environment (use env vars locally;
  keep README/docs/commands generic).

**Public docs** (`README.md`, `docs/manual.md`, issue templates, etc.) should stay
general — no machine-specific paths, account names, or unreproducible one-off steps unless
clearly marked as examples.

## Product scope

Do not refactor product code or change the licence unless the task explicitly asks.
Leave open issues **#37** (Windows CI) and **#38** (macOS notarisation) alone unless
the task targets them.
