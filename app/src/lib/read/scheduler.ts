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
 *
 * Two lanes and one priority (added 2026-09-25, r4/metrics). The one-start-a-
 * second rule is the gateway's provider lane only. Where read-v3 is listed,
 * the gateway admits its stored routes (overview, history, search) on a
 * stored lane of four slots with no start interval (backend/read_gateway.py,
 * `ReadGate(stored_capacity=4, stored_interval=0)`), so with `unspacedStored`
 * those reads neither wait for the 1.1 s nor move it on: they wait for the
 * budget and a busy hold only. Before, the six Markets cards' stored history
 * reads went 1.1 s apart for nothing, and the production tail showed them
 * two seconds apart once the budget ran low. And a read asked with
 * `priority: 'first'` starts before every queued read without it, even one
 * already waiting for its turn on the wire: the table's overview no longer
 * waits behind six card histories (it did for eleven seconds on production,
 * 2026-09-25 13:07 UTC).
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

/**
 * The read-v3 routes the gateway admits on its stored lane: four at a time, no start interval. Listed only where
 * read-v3 is enabled, which is where the gateway builds that lane (backend/read_gateway.py).
 */
export const STORED_LANE: ReadonlySet<ReadRoute> = new Set<ReadRoute>(['overview', 'history', 'search'])

export interface SchedulerOptions {
  minIntervalMs?: number
  maxPending?: number
  /** A read's whole budget from the moment it is queued: R-1's 60 s. */
  totalMs?: number
  clock?: Clock
  /** The attempts this tab may send: the gateway's budget unless given. Null: spacing alone. */
  budget?: ReadBudget | null
  /**
   * Stored-lane reads (STORED_LANE) skip `minIntervalMs`: they neither wait for it nor move it on, and keep the
   * budget and a busy hold. Absent or false: every read is spaced, as the development reader (local-live) needs.
   */
  unspacedStored?: boolean
}

interface Job {
  key: string
  run: (signal: AbortSignal) => Promise<ReadOutcome>
  controller: AbortController
  waiters: number
  promise: Promise<ReadOutcome>
  resolve: (outcome: ReadOutcome) => void
  /** Held to the start spacing: a provider-lane read, or any read without `unspacedStored`. */
  spaced: boolean
  /** Asked with `priority: 'first'`. */
  first: boolean
}

export function createScheduledSource(
  source: ReadSource,
  { minIntervalMs = 1100, maxPending = 12, totalMs = BRIDGE_RETRY.totalMs, clock = realClock, budget = GATEWAY_BUDGET, unspacedStored = false }: SchedulerOptions = {},
): ReadSource {
  const queue: Job[] = []
  const byKey = new Map<string, Job>()
  let running = false
  /** The last start of a spaced read. */
  let lastStart = -Infinity
  /** No read starts before this monotonic reading: the Retry-After of the last busy answer. */
  let holdUntil = -Infinity
  /** Ends the wait of a read without priority that is next on the wire, so a read asked first can take its turn. */
  let wake: AbortController | null = null
  /** The read waiting for its turn on the wire, out of the queue while it waits. */
  let napping: Job | null = null

  /** In line: a first read after the first reads already queued, any other read at the end, or at the head of its kind when `back` (a read that gave up its turn). */
  const enqueue = (job: Job, back = false) => {
    const at = job.first || back ? queue.findIndex((queued) => !queued.first) : -1
    if (at === -1) queue.push(job)
    else queue.splice(at, 0, job)
    if (job.first) wake?.abort()
  }

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
        // One wait for all three: the spacing (a spaced read's only), a busy answer's hold, and the budget. Nothing
        // else spends it meanwhile.
        const wait = Math.max(job.spaced ? lastStart + minIntervalMs - now : 0, holdUntil - now, budgetWait())
        if (wait > 0) {
          const nap = new AbortController()
          const stop = () => nap.abort()
          signal.addEventListener('abort', stop, { once: true })
          if (!job.first) wake = nap
          napping = job
          try {
            await clock.sleep(wait, nap.signal)
          } catch {
            // Cancelled by its last reader, or woken for a read asked first.
          } finally {
            signal.removeEventListener('abort', stop)
            if (wake === nap) wake = null
            napping = null
          }
          if (signal.aborted) continue
          if (nap.signal.aborted) {
            // A read asked first arrived while this one waited: it takes the turn, this one goes back to the head of its kind.
            enqueue(job, true)
            continue
          }
        }
        if (job.spaced) lastStart = clock.monotonic()
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
      const first = opts.priority === 'first'
      let job = byKey.get(key)
      if (!job) {
        if (byKey.size >= maxPending) {
          return Promise.resolve({ route, state: 'unavailable', cause: { kind: 'queue_full' }, retryable: true, provenance: provenance() })
        }
        let resolve!: (outcome: ReadOutcome) => void
        const promise = new Promise<ReadOutcome>((done) => {
          resolve = done
        })
        const spaced = !(unspacedStored && STORED_LANE.has(route))
        // Every attempt of the job, an automatic retry included, spends the budget, and a spaced one moves the pace on.
        const onAttempt = () => {
          if (spaced) lastStart = clock.monotonic()
          spend()
        }
        job = { key, run: (signal) => source.read(route, request, { signal, deadlineAt, onAttempt }), controller: new AbortController(), waiters: 0, promise, resolve, spaced, first }
        byKey.set(key, job)
        enqueue(job)
      } else if (first && !job.first) {
        // Joined by a reader asked first while it is still in line: it moves up with that reader. Already waiting for
        // its turn on the wire (out of the queue), it keeps that turn: no later read asked first takes it (fixed
        // 2026-09-25 after review; it used to be woken and sent back behind such a read).
        job.first = true
        const at = queue.indexOf(job)
        if (at !== -1) {
          queue.splice(at, 1)
          enqueue(job)
        } else if (napping === job) wake = null
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
