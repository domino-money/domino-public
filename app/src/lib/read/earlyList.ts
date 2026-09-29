/**
 * The reads public/early-list.js sent before the app started (speed wave, item 10, 2026-09-28): the featured pools
 * list and the read-v3 capabilities, taken once each by the app's own first request for them (bridgeSource.ts
 * `first`), within EARLY_LIST_MS of their sending; after that they are let go and the app asks for itself. Each answer
 * goes through the same pipeline as any other: the contract header, the runtime, the deadline and the budget.
 */
export const EARLY_LIST_MS = 5_000

interface Early {
  at: number
  replies: Record<string, Promise<Response> | undefined>
}

/**
 * The early reply for `method path`, once, while it is recent enough; null otherwise. The first ask leaves the slot
 * taken either way, so the script, should it run after the app (a cached app, and this file asked again), sends
 * nothing.
 */
export function takeEarly(path: string, method: string): Promise<Response> | null {
  const holder = globalThis as { __dominoEarly?: Early }
  const early = holder.__dominoEarly
  if (!early || typeof early !== 'object' || typeof early.replies !== 'object' || early.replies === null) {
    holder.__dominoEarly = { at: -Infinity, replies: {} }
    return null
  }
  const key = `${method} ${path}`
  const reply = early.replies[key]
  delete early.replies[key]
  return reply instanceof Promise && typeof early.at === 'number' && performance.now() - early.at < EARLY_LIST_MS ? reply : null
}
