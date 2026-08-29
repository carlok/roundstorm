import { useState } from 'react'

type Section = 'start' | 'modes' | 'rounds' | 'reading' | 'access' | 'clearing' | 'backup' | 'experiments' | 'keys'

/**
 * The in-app manual.
 *
 * Six modes and two discussion styles are not self-explanatory from a dropdown
 * blurb — Conclave in particular behaves unlike anything else here and is the
 * one worth understanding before spending money on it. Everything below
 * describes what the system actually does, including where it will disappoint.
 */
export function Manual({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Section>('start')

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <div className="manual" onMouseDown={e => e.stopPropagation()}>
        <div className="manual-head">
          <h2>How Roundstorm works</h2>
          <button className="linkish" onClick={onClose}>Close</button>
        </div>

        <div className="manual-body">
          <nav className="manual-nav">
            {([
              ['start', 'Getting started'],
              ['modes', 'The six modes'],
              ['rounds', 'Rounds & styles'],
              ['reading', 'Reading a discussion'],
              ['access', 'What agents may do'],
              ['clearing', 'Clearing a room'],
              ['backup', 'Backing up'],
              ['experiments', 'Experiment files'],
              ['keys', 'Shortcuts'],
            ] as [Section, string][]).map(([k, label]) => (
              <button key={k} className={tab === k ? 'sel' : ''} onClick={() => setTab(k)}>
                {label}
              </button>
            ))}
          </nav>

          <div className="manual-content">
            {tab === 'start' && <Start />}
            {tab === 'modes' && <Modes />}
            {tab === 'rounds' && <Rounds />}
            {tab === 'reading' && <Reading />}
            {tab === 'access' && <Access />}
            {tab === 'clearing' && <Clearing />}
            {tab === 'backup' && <Backup />}
            {tab === 'experiments' && <Experiments />}
            {tab === 'keys' && <Keys />}
          </div>
        </div>
      </div>
    </div>
  )
}

const Start = () => (
  <>
    <h3>The idea</h3>
    <p>
      You write one hard question. Several AI researchers argue about it for a set
      number of rounds while you watch. You never copy anything between them.
    </p>

    <h3>Four words</h3>
    <dl className="manual-dl">
      <dt>Agent</dt><dd>A named researcher with a persona and a memory. Alice, Bruno, Curie.</dd>
      <dt>Brain</dt><dd>The model behind it. Swapping Alice from Claude to Gemini is a settings change, not a new colleague.</dd>
      <dt>Room</dt><dd>A conversation with a cast. Agents outlive rooms; transcripts do not travel.</dd>
      <dt>Deliberation</dt><dd>A bounded job inside a room: N rounds, one mode, one result.</dd>
    </dl>

    <h3>A first run</h3>
    <ol>
      <li>Open a room and type your question in the composer.</li>
      <li>Click <b>Deliberate…</b>, keep the defaults, press Start.</li>
      <li>Watch the control bar. Round&nbsp;1 is sealed, so nothing appears until everyone has committed.</li>
      <li>Read the result card pinned at the end.</li>
    </ol>

    <div className="manual-note">
      <b>Ask something with two defensible answers.</b> This is the single thing that
      decides whether a run is worth the money. Given a question with an obvious
      answer, all the agents agree in round&nbsp;1 and you learn nothing — the
      transcript still looks busy, which makes it easy to miss.
    </div>

    <div className="manual-note warn">
      <b>Cost.</b> Each turn is a real model call. Four agents over three rounds is
      twelve calls. On Haiku that is a few cents; on Opus it is dollars. Click any
      agent to change its brain — LM&nbsp;Studio runs locally and costs nothing.
    </div>
  </>
)

const Modes = () => (
  <>
    <p className="manual-lede">
      Modes differ in three things: what each round asks for, when it stops, and
      what the final report emphasises. Nothing else changes.
    </p>

    <Mode name="Deliberation" tag="the default">
      Each agent advances its position and engages the strongest argument against
      it, revising when beaten. Use this when you want the best answer to a
      contested question.
    </Mode>

    <Mode name="Brainstorm">
      Diverge deliberately. Agents are penalised for restating an idea already on
      the table and asked for options nobody raised. Use it early, when you want
      the space of possibilities rather than a verdict.
    </Mode>

    <Mode name="Critique">
      Attack a proposal. Counterexamples, hidden assumptions, failure modes — and
      every objection must name what would resolve it. Put the proposal in the
      question and let them try to break it.
    </Mode>

    <Mode name="Consensus">
      Find genuine shared ground and state the residual disagreement sharply
      rather than blurring it. Unlike Conclave, it will not force agreement.
    </Mode>

    <Mode name="Research Plan">
      Turn uncertainty into work: hypotheses, subproblems, experiments,
      falsification tests, prioritised by what discriminates fastest.
    </Mode>

    <Mode name="Conclave" tag="the unusual one">
      <p>
        The room cannot finish until <b>every</b> participant endorses one single
        position. It runs a real negotiation rather than a discussion:
      </p>
      <ul>
        <li>A rotating <b>chair</b> drafts, then revises, the proposal.</li>
        <li>A rotating <b>devil's seat</b> is <i>required</i> to attack the current
            draft and may not pass. Its duty is to attack, not to dissent — if its
            own best objection fails, it may endorse.</li>
        <li>Endorsing costs something: you must restate the proposal in your own
            words <i>and</i> name the concession you made. "Agreed" does not count.</li>
        <li>Revising the proposal <b>invalidates every endorsement</b> collected
            against the old version. Stale yeses cannot accumulate.</li>
      </ul>
      <p>
        The round count you set is an <b>emergency maximum</b>, not a target. If
        unanimity is not reached it reports <i>"Conclave failed to reach
        consensus"</i>, names who held out, and shows the last proposal. That is a
        real result, not an error.
      </p>
      <p className="manual-aside">
        Use it when you want one answer you can act on — "give me the single
        architecture you all agree is best". Expect it to cost more than
        Deliberation, because negotiating takes rounds.
      </p>
    </Mode>
  </>
)

const Mode = ({ name, tag, children }: { name: string; tag?: string; children: React.ReactNode }) => (
  <div className="manual-mode">
    <h3>{name}{tag && <span className="manual-tag">{tag}</span>}</h3>
    {typeof children === 'string' ? <p>{children}</p> : children}
  </div>
)

const Rounds = () => (
  <>
    <h3>Parallel <span className="manual-tag">default</span></h3>
    <p>
      Everyone answers at once from the same starting point — everything through
      the previous round, nothing from the current one. Faster, and it keeps them
      independent rather than letting the first speaker set the frame.
    </p>

    <h3>Ping-pong</h3>
    <p>
      They speak in sequence and can react within the round, so arguments chain
      more deeply. Slower. Speaking order rotates each round, because the last
      speaker gets a free rebuttal nobody can answer.
    </p>

    <h3>Sealed opening round</h3>
    <p>
      On by default. In round 1 nobody can see anyone else's answer; all are
      revealed together once everyone has committed. This stops the room
      converging on whoever happened to write first, and the spread of opening
      positions is often the most informative moment of a run.
    </p>

    <h3>Steering a run</h3>
    <ul>
      <li>Type while it is running. Your message goes to the top of the next round for everyone.</li>
      <li><code>@Bruno</code> scopes it — others see it but are told to let Bruno answer.</li>
      <li><b>+1 round</b> mid-flight when it is getting somewhere.</li>
      <li><b>Interrupt now</b> discards the turns in flight and restarts the round with your steer. You lose the tokens already spent.</li>
    </ul>
  </>
)

const Reading = () => (
  <>
    <h3>Basis chips</h3>
    <p>Under each message, what kind of thing it is:</p>
    <dl className="manual-dl">
      <dt>reasoned</dt><dd>The agent derived it.</dd>
      <dt>computed</dt><dd>It ran something.</dd>
      <dt>sourced</dt><dd>It retrieved a source. A claim marked sourced with no reference is automatically downgraded to reasoned, so this label cannot be used to dress up a guess.</dd>
      <dt>recalled</dt><dd>From memory of earlier work.</dd>
    </dl>

    <h3>Positions</h3>
    <p>
      The right-hand panel shows every named position and who asserts, endorses or
      opposes it. The agreement level in the result card is <b>computed from this
      record</b>, then narrated — not the other way round. That is what stops a
      tidy-sounding summary being written over a room that was actually split.
    </p>
    <p className="manual-aside">
      Agents tend to restate a colleague's position under a new title instead of
      endorsing it. When a local embedding model is running, near-duplicates are
      merged automatically and the merge is logged with its similarity score.
    </p>

    <h3>The result card</h3>
    <p>
      Pinned at the end: conclusion, the reasoning that survived, common ground,
      remaining disagreement, evidence, unknowns, next steps. <i>"Two competing
      positions remain"</i> and <i>"No reliable conclusion"</i> are legitimate
      outcomes, not failures.
    </p>

    <h3>Unstructured</h3>
    <p>
      A grey <code>unstructured</code> chip means the agent's reply could not be
      parsed into claims. The message is still shown in full; only the ledger is
      thinner for it.
    </p>
  </>
)

const Access = () => (
  <>
    <p className="manual-lede">
      Set per room, and capped by each agent's own ceiling. Visible in the room
      header at all times.
    </p>
    <dl className="manual-dl">
      <dt>🔒 Reasoning only</dt><dd>No tools, no network, no files.</dd>
      <dt>🌐 Research tools</dt><dd>Web search and fetch. No local writes. The sensible default for research questions.</dd>
      <dt>📖 Workstation</dt><dd>Also reads files in a chosen directory.</dd>
      <dt>⚠️ Full local</dt><dd>Also writes files and runs programs, inside that directory.</dd>
    </dl>
    <div className="manual-note warn">
      <b>One honest caveat.</b> These map onto each CLI's real sandbox flags, but
      the CLIs differ in how strictly they enforce them. Cursor Agent's read-only
      guarantee is a mode rather than a kernel sandbox, so treat its lower tiers as
      advisory and do not point it at a directory you would mind it touching.
    </div>
  </>
)

const Clearing = () => (
  <>
    <h3>Clear room</h3>
    <p>
      In a room's <code>⋯</code> menu. Removes everything that room produced: the
      messages, the positions ledger, sources, result cards, its search index, and
      the memory cards derived from it — <b>including ones you already accepted
      into an agent's long-term memory</b>. The room and its cast survive.
    </p>
    <p className="manual-aside">
      That last part matters: leaving accepted cards behind would mean an agent
      still remembers a discussion you believe you erased, and carries it quietly
      into the next one.
    </p>
    <h3>Delete room</h3>
    <p>The same, and the room goes too.</p>
    <p>Neither is undoable, and both refuse while a deliberation is running.</p>
  </>
)

const Backup = () => (
  <>
    <h3>Back up everything</h3>
    <p>
      In <b>Inspector → Activity</b>, or <code>⌘K → Back up everything</code>. One SQLite
      file with every room, transcript, positions ledger, source, memory card and log
      entry, written to your Downloads folder — the app tells you the exact path.
    </p>
    <p className="manual-aside">
      Saved directly rather than served as a download: a WKWebView does not handle
      content-disposition the way a browser does, and following such a link can
      navigate the app away from its own interface. Scripts can still
      <code>GET /api/backup</code> for the bytes.
    </p>
    <p>
      To restore, quit the app and put the file back as
      <code>~/Library/Application Support/Roundstorm/roundstorm.db</code>.
    </p>
    <h3>Why not just copy the file?</h3>
    <p>
      Because it does not work. SQLite runs in WAL mode here, so recent writes live
      in a separate <code>-wal</code> file that is routinely larger than the database
      itself. Copying only the <code>.db</code> gives you something that opens cleanly
      and is quietly missing your recent work.
    </p>
    <p className="manual-aside">
      Measured: three messages written, then the proper snapshot had all three while
      a plain copy of the same live database had no tables at all.
    </p>
  </>
)

const Experiments = () => (
  <>
    <h3>One file, three places</h3>
    <p>
      A run can be written down: the cast, their personas and brains, the question,
      the mode and the rounds, in one JSONC file. Comments are allowed.
    </p>
    <ul>
      <li>Headless — <code>node dist-server/cli.mjs experiment.jsonc</code></li>
      <li>Here — <code>⤓</code> next to <b>Rooms</b>, or <code>⌘K → Load an experiment file</code></li>
      <li>Over HTTP — <code>POST /api/experiments</code></li>
    </ul>
    <h3>Loading one does not start it</h3>
    <p>
      It creates the cast and the room, prefills the question, and stops. A run
      costs money, so pressing <b>Deliberate</b> stays yours. A file with a mistake is
      refused with the field named — <code>agents[0].brain is required</code> — before
      anything is created.
    </p>
    <p className="manual-aside">
      A <code>.jsonl</code> file holds one experiment per line: the persona-lab
      comparison, run without the interface.
    </p>
  </>
)

const Keys = () => (
  <dl className="manual-dl keys">
    <dt>⌘K</dt><dd>Command palette — rooms, agents, actions</dd>
    <dt>⌘F</dt><dd>Search this room</dd>
    <dt>⇧⌘F</dt><dd>Search every room, by meaning as well as by word</dd>
    <dt>⏎</dt><dd>Send</dd>
    <dt>⇧⏎</dt><dd>Newline</dd>
    <dt>↩ on a message</dt><dd>Reply to it</dd>
    <dt>Right-click</dt><dd>On a message: copy, quote, take to a side room. On a room or agent: rename, configure, delete.</dd>
    <dt>Select text</dt><dd>Quote it, copy it, or ask about it</dd>
    <dt>⌘C on an equation</dt><dd>Copies the LaTeX source, not the rendered glyphs</dd>
  </dl>
)
