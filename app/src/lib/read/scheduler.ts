/**
 * Paces one screen's reads the way the bridge admits them.
 *
 * The bridge runs one operation at a time, starts at most one per second, has
 * no waiting queue, and gives each IP 30 reads a minute with a burst of five
 * (docs/API_READ_BRIDGE.md). A table that fired all its reads at once would
 * mostly get 429s back. So reads from one screen go through one serial queue:
 * at least 1.1 s between starts, at most 12 distinct reads queued or running,
 * an identical read sharing the request already queued or in flight, and a
 * read nobody waits for any more cancelled.
 *
 * The queue also keeps the gateway's per-client budget for this tab: a burst
 * of five, then one more read every two seconds (30 a minute). Every attempt
 * on the wire takes one, an automatic retry included, so the queue waits for
 * the budget the way the gateway counts it instead of drawing its 429, with
 * a quarter of a read kept in hand for requests that meet less transit delay
 * than the one before them. And
 * after a read comes back busy, the whole queue holds for the Retry-After
 * that answer asked for, plus up to R-1's 250 ms of jitter: the next read,
 * whichever it is, is not sent into a service that has just said it is full.
 *
 * R-1's 60 s for a read start here, when it is queued, so they cover the time
 * it waits in line; the source is handed what is left. They and the 1.1 s
 * between starts are measured on the monotonic clock (pipeline.ts), so a step
 * of the wall clock neither stalls the queue nor rushes it. A reader settles on
 * its own, at its abort or its deadline, queued or running, without cancelling
 * the read for anyone else who waits for it. The last one to leave cancels
 * the read and frees the queue at once, even from a source that ignores the
 * cancellation.
 *
 * A reader that joins an identical read is held to that read's deadline, its
 * first reader's, not to 60 s from its own enqueue. The first reader was
 * queued no later, so that deadline is never more than 60 s after the
 * joiner's enqueue either: a joiner can be stopped early, never kept late.
 *
 * This mirrors the pacing of the package's progressive.mjs. Its 429 retries
 * are pipeline.ts's, inside a job: the queue waits with them, and the next
 * read is paced from the job's last attempt, not its first. It does not import
 * progressive.mjs, which checks the contract header before the gate and would
 * turn a gate 401 into a contract mismatch.
 */
import { BRIDGE_RETRY, realClock, settleBy, type Clock } from './pipeline'
import type { Provenance, ReadOptions, ReadOutcome, ReadRequests, ReadRoute, ReadSource, RouteCheck } from './types'

/** A per-client budget: `burst` attempts at once, then `perMinute` a minute. */
export interface ReadBudget {
  burst: number
  perMinute: number
}

/** The gateway's per-client budget (backend ClientBudgets), which this tab keeps for itself. */
export const GATEWAY_BUDGET: ReadBudget = { burst: 5, perMinute: 30 }
/** Of an attempt, what the queue keeps in hand beyond the one it spends: 500 ms at 30 a minute, for transit jitter. */
export const BUDGET_RESERVE = 0.25

export interface SchedulerOptions {
  minIntervalMs?: number
  maxPending?: number
  /** A read's whole budget from the moment it is queued: R-1's 60 s. */
  totalMs?: number
  clock?: Clock
  /** The attempts this tab may send: the gateway's budget unless given. Null: spacing alone. */
  budget?: ReadBudget | null
}

interface Job {
  key: string
  run: (signal: AbortSignal) => Promise<ReadOutcome>
  controller: AbortController
  waiters: number
  promise: Promise<ReadOutcome>
  resolve: (outcome: ReadOutcome) => void
}

export function createScheduledSource(
  source: ReadSource,
  { minIntervalMs = 1100, maxPending = 12, totalMs = BRIDGE_RETRY.totalMs, clock = realClock, budget = GATEWAY_BUDGET }: SchedulerOptions = {},
): ReadSource {
  const queue: Job[] = []
  const byKey = new Map<string, Job>()
  let running = false
  let lastStart = -Infinity
  /** No read starts before this monotonic reading: the Retry-After of the last busy answer. */
  let holdUntil = -Infinity

  // The per-client budget, on the monotonic clock: tokens refill at `perMinute` a minute up to `burst`.
  const perMs = budget ? budget.perMinute / 60_000 : 0
  let tokens = budget ? budget.burst : Infinity
  let filledAt = clock.monotonic()
  const refill = () => {
    if (!budget) return
    const at = clock.monotonic()
    tokens = Math.min(budget.burst, tokens + Math.max(0, at - filledAt) * perMs)
    filledAt = at
  }
  /**
   * Ms until an attempt is in the budget, with a quarter of one more in hand; 0 when it is there now. The
   * gateway counts an attempt when it arrives, and transit is not the same for every request: without the
   * quarter, a request that met less delay than the one before it would arrive a moment early and draw the
   * 429 this budget is here to avoid. The burst and the rate are the gateway's. A retry may have spent past zero.
   */
  const budgetWait = () => {
    if (!budget) return 0
    refill()
    const wanted = 1 + BUDGET_RESERVE
    // A thousandth of a millisecond forgiven, so the float sums of refilling never add a whole millisecond.
    return tokens >= wanted - 1e-9 ? 0 : Math.ceil((wanted - tokens) / perMs - 1e-3)
  }
  const spend = () => {
    if (!budget) return
    refill()
    tokens -= 1
  }

  async function drain() {
    if (running) return
    running = true
    try {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const { signal } = job.controller
        if (signal.aborted) continue
        const now = clock.monotonic()
        // One wait for all three: the spacing, a busy answer's hold, and the budget. Nothing else spends it meanwhile.
        const wait = Math.max(lastStart + minIntervalMs - now, holdUntil - now, budgetWait())
        if (wait > 0) {
          try {
            await clock.sleep(wait, signal)
          } catch {
            continue
          }
        }
        lastStart = clock.monotonic()
        // Registered until it settles, so an identical read joins it in flight. Let go
        // of as soon as nobody waits: a source that ignores the abort cannot hold the queue.
        const settled = await settleBy(clock, job.run(signal), Infinity, signal)
        if (byKey.get(job.key) === job) byKey.delete(job.key)
        if (settled.kind !== 'done') continue
        // Busy after R-1, or with a wait its read could not afford: the whole queue waits what the service asked.
        const outcome = settled.value
        if (outcome.state === 'busy') {
          holdUntil = Math.max(holdUntil, clock.monotonic() + outcome.retryAfterSeconds * 1000 + Math.floor(clock.random() * BRIDGE_RETRY.jitterMs))
        }
        job.resolve(outcome)
      }
    } finally {
      running = false
    }
  }

  /** A reader stops waiting. The last one cancels the read and takes it off the count. */
  function leave(job: Job, outcome: ReadOutcome) {
    job.waiters -= 1
    if (job.waiters > 0) return
    job.controller.abort()
    // A later identical read starts afresh instead of joining a cancelled one.
    if (byKey.get(job.key) === job) byKey.delete(job.key)
    job.resolve(outcome)
  }

  const inner = source.routeEnabled?.bind(source)
  return {
    transport: source.transport,
    ...(source.supportsStoredReads ? { supportsStoredReads: true as const } : {}),
    // Whether a route is listed is the source's own capabilities answer, never a job: it takes no place in
    // the queue and moves no pacing, so a screen can skip a route that is off without waiting a turn for it.
    ...(inner ? { routeEnabled: (route: ReadRoute, opts?: Pick<ReadOptions, 'signal' | 'deadlineAt'>): Promise<RouteCheck> => inner(route, opts) } : {}),
    read<R extends ReadRoute>(route: R, request: ReadRequests[R], opts: ReadOptions = {}): Promise<ReadOutcome<R>> {
      // The budget runs from here. A restart keeps what is left of the read it restarts.
      const deadlineAt = Math.min(opts.deadlineAt ?? Infinity, clock.monotonic() + totalMs)
      const provenance = (): Provenance => ({ transport: source.transport, contract: null, receivedAt: clock.now(), receivedMonotonic: clock.monotonic(), attempts: 0, deadlineAt })
      const aborted = (): ReadOutcome<R> => ({ route, state: 'aborted', provenance: provenance() })
      const expired = (): ReadOutcome<R> => ({ route, state: 'unavailable', cause: { kind: 'read_deadline', limit: 'read' }, retryable: true, provenance: provenance() })
      if (opts.signal?.aborted) return Promise.resolve(aborted())
      if (clock.monotonic() >= deadlineAt) return Promise.resolve(expired())

      const key = `${route}\u0000${JSON.stringify(request)}`
      let job = byKey.get(key)
      if (!job) {
        if (byKey.size >= maxPending) {
          return Promise.resolve({ route, state: 'unavailable', cause: { kind: 'queue_full' }, retryable: true, provenance: provenance() })
        }
        let resolve!: (outcome: ReadOutcome) => void
        const promise = new Promise<ReadOutcome>((done) => {
          resolve = done
        })
        // Every attempt of the job, an automatic retry included, moves the pace on and spends the budget.
        const onAttempt = () => {
          lastStart = clock.monotonic()
          spend()
        }
        job = { key, run: (signal) => source.read(route, request, { signal, deadlineAt, onAttempt }), controller: new AbortController(), waiters: 0, promise, resolve }
        byKey.set(key, job)
        queue.push(job)
      }

      const shared = job
      shared.waiters += 1
      const answer = settleBy(clock, shared.promise, deadlineAt, opts.signal).then((settled): ReadOutcome<R> => {
        if (settled.kind === 'done') return settled.value as ReadOutcome<R>
        // This reader alone stops waiting; the read goes on for anyone else.
        const outcome = settled.kind === 'aborted' ? aborted() : expired()
        leave(shared, outcome)
        return outcome
      })
      void drain()
      return answer
    },
  }
}
