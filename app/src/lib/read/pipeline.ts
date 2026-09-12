/**
 * The read loop both sources share: ask, interpret, and ask again only when
 * the bridge said it is busy and the read can afford the wait.
 *
 * This is R-1, rugged97's policy on #1, for every logical read:
 *
 *   - three attempts at most, the first included;
 *   - only a validated 429 `read_capacity_busy` is asked again on its own,
 *     after the bridge's bounded Retry-After (1 to 60 s, otherwise 1) plus up
 *     to 250 ms of jitter, and only while the read's budget covers that wait.
 *     Past that, the busy answer is shown, with the wait it asked for;
 *   - a transient 503 or 504, rc.3's gas and revert codes included, stays a
 *     state of its own that a person may retry. The pipeline never does;
 *   - nor does it ask again after a transport failure, whose effect at the
 *     bridge is unknown, an incompatible or invalid payload, an answer to
 *     another question, an access refusal, or any other status;
 *   - a read has 60 s from enqueue (scheduler.ts), which cover the queue, the
 *     capabilities wait, every attempt and wait, and one cursor or revision
 *     restart (pagers.ts); each attempt, fetch and body, has 20 s or what is
 *     left of those 60 s, whichever is shorter. At either deadline the attempt
 *     is aborted, and an answer that arrives anyway is discarded.
 *
 * Every one of those times is kept on the monotonic clock (`Clock.monotonic`,
 * performance.now() in the browser), never on the wall clock: an NTP step, a
 * change to the system time or a resume from sleep can move Date.now() any
 * distance either way, and would cut a read short or let a late answer in.
 * The wall clock only stamps when a reply was received.
 *
 * Cursor and revision recovery is the pagers' single fresh-page restart, not
 * a retry. The package's progressive.mjs asks again on the same terms.
 */
import { interpretReply } from './interpret'
import type { RawReply, ReadKey, ReadOutcome, ReadValidators, RequestOf } from './types'

export interface RetryPolicy {
  /** Attempts per logical read, the first included. */
  maxAttempts: number
  /** Up to this many ms added to a Retry-After, so readers told the same wait do not all return at once. */
  jitterMs: number
  /** One HTTP attempt, from the request to the last byte of its body. */
  attemptMs: number
  /** The logical read's whole budget, from enqueue. A retry whose wait it cannot cover is not made. */
  totalMs: number
}

/** R-1: three attempts, a validated 429 the only one asked again, 20 s an attempt, 60 s a read. */
export const BRIDGE_RETRY: RetryPolicy = { maxAttempts: 3, jitterMs: 250, attemptMs: 20_000, totalMs: 60_000 }

export interface Clock {
  /** Wall-clock ms, Date.now(): the time of day, to stamp when something was received. It can step either way, so it never measures a wait. */
  now: () => number
  /**
   * Ms on a clock that only moves forward, whatever the wall clock does:
   * performance.now() in the browser, the clock its timers run on. Every
   * deadline, attempt bound, Retry-After wait and pacing interval is measured
   * on it. Its readings mean nothing outside this page, so none is shown.
   */
  monotonic: () => number
  /** Resolves after `ms`, or rejects as soon as `signal` aborts. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  random: () => number
  /** Calls `fire` once `ms` have passed, unless the function it returns is called first. */
  timer: (ms: number, fire: () => void) => () => void
}

export const realClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(timer)
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    }),
  random: () => Math.random(),
  timer: (ms, fire) => {
    const handle = setTimeout(fire, ms)
    return () => clearTimeout(handle)
  },
}

export type Settled<T> = { kind: 'done'; value: T } | { kind: 'aborted' } | { kind: 'deadline' }

/**
 * `work`'s value, unless `signal` aborts or the clock reaches `endsAt` first,
 * whichever comes first. A value that arrives at `endsAt` or later is late and
 * dropped, whether or not the timer got to fire: a timer can lag, the clock
 * cannot. `endsAt` is a `clock.monotonic()` reading. `work` itself is not
 * stopped here; whoever owns it aborts it.
 */
export function settleBy<T>(clock: Clock, work: Promise<T>, endsAt: number, signal?: AbortSignal): Promise<Settled<T>> {
  return new Promise((resolve, reject) => {
    let cancelTimer: () => void = () => undefined
    const onAbort = () => finish({ kind: 'aborted' })
    function finish(result: Settled<T>) {
      cancelTimer()
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    if (signal?.aborted) return finish({ kind: 'aborted' })
    if (clock.monotonic() >= endsAt) return finish({ kind: 'deadline' })
    signal?.addEventListener('abort', onAbort, { once: true })
    if (Number.isFinite(endsAt)) cancelTimer = clock.timer(endsAt - clock.monotonic(), () => finish({ kind: 'deadline' }))
    work.then(
      (value) => finish(clock.monotonic() >= endsAt ? { kind: 'deadline' } : { kind: 'done', value }),
      (error: unknown) => {
        cancelTimer()
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** One attempt on the wire: a reply, or null when the transport itself failed. `signal` is the attempt's own. */
export type Transport = (attempt: number, signal: AbortSignal) => Promise<RawReply | null>

export interface ReadRun<R extends ReadKey> {
  route: R
  request: RequestOf<R>
  transport: Transport
  validators: ReadValidators
  policy: RetryPolicy
  clock: Clock
  signal?: AbortSignal
  /** When the logical read must be settled by, a `clock.monotonic()` reading. `policy.totalMs` from now if not given. */
  deadlineAt?: number
  /** Told as each attempt goes out, retries included, so a queue can pace from the last one. */
  onAttempt?: () => void
  label: { transport: 'fixture' | 'bridge'; fixture?: (attempt: number) => string | undefined }
}

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export async function runRead<R extends ReadKey>(run: ReadRun<R>): Promise<ReadOutcome<R>> {
  const { route, request, transport, validators, policy, clock, signal } = run
  const deadlineAt = run.deadlineAt ?? clock.monotonic() + policy.totalMs
  const provenance = (attempts: number, reply: RawReply | null) => ({
    transport: run.label.transport,
    fixture: run.label.fixture?.(attempts),
    requestId: reply?.requestIdHeader && REQUEST_ID.test(reply.requestIdHeader) ? reply.requestIdHeader : undefined,
    contract: reply?.contractHeader ?? null,
    receivedAt: clock.now(),
    receivedMonotonic: clock.monotonic(),
    attempts,
    deadlineAt,
  })
  const aborted = (attempts: number): ReadOutcome<R> => ({ route, provenance: provenance(attempts, null), state: 'aborted' })
  const late = (attempts: number, limit: 'attempt' | 'read'): ReadOutcome<R> => ({
    route,
    provenance: provenance(attempts, null),
    state: 'unavailable',
    cause: { kind: 'read_deadline', limit },
    retryable: true,
  })

  let attempts = 0
  for (;;) {
    if (signal?.aborted) return aborted(attempts)
    if (clock.monotonic() >= deadlineAt) return late(attempts, 'read')
    attempts += 1
    // 20 s for this attempt, or what is left of the read's budget if that is less.
    const attemptEndsAt = Math.min(clock.monotonic() + policy.attemptMs, deadlineAt)
    const limit = attemptEndsAt === deadlineAt ? 'read' : 'attempt'
    const attempt = new AbortController()
    const follow = () => attempt.abort()
    signal?.addEventListener('abort', follow, { once: true })
    run.onAttempt?.()
    let sent: Promise<RawReply | null>
    try {
      sent = transport(attempts, attempt.signal).catch(() => null)
    } catch {
      sent = Promise.resolve(null)
    }
    const settled = await settleBy(clock, sent, attemptEndsAt, signal)
    signal?.removeEventListener('abort', follow)
    // Nobody will read what this attempt might still bring: stop the request and its body.
    if (settled.kind !== 'done') attempt.abort()
    if (settled.kind === 'aborted' || signal?.aborted) return aborted(attempts)
    if (settled.kind === 'deadline') return late(attempts, limit)
    const reply = settled.value
    // Whether the bridge acted on it is unknown, so it is shown, never asked again.
    if (reply === null) {
      return { route, provenance: provenance(attempts, null), state: 'unavailable', cause: { kind: 'network' }, retryable: false }
    }
    const outcome = interpretReply(route, request, reply, validators, provenance(attempts, reply))
    // A validated 429 read_capacity_busy is the only answer asked again, and only with an attempt left.
    if (outcome.state !== 'busy' || attempts >= policy.maxAttempts) return outcome
    const wait = outcome.retryAfterSeconds * 1000 + Math.floor(clock.random() * policy.jitterMs)
    // A wait the read cannot afford: the bridge's own answer is shown, with the wait it asked for.
    if (clock.monotonic() + wait >= deadlineAt) return outcome
    try {
      await clock.sleep(wait, signal)
    } catch {
      return aborted(attempts)
    }
  }
}
