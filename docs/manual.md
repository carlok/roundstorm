# Roundstorm — manual

The same text is in the app: click **Manual** in the room header, press
**shift-?**, or use **⌘K → How Roundstorm works**.

## The idea

You write one hard question. Several AI researchers argue about it for a set
number of rounds while you watch. You never copy anything between them.

### Four words

| | |
|---|---|
| **Agent** | A named researcher with a persona and a memory. Alice, Bruno, Curie. |
| **Brain** | The model behind it. Swapping Alice from Claude to Gemini is a settings change, not a new colleague. |
| **Room** | A conversation with a cast. Agents outlive rooms; transcripts do not travel. |
| **Deliberation** | A bounded job inside a room: N rounds, one mode, one result. |

### A first run

1. Open a room and type your question in the composer.
2. Click **Deliberate…**, keep the defaults, press Start.
3. Watch the control bar. Round 1 is sealed, so nothing appears until everyone has committed.
4. Read the result card pinned at the end.

> **Ask something with two defensible answers.** This is the single thing that
> decides whether a run is worth the money. Given a question with an obvious
> answer, all the agents agree in round 1 and you learn nothing — the transcript
> still looks busy, which makes it easy to miss.

> **Cost.** Each turn is a real model call. Four agents over three rounds is
> twelve calls. On Haiku that is a few cents; on Opus it is dollars. Click any
> agent to change its brain — LM Studio runs locally and costs nothing.

## The six modes

Modes differ in three things: what each round asks for, when it stops, and what
the final report emphasises. Nothing else changes.

**Deliberation** *(the default)* — Each agent advances its position and engages
the strongest argument against it, revising when beaten. Use this when you want
the best answer to a contested question.

**Brainstorm** — Diverge deliberately. Agents are penalised for restating an idea
already on the table and asked for options nobody raised. Use it early, when you
want the space of possibilities rather than a verdict.

**Critique** — Attack a proposal. Counterexamples, hidden assumptions, failure
modes, and every objection must name what would resolve it.

**Consensus** — Find genuine shared ground and state the residual disagreement
sharply rather than blurring it. Unlike Conclave, it will not force agreement.

**Research Plan** — Turn uncertainty into work: hypotheses, subproblems,
experiments, falsification tests, prioritised by what discriminates fastest.

### Conclave — the unusual one

The room cannot finish until **every** participant endorses one single position.
It runs a real negotiation rather than a discussion:

- A rotating **chair** drafts, then revises, the proposal.
- A rotating **devil's seat** is *required* to attack the current draft and may
  not pass. Its duty is to attack, not to dissent — if its own best objection
  fails, it may endorse.
- Endorsing costs something: you must restate the proposal in your own words
  *and* name the concession you made. "Agreed" does not count.
- Revising the proposal **invalidates every endorsement** collected against the
  old version. Stale yeses cannot accumulate.

The round count you set is an **emergency maximum**, not a target. If unanimity
is not reached it reports *"Conclave failed to reach consensus"*, names who held
out, and shows the last proposal. That is a real result, not an error.

Use it when you want one answer you can act on. Expect it to cost more than
Deliberation, because negotiating takes rounds.

## Rounds and styles

**Parallel** *(default)* — Everyone answers at once from the same starting point:
everything through the previous round, nothing from the current one. Faster, and
it keeps them independent rather than letting the first speaker set the frame.

**Ping-pong** — They speak in sequence and can react within the round, so
arguments chain more deeply. Slower. Speaking order rotates each round, because
the last speaker gets a free rebuttal nobody can answer.

**Sealed opening round** *(on by default)* — In round 1 nobody can see anyone
else's answer; all are revealed together once everyone has committed. This stops
the room converging on whoever wrote first, and the spread of opening positions
is often the most informative moment of a run.

### Steering a run

- Type while it is running. Your message goes to the top of the next round for everyone.
- `@Bruno` scopes it — others see it but are told to let Bruno answer.
- **+1 round** mid-flight when it is getting somewhere.
- **Interrupt now** discards the turns in flight and restarts the round with your
  steer. You lose the tokens already spent.

## Reading a discussion

### Basis chips

Under each message, what kind of thing it is:

| | |
|---|---|
| `reasoned` | The agent derived it. |
| `computed` | It ran something. |
| `sourced` | It retrieved a source. A claim marked sourced with no reference is automatically downgraded to reasoned, so this label cannot be used to dress up a guess. |
| `recalled` | From memory of earlier work. |

### Positions

The right-hand panel shows every named position and who asserts, endorses or
opposes it. The agreement level in the result card is **computed from this
record**, then narrated — not the other way round. That is what stops a
tidy-sounding summary being written over a room that was actually split.

Agents tend to restate a colleague's position under a new title instead of
endorsing it. When a local embedding model is running, near-duplicates are merged
automatically and the merge is logged with its similarity score.

### The result card

Pinned at the end: conclusion, the reasoning that survived, common ground,
remaining disagreement, evidence, unknowns, next steps. *"Two competing positions
remain"* and *"No reliable conclusion"* are legitimate outcomes, not failures.

A grey `unstructured` chip means the agent's reply could not be parsed into
claims. The message is still shown in full; only the ledger is thinner for it.

## What agents may do

Set per room, capped by each agent's own ceiling, visible in the room header.

| | |
|---|---|
| 🔒 **Reasoning only** | No tools at all. No web, no files, no commands. Pure argument from what is in the prompt. |
| 🌐 **Research tools** | Adds web search and fetch. No filesystem access. The sensible default. |
| 📖 **Workstation** | Adds reading files — `Read`, `Glob`, `Grep` — inside the project's working directory. Still no writes and no shell. |
| ⚠️ **Full local** | Adds `Write`, `Edit` and `Bash` inside that directory. This is the one that acts on your machine for real. |

The two file tiers require a **working directory** on the project. Without one
they are refused and the room silently drops to Research — logged as
`tier.downgraded`. That is deliberate: with no directory the CLI runs wherever
the daemon happens to be, which for a Finder-launched app is `/`, so granting
`Bash` there would scope nothing at all.

Networking: every tier from Research up can reach the web through the brain's own
search and fetch tools. At Full local, `Bash` can obviously also make network
calls — `curl` is just a command. Treat Full local as "this agent may do what I
could do from a shell in that directory".

> **One honest caveat.** These map onto each CLI's real sandbox flags, but the
> CLIs differ in how strictly they enforce them. Cursor Agent's read-only
> guarantee is a mode rather than a kernel sandbox, so treat its lower tiers as
> advisory and do not point it at a directory you would mind it touching.

## Clearing a room

**Clear room** (in a room's `⋯` menu) removes everything that room produced: the
messages, the positions ledger, sources, result cards, the search index for it,
**and the memory cards derived from it — including ones you already accepted into
an agent's long-term memory.** The room and its cast survive.

That last part is the point. Leaving accepted cards behind would mean an agent
still remembers a discussion you believe you erased, and quietly carries it into
the next one.

**Delete room** does the same and removes the room as well.

Neither is undoable, and both refuse while a deliberation is running.

## Backing up

**Inspector → Activity → Back up everything** writes a single SQLite file to your
Downloads folder containing every room, transcript, positions ledger, source,
memory card and log entry, and tells you the path. Also on
`⌘K → Back up everything`.

To restore, quit the app and put the file back over the existing database:

| | |
|---|---|
| macOS | `~/Library/Application Support/Roundstorm/roundstorm.db` |
| Linux | `~/.local/share/roundstorm/roundstorm.db` |
| Windows | `%APPDATA%\Roundstorm\roundstorm.db` |

It saves the file directly rather than serving it as a browser download. A
WKWebView does not handle `content-disposition` the way a browser does, and
following such a link can navigate the app away from its own interface. Scripts
that want the bytes can still `GET /api/backup`.

It is a real snapshot, not a file copy. Roundstorm runs SQLite in WAL mode, where
recent writes live in a separate `-wal` file that is routinely *larger* than the
database — so copying just the `.db` gives you something that opens cleanly and
is silently missing your recent work. Tested here: three messages written, then
the snapshot had all three while a plain copy of the same database had no tables
at all.

## Experiment files

A run can be described in one JSONC file — the cast, their personas and brains,
the question, the mode and the rounds. The same file works in three places:

- headless, `node dist-server/cli.mjs experiment.jsonc`
- in the interface, `⤓` next to **Rooms** or `⌘K → Load an experiment file`
- over HTTP, `POST /api/experiments`

Loading one in the interface creates the cast and the room and stops there. It
does not start a deliberation, because that costs money — the question is
prefilled and pressing **Deliberate** is yours.

A `.jsonl` file holds one experiment per line, which is the persona-lab
comparison run without the interface.

## Shortcuts

| | |
|---|---|
| `⌘K` | Command palette — rooms, agents, actions |
| `⌘F` | Search this room |
| `⇧⌘F` | Search every room, by meaning as well as by word |
| `shift-?` | This manual |
| `⏎` / `⇧⏎` | Send / newline |
| `↩` on a message | Reply to it |
| Right-click | On a message: copy, quote, take to a side room. On a room or agent: rename, configure, delete. |
| Select text | Quote it, copy it, or ask about it |
| `⌘C` on an equation | Copies the LaTeX source, not the rendered glyphs |
