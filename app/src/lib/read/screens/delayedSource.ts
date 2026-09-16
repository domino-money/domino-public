/**
 * A read source that answers late, or never, and records what it was asked.
 *
 * For the read lab and the node tests only: they need a read that is still in
 * flight when someone navigates away, changes the IDs or hides the section.
 * The delay happens inside the read itself, so the scheduler sees it as a
 * running read, and an abort ends it at once with `aborted`. Never imported by
 * an app screen.
 */
import { realClock, type Clock } from '../pipeline'
import type { ReadOptions, ReadOutcome, ReadRequests, ReadRoute, ReadSource, RouteCheck } from '../types'

export interface Delay {
  delayMs?: number
  /** Never answers; only an abort ends it. */
  hang?: boolean
}

export interface LoggedRead {
  route: ReadRoute
  request: unknown
  /** Clock time the read started. */
  at: number
  /** Set when an abort ended it before it answered. */
  aborted?: boolean
}

export interface DelayedSource extends ReadSource {
  readonly log: LoggedRead[]
}

export function withDelays(inner: ReadSource, plan: (route: ReadRoute, request: unknown, n: number) => Delay | undefined, clock: Clock = realClock): DelayedSource {
  const log: LoggedRead[] = []
  const counts = new Map<ReadRoute, number>()
  const listed = inner.routeEnabled?.bind(inner)
  return {
    transport: inner.transport,
    log,
    // Whether a route is listed is the inner source's capabilities answer, not a read: never delayed, never logged.
    ...(listed ? { routeEnabled: (route: ReadRoute, options?: Pick<ReadOptions, 'signal' | 'deadlineAt'>): Promise<RouteCheck> => listed(route, options) } : {}),
    async read<R extends ReadRoute>(route: R, request: ReadRequests[R], options: { signal?: AbortSignal } = {}): Promise<ReadOutcome<R>> {
      const n = counts.get(route) ?? 0
      counts.set(route, n + 1)
      const entry: LoggedRead = { route, request: JSON.parse(JSON.stringify(request)), at: clock.now() }
      log.push(entry)
      const delay = plan(route, request, n)
      const aborted = (): ReadOutcome<R> => {
        entry.aborted = true
        return { route, state: 'aborted', provenance: { transport: inner.transport, contract: null, receivedAt: clock.now(), attempts: 0 } }
      }
      if (delay?.hang) {
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve()
          options.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        return aborted()
      }
      if (delay?.delayMs) {
        try {
          await clock.sleep(delay.delayMs, options.signal)
        } catch {
          return aborted()
        }
      }
      if (options.signal?.aborted) return aborted()
      return inner.read(route, request, options)
    },
  }
}
