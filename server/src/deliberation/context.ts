/**
 * Context composition (plan §5.3).
 *
 * Roundstorm owns the context and rebuilds it every turn. CLI session state is
 * used only within a turn, never for room history — which is exactly why a
 * brain vendor disappearing costs nothing but a dropdown entry (plan §19.7).
 *
 * Everything assembled here is recorded so the UI can answer "what did Alice
 * see?" for any message.
 */
import type { Agent, Deliberation, Message, Mode, Room } from '../types.ts'
import { personaByKey } from './personas.ts'
import { PROMPT_CONTRACT } from './contract.ts'
import { renderLedger } from './ledger.ts'
import { listMemory, listSources } from '../db.ts'

export const MODE_LABEL: Record<Mode, string> = {
  brainstorm: 'Brainstorm',
  critique: 'Critique',
  deliberation: 'Deliberation',
  consensus: 'Consensus',
  research_plan: 'Research Plan',
  conclave: 'Conclave',
}

export const MODE_BLURB: Record<Mode, string> = {
  brainstorm: 'Maximise useful diversity; avoid premature convergence.',
  critique: 'Try to break the proposal on the table.',
  deliberation: 'Competing approaches, mutual criticism, converge where justified.',
  consensus: 'Seek the strongest shared conclusion; state residual disagreement precisely.',
  research_plan: 'Turn the question into hypotheses, subproblems and experiments.',
  conclave: 'Do not finish until every participant endorses one position.',
}

/** Per-round instruction. Modes differ here, in termination, and in synthesis — nowhere else (plan §7). */
export function modeInstruction(mode: Mode, round: number, totalRounds: number, sealed: boolean): string {
  const opening = sealed && round === 1
  if (opening) {
    return `This is the sealed opening round. You cannot see anyone else's answer, and they cannot see yours.
Commit an independent position on the question. Be specific enough to be wrong.
Do not hedge toward what you imagine the others will say.`
  }

  const closing = round === totalRounds
  const common = closing
    ? `This is the final round. Consolidate: state where you now stand and why, including anything you have conceded.
Do not manufacture agreement to tidy things up — an unresolved disagreement is a legitimate result.`
    : `Engage with what the others actually said. Quote or name the specific claim you are responding to.`

  switch (mode) {
    case 'brainstorm':
      return `${common}
Diverge. Do not restate an idea already on the table — extend it, cross it with another, or open a new line.
Offer at least one option nobody has raised.`
    case 'critique':
      return `${common}
Attack the proposal. Look for counterexamples, hidden assumptions, logical errors, missing evidence, edge cases, failure modes.
Every objection must name what evidence or argument would resolve it.`
    case 'deliberation':
      return `${common}
Advance your position and engage the strongest argument against it.
Revise openly when you have been beaten; say what changed your mind.`
    case 'consensus':
      return `${common}
Look for genuine shared ground and name it precisely. Where you still differ, state the disagreement sharply rather than blurring it.`
    case 'research_plan':
      return `${common}
Convert uncertainty into concrete work: hypotheses, mathematical subproblems, experiments, simulations, literature to check, falsification tests.
Prioritise by what would discriminate fastest between the live possibilities.`
    case 'conclave':
      return `${common}
You are in conclave: the room cannot finish until every participant endorses one position.
Move toward a jointly endorsable statement, but do not endorse something you believe is wrong.`
  }
}

export interface ComposedContext {
  systemPrompt: string
  userPrompt: string
  sections: { name: string; chars: number }[]
}

export function composeContext(args: {
  agent: Agent
  room: Room
  roster: Agent[]
  deliberation: Deliberation
  round: number
  history: Message[]
  steers: Message[]
  schemaEnforced: boolean
  extraInstruction?: string
  mentioned?: boolean
}): ComposedContext {
  const { agent, room, roster, deliberation, round, history, steers, schemaEnforced } = args
  const persona = personaByKey(agent.personaKey)

  const others = roster.filter(a => a.id !== agent.id)
  // A custom persona's contract is whatever the user wrote; a template's is the
  // template plus anything the user added on top.
  const custom = agent.personaKey === 'custom'
  const contract = custom ? agent.personaExtra.trim() : persona.contract
  const extra = custom ? '' : agent.personaExtra.trim()

  const systemParts = [
    `You are ${agent.name}${agent.role ? `, ${agent.role}` : ''}, a researcher in a multi-agent research room.`,
    ``,
    `## Your standing instructions (${custom ? agent.role || 'custom' : persona.label})`,
    contract || 'Reason carefully and say what you actually think.',
    extra ? `\n${extra}` : '',
    ``,
    `## The room`,
    `Room: ${room.name}`,
    `Other participants: ${others.length ? others.map(a => `${a.name} (${personaByKey(a.personaKey).label})`).join(', ') : 'none yet'}`,
    `A human researcher is present and may intervene at any time. Their messages take priority.`,
    ``,
    `## How to behave here`,
    `- You are talking to colleagues, not writing a report. Be direct and concrete.`,
    `- Disagree when you disagree. Agreeing to be agreeable is the failure mode of this format.`,
    `- Say plainly whether something is reasoned, computed, retrieved, or recalled. Never present a guess as evidence.`,
    `- Length: a few tight paragraphs. Nobody reads a wall of text five times per round.`,
    `- Do not restate the question back at the room. Do not summarise the discussion unless asked.`,
  ]
  if (!schemaEnforced) systemParts.push('', PROMPT_CONTRACT)
  const systemPrompt = systemParts.filter(Boolean).join('\n')

  const sections: { name: string; chars: number }[] = []
  const add = (name: string, text: string) => {
    if (text.trim()) sections.push({ name, chars: text.length })
    return text
  }

  const header = add('question', [
    `# Research question`,
    deliberation.question,
    ``,
    `Mode: ${MODE_LABEL[deliberation.mode]} — ${MODE_BLURB[deliberation.mode]}`,
    `Round ${round} of ${deliberation.rounds}. Style: ${deliberation.style === 'parallel' ? 'parallel (everyone answers at once)' : 'ping-pong (sequential)'}.`,
  ].join('\n'))

  const memory = add('memory', renderMemory(agent, room.projectId))
  const ledger = add('ledger', renderLedger(room.id, roster, deliberation.id))
  const sources = add('sources', renderSources(room.id))
  const transcript = add('transcript', renderHistory(history, roster))
  const steerText = add('steer', steers.length
    ? [`# PRIORITY — from the human researcher`,
       ...steers.map(s => s.body.trim()),
       args.mentioned
         ? `They addressed you by name. Answer it directly.`
         : `Address this before anything else. If it names another participant, let them answer it; engage only with the part that bears on your own position.`,
      ].join('\n\n')
    : '')

  const instruction = add('instruction', [
    `# Your turn`,
    args.extraInstruction
      ?? modeInstruction(deliberation.mode, round, deliberation.rounds, deliberation.sealedOpening),
    ``,
    `Reply as ${agent.name}. Write only your own message — never speak for another participant.`,
    // Agents engage by name in prose but skip the reply_to field unless told
    // plainly; without it the transcript is a stack of essays, not a conversation.
    round > 1
      ? `If your message is mainly a response to one specific message above, set "reply_to" to that message's id (shown as [id: ...]). Use "" only when addressing the room as a whole.`
      : '',
    // Agents reliably open a near-duplicate rather than endorsing a peer's
    // position, which fragments the ledger and makes the computed consensus
    // level read as disagreement where there is none. It has to be said
    // bluntly, and only makes sense once a shared ledger actually exists.
    round === 1 && deliberation.sealedOpening
      ? `Record your position in "position_ops": give it a title and use op "assert".`
      : `Record where you stand in "position_ops".
**Before opening a new position, read the ledger above.** If an existing position already says what you mean, endorse it (op "endorse") or sharpen it (op "revise") — do NOT open a near-duplicate under a new title. Two entries for one idea make the record unreadable and misreport the room as more divided than it is.
Open a new position only for a genuinely distinct claim. Use op "oppose" on positions you reject, and say what would change your mind.
If you are abandoning something you argued for earlier, set your stance to "concede" and say what changed your mind. That is a result, not a loss, and it is the single most useful thing a reader can learn from a round.`,
  ].filter(Boolean).join('\n'))

  const userPrompt = [header, memory, ledger, sources, transcript, steerText, instruction]
    .filter(s => s.trim()).join('\n\n---\n\n')

  return { systemPrompt, userPrompt, sections }
}

/** Accepted cards only. Proposals live in the inbox until a human keeps them. */
/**
 * What this agent remembers — from this project.
 *
 * Cards are proposed with `scope: 'project'`, but nothing filtered on it, so an
 * accepted card from any project was injected into every room the agent joined.
 * A conclusion from unrelated work is worse than no memory: it reads as
 * established context and nobody in the room can tell where it came from.
 */
function renderMemory(agent: Agent, projectId: string): string {
  const cards = listMemory({ agentId: agent.id, status: 'accepted', projectId }).slice(0, 25)
  if (!cards.length) return ''
  return ['# What you remember from earlier work', '',
    ...cards.map(c => `- [${c.type}] ${c.text}`)].join('\n')
}

function renderSources(roomId: string): string {
  const sources = listSources(roomId)
  if (!sources.length) return ''
  return ['# Sources gathered in this room',
    'Cite these by label in your claims. Do not mark a claim "sourced" without one.', '',
    ...sources.map(s => `- **${s.label}** ${s.title}${s.url ? ` — ${s.url}` : ''}`)].join('\n')
}

function renderHistory(history: Message[], roster: Agent[]): string {
  if (!history.length) return ''
  const nameOf = (m: Message) =>
    m.authorType === 'human' ? 'Human researcher'
      : roster.find(a => a.id === m.authorId)?.name ?? 'Unknown'

  const lines = ['# Discussion so far', '']
  let lastRound: number | null = null
  for (const m of history) {
    if (m.round !== lastRound && m.round != null) {
      lines.push(`## Round ${m.round}`, '')
      lastRound = m.round
    }
    const reply = m.replyTo ? ` (replying to ${m.replyTo})` : ''
    lines.push(`### ${nameOf(m)} [id: ${m.id}]${reply}`)
    lines.push(m.body.trim())
    if (m.claims.length) {
      lines.push('', 'Claims: ' + m.claims.map(c => `[${c.basis}] ${c.text}`).join(' | '))
    }
    lines.push('')
  }
  return lines.join('\n')
}
