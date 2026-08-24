import * as db from './db.ts'
import type { Agent } from './types.ts'

/** A room you can actually use on first launch. Nothing here is load-bearing. */
export function seedIfEmpty() {
  if (db.listProjects().length) return

  const project = db.createProject('Research', null)

  const cast: Omit<Agent, 'id' | 'createdAt'>[] = [
    { name: 'Alice', role: 'mathematical analyst', avatarColor: '#5b8def',
      personaKey: 'mathematician', personaExtra: '', brain: 'claude',
      model: 'claude-sonnet-5', tierCeiling: 'research' },
    { name: 'Bruno', role: 'rigorous skeptic', avatarColor: '#e0616f',
      personaKey: 'skeptic', personaExtra: '', brain: 'claude',
      model: 'claude-sonnet-5', tierCeiling: 'research' },
    { name: 'Curie', role: 'experimental scientist', avatarColor: '#3fa87a',
      personaKey: 'experimentalist', personaExtra: '', brain: 'claude',
      model: 'claude-sonnet-5', tierCeiling: 'research' },
    { name: 'Gauss', role: 'formalist', avatarColor: '#9b6dd6',
      personaKey: 'formalist', personaExtra: '', brain: 'claude',
      model: 'claude-sonnet-5', tierCeiling: 'research' },
    { name: 'Noether', role: 'unconventional theorist', avatarColor: '#d68c3f',
      personaKey: 'outsider', personaExtra: '', brain: 'claude',
      model: 'claude-sonnet-5', tierCeiling: 'research' },
  ]

  const agents = cast.map(a => db.createAgent(a))
  db.createRoom(project.id, 'Main room', 'room', agents.slice(0, 4).map(a => a.id))
  for (const a of agents) {
    db.createRoom(project.id, a.name, 'dm', [a.id])
  }
}
