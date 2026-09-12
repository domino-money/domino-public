/**
 * Every read a screen makes goes through here, and from here through the one
 * shared scheduled source (slice A's scheduler): serial, spaced, coalesced,
 * bounded to 12 distinct pending reads, and cancelled when its last waiter
 * leaves. This adds the one bound the scheduler does not have: a 60 s budget
 * per read that counts time spent queued, so a read stuck behind others is
 * given up rather than left waiting. It retries nothing.
 */
import { realClock, type Clock } from '../pipeline'
import type { ReadOutcome, ReadRequests, ReadRoute, ReadSource } from '../types'

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
  const budgeted: ReadSource = {
    transport: source.transport,
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
