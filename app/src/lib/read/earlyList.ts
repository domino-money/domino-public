/**
 * The reads the page's boot script sent before the app started (speed wave, item 10, 2026-09-28; a file of its own,
 * public/early-list.js, until 2026-10-01, inline since: functions/_lib/boot.ts): the featured pools
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
 *
 * Since 2026-10-01 (audit A7 b) the script also asks the stored overview of the list's pools the moment the list
 * answers, under `method path body`: it is taken only by a request with that very body (the same pools in the same
 * order), so an answer to another question is never taken for this one.
 */
export function takeEarly(path: string, method: string, body?: string): Promise<Response> | null {
  const holder = globalThis as { __dominoEarly?: Early }
  const early = holder.__dominoEarly
  if (!early || typeof early !== 'object' || typeof early.replies !== 'object' || early.replies === null) {
    holder.__dominoEarly = { at: -Infinity, replies: {} }
    return null
  }
  const exact = body === undefined ? null : `${method} ${path} ${body}`
  const key = exact !== null && early.replies[exact] !== undefined ? exact : `${method} ${path}`
  const reply = early.replies[key]
  delete early.replies[key]
  return reply instanceof Promise && typeof early.at === 'number' && performance.now() - early.at < EARLY_LIST_MS ? reply : null
}
