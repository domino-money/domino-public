/**
 * Tracking a deposit (spec F7 §3.7): the status polling rules, as a pure reducer plus a small driver on an injected
 * clock. Nothing here reads the device's clock, sends from the wallet or keeps anything in the browser: the driver
 * hands every new state to `onUpdate`, and PHASE B writes the record's `lastState` to the journal and draws the screen.
 *
 *   - Every call passes the state last shown as `previousState` (null on the first one).
 *   - The answer's `nextCheckSeconds` says when to ask again. The per-provider table below is a fallback only, for
 *     waits after a failure, when there is no answer to take it from.
 *   - The screen never moves back: the answer's `state` already holds a regressed provider (`transition: "held"`), and
 *     the runtime's `advance(shown, state)` is applied once more here, so a `held` keeps the state shown.
 *   - `terminal` (filled, refunded) stops the polling, and so does `crosschain_deposit_not_found` (the screen shows
 *     the deposit's hash to check in an explorer).
 *   - Busy and unavailable answers (429, 503, 504, a network failure) wait and ask again, longer each time, up to five
 *     minutes. There is no Retry button: the page asks again by itself.
 *   - An unexpected answer (502 upstream_contract_mismatch / upstream_invalid_response, or one this page's checks
 *     refuse) gets one more attempt, then the polling stops.
 */
import type { CrosschainClient, CrosschainOutcome } from './client'
import { FAILURE_COPY } from './copy'
import { errorDisposition } from './errors'
import { statusRequestOf, withLastState, type CrosschainJournalRecord } from './steps'
import type { CrosschainClock, CrosschainValidators, DepositState, Provider, StatusReport } from './types'
import { DEPOSIT_STATES } from './types'

/** XC `pollSeconds` (spec §3.7 table). A fallback only: a valid answer's `nextCheckSeconds` governs. */
export const FALLBACK_POLL_SECONDS: Readonly<Record<Provider, Readonly<Partial<Record<DepositState, number>>>>> = Object.freeze({
  relay: Object.freeze({ awaiting_deposit: 5, pending: 5, failed: 300, refund_failed: 900 }),
  across: Object.freeze({ awaiting_deposit: 10, pending: 10, refund_pending: 300 }),
})

/** The longest wait between two asks after failures. */
export const MAX_WAIT_SECONDS = 300
/** How many more attempts an unexpected answer gets before the polling stops. */
export const UNEXPECTED_RETRIES = 1

export type StopReason =
  /** filled or refunded. */
  | 'terminal'
  /** crosschain_deposit_not_found: show the hash. */
  | 'not_found'
  /** Unexpected answers past the one more attempt. */
  | 'unexpected'
  /** The session ended or was refused; tracking resumes from the journal after signing in again. */
  | 'session'
  /** This wallet cannot use S2. */
  | 'account'
  /** The route is not there: deposits from another network are off. */
  | 'feature_off'
  /** The site's access gate asks for its password again. */
  | 'gate'
  /** Something only a code change fixes. */
  | 'bug'
  /** Stopped by the page (an account, network or page change). */
  | 'aborted'

export interface PollNotice {
  copy: string
  /** For a data-error-code attribute only; never in the text. */
  code: string | null
}

export interface PollState {
  /** The journal record: `lastState` is the state shown, sent as the next `previousState`. */
  record: CrosschainJournalRecord
  /** The last answer accepted. */
  report: StatusReport | null
  /** The fill (destination) and refund (origin) transactions once reported; a later held answer does not erase them. */
  fillTxHash: string | null
  refundTxHash: string | null
  /** Busy or unavailable answers in a row. */
  failures: number
  /** Unexpected answers in a row. */
  unexpected: number
  stopped: StopReason | null
  /** What to say about the last failure, if the last call failed. */
  notice: PollNotice | null
}

export type PollNext = { kind: 'wait'; ms: number } | { kind: 'stop'; reason: StopReason }

/**
 * A fresh polling state for a journal record. A record whose last state is already terminal (a reload after the fill)
 * is asked once more, for the fill or refund transaction and the fee's measurement, then the polling stops: the
 * answer is terminal, held there if the provider's indexer regressed (XC variant status.across-held).
 */
export function initialPoll(record: CrosschainJournalRecord): PollState {
  return {
    record,
    report: null,
    fillTxHash: null,
    refundTxHash: null,
    failures: 0,
    unexpected: 0,
    stopped: null,
    notice: null,
  }
}

const isTerminal = (state: DepositState) => state === 'filled' || state === 'refunded'

/** The table's interval for the state shown; the provider's first-state interval when the table has none. */
export function fallbackSeconds(provider: Provider, shown: DepositState | null): number {
  const table = FALLBACK_POLL_SECONDS[provider]
  return (shown !== null ? table[shown] : undefined) ?? table.awaiting_deposit ?? 10
}

const grow = (baseSeconds: number, attempt: number) => Math.min(MAX_WAIT_SECONDS, baseSeconds * 2 ** Math.max(0, attempt - 1)) * 1000

function stop(state: PollState, reason: StopReason, notice: PollNotice | null): { state: PollState; next: PollNext } {
  return { state: { ...state, stopped: reason, notice }, next: { kind: 'stop', reason } }
}

/** One `status` outcome applied to the polling state. Pure; exported for the tests. */
export function reduceStatus(
  state: PollState,
  outcome: CrosschainOutcome<'status'>,
  runtime: Pick<CrosschainValidators, 'advance'>,
): { state: PollState; next: PollNext } {
  const { record } = state
  const shown = record.lastState
  if (outcome.ok) {
    const report = outcome.data.status
    const [kept, transition] = runtime.advance(shown, report.state)
    const now = (transition === 'held' ? shown : kept) as DepositState
    const next: PollState = {
      record: withLastState(record, now),
      report,
      fillTxHash: report.fillTxHash ?? state.fillTxHash,
      refundTxHash: report.refundTxHash ?? state.refundTxHash,
      failures: 0,
      unexpected: 0,
      stopped: null,
      notice: null,
    }
    if (report.terminal || isTerminal(now)) return stop(next, 'terminal', null)
    const seconds = report.nextCheckSeconds ?? fallbackSeconds(record.provider, now)
    return { state: next, next: { kind: 'wait', ms: seconds * 1000 } }
  }
  const failure = outcome.failure
  const base = fallbackSeconds(record.provider, shown)
  const transient = (notice: PollNotice, baseSeconds: number) => {
    const failures = state.failures + 1
    return { state: { ...state, failures, notice }, next: { kind: 'wait', ms: grow(baseSeconds, failures) } as PollNext }
  }
  const unexpected = (notice: PollNotice) => {
    const count = state.unexpected + 1
    if (count > UNEXPECTED_RETRIES) return stop({ ...state, unexpected: count }, 'unexpected', notice)
    return { state: { ...state, unexpected: count, notice }, next: { kind: 'wait', ms: base * 1000 } as PollNext }
  }
  switch (failure.kind) {
    case 'aborted':
      return stop(state, 'aborted', null)
    case 'session_gone':
      return stop(state, 'session', { copy: FAILURE_COPY.session_gone, code: null })
    case 'gate_required':
      return stop(state, 'gate', { copy: FAILURE_COPY.gate_required, code: null })
    case 'gate_unavailable':
      return transient({ copy: FAILURE_COPY.gate_unavailable, code: null }, Math.max(base, 60))
    case 'not_deployed':
      return stop(state, 'feature_off', { copy: FAILURE_COPY.not_deployed, code: null })
    case 'request_invalid':
    case 'expired':
      return stop(state, 'bug', { copy: FAILURE_COPY.request_invalid, code: null })
    case 'network':
      return transient({ copy: FAILURE_COPY.network, code: null }, base)
    case 'timeout':
      return transient({ copy: FAILURE_COPY.timeout, code: null }, base)
    case 'contract':
      return unexpected({ copy: FAILURE_COPY[failure.detail === 'owner' ? 'owner' : failure.detail === 'echo' ? 'echo' : 'contract'], code: null })
    case 'error': {
      const disposition = errorDisposition(failure.code)
      const notice = { copy: disposition.copy, code: failure.code }
      switch (disposition.next) {
        case 'session':
          return stop(state, 'session', notice)
        case 'account':
          return stop(state, 'account', notice)
        case 'stop_polling':
          return stop(state, 'not_found', notice)
        case 'feature_off':
          return stop(state, 'feature_off', notice)
        case 'backoff':
          return transient(notice, failure.retryAfterS ?? 60)
        case 'retry':
          return transient(notice, base)
        case 'later':
          return transient(notice, Math.max(base, 60))
        case 'retry_once':
          return unexpected(notice)
        case 'requote':
        case 'edit':
        case 'stop':
          return stop(state, 'bug', notice)
      }
    }
  }
}

export interface StatusPoller {
  /** Asks now, then by the rules above until it stops. Calling it again while running does nothing. */
  start(): void
  /** Stops for good: the timer is cancelled, a call in flight is aborted and its answer ignored. */
  stop(): void
  current(): PollState
}

export function createStatusPoller({
  client,
  runtime,
  clock,
  owner,
  record,
  onUpdate,
}: {
  client: Pick<CrosschainClient, 'status'>
  runtime: Pick<CrosschainValidators, 'advance'>
  clock: CrosschainClock
  /** The connected wallet; every answer must be about it. */
  owner: string
  record: CrosschainJournalRecord
  onUpdate: (state: PollState) => void
}): StatusPoller {
  let state = initialPoll(record)
  let running = false
  let ended = state.stopped !== null
  let cancelTimer: (() => void) | null = null
  let controller: AbortController | null = null

  async function ask(): Promise<void> {
    cancelTimer = null
    if (ended) return
    controller = new AbortController()
    const mine = controller
    const outcome = await client.status(statusRequestOf(state.record), { owner, signal: mine.signal })
    if (ended || mine.signal.aborted) return
    controller = null
    const step = reduceStatus(state, outcome, runtime)
    state = step.state
    if (step.next.kind === 'stop') ended = true
    else cancelTimer = clock.setTimer(() => void ask(), step.next.ms)
    onUpdate(state)
  }

  return {
    start() {
      if (running || ended) return
      running = true
      void ask()
    },
    stop() {
      if (ended) return
      ended = true
      cancelTimer?.()
      cancelTimer = null
      controller?.abort()
      state = { ...state, stopped: 'aborted' }
    },
    current: () => state,
  }
}

/** Whether a string is one of the tracking states (for a journal read back). */
export const isDepositState = (value: unknown): value is DepositState => typeof value === 'string' && (DEPOSIT_STATES as readonly string[]).includes(value)
