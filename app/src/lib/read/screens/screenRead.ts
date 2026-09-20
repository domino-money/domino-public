/**
 * Every read a screen makes goes through here, and from here through the one
 * shared scheduled source (slice A's scheduler): serial, spaced, coalesced,
 * bounded to 12 distinct pending reads, and cancelled when its last waiter
 * leaves. This adds the one bound the scheduler does not have: a 60 s budget
 * per read that counts time spent queued, so a read stuck behind others is
 * given up rather than left waiting. It retries nothing: `askAgainLater`
 * below only says when a screen may ask again after a busy or transient
 * failure, and the screen asks.
 */
import { realClock, type Clock } from '../pipeline'
import type { ReadOptions, ReadOutcome, ReadRequests, ReadRoute, ReadSource, RouteCheck } from '../types'
import { quietDelayMs, type TransientCandidate } from './transient'

export const SCREEN_BUDGET_MS = 60_000

/** A's outcomes, plus the one state only a screen can end in. */
export type ScreenOutcome<R extends ReadRoute> =
  | ReadOutcome<R>
  /** Distinct from the bridge's 504 `read_deadline_exceeded`: this one never left the browser's budget. */
  | { route: R; state: 'local'; code: 'screen_budget_exceeded' }

export interface WithinOptions {
  signal: AbortSignal
  budgetMs?: number
  clock?: Clock
  /**
   * The caller's own deadline (monotonic ms), when it has one: a pager's
   * automatic restart carries the first attempt's, so the two share one
   * budget. The budget below can only shorten it, never extend it, or a
   * restart near expiry would be granted a fresh 60 s.
   */
  deadlineAt?: number
  onAttempt?: () => void
}

export async function readWithin<R extends ReadRoute>(source: ReadSource, route: R, request: ReadRequests[R], options: WithinOptions): Promise<ScreenOutcome<R>> {
  const { signal, budgetMs = SCREEN_BUDGET_MS, clock = realClock, deadlineAt, onAttempt } = options
  // Whichever comes first: the caller's deadline or this screen's budget.
  const budgetEndsAt = clock.monotonic() + budgetMs
  const endsAt = deadlineAt === undefined ? budgetEndsAt : Math.min(budgetEndsAt, deadlineAt)
  const remaining = endsAt - clock.monotonic()
  // Only the caller's own deadline travels on. This budget is not a deadline
  // for the source: when it is the budget that runs out, the outcome must stay
  // this screen's `screen_budget_exceeded`, worded as time spent queued, not
  // the pipeline's read_deadline. Passing it down would rename it.
  //
  // Already past the caller's: hand it over and let the source answer as a
  // direct read would — unavailable/read_deadline, no transport call — rather
  // than race a zero-length timer and call the result our budget.
  if (remaining <= 0) return source.read(route, request, { signal, deadlineAt, onAttempt })
  const controller = new AbortController()
  const follow = () => controller.abort()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', follow, { once: true })

  let expired = false
  const timer = new AbortController()
  // The clock's sleep is the timer, so tests drive it with a fake clock.
  void clock.sleep(remaining, timer.signal).then(
    () => {
      expired = true
      controller.abort()
    },
    () => undefined,
  )
  try {
    const outcome = await source.read(route, request, { signal: controller.signal, deadlineAt, onAttempt })
    if (expired && outcome.state === 'aborted' && !signal.aborted) return { route, state: 'local', code: 'screen_budget_exceeded' }
    return outcome
  } finally {
    timer.abort()
    signal.removeEventListener('abort', follow)
  }
}

/**
 * The same budget for a consumer that only understands slice A's outcomes
 * (the markets provider): a read that outlasts it comes back as `unavailable`
 * with its own cause, `read_deadline`, worded as a read stopped for taking too
 * long, never as retries used up. Every other outcome passes through as it is.
 */
export function withReadBudget(source: ReadSource, options: { budgetMs?: number; clock?: Clock } = {}): ReadSource {
  const { budgetMs = SCREEN_BUDGET_MS, clock = realClock } = options
  const listed = source.routeEnabled?.bind(source)
  const budgeted: ReadSource = {
    transport: source.transport,
    ...(source.supportsStoredReads ? { supportsStoredReads: true as const } : {}),
    // Whether a route is listed is the source's capabilities answer, not a read: it passes through, unbudgeted.
    ...(listed ? { routeEnabled: (route: ReadRoute, opts?: Pick<ReadOptions, 'signal' | 'deadlineAt'>): Promise<RouteCheck> => listed(route, opts) } : {}),
    async read(route, request, options) {
      const outcome = await readWithin(source, route, request, { signal: options?.signal ?? new AbortController().signal, budgetMs, clock, deadlineAt: options?.deadlineAt, onAttempt: options?.onAttempt })
      if (outcome.state !== 'local') return outcome
      const stopped: ReadOutcome<typeof route> = { route, state: 'unavailable', cause: { kind: 'read_deadline', limit: 'read' }, retryable: true, provenance: { transport: source.transport, contract: null, receivedAt: clock.now(), attempts: 0 } }
      return stopped
    },
  }
  return budgeted
}

/** Outcomes nobody sees: a read the screen itself cancelled. Never rendered, never announced. */
export const isSilent = (outcome: { state: string }) => outcome.state === 'aborted'

// ---------------------------------------------------------------------------
// Asking again quietly
// ---------------------------------------------------------------------------

export { QUIET_ATTEMPTS } from './transient'

/**
 * How long a pool screen waits before asking again on its own, in ms, or
 * null when it does not ask again. Which failures pass, how many times and
 * how long, jitter included, is the one rule in transient.ts that the wallet,
 * token and position screens follow too. Nothing is said while it waits; the
 * figure it would fill shows a dash with the reason in its title.
 */
export function quietRetryDelay(outcome: TransientCandidate, attempt: number, random?: () => number): number | null {
  return quietDelayMs(outcome, attempt, random)
}

/** The page's visibility, as `document` has it; absent outside a browser. */
export interface PageVisibility {
  readonly hidden: boolean
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

const documentVisibility = (): PageVisibility | null => (typeof document === 'undefined' ? null : document)

/**
 * Waits until a failed read may be asked again: its quiet delay, then, while
 * the page is hidden, until it is shown. Resolves true when it is time,
 * false at once when this failure is not asked again, and false when the
 * signal ends the wait. It reads nothing itself. The delay's jitter draws on
 * `random` when given, else on the clock's own, so a test clock decides it.
 */
export async function askAgainLater(
  outcome: TransientCandidate,
  attempt: number,
  signal: AbortSignal,
  { clock = realClock, page = documentVisibility(), random }: { clock?: Clock; page?: PageVisibility | null; random?: () => number } = {},
): Promise<boolean> {
  // A partial test clock may have no random of its own: then Math.random draws.
  const draw = random ?? (typeof clock.random === 'function' ? () => clock.random() : undefined)
  const delay = quietRetryDelay(outcome, attempt, draw)
  if (delay === null || signal.aborted) return false
  try {
    await clock.sleep(delay, signal)
  } catch {
    return false
  }
  if (signal.aborted) return false
  if (!page?.hidden) return true
  return new Promise<boolean>((resolve) => {
    const done = (again: boolean) => {
      page.removeEventListener('visibilitychange', shown)
      signal.removeEventListener('abort', stop)
      resolve(again)
    }
    const shown = () => {
      if (!page.hidden) done(true)
    }
    const stop = () => done(false)
    page.addEventListener('visibilitychange', shown)
    signal.addEventListener('abort', stop, { once: true })
  })
}
