import type { ServerEvent } from './types.ts'

type Listener = (e: ServerEvent) => void

class Bus {
  private listeners = new Set<Listener>()

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit(e: ServerEvent) {
    for (const fn of this.listeners) {
      try { fn(e) } catch { /* a dead socket must not stall a deliberation */ }
    }
  }
}

export const bus = new Bus()
