# Roundstorm — design

The product and UX proposal this implementation was built from, with notes added
after each sprint recording what the real runs actually showed — including the
things that turned out wrong. Kept as written rather than tidied up, because the
corrections are the useful part.

## Context

Today, getting several strong AI perspectives on a hard research question means the human becomes a message router: ask Claude, copy the answer into Codex, paste the rebuttal into Gemini, keep a scratch file of who said what, and reconstruct the argument yourself. The cost of that routing is high enough that people just don't do it, so serious questions get one model's answer and one model's blind spots.

Two existing projects bracket the space and neither hits it. [`gumbel-ai/agent-debate`](https://github.com/gumbel-ai/agent-debate) has the right *protocol* instinct — evidence-bound claims, dispute tracking, forced convergence — but it is a shell/Python orchestrator over a shared markdown file, aimed at coding decisions, with no GUI and no persistent agents. [`yetone/cumora`](https://github.com/yetone/cumora) has the right *social* instinct — AI agents as first-class chat participants with personas — but ships a full team-collaboration product (Postgres + Redis + Kubernetes, Kanban, calendar, email) that is server-shaped, cloud-shaped, and mostly things this brief explicitly postpones.

Roundstorm is the missing middle: **a local-first macOS chat app where persistent, heterogeneous AI researchers deliberate for N rounds on a hard STEM question, with as little orchestration effort from the human as an ordinary group chat.**

The intended outcome: opening a room, typing one difficult question, picking a cast and a mode, and getting back a defensible research position — plus a searchable record of how it was reached — should feel as ordinary as sending a message.

---

## 1. The researcher's mental model

Four nouns. If a user can hold these four, the whole app is legible.

| Noun | What it is | Analogy |
|---|---|---|
| **Agent** | A named researcher with a persona, memory, and history. Alice, Bruno, Curie. | A colleague |
| **Brain** | The model/CLI that executes an agent's turn. Claude Code, Codex, `agy`, `cursor-agent`, DeepSeek. | Which computer they happen to use |
| **Room** | A persistent conversation with a cast and its own context. | A group chat / a whiteboard room |
| **Deliberation** | A bounded job that runs *inside* a room: N rounds, a mode, a style, a result. | Booking the room for an hour |

Three consequences the UI must make obvious:

- **Agents outlive rooms.** Alice is the same Alice in every room; her memory travels, the room's transcript does not.
- **Brains are swappable hardware.** Changing Alice's brain from Claude to DeepSeek is a settings change, not a new agent. The brain is a small badge, never the headline.
- **A deliberation is a job, not a mood.** It starts, it runs, you can watch it, steer it, extend it, or kill it, and it terminates in an artifact. Rooms without a running deliberation are just chat.

What the user should *never* need to think about: schedulers, graphs, prompt assembly, context windows, session IDs, subprocess lifetimes.

**The one-sentence pitch:** *You write the question once; they do the arguing.*

---

## 2. The interface

### 2.1 Overall shape

Three panes, macOS-standard, collapsible. Familiar on sight — the novelty is in behavior, not chrome.

```text
┌──────────────┬────────────────────────────────────────────┬───────────────────┐
│ ROOMS        │  Topological Dynamics                      │  INSPECTOR        │
│              │  Deliberation · Round 3/5 · Parallel  ⏸ ⏹  │  ┌─────────────┐  │
│ ▸ Nonlinear  │ ──────────────────────────────────────────  │  │Cast Positions│ │
│   ID         │                                            │  │Sources Memory│ │
│   ▸ Main     │  ⬤ Alice · Claude · Round 2      14:02     │  │Activity      │ │
│   ▸ Counter- │  ┌ Bruno ─────────────────────┐            │  └─────────────┘  │
│     examples │  │ "…fails when the spectrum   │            │                   │
│   ▸ Numerics │  │  is not simple."            │            │  Positions        │
│   ▸ ↔ Alice  │  └────────────────────────────┘            │  P1 Obstruction   │
│              │  Agreed for the degenerate case, but the    │     is topological│
│ ▸ Lean       │  hypothesis rules that out. See [S3, §4].   │   Alice  ✔ hold   │
│   conjecture │  ⟨reasoned⟩ ⟨cites S3⟩            ↩ ⋯      │   Gauss  ✔ hold   │
│              │                                            │   Bruno  ✖ opposes│
│ + New room   │  ⬤ Curie · Gemini · Round 2      14:02     │   Curie  ~ unsure │
│              │  Ran the 200-mode sweep; instability onset  │                   │
│ AGENTS       │  at Re≈4.1e3, not 3.6e3. [plot] [data]     │  P2 Onset scaling │
│ ⬤ Alice      │  ⟨computed⟩                       ↩ ⋯      │   …               │
│ ⬤ Bruno      │                                            │                   │
│ ⬤ Curie      │  ⬤ Gauss   thinking…                       │                   │
│ ⬤ Gauss      │  ⬤ Noether searching literature…           │                   │
│ ⬤ Noether    │ ──────────────────────────────────────────  │                   │
│              │  Message the room…            @  📎  [Send] │                   │
└──────────────┴────────────────────────────────────────────┴───────────────────┘
```

The middle pane is the product. Left and right panes are both collapsible to a single-column reading view (⌘\, ⌘⌥\), because a five-agent five-round transcript is something you *read*, sometimes for an hour.

### 2.2 Message anatomy

Every message renders as a normal chat bubble. Underneath, it carries structure (§3). The visible surface:

```text
⬤ Alice · Claude · Round 2 · 14:02                        ↩  ⋯
┌─────────────────────────────────────┐
│ Bruno · Round 1                     │   ← reply quote, click to jump
│ "The assumption fails when the      │
│  spectrum is not simple."           │
└─────────────────────────────────────┘
Agreed for the degenerate case, but Hypothesis (H2) rules it
out by construction. The residual obstruction is topological,
not spectral — see Kuznetsov §4 [S3].

⟨reasoned⟩  ⟨cites S3⟩  ⟨position P1 · revised⟩
```

The footer chips are the honest part of the design. `⟨reasoned⟩` vs `⟨computed⟩` vs `⟨sourced⟩` vs `⟨recalled⟩` tells you, at a glance and across a 4,000-line transcript, which sentences are load-bearing. This directly answers the brief's "I reasoned this" vs "I found evidence for this."

### 2.3 Telegram-grade ergonomics (non-negotiable, MVP scope)

These are not polish items; they are the difference between a research instrument and a demo.

- Native text selection across message boundaries. Selection survives new messages arriving.
- Select → floating **Quote / Copy / Ask about this** bar.
- ⌘C copies clean Markdown (not HTML soup, not the chips).
- ↩ on any message = reply. Reply quote is clickable and scroll-jumps with a highlight flash.
- ⌘F in-room search with match highlighting and n/N navigation; ⇧⌘F global search.
- LaTeX renders (KaTeX). **⌘C on an equation yields the LaTeX source**, not the rendered glyphs. Code blocks copy verbatim with a hover copy button.
- Links open externally; citation chips open the Sources panel.
- Right-click message → Copy / Copy as Markdown / Reply / Quote to new room / Pin / Show raw turn.
- New-message behavior: auto-scroll only when already at bottom; otherwise a "3 new ↓" pill. Reading a Round-2 argument while Round 3 lands must not yank the viewport.
- ⌘K command palette: jump to room, jump to agent, start deliberation, add rounds, stop.

### 2.4 The deliberation control bar

When a deliberation is running, a bar pins under the room header. It replaces every orchestration concept the user would otherwise have to learn.

```text
Deliberation · Round 3 of 5 · Parallel · Research tools
Alice ✔  Bruno ✔  Curie ⟳  Gauss ⟳  Noether ⏸        [+1 round] [Steer] [⏸] [⏹]
```

- `[+1 round]` / `[+3]` extend mid-flight. This will be the most-used button in the product.
- `[Steer]` focuses the composer and marks the next message as a **priority steer** (§8).
- `[⏸]` finishes in-flight turns then holds. `[⏹]` stops and offers "synthesize what we have?"
- Clicking any agent chip opens their live activity (§12).

### 2.5 Starting a deliberation

One sheet, six controls, sensible defaults, no schema editing.

```text
┌─ New deliberation ──────────────────────────────┐
│ Mode        [ Deliberation ▾ ]                  │
│             Competing approaches, mutual        │
│             criticism, converge where justified │
│                                                 │
│ Rounds      [ 4 ]  ──●────────                  │
│ Style       (•) Parallel    ( ) Ping-pong       │
│ Opening     [✔] Sealed first round              │
│ Cast        ⬤Alice ⬤Bruno ⬤Curie ⬤Gauss  + add  │
│ Capability  [ Research tools ▾ ]  ⓘ             │
│                                                 │
│ Est. 6–11 min · ~180k tokens         [ Start ]  │
└─────────────────────────────────────────────────┘
```

The estimate line matters. Deliberations cost real time and real money; showing that before the button is honest and prevents the "I asked for 8 rounds and it ran for 40 minutes" experience.

---

## 3. The turn contract — the spine

The single most important design decision. Every agent turn is produced against a fixed contract and stored structured; the chat bubble is a *rendering* of it.

```
turn:
  agent, brain, room, round, timestamp
  reply_to:      message_id | null
  addressed_to:  [agent_id] | ROOM
  stance:        propose | support | object | refine | question | concede | endorse
  body:          markdown
  claims: [
    { text, basis: reasoned|computed|sourced|recalled,
      refs: [source_id | artifact_id | message_id],
      confidence: low|medium|high }
  ]
  position_ops:  [ {position_id, op: assert|revise|withdraw|endorse|oppose, note} ]
  memory_proposals: [ {scope, text} ]        # queued, never auto-committed
```

Why this earns its complexity:

1. **Agents can reply to each other.** `reply_to` is what makes the transcript a conversation instead of a stack of essays. It is also what lets a later agent's prompt say "Bruno is responding *to your* Round-2 claim."
2. **Conclave becomes decidable.** Unanimity is `endorse` ops on one position from every participant — a computed fact, not a vibe (§7).
3. **Synthesis becomes cheap and faithful.** The final report is assembled largely by *querying* claims and positions, with a model pass for prose. Common ground and remaining disagreement fall out of the ledger rather than being re-hallucinated from a transcript.
4. **Search gets real filters.** "Every high-confidence `computed` claim Curie made about the onset threshold" is a query, not a grep.

**Enforcement is mostly free.** Most installed brains accept a JSON Schema and constrain their final response to it — `claude --json-schema`, `agy --json-schema`, `codex exec --output-schema <file>`, DeepSeek's `response_format`. Where that holds, the Turn schema is *enforced at the provider* rather than begged for in a prompt.

**`cursor-agent` is the exception** and it is why the fallback path is not optional. It offers `--output-format json|stream-json` but no schema flag, so its turns are prompt-constrained and parsed. Any brain in that position gets: an explicit output-format instruction with a fenced example, then a lenient parse, then a cheap extraction pass. A degraded turn becomes `{stance: propose, claims: [whole body as reasoned]}`. **The transcript is always readable even when the structure fails.** Track per-brain contract-compliance rate in the activity log; a brain that keeps degrading is a brain to stop using for Conclave.

One caveat to design around: schemas apply to the *final* response, so the prose body and the structure come back in one object. Render `body` as the bubble; the rest drives the ledger.

The user never sees this schema. They see chips, reply quotes, and a Positions panel.

---

## 4. Agents vs brains

### 4.1 Agent record

```
identity     name, avatar, one-line role
persona      template (or custom) + free-text instructions
brain        provider + model + params
capability   default tier ceiling (a room cannot exceed the agent's ceiling)
memory       filed cards, scoped (§5)
```

The avatar is not decoration. Five circular avatars with distinct colors and initials is the entire mechanism by which "five researchers" beats "five endpoints" perceptually. Ship a generated-identicon default (deterministic from name), allow image upload. Never render an agent without one.

### 4.2 Brain adapters

Four CLIs and one HTTP API, verified against what is actually installed on this machine (Aug 2026). Two of the four are multiplexers, so this table is five adapters, not five brains — the brain count is in the dozens:

| Brain | Binary / version | Print mode | Structured output | Streaming | Workspace scope | Sandbox / permissions |
|---|---|---|---|---|---|---|
| Claude Code | `claude` 2.1.237 | `-p` | `--json-schema <schema>` | `--output-format stream-json` | `--add-dir` | `--allowed-tools` / `--disallowed-tools`, `--dangerously-skip-permissions` |
| Antigravity | `agy` 1.1.19 | `-p` / `--print` | `--json-schema <schema\|file>` | `--output-format stream-json` | `--add-dir` (repeatable) | `--sandbox`, `--mode accept-edits\|plan`, `--dangerously-skip-permissions` |
| Codex | `codex` 0.149.0 | `codex exec` | `--output-schema <file>` | `--json` (JSONL) | `-C/--cd`, `--add-dir` | `-s read-only\|workspace-write\|danger-full-access` |
| Cursor | `cursor-agent` 2026.01.23 | `-p/--print` | **none** — prompt-level only | `--output-format stream-json`, `--stream-partial-output` | `--workspace <path>` | `--sandbox enabled\|disabled`, `--mode plan\|ask` (read-only), `-f/--force` |
| DeepSeek | HTTP | — | `response_format` | SSE | — | none |

Three facts from that table matter more than the rest:

**1. `agy` is not `gemini-cli` — and it is not one brain.** Antigravity fronts several models behind one binary (`agy models`): `gemini-3.1-pro-high/low`, `gemini-3.7/3.6/3.5-flash-*`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`. So a single adapter yields many brains via `--model`, and `--effort low|medium|high` is a further axis. Two useful consequences: the day-one brain roster is far wider than four, and *Gemini-via-`agy`* and *Claude-via-`agy`* are distinct brains from *Claude-via-`claude`* — different harnesses, different tool sets, genuinely different behavior. Worth exposing as separate brain entries, not collapsing by model name.

Google's `gemini-cli` is **not** a fallback: it was retired at I/O on 2026-05-19 and stopped serving individual-tier users on 2026-06-18 ([announcement](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)). It survives only for Gemini Code Assist Standard/Enterprise licences and paid API keys. Do not write an adapter for it. Reaching Gemini models means `agy`, or the Gemini HTTP API directly.

**2. `cursor-agent` is the second multiplexer, and the one that widens the *model families* on offer.** `cursor-agent --list-models` reaches things no other installed CLI does: `cursor-grok-4.5/4.6`, `composer-2.5`, `gpt-5.6-sol-*`, `gpt-5.3-codex-*` at six effort levels, `claude-opus-5-thinking-high`, `claude-fable-5-thinking-*`. For a product whose thesis is that heterogeneous perspectives beat one model, Grok and Composer sitting behind an already-installed binary is the cheapest diversity available. It also has `--browser` for browser automation, which is a real research affordance.

Two cautions. It is the **only brain with no schema flag** (see §3), and some of its models are flagged `NO ZDR` — no zero-data-retention. Surface that in the brain picker; a researcher pasting unpublished data into a room deserves to know which brains retain it.

**3. Every CLI scopes its writable workspace by directory** (`--add-dir`, `-C`, `--workspace`). Capability tiers (§9) map onto real, enforced primitives rather than politely-worded prompts.

### Measured in sprint 1 — three things the flag table does not show

Built and probed against the real `claude` binary, and every CLI adapter should inherit these lessons:

- **`--json-schema` is a tool, not a decoding constraint.** Claude Code implements it as a `StructuredOutput` tool the model must call. So `--disallowed-tools '*'` denies the very mechanism the turn contract depends on: the run burns four turns retrying and returns nothing structured. Deny lists must be explicit, never wildcards.
- **Isolate the agent from the operator's own configuration.** Without `--setting-sources ''` and `--strict-mcp-config`, a Roundstorm agent inherits the user's global CLAUDE.md, hooks, skills and MCP servers. That is a reproducibility bug before it is a cost bug — two users get materially different agents from the same persona definition.
- **Trim the advertised toolset per tier.** A turn carrying the default toolset costs ~18,700 input tokens; trimmed to the tier's actual needs, ~2,300. End to end: $0.11 for a naive probe versus $0.0044 for the same question configured properly. At five agents times five rounds that ratio *is* the product's cost profile, which makes §9's tier mapping a performance feature as much as a safety one.

The adapter contract:

```
run(agentContext, turnRequest, capabilityTier)
  → stream of { activity | token | tool_call | citation } then a Turn
```

**Process model.** Default to one subprocess per turn: simple, isolated, trivially cancellable. But `agy --input-format stream-json` reads NDJSON from stdin and runs one turn per line, which allows a *persistent worker per agent* — one process alive across a whole deliberation, fed a turn per round. Prototype it in sprint 3 and adopt it if per-turn startup proves to be a real share of the latency. Claude Code's `--input-format` offers a comparable path.

**Session policy.** Roundstorm owns context and composes it fresh each turn (§5.3); CLI session state is used only *within* a turn. Concretely: `codex exec --ephemeral` to avoid writing session files at all, and no reliance on `--continue` / `--resume` / `--conversation` for room history. Those flags are per-vendor, opaque, and unresumable across restarts — exactly the state the app must own itself.

**Design rule: no lowest-common-denominator.** DeepSeek can't run a simulation; Claude Code can. Rather than crippling Claude, the persona prompt is composed with the agent's *actual* affordances, and the UI shows honestly what each agent can do. An agent whose brain lacks web search says "I could not verify this myself" rather than silently guessing.

---

## 5. Personas and memory

### 5.1 Personas that bite

A persona is a *behavioral contract*, not flavor text. Each template ships with: a stance prior, a checklist the agent runs before answering, an output emphasis, and a failure mode it must avoid.

Example — **Skeptic**:
> Before responding, list the load-bearing assumptions in the current proposal and test each for a counterexample. Prefer one decisive counterexample to five weak doubts. You may not object without naming what evidence would change your mind. Do not object to notation or style.

That last clause is what stops a skeptic from degenerating into a contrarian noise generator by Round 3. Every template gets an equivalent guardrail.

Ship nine: Skeptic, Builder, Formalist, Experimentalist, Mathematician, Physicist, Engineer, Outsider, Literature Scout. Fully editable; "Duplicate & edit" is the intended path to custom personas.

**Persona lab.** Because "same persona, different brains" is a genuine research question, make the comparison first-class: duplicate a room's cast with brains permuted, run the same question, diff the outcomes side by side. Small feature, real scientific value, cheap on top of the existing model. (MVP: manual cast duplication. Sprint 7+: the diff view.)

### 5.2 Memory as filed cards

Memory is a set of small, typed, editable records — never an accumulating transcript.

```
card: { agent, scope, type, text, confidence, source_room, created, last_used }
scope: agent-global | project | room
type:  definition | decision | assumption | rejected-hypothesis
     | result | open-question | reference | own-position | user-preference
```

**Nothing is written silently.** At the end of a deliberation, each agent proposes memory cards. They land in a **Memory Inbox** badge on the Inspector:

```text
Memory proposals (4)                          [Accept all] [Discard all]
─────────────────────────────────────────────────────────────────
Alice · project · definition
"'Onset' means the first Re where the leading Lyapunov exponent
 crosses zero, not first visible oscillation."          [✔] [✎] [✖]

Bruno · project · rejected-hypothesis
"Spectral-degeneracy explanation ruled out by Curie's 200-mode
 sweep (Round 3)."                                      [✔] [✎] [✖]
```

Cards are readable, editable, deletable, and each links back to the message that created it. This is the entire answer to "memory must not become mysterious invisible state" — and reviewing four cards after a deliberation is a satisfying 20-second ritual, not a chore.

### 5.3 Context composition, made inspectable

Every turn's prompt is assembled from a fixed recipe with a token budget:

```
identity + persona                        ~always
pinned project memory (user-pinned first) ~10%
relevant agent memory (recency + tags)    ~10%
room digest (rounds older than 2)         ~15%
verbatim recent rounds                    ~45%
the human's active steer                  ~always, verbatim, at the top
the turn instruction (mode + round + role) ~always
```

And then — the trust feature — **"What did Alice see?"** on any message opens exactly the composed context that produced it, with token counts per section. Debugging a bad turn stops being guesswork. I know of no comparable tool that exposes this; it should be a signature of the product.

---

## 6. Rounds: parallel and ping-pong

**Parallel (default).** All agents receive identical context (everything through round N−1) and run concurrently. Fast, preserves independence, and the transcript groups cleanly under a round divider. Arrival order within a round is randomized in display *or* by completion — pick completion, but stamp the round so reading order stays honest.

**Ping-pong.** Sequential within the round; each speaker sees everything said so far, including this round. Slower, deeper chains. Speaking order rotates each round so the same agent isn't always last (last speaker has an unfair rebuttal advantage).

**Sealed opening (default on).** Round 1 runs blind: every agent commits an independent position before any are revealed. The UI shows it as a genuine event, which is good theater *and* good epistemics:

```text
─────────── Round 1 · sealed ───────────
⬤ Alice   ✔ committed
⬤ Bruno   ✔ committed
⬤ Curie   ⟳ writing…
⬤ Gauss   ✔ committed
                        [ Reveal when ready ]
```

On reveal, all four appear at once. Anchoring avoided, and the user immediately sees the diversity of the starting field — which is the best possible demonstration of why a multi-agent room beats one model.

---

## 7. Modes

Modes differ in three parameters: the per-round instruction, the termination rule, and the synthesis template. Nothing else. Keeping that uniform is what stops the mode list from becoming a workflow designer.

| Mode | Round instruction emphasis | Terminates | Synthesis |
|---|---|---|---|
| **Brainstorm** | Diverge. Penalize restating another agent's idea. Later rounds: cross-pollinate, don't converge. | N rounds | Idea catalogue, clustered, with the best 3 argued |
| **Critique** | Attack the target. Counterexamples, hidden assumptions, failure modes. Every objection names its falsifier. | N rounds | Ranked objections by severity + survivability verdict |
| **Deliberation** | Advance your position, engage the strongest opposing argument, revise when beaten. | N rounds | Full report (§13) |
| **Consensus** | Seek shared ground, state precisely where you still differ and why. | N rounds | Report + explicit agreement level |
| **Research Plan** | Convert uncertainty into hypotheses, subproblems, experiments, falsification tests. | N rounds | Prioritized plan with discriminating experiments |
| **Conclave** | Converge on one jointly endorsable position. | **Unanimous endorsement** or emergency cap | Single final position + endorsement record |

### Conclave, in detail

Conclave is the mode people will talk about, and the easiest to get wrong. It runs a real negotiation loop over the Positions ledger:

```text
Round k:
  1. Chair (rotating) drafts / revises PROPOSAL vK from the ledger
  2. Devil's seat (rotating, one agent) is REQUIRED to attack vK
  3. Every other agent: ENDORSE | OBJECT(reason, what-would-fix-it)
  4. If all endorse and the devil is satisfied → CONCLAVE REACHED
     else → revise, k+1
```

Three anti-fake-agreement mechanisms, because a conclave that rubber-stamps is worse than no conclave:

1. **Endorsement is expensive.** To endorse, an agent must restate the position in their own words *and* name the concession they made. A one-word "agreed" is rejected by the contract and re-requested.
2. **The devil's seat rotates and cannot pass.** Someone is always obligated to attack the current draft. It never happens that everyone is agreeable in the same round by accident.
3. **Endorsements expire on revision.** If the proposal changes materially, prior endorsements are invalidated and must be re-collected. No accumulating stale yeses.

The live UI is a tally, which makes the tension visible and is genuinely fun to watch:

```text
CONCLAVE · Proposal v4 · round 7 of max 12
Alice   ✔ endorsed v4
Gauss   ✔ endorsed v4
Curie   ✔ endorsed v4
Bruno   ✖ objects — "onset definition still ambiguous below Re=4e3"
Noether ⟳ (devil's seat) attacking v4…
```

On the cap: **`Conclave failed to reach consensus after 12 rounds`**, plus the final proposal, the surviving objections, and who held out. Reported as a legitimate outcome with its own result card — never softened into fake agreement.

### Not-fake consensus generally

Outside Conclave, the synthesizer picks from a fixed vocabulary and is forbidden from inventing agreement: `Strong consensus` / `Consensus with reservations` / `Two competing positions` / `No reliable conclusion` / `Additional evidence required`. The level is computed from the Positions ledger first and only then narrated. "Two positions remain" is a first-class success state and should be presented as a result, not a failure.

---

## 8. Human intervention

The human is a member of the room with one privilege: **their message jumps the queue.**

- Type any time. The message lands in the transcript immediately and is injected verbatim at the top of the next round's context for every agent, labeled `PRIORITY — from the human`.
- `@Bruno` scopes a message to one agent. Others see it but aren't asked to respond.
- Reply to a specific message to make the objection concrete: "Bruno's objection looks important — everyone focus on that."
- **Interrupt now** (⌘⏎ while running): abandon in-flight turns and restart the round with the steer included. Costs the in-flight tokens; the button says so.
- Drop a file or paste data → becomes an **Evidence** source (§10), visible to every agent from that round on.
- **Fork to side room** from any message: select messages → "Take this to a room" → pick agents, rounds, mode. The child room opens with the selected messages as its seed context and a back-link. Its result card can be cited into the parent with one click (§11).

Consistent principle: the human adds *constraints and evidence*, never plumbing. There is no action in the product that amounts to "pass this along."

---

## 9. Capability tiers

One room-level dial, four stops, mapped per-brain to real sandbox flags. The room's tier is capped by each agent's own ceiling.

| Tier | Means | Shown as |
|---|---|---|
| **Reasoning only** | No tools, no network, no filesystem | 🔒 |
| **Research** | Web search + fetch. No local writes. *(default)* | 🌐 |
| **Workstation (read-only)** | + read files, run read-only computations in a scoped dir | 📖 |
| **Full local** | + write files, execute programs, run simulations | ⚠️ |

Rules:
- The tier is visible in the room header at all times. Not buried in settings.
- Raising a tier is an explicit dialog naming what becomes possible.
- **Full local** requires choosing a working directory; agents cannot reach outside it.
- Destructive-looking actions (delete, network POST, `sudo`, package installs) pause the deliberation and prompt — with the exact command shown. Nothing irreversible happens invisibly.
- Every tool call is logged with its full command and result regardless of tier.

Tier → flag mapping, verified:

| Tier | `claude` | `agy` | `codex exec` | `cursor-agent` |
|---|---|---|---|---|
| Reasoning only | `--disallowed-tools '*'` | `--sandbox`, no `--add-dir` | `-s read-only` + no workspace | `--mode ask --sandbox enabled` |
| Research | allow web tools only | `--sandbox` | `-s read-only` | `--mode ask --sandbox enabled` |
| Workstation (read-only) | `--add-dir <wd>`, read tools | `--add-dir <wd>`, `--mode plan` | `-C <wd> -s read-only` | `--mode plan --workspace <wd>` |
| Full local | `--add-dir <wd>` + write tools | `--add-dir <wd>`, `--mode accept-edits` | `-C <wd> -s workspace-write` | `--workspace <wd> --sandbox enabled -f` |

`cursor-agent` is the coarsest of the four: `--print` grants all tools including write and bash, and the read-only guarantee rests on `--mode plan|ask` rather than a kernel sandbox. Treat its Reasoning-only and Research tiers as *advisory*, mark them as such in the UI, and never hand it a working directory containing anything you would mind it touching.

`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` are never used. If a brain cannot express a tier, the agent is shown as capped at the highest tier it *can* honor — silently over-granting is the one failure mode that must not exist.

---

## 10. Internet research and citations

A **Source** is a first-class record, deduped at room scope:

```
source: { id: S3, url|doi|file, title, authors, retrieved_at, snapshot, found_by }
```

- When an agent's brain performs a web search, the adapter captures result URLs and turns them into sources; the agent's claims reference `S3`, and the bubble shows `⟨cites S3⟩`.
- A **Sources panel** lists everything the room has gathered, with which agent found it, when, and which claims lean on it.
- Sources are shared context: subsequent rounds get the source list, so Bruno can attack Alice's citation by ID instead of "that paper you mentioned."
- A local snapshot (text extract) is stored so a claim stays auditable after link rot. That's the local-first commitment applied to evidence.
- The **⟨sourced⟩ vs ⟨reasoned⟩ chip is enforced at the contract level**: a claim marked `sourced` with no `refs` is downgraded to `reasoned` on ingest. Agents cannot launder speculation as evidence by adjective choice.

Evidence in this product is deliberately broader than `agent-debate`'s `file:line`: a theorem, a derivation, numerical output, a dataset, a plot, a limiting-case argument, a dimensional check, or an explicitly stated assumption all register as artifacts or claims with the appropriate basis.

---

## 11. Rooms, DMs, side rooms

- **Project** → contains rooms. A project owns shared memory scope, working directory, and default capability tier.
- **Room** → cast + transcript + positions + sources + deliberation history.
- **DM** → a room with one agent, no rounds, plain chat. Essential: "Alice, explain your Round-3 argument to me slowly" is a thing researchers will do constantly.
- **Side room** → a child room seeded from selected parent messages, with a back-link.

**Result citation** closes the loop: a side room's result card can be posted into the parent as a citable message. That is how "Alice and Bruno, take this objection away for three rounds" actually pays off, and it is why side rooms are MVP rather than later.

Agents keep identity and memory everywhere; each room's transcript stays local to it.

---

## 12. Activity, logs, auditability

Two strictly separated surfaces.

**The transcript** is clean. Only messages, round dividers, human interventions, and result cards. Never raw tool output. Never internal errors. It should be pleasant to read six months later.

**Live activity** is ambient, one line per agent in the control bar, human-readable:

```text
Alice     Searching literature…
Bruno     Thinking…
Curie     Running calculation (sweep.py, 40s)…
Gauss     Waiting for Round 3
Noether   Replying to Alice…
```

Clicking an agent expands their detail: current tool call, elapsed time, tokens, partial output, a `[Cancel this turn]` button.

**The activity log** is a separate inspector tab and a separate on-disk stream, capturing: every turn with full composed prompt and raw response, every tool call with command/exit code/output, every web fetch, file access, memory write, config change, error, timeout, cancellation, cost, and latency. Filterable by agent / round / event type. Exportable as JSONL. Transcripts export as Markdown (with citations as footnotes) or JSON.

Auditability is a research requirement, not a nicety: a conclusion you can't reconstruct the provenance of is not usable in a paper.

---

## 13. Final synthesis

A deliberation always ends in a **Result card** — pinned at the end of the transcript, expandable, exportable, and citable elsewhere.

```text
╔══════════════════════════════════════════════════════════╗
║ RESULT · Deliberation · 5 rounds · 4 agents · 11m        ║
║ ▸ Two competing positions remain                         ║
╠══════════════════════════════════════════════════════════╣
║ BEST CURRENT CONCLUSION                                  ║
║   The instability is a topological obstruction, not      ║
║   spectral degeneracy. Onset scales as Re^(1/2).         ║
║ WHY  · survived Bruno's degenerate-spectrum counter-     ║
║        example (R2), confirmed numerically by Curie (R3) ║
║ COMMON GROUND        4/4 agents · 3 items                ║
║ REMAINING DISAGREEMENT  Bruno holds the scaling exponent ║
║        is unidentified below Re=4e3 [P2]                 ║
║ ALTERNATIVES         2 not selected                      ║
║ EVIDENCE             S1 S3 S7 · sweep.py · plot.png      ║
║ UNKNOWNS             3                                   ║
║ NEXT STEPS           1. Re-run sweep at 4e3–6e3 …        ║
╚══════════════════════════════════════════════════════════╝
                                    [Export ▾]  [Cite into…]
```

Generated primarily from the ledger (positions, endorsements, claims, sources) with one synthesizer pass for prose — by a *neutral* synthesizer agent that took no side in the debate. Every section links back to the messages it summarizes; nothing in the card is unreachable from the transcript.

Conclave's card is different: one final position, the endorsement roll-call, each agent's stated concession, and the version count. Or a clearly-labeled failure card.

---

## 14. Searchable research history

Global search (⇧⌘F) across all projects, rooms, messages, claims, sources, memory cards, and result cards. Full-text plus structured filters: agent, brain, mode, round, stance, basis, confidence, date, project.

Two views that make it a notebook rather than a log:

- **Claim view** — every claim on a topic across all time, who made it, what happened to it (upheld / revised / withdrawn / refuted), and where.
- **Position history** — a named position's lifetime: proposed → objected → revised → endorsed → revived six months later in another room.

This is what makes the app accumulate value. Semantic/embedding search is a fast-follow, not MVP; SQLite FTS answers most real queries.

---

## 15. Architecture stance (as little as the design requires)

Per your decision: **a local daemon plus a web UI, wrapped in Tauri once the UI settles.**

- **Daemon** owns everything durable: SQLite (WAL) for rooms, messages, turns, positions, sources, memory, logs; agent subprocess lifecycle; the round scheduler; the context composer; the adapters. One process, no server, no cloud, no account.
- **UI** is a React web app the daemon serves, talking over WebSocket. Streaming turns and activity are pushed.
- **Why this shape:** the daemon is the product and it is shell-agnostic. If Tauri turns out wrong, the UI is replaceable without touching orchestration. It also means a headless mode (`roundstorm run …`) comes nearly free for scripted experiments — secondary infrastructure, exactly as the brief wants.
- **Local-first is a hard constraint:** everything in `~/Library/Application Support/Roundstorm`, human-readable exports on demand, provider keys in Keychain, no telemetry, no network calls the user didn't ask for. The app keeps working if the project is abandoned — and the *research record* keeps working even if every brain vendor does (§19.7).

---

## 16. What to reuse

Reuse for anything that isn't the novel value. The novel value is: persistent heterogeneous researchers + autonomous multi-round deliberation + filed research memory + a chat surface good enough for real work.

| Need | Reuse | Note |
|---|---|---|
| Chat/message rendering | `assistant-ui` or hand-rolled on Radix primitives | Avoid heavy chat SDKs with server assumptions |
| Markdown | `react-markdown` + `remark-gfm` | |
| Math | KaTeX | Must preserve LaTeX on copy |
| Code highlighting | Shiki | |
| Virtualized transcript | TanStack Virtual | 5×8 rounds gets long fast |
| Avatars | `boring-avatars` / dicebear | Deterministic from agent name |
| Command palette | `cmdk` | |
| UI primitives | Radix + Tailwind | |
| Persistence | SQLite + FTS5 (better-sqlite3 / libsql) | |
| Search | SQLite FTS5 first | |
| Desktop shell | Tauri v2 (later) | Small binary, macOS-native feel |
| Notifications | Tauri notification API / web Notification | |
| Agent invocation | The vendor CLIs themselves | Don't reimplement agent loops |

**From the two reference projects:** take `agent-debate`'s *ideas* — evidence-bound claims, dispute ledger, forced convergence, escalation on non-convergence — and reimplement them as structured records rather than markdown strikethrough. Take `cumora`'s *stance* that agents are first-class chat participants with personas, and its BYOA local-daemon pattern for keeping provider keys on-device. Take neither codebase wholesale: one is a shell orchestrator, the other is a cloud team-collaboration platform. Both are MIT, so lifting specific adapter code is legally fine if it's genuinely useful.

---

## 17. MVP, by sprint

Two-week sprints, each ending in something demoable. Sprint 0 is setup. The MVP is sprints 1–7; **sprint 3 is the moment the product exists.**

### Sprint 0 — Skeleton
Daemon + SQLite schema + WebSocket + React shell. Three-pane layout with dummy data. One end-to-end message round-trip, no agents.
**Exit:** you can type in a room and see the message persist across restart.

### Sprint 1 — One agent, real
Adapter interface + Claude Code adapter (streaming). Agent records, personas, avatars. DM room. Turn contract v1 with graceful degradation.
**Exit:** DM with Alice, streaming replies, survives restart. The chat feels good already.

### Sprint 2 — The room
Multi-agent rooms. Parallel rounds. Round dividers. Control bar with live activity and stop. Sealed opening round. Deliberation mode only.
**Exit:** four Claude-brained agents deliberate 3 parallel rounds on a real question and it is worth reading.

*Done. Four agents on Haiku, two rounds, a rotating-rig instability question: 8/8 turns structurally valid, zero degraded, stances moving `propose` → `refine`/`concede`, one agent conceding with stated reasoning against three others, $0.20 total. Personas were visibly distinct — the mathematician reached for jump resonance, the experimentalist for a discriminating measurement, the formalist for ruling things out. Two findings to carry forward:*

- *Agents engage each other by name in prose but leave `reply_to` empty unless told plainly. One added line in the turn instruction moved it from 1/4 to 2/4 round-2 turns. The remaining blanks were legitimate — those agents were addressing the room while synthesising across several positions — and no agent ever emitted an id that failed validation. 100% is the wrong target.*
- *The §19.2 persona-collapse risk did not surface at two rounds. If it exists it is a three-round-plus phenomenon, so the real test belongs in sprint 3 next to the heterogeneity check rather than before it.*

### Sprint 3 — Heterogeneity ⭐
Codex, `agy`, `cursor-agent`, DeepSeek adapters. Brain registry populated by probing `$PATH` then enumerating each multiplexer (`agy models`, `cursor-agent --list-models`), so every model registers as its own brain with its harness recorded. Brain badges. The prompt-and-parse fallback for schema-less brains. Prototype the persistent-worker process model.
**Exit:** the central product test from the brief runs — and with five families available (Claude, Gemini, GPT/Codex, Grok, DeepSeek) the cast can be genuinely heterogeneous rather than four wrappers over two labs. **This is the demo.**

*Done, with `cursor-agent` standing in for DeepSeek (no API key on this machine; the adapter ships and reports itself unavailable). Registry enumerates 226 selectable brains across five families. 8/8 turns valid, zero failures, zero degraded. A real 2–2 split: Curie and Bruno for oil whip, Alice and Noether for a hardening nonlinearity. Noether — Outsider persona, on the schema-less brain — explicitly named the room's frame and abandoned it, which is what that contract asks for and what no single-model answer produced.*

*Each brain cost a failed run to characterise. Every quirk is now commented at its call site:*

| Brain | Quirk that broke a run |
|---|---|
| `codex` | stdin must be closed or `exec` blocks forever; `--ignore-user-config` does **not** stop skills loading (only a clean `CODEX_HOME` does — 21.3k → 13.8k tokens — and it carries auth, so the isolated home symlinks `auth.json` back); schema must be OpenAI **strict** mode, where one optional property is a hard 400 and the agent silently misses the round |
| `agy` | appends its own `toolAction`/`toolSummary` keys, so the schema must omit `additionalProperties: false`; emits prose *then* JSON |
| `cursor-agent` | no schema flag; refuses to start in an untrusted directory; omitting `--model` inherits the user's configured model rather than `auto`, which a free plan rejects |

***The general rule, now applied to every adapter: never inherit a CLI's own configuration or defaults.*** *Pin the model explicitly, isolate the config, and enumerate model ids rather than guess them — a guessed id 400s at request time and reads as a dead agent. Same failure class as the `gemini-cli` retirement, at model granularity.*

*One genuine bug in Roundstorm's own code, worth recording because it was invisible: `extractJson` took the **last** `{` in the text. Against agy's prose-then-JSON output that finds the final claim object rather than the turn, so the message rendered perfectly while the entire ledger came back empty. A silent, plausible-looking failure — the kind the degradation path is supposed to catch and didn't. Now it tries every brace position and prefers the outermost turn-shaped object, with regression tests on the exact shape.*

### Sprint 4 — Conversation ergonomics
Reply + quote + jump. Selection, copy, copy-as-Markdown. KaTeX with LaTeX-preserving copy. In-room search. Context menus. Scroll behavior. Agent-to-agent `reply_to` rendering.
**Exit:** you can read and work a long transcript without fighting the UI. Non-negotiable before anyone else sees it.

*Done. Verified against a 41-message four-brain transcript: ⌘F finds 23 matches with 73 highlights and steps through them, ⌘K jumps rooms and fires actions, right-click copies text / Markdown / claims-with-basis.*

*The LaTeX-copy requirement needed a real fix, not the obvious one. Hiding KaTeX's rendered tree with `user-select: none` so the MathML annotation gets picked up does nothing — `Range.toString()` ignores `user-select`, and ⌘C still yielded `𝑓𝑛`. It takes a `copy` event handler that clones the selection and swaps each KaTeX node for its TeX source. That handler needs two branches: selecting **inside** one equation clones the node's children rather than the node, leaving no `.katex` to swap, and the naive version silently falls back to glyphs. Both branches verified in-browser — `$f_n$` for an equation, and prose with `$f_n$` embedded for a paragraph.*

### Sprint 5 — Modes and the ledger
Positions ledger + Positions panel. Brainstorm, Critique, Consensus, Research Plan. Ping-pong style. Human steering, `@agent`, priority injection, interrupt-now.
**Exit:** all five non-conclave modes produce visibly different discussions; you can redirect a running deliberation.

*Done. Two findings, both from watching the ledger rather than the prose:*

- ***Agents open near-duplicate positions rather than endorsing a peer's.*** *A real run produced three positions for two hypotheses — P1 and P2 were both "hardening" — which fragmented the record and made `summarise()` report "no reliable conclusion" over what was actually a 2–1 majority. The instruction has to say so bluntly ("read the ledger; do NOT open a near-duplicate"), and only from round 2, since a sealed opening round has no shared ledger to read. A later conclave produced exactly one position.*
- ***No per-turn timeout.*** *A hung `cursor-agent` stalled a round for over twenty minutes with no way out: three of four turns done, the fourth never returning, the deliberation unable to advance. Any single slow brain could block a room indefinitely. There is now a per-turn deadline that abandons the turn, records `turn.timeout`, posts a visible system message, and lets the round continue without it.*

### Sprint 6 — Conclave and synthesis
Conclave loop, devil's seat, endorsement contract, expiry-on-revision, emergency cap and honest failure. Result cards for every mode. Export (Markdown/JSON).
**Exit:** a conclave reaches unanimity on a real question — and a rigged one correctly reports failure.

*Done, and the first version was structurally broken in a way only a real run exposed.*

*§7 above says the devil's seat should "attack the current draft" and records `oppose`. Implemented literally, that makes unanimity **impossible**: someone holds the seat every round, so there is always a standing objection, and the conclave can only ever run to its cap. The round log made it obvious — the holdout was the current devil in four rounds out of five, and the run failed at the cap.*

*The fix is a distinction the plan should have drawn: **the devil's duty is to attack, not to dissent.** Mount the strongest objection available, then judge honestly whether it landed — a devil whose own best attack fails may endorse. With that change the same question reached unanimity at round 3 on proposal **v3**, after two rounds of genuine holdouts, with concessions recorded in each endorsement. Not a rubber-stamp, and not structurally rigged either way.*

*Both outcomes are now demonstrated on real runs: `conclave_reached` and `conclave_failed`.*

### Sprint 7 — Memory, sources, audit
Memory cards + Memory Inbox + editor. Sources panel with snapshots. Capability tiers with per-brain sandbox mapping and the dangerous-action prompt. Activity log tab + JSONL export. Global search. Side rooms with result citation. "What did Alice see?" inspector.
**Exit:** run a week of real research through it; find a six-week-old claim by search; audit how it was reached. **MVP complete.**

*Done. Global search finds a phrase across every room; Markdown and JSONL exports carry the ledger, the sources and the full activity log, not just prose. The synthesised "Why" section traced which objection killed which draft and which survived — that is the auditability §12 was asking for.*

*One finding: **the memory inbox drowns.** Collecting proposals from every round produced 37 cards from a single conclave, which turns a 20-second review ritual into a chore nobody performs — and an unreviewed inbox is exactly the invisible state §5.2 exists to prevent. Proposals are now taken only from the closing round, capped at two per agent. Memory should hold what survived the argument, not every intermediate thought.*

### Sprint 8 — Packaging, lab, local brains, semantic search

*Done.*

**Tauri.** An unsigned `Roundstorm.app` (~21 MB) that bundles the daemon and starts it on launch. Two things bit, both obvious only once it was a real bundle: a GUI app does not inherit a login shell's `PATH`, so Node has to be probed explicitly (Homebrew, system paths, nvm); and `WindowEvent::Destroyed` does not fire on ⌘Q or a Dock quit, so the daemon outlived the app, held port 8787, and the next launch silently talked to a stale build. Fixed with `RunEvent::Exit` plus a parent-pid watchdog in the daemon — the watchdog is the one that survives a force-quit, which no exit handler can catch. Both paths verified: zero orphans after a clean quit and after `kill -9`.

*Not signed or notarised — that needs an Apple Developer certificate. A fully self-contained bundle needs the one native dependency (`better-sqlite3`) gone; Node's `node:sqlite` would do it and the API is nearly identical, but it is still flagged experimental and swapping a working storage layer onto an unstable API is not a trade worth making for packaging convenience.*

**Local brains are real, not a placeholder.** LM Studio and Ollama go through one OpenAI-compatible adapter shared with DeepSeek. LM Studio supports `response_format: json_schema`, so a fully offline agent produces the same enforced structured turns as a hosted one — verified end to end on a local Gemma. Worth noting the shape of the bug found here: LM Studio *rejects* `json_object` outright while DeepSeek only offers `json_object`, so the response format has to be per-endpoint. Guessing it is a 400 and a dead agent.

**Semantic search runs locally.** A search index that phones a vendor would undo §22 entirely. Queries with zero keyword hits return the right passages: "where should the sensor be mounted" surfaced the accelerometer-orientation argument at 0.63, sharing no words with it. Keyword and semantic results are shown as separate lists rather than blended, because they answer different questions and merging them hides which kind of match you got.

**The persona lab earned its place immediately** — by finding a bug in the ledger, which is the product's central claim.

*Both arms of the first comparison reported **"no reliable conclusion"** while every position in them said the same thing. The room agreed unanimously; the ledger had fragmented that into three or four positions with one supporter each. §7 says consensus is computed rather than narrated, and it is — but a computation is only as honest as the record it reads, and the record was wrong.*

*The instruction fix from sprint 5 could not solve this: a sealed opening round has no shared ledger to read, so duplicates are created by construction. The fix uses sprint 8's own embedder. Threshold measured, not guessed — across real output, restatements of one claim scored 0.73–0.99 pairwise while every genuinely distinct pair topped out at 0.60, so 0.70 sits in the gap with margin both ways. A new position that is a restatement of an existing one is recorded as an **endorsement** of it, and every merge is logged with its similarity score so the decision stays auditable and reversible.*

*Re-run: 1 position per arm at +3/−0, both arms reporting **strong consensus**, four merges logged at 0.92–0.96.*

**Smaller things found by using it.** The ⌘K palette listed rooms before actions and sliced to twelve, so once a project accumulated a dozen rooms every action fell off the end — which defeats the point of a command palette. And the persona lab's generated agent names collided on a second experiment, because agent names are globally unique (`@mention` resolves by name); there is now a `uniqueAgentName` helper, and the API returns a readable error instead of an Express stack trace.

### Investigation — why concessions disappeared

*The lab's first comparison reported "no arm produced a single concession", where earlier sprints had produced them. Three causes, only one of which was a regression.*

**1. The question, not the agents.** "Does a hysteresis band alone distinguish X from Y?" has one obvious answer, so every agent asserted the same thing in the sealed round and there was nothing left to concede. Re-running the identical casts on a contested question — "oil whip **or** hardening; commit to one" — restored concessions immediately (2 and 1). Not a regression, a confounded experiment. The lab now detects this and says *"the question was not contested"* rather than blaming the brains, because reporting "nobody changed their mind" about a question nobody disagreed on is a misleading finding dressed as a real one.

**2. The metric read the wrong field.** `concessions` counted `stance: 'concede'` only. But the sprint-5 ledger instruction — *"if you are backing what someone else already stated, endorse it"* — moved agents onto `endorse` for everything. One turn literally reads *"Concede that excitation-removal is definitive"* while filing `op: endorse`. **My own instruction change suppressed the signal I was measuring.** Movement is now counted from the ledger and the stance field, unioned, because each covers the other's blind spot: the ledger misses an agent that switches sides while calling it an endorsement, and the stance misses movement inside a position that de-duplication has already collapsed.

**3. A real provenance bug from sprint 8.** De-duplication recorded a merged restatement as `endorse` even in a **sealed** round — where the agent could not possibly have seen the position it was recorded as endorsing. The consensus level came out right; the provenance was a fabrication, and provenance is the entire reason for keeping a ledger. Sealed-round merges are now `assert` (independent co-assertion), noted as such. It also mattered for measurement: recording the merge as the agent's first op erased the trajectory that led there.

*The general lesson is worth keeping: **an instruction that changes how agents describe what they do will silently break any metric reading that description.** The ledger is the more durable measurement surface precisely because it records acts rather than words — but only if what it records is true, which is what made bug 3 worse than it looked.*

### Sprint 9+ — remaining fast-follows

Signing and notarisation · direct HTTP adapters for Anthropic/Gemini/OpenAI as CLI-independent fallbacks · notifications · scheduled/background deliberations.

---

## 18. Deliberately postponed

Everything in the brief's §24, plus these, which are tempting and still wrong for the MVP:

- **Agent-initiated messages.** No agent speaks outside a deliberation round or a DM reply. Rooms that chatter on their own are unmanageable and expensive.
- **Agents editing each other's memory.**
- **Automatic memory extraction without review.** Every card is user-approved.
- **A visual workflow/graph editor.** Six modes and two styles cover the real space; the moment there's a node graph, this became enterprise software.
- **Multi-human rooms, sharing, sync.** Local-first, single-user.
- **Agents delegating to sub-agents.** Depth explosion, cost explosion, illegible transcripts.
- **Voice, mobile, RAG over a document library, plugins.**

---

## 19. Honest risks

1. **Cost and latency.** 5 agents × 5 rounds with tools is minutes and real money. Mitigations: pre-flight estimate, live token/cost counter, per-deliberation caps, streaming so waiting is watchable.
2. **Personality as costume.** Different personas on the same brain may converge to the same voice by Round 3. Mitigations: behavioral checklists rather than adjectives, an anti-restatement instruction, sealed openings, the devil's seat. **Test this in sprint 2 and treat convergence-to-sameness as a bug**, not a curiosity — it invalidates the product thesis if unfixed.
3. **Structured output non-compliance.** Mostly retired by provider-side schema enforcement (§4.2), but `cursor-agent` has no schema flag, so the prompt-and-parse path stays live and must be tested, not left as dead code. Measure per-brain compliance rate; degrade gracefully; never let a bad parse break the transcript.
4. **Sycophantic convergence.** LLMs agree too easily. Conclave's expensive-endorsement rule and the rotating devil's seat are the primary defense; monitor how often unanimity arrives in one round (a red flag).
5. **CLI churn.** Vendor CLIs change flags without warning, and they are not even reliably *named* what you expect — the Gemini brain on this machine is `agy` (Antigravity), not `gemini`. So: never hardcode a binary name. Brains are configured with a path plus a flag profile, discovered at setup by probing `$PATH` and confirmed by the user. Ship an adapter self-test that runs on launch and after updates: *"Roundstorm can talk to: claude ✔ · agy ✔ · cursor-agent ✔ · codex ✖ — `--output-schema` rejected."*
6. **Transcript fatigue.** 4,000 lines nobody reads. Mitigations: the result card, per-round collapse, claim view, and basis chips for skimming.

7. **Brains are rented.** `gemini-cli` was announced dead in May 2026 and stopped serving individual users a month later; `agy` and `cursor-agent` are closed-source and vendor-authenticated. This matters less than it first appears, because **no durable state lives inside a brain**: rooms, transcripts, positions, sources, memory cards and result cards are Roundstorm's own SQLite plus exports, and context is recomposed from them on every turn (§5.3). If `agy` disappeared tomorrow, nothing is lost but a name in a dropdown. Keep it that way: adapters stay thin, no provider quirk leaks into the scheduler, ledger, or context composer, and at least one plain-HTTP brain (DeepSeek) always works. Do show each brain's data-retention status in the picker, though — some `cursor-agent` models are marked `NO ZDR`, and that is a live concern for unpublished research, unlike vendor mortality.

---

## 20. Verification

Two tracks, run every sprint.

**Automated**
- Adapter conformance suite per adapter: fixed prompt → valid Turn, streaming events, cancellation, timeout, malformed-output degradation. Run it against both paths — schema-enforced (`claude`, `agy`, `codex`, DeepSeek) and prompt-and-parse (`cursor-agent`) — and assert the degraded turn still renders.
- Multiplexer enumeration: `agy models` and `cursor-agent --list-models` parse into brain records, and a model disappearing from the list downgrades affected agents with a visible warning rather than failing mid-round.
- Scheduler tests: parallel round isolation (no agent sees same-round output), ping-pong ordering and rotation, sealed-round non-leakage — verified by asserting on the *composed context*, not the output.
- Conclave termination: unanimity detected exactly; endorsement expiry on revision; cap produces a failure card. Include a rigged unsatisfiable question that must fail.
- Ledger→synthesis: consensus level computed from positions matches the card's stated level.
- Capability enforcement: a full-local agent cannot touch anything outside the working directory; read-only tier cannot write.
- Persistence: kill the daemon mid-round, restart, transcript intact and the deliberation resumable or cleanly marked interrupted.

**Manual, per sprint**
Run one real research question end to end and read the whole transcript. The acceptance question is not "did it run" but **"did I learn something I wouldn't have learned from one model?"** If sprint 3's four-brain room doesn't beat asking Claude alone, the thesis needs revisiting before building sprints 4–7.

**Sprint-7 acceptance = the brief's central product test**, verbatim: four agents on four *different model families*, deliberation, 5 rounds, parallel, mid-flight steer, tool use, web search, memory recall, result card, and the whole thing searchable afterwards.
