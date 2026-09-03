/**
 * Direct messages (plan §11): one agent, no rounds, plain chat.
 * "Alice, explain your round-3 argument to me slowly" is the single most likely
 * thing a researcher does after reading a transcript, so it gets its own path.
 */
import type { Message, Room } from '../types.ts'
import * as db from '../db.ts'
import { bus } from '../bus.ts'
import { getAdapter, schemaFor } from '../adapters/registry.ts'
import { personaByKey } from './personas.ts'
import { TURN_SCHEMA, coerceTurn, extractJson, stripJsonBlock } from './contract.ts'
import { TURN_TIMEOUT_MS } from './scheduler.ts'

export async function replyInDm(room: Room, trigger: Message) {
  const agent = room.memberIds[0] ? db.getAgent(room.memberIds[0]) : undefined
  if (!agent) return
  const adapter = getAdapter(agent.brain)
  if (!adapter) return

  const persona = personaByKey(agent.personaKey)
  const history = db.listMessages(room.id).slice(-30)

  const custom = agent.personaKey === 'custom'
  const systemPrompt = [
    `You are ${agent.name}${agent.role ? `, ${agent.role}` : ''}.`,
    ``,
    `## Your standing instructions (${custom ? agent.role || 'custom' : persona.label})`,
    custom ? agent.personaExtra.trim() : persona.contract,
    custom ? '' : agent.personaExtra.trim(),
    ``,
    `## Context`,
    `This is a private conversation with the human researcher you work with.`,
    `Talk like a colleague: direct, concrete, no preamble. Disagree when you disagree.`,
    `Be clear about whether something is reasoned, computed, retrieved, or recalled.`,
  ].filter(Boolean).join('\n')

  const userPrompt = [
    history.length > 1 ? '# Conversation so far\n\n' + history.slice(0, -1).map(m =>
      `### ${m.authorType === 'human' ? 'Human' : agent.name} [id: ${m.id}]\n${m.body}`).join('\n\n') : '',
    `# Their message\n\n${trigger.body}`,
  ].filter(Boolean).join('\n\n---\n\n')

  bus.emit({ type: 'activity', roomId: room.id, activity: {
    agentId: agent.id, state: 'thinking', detail: 'Thinking', round: null, startedAt: Date.now() } })

  db.logEvent('turn.started', {
    roomId: room.id, agentId: agent.id,
    payload: { dm: true, brain: agent.brain, model: agent.model, systemPrompt, userPrompt },
  })

  // The scheduler gives every turn a deadline; a DM had none. A brain that hung
  // left the generator awaiting forever and the agent stuck on "Thinking", with
  // no way to clear it short of restarting the daemon.
  const controller = new AbortController()
  let timedOut = false
  const deadline = setTimeout(() => { timedOut = true; controller.abort() }, TURN_TIMEOUT_MS)

  let text = '', structured: unknown = null, costUsd: number | undefined, err: string | null = null

  try {
    for await (const ev of adapter.run({
      systemPrompt, userPrompt, model: agent.model, tier: room.tier,
      workingDir: null, schema: schemaFor(adapter, TURN_SCHEMA),
    }, controller.signal)) {
      if (ev.type === 'activity') emitActivity(room.id, agent.id, 'thinking', ev.text)
      else if (ev.type === 'tool') emitActivity(room.id, agent.id, 'tool', ev.detail ?? ev.name)
      else if (ev.type === 'delta') { text = ev.text; emitActivity(room.id, agent.id, 'writing', 'Writing') }
      else if (ev.type === 'final') { structured = ev.structured; if (ev.text) text = ev.text; costUsd = ev.costUsd }
      else if (ev.type === 'error') err = ev.message
    }
  } catch (e) {
    err = String(e)
  } finally {
    clearTimeout(deadline)
  }
  if (timedOut) err = `no reply within ${Math.round(TURN_TIMEOUT_MS / 1000)}s`

  emitActivity(room.id, agent.id, 'idle', '')

  if (err && !structured && !text) {
    const m = db.insertMessage({
      roomId: room.id, authorType: 'system', authorId: agent.id,
      body: `${agent.name} could not reply: ${err.slice(0, 300)}`,
    })
    db.logEvent('turn.failed', { roomId: room.id, agentId: agent.id, payload: { error: err } })
    bus.emit({ type: 'message', message: m })
    return
  }

  // `api.ts` calls this with `void`, so anything thrown from here on was an
  // unhandled rejection — which, with no process handler, ended the daemon.
  try {
  const parsed = coerceTurn(structured ?? extractJson(text), stripJsonBlock(text))
  const message = db.insertMessage({
    roomId: room.id, authorType: 'agent', authorId: agent.id,
    body: parsed.turn.body, stance: parsed.turn.stance, claims: parsed.turn.claims,
    degraded: parsed.degraded, brain: agent.brain, model: agent.model, costUsd,
    raw: JSON.stringify({ structured, text }).slice(0, 200_000),
  })
  db.logEvent('turn.completed', {
    roomId: room.id, agentId: agent.id,
    payload: { messageId: message.id, degraded: parsed.degraded, costUsd },
  })
  bus.emit({ type: 'message', message })
  } catch (e) {
    db.logEvent('turn.failed', { roomId: room.id, agentId: agent.id, payload: { error: String(e) } })
  }
}

function emitActivity(roomId: string, agentId: string, state: any, detail: string) {
  bus.emit({ type: 'activity', roomId, activity: { agentId, state, detail, round: null, startedAt: Date.now() } })
}
