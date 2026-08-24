# Roundstorm

A local-first macOS app where persistent, heterogeneous AI researchers deliberate
for N rounds on a hard question — with as little orchestration effort from you as
an ordinary group chat.

You write the question once. They do the arguing.

Design proposal: `~/.claude/plans/roundstorm-design-brief-starry-avalanche.md`.

## Status — sprints 0–2 complete

| Sprint | Scope | State |
|---|---|---|
| 0 | Daemon, SQLite, WebSocket push, three-pane shell | done |
| 1 | Adapter interface, Claude Code adapter, personas, avatars, DMs, turn contract | done |
| 2 | Multi-agent rooms, parallel + ping-pong rounds, sealed opening, control bar | done |
| 3 | Codex / `agy` / `cursor-agent` / DeepSeek adapters, multiplexer enumeration | done |
| 4 | Selection, copy-as-Markdown, LaTeX copy, in-room search, context menus, ⌘K | done |
| 5 | Positions ledger, all six modes, steering, @mentions, interrupt-now | done |
| 6 | Conclave, synthesis, result cards, export | done |
| 7 | Memory inbox, sources, activity log, global search, side rooms | done |

| 8 | Tauri app, persona lab, local brains, semantic search | done |

**The MVP is complete and packaged.**

Working today: rooms and DMs, nine persona templates, sealed opening rounds,
parallel and ping-pong scheduling, live per-agent activity, mid-flight extend and
stop, human steering with priority injection, capability tiers, full activity log,
round dividers, reply quotes with jump-to, basis chips, Markdown + LaTeX,
in-room search with highlighting, right-click menus, a ⌘K palette, and copy that
preserves LaTeX source and claim provenance.

Four brains work: `claude`, `codex`, `agy`, `cursor-agent`. Two of them are
multiplexers, so the brain picker offers 200+ models across five families
(Claude, GPT, Gemini, Grok, Composer). DeepSeek is implemented and reports
itself unavailable until `DEEPSEEK_API_KEY` is set.

Every mode works: Brainstorm, Critique, Deliberation, Consensus, Research Plan,
Conclave. Deliberations end in a result card whose agreement level is *computed
from the positions ledger*, so "two positions remain" and "conclave failed to
reach consensus" are reported honestly rather than smoothed into agreement.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:5273. The daemon listens on 8787 and stores everything
in `~/Library/Application Support/Roundstorm` (override with `ROUNDSTORM_DATA`).

### Both at once

The daemon owns port 8787 and the app starts its own. To use the browser
alongside the app, start only the web UI — it proxies to whichever daemon is
already there, so both windows show the same rooms and the same database:

```bash
npm run dev:web     # http://localhost:5273
```

Running the full `npm run dev` while the app is open just fails on
`EADDRINUSE` for the second daemon.

### As a macOS app

```bash
npm run app:build
```

Produces an unsigned `Roundstorm.app` (~21 MB) that bundles the daemon and starts
it on launch.

**Everything is resolved by absolute path, never through `PATH`.** A GUI app
launched from Finder or the Dock inherits `/usr/bin:/bin:/usr/sbin:/sbin` and
nothing more — no nvm, no `~/.local/bin`, no Homebrew. That applies to Node and
to every CLI brain, and getting it wrong looks like `spawn claude ENOENT` on
every turn while a terminal launch works perfectly. `adapters/resolve.ts` probes
the real install locations and the spawned brains get an enriched `PATH` of their
own, because they shell out too.

Not signed or notarised: that needs an Apple Developer certificate, so the first
launch requires right-click → Open. Making the bundle fully self-contained means
removing the one native dependency (`better-sqlite3`); Node's built-in
`node:sqlite` would do it, but it is still flagged experimental.

```bash
npm test        # contract + context isolation tests
npm run typecheck
```

## Requirements

Any of `claude`, `codex`, `agy`, `cursor-agent` on `$PATH` and authenticated.
The daemon probes each at boot, enumerates the multiplexers, and prints what it
found:

```
brains   claude ✔ (4) · codex ✔ (2) · agy ✔ (14) · cursor ✔ (204) · deepseek ✖
```

A missing, renamed, or newly-broken CLI shows up there rather than as an agent
that silently misses round three.

## Running fully offline

Point an agent at LM Studio or Ollama and it needs no account and no network.
`--json_schema` on those servers is real enforcement, so a local agent produces
the same structured turns as a hosted one.

Semantic search uses a local embedding model too. Nothing about the search index
leaves the machine, which is the only way it could be part of a local-first
notebook.

## Configuring researchers and rooms

All of it is in the GUI — §17 of the design is explicit that a researcher should
not have to type commands to create agents, start rooms, or change personalities.

**A researcher.** Click any name under **Agents** in the left pane, or `+` to add
one. You get its name, role, colour, persona, brain and capability ceiling.
The persona's behavioural contract is shown in full, because it is the thing that
actually governs how the agent argues — not flavour text. Pick **Custom** and you
write the contract yourself. `Duplicate` is the intended route to a custom
persona: start from a template that nearly works, then edit it.

Deleting a researcher removes it from every room but leaves its past messages in
the transcripts. A record that loses its authors is worthless.

**A room.** `+` next to **Rooms**, or the `Cast` button in the room header to
change an existing one. Name it, pick any set of researchers, set what they are
allowed to do. One researcher makes it a direct message — plain chat, no rounds.
The sheet tells you whether you have built a single-brain or a mixed-brain cast,
since those are different experiments.

Deleting a room does destroy its transcript, ledger and sources, and says so.

Everything here is also on `⌘K`.

## Persona lab

The experiment the design is built around: hold the personas fixed, vary the
brains, ask the identical question, compare. `⌘K → Persona lab` creates two rooms
— one where every persona runs on the same brain, one where they are spread
across brains — and the compare view diffs the outcomes: agreement level,
positions, concession rate, claim bases, turn length, cost.

Movement is the number worth watching, and it is counted from the ledger and the
stance field together. Either alone under-reports: the ledger misses an agent
that switches sides while calling it an endorsement, and the stance misses
movement inside a position that de-duplication has already collapsed onto one
entry.

The lab also checks whether the question was contested at all. "Nobody changed
their mind" is a misleading finding if nobody disagreed in the first place, so
that case is reported as an experiment-design problem rather than a result about
the brains.

## Calling it from something else

The daemon is a plain HTTP service on `127.0.0.1:8787`, so anything that speaks
HTTP can drive it — an agent, a CLI, a cron job, another local service. There is
no auth because it binds to loopback only.

Deliberations are asynchronous: you start one, then either poll the room or
subscribe to the WebSocket at `/ws`. `scripts/ask.sh` is a working example of the
polling form.

```bash
scripts/ask.sh <room-id> "Your hard question" 3
```

Under the hood:

```bash
# 1. start it
curl -X POST localhost:8787/api/rooms/$ROOM/deliberations \
  -H 'content-type: application/json' \
  -d '{"mode":"deliberation","rounds":3,"style":"parallel","question":"…"}'

# 2. poll until the room goes idle, then read the result card
curl -s localhost:8787/api/rooms/$ROOM/messages | jq '.active // .results[-1]'
```

For live progress instead of polling, open a WebSocket to `/ws` and read the
`message`, `activity`, `deliberation` and `result` events as they arrive — that is
exactly what the GUI does, and it has no privileged channel.

Useful for scripting: `GET /api/search?q=` (keyword and semantic),
`GET /api/rooms/:id/export?format=json|markdown`,
`GET /api/events/export?roomId=` for the JSONL audit log.

## The positions ledger

Agents do not just talk; they record where they stand. Every turn can assert,
endorse, oppose, revise, or withdraw a named position (`P1`, `P2`…), and the
ledger is rendered back into every subsequent prompt so the room argues about a
shared record.

That makes the outcome a computed fact. `summarise()` derives the agreement level
from who backs what, and the synthesiser is *told* the level rather than asked to
judge it — which is what stops a tidy-sounding "the room agreed" being written
over a record showing a 2–2 split.

Positions are de-duplicated by meaning. Agents reliably restate a peer's position
under a new title instead of endorsing it, which fragments the record — a room in
unanimous agreement reported as "no reliable conclusion" because each agent filed
its own phrasing of one idea. When a local embedder is available, a new position
that is a restatement of an existing one is recorded as an endorsement instead,
and the merge is logged with its similarity score so it stays auditable.

Conclave adds a real negotiation loop on top: a rotating chair drafts the
proposal, a rotating devil's seat is obliged to attack it, and endorsing costs
something — you must restate the proposal in your own words and name the
concession you made. Revising a proposal invalidates every endorsement collected
against the old version, so stale yeses cannot accumulate.

## How a turn actually works

1. The scheduler snapshots the transcript through round N-1.
2. `composeContext` builds a persona system prompt plus a question/transcript/steer/instruction
   user prompt. Roundstorm owns this context and rebuilds it every turn — CLI session
   state is never used for room history.
3. The adapter spawns the CLI, streams activity to the UI, and returns a structured turn.
4. `coerceTurn` normalises it. A turn that cannot be parsed still renders as a
   readable message; only the ledger gets thinner.

### Per-brain quirks, all found by probing

Each of these cost a failed run to discover, and each is commented at the call site.

| Brain | Quirk |
|---|---|
| `claude` | `--json-schema` is a `StructuredOutput` **tool**; `--disallowed-tools '*'` denies it and the turn dies |
| `codex` | stdin must be closed or `exec` blocks forever; `--ignore-user-config` does *not* stop skills loading (only a clean `CODEX_HOME` does); schema must be OpenAI **strict** mode — every property required, or a hard 400 |
| `agy` | appends its own `toolAction`/`toolSummary` keys, so the schema must not say `additionalProperties: false`; emits prose *then* JSON |
| `cursor-agent` | no schema flag at all; refuses to start in an untrusted directory; omitting `--model` inherits the user's configured model rather than `auto` |

The general lesson, which now applies to every adapter: **never inherit a CLI's
own configuration or defaults.** Pin the model explicitly, isolate the config,
and enumerate rather than guess model ids — a guessed id 400s at request time
and reads as a dead agent.

### Why the Claude flags look like that

`server/src/adapters/claude.ts` runs with `--setting-sources '' --strict-mcp-config
--system-prompt <persona> --disallowed-tools <explicit list>`.

Measured, not guessed:

- `--json-schema` is implemented as a `StructuredOutput` tool the model must call,
  so `--disallowed-tools '*'` denies the very mechanism the turn contract depends on
  and the run burns four turns failing. The deny list must be explicit.
- Without `--setting-sources ''` the agent inherits your global CLAUDE.md, hooks,
  skills and MCP servers.
- Trimming the advertised toolset takes a turn from ~18,700 input tokens to ~2,300.
  At five agents times five rounds that is the whole cost profile of the product.

## Layout

```
server/src/
  index.ts              daemon: http + ws
  db.ts                 SQLite schema and queries
  api.ts                REST surface
  bus.ts                server → UI event fanout
  adapters/             brain adapters behind one interface
  deliberation/
    contract.ts         turn schema, coercion, degradation
    context.ts          context composer, mode instructions
    personas.ts         nine behavioural contracts
    scheduler.ts        parallel / ping-pong rounds, sealed opening
    dm.ts               direct messages
web/src/                React UI
```
