/**
 * One preview screen's state, as a small machine around the client.
 *
 * Rules it keeps (C38, INV-1 to INV-8, E-1 to E-6):
 *   - A request is sent only when the user asks, from a ready, expired or
 *     retryable failed state, within the budget and outside a cooldown. On the
 *     lab screen the user asks with Get preview. On a product screen, which has
 *     no such button, intent.ts asks on the person's behalf: when they open the
 *     figures (Setup's swap quote: only for a request not asked yet), when they
 *     change what would be sent while those are open, or when a sign-in
 *     finishes an intent that waited for it. Never on a timer, at expiry, after
 *     a failure, or when the budget or a cooldown lifts.
 *   - Any change of the inputs, or of the session (account, network, sign-out,
 *     a new server session, a denial), aborts what is in flight and drops the
 *     preview at once. A late answer is recognised by its sequence number and
 *     session key and ignored.
 *   - A current preview has a hard stop on the monotonic clock
 *     (expiry.ts). One that arrives already past it is `failed
 *     (expired_on_arrival)` and never shown. Nothing refreshes by itself.
 *   - Every failure replaces the preview; nothing partly renders.
 *   - The preview lives in this closure only: never storage, the URL, a
 *     query cache or a log.
 */
import type { Clock } from '../lib/clock'
import { SESSION_GONE, sessionKey, type SessionPort, type SessionSnapshot } from '../session/port'
import type { BudgetCheck, PreviewBudget } from './budget'
import type { OnboardingClient, PreviewFailure } from './client'
import { previewDeadlineMono, secondsLeft } from './expiry'
import type { BuildResult, InputIssue } from './inputs'
import type { OnboardingRoute, PreviewOf } from './types'

export type EligibilityBlock =
  | Exclude<SessionSnapshot['kind'], 'signed_in' | 'off'>
  /** This build has no wallet session. */
  | 'session_off'
  /** The controller cannot lend its CSRF: nothing private can be sent. */
  | 'session_access_unavailable'

export type ExpiredOnArrival = { kind: 'expired_on_arrival'; retry: 'manual'; repeated: boolean }

export type PreviewState<R extends OnboardingRoute> =
  | { status: 'ineligible'; block: EligibilityBlock; retryAfterS: number | null }
  | { status: 'editing'; issues: InputIssue[] }
  | { status: 'ready' }
  | { status: 'loading' }
  | { status: 'current'; preview: PreviewOf<R>; owner: string; deadlineMono: number; secondsLeft: number; requestId: string | null }
  | { status: 'expired'; expiredAtWallMs: number }
  | { status: 'failed'; failure: PreviewFailure | ExpiredOnArrival; requestId: string | null }

export interface ControllerView<R extends OnboardingRoute> {
  state: PreviewState<R>
  /** Whether "Get preview" / "Refresh preview" may be pressed now. */
  canRequest: boolean
  /** Why it may not, when the state alone does not say. */
  budget: BudgetCheck
}

export interface PreviewController<R extends OnboardingRoute> {
  getView(): ControllerView<R>
  subscribe(listener: () => void): () => void
  setForm(result: BuildResult<R>): void
  request(): void
  /** Starts following the session and the budget; returns what stops it (which also drops any preview). */
  start(): () => void
  dispose(): void
}

export interface PreviewDeps {
  client: OnboardingClient
  port: SessionPort
  clock: Clock
  budget: PreviewBudget
}

const TICK_MS = 1000

function blockOf(snapshot: SessionSnapshot, port: SessionPort): { block: EligibilityBlock; retryAfterS: number | null } | null {
  if (snapshot.kind === 'off') return { block: 'session_off', retryAfterS: null }
  if (snapshot.kind !== 'signed_in') return { block: snapshot.kind, retryAfterS: snapshot.kind === 'session_busy' ? snapshot.retryAfterS : null }
  if (!port.csrfAccess) return { block: 'session_access_unavailable', retryAfterS: null }
  return null
}

function retryable(state: PreviewState<OnboardingRoute>): boolean {
  if (state.status === 'ready' || state.status === 'expired') return true
  if (state.status !== 'failed') return false
  return state.failure.retry === 'manual' || state.failure.retry === 'after'
}

export function createPreviewController<R extends OnboardingRoute>(route: R, deps: PreviewDeps): PreviewController<R> {
  const { client, port, clock, budget } = deps
  const listeners = new Set<() => void>()
  let form: BuildResult<R> | null = null
  let session = port.getSnapshot()
  let key = sessionKey(session)
  let seq = 0
  let inflight: AbortController | null = null
  let cancelExpiry: (() => void) | null = null
  let cancelTick: (() => void) | null = null
  let expiredOnArrivalRun = 0
  let state: PreviewState<R> = { status: 'ready' }
  let view: ControllerView<R> = { state, canRequest: false, budget: budget.check() }

  function publish() {
    const check = budget.check()
    const eligible = blockOf(session, port) === null && form?.ok === true
    view = { state, canRequest: eligible && retryable(state) && check.ok, budget: check }
    for (const listener of listeners) listener()
  }

  function stopTimers() {
    cancelExpiry?.()
    cancelTick?.()
    cancelExpiry = null
    cancelTick = null
  }

  /** Aborts the request in flight and forgets any preview: nothing of it survives. */
  function drop() {
    seq += 1
    inflight?.abort()
    inflight = null
    stopTimers()
  }

  /** Where the screen rests with no preview. */
  function resting(): PreviewState<R> {
    const blocked = blockOf(session, port)
    if (blocked) return { status: 'ineligible', ...blocked }
    if (!form) return { status: 'ready' }
    return form.ok ? { status: 'ready' } : { status: 'editing', issues: form.issues }
  }

  function tick() {
    if (state.status !== 'current') return
    const left = secondsLeft(state.deadlineMono, clock.monoMs())
    if (left !== state.secondsLeft) {
      state = { ...state, secondsLeft: left }
      publish()
    }
    cancelTick = clock.setTimer(tick, TICK_MS)
  }

  function expire() {
    if (state.status !== 'current') return
    drop()
    state = { status: 'expired', expiredAtWallMs: clock.wallMs() }
    publish()
  }

  function onSession() {
    const next = port.getSnapshot()
    const nextKey = sessionKey(next)
    if (next === session) return
    const changed = nextKey !== key || nextKey === null
    session = next
    if (changed) {
      key = nextKey
      drop()
      state = resting()
    } else if (state.status === 'ineligible') {
      state = resting()
    }
    publish()
  }

  let unsubscribeSession: (() => void) | null = null
  let unsubscribeBudget: (() => void) | null = null
  state = resting()
  publish()

  /** Stops following the session and the budget. Nothing of a preview outlives this. */
  function stop() {
    drop()
    unsubscribeSession?.()
    unsubscribeBudget?.()
    unsubscribeSession = null
    unsubscribeBudget = null
    if (state.status === 'loading' || state.status === 'current') {
      state = resting()
      publish()
    }
  }

  async function send() {
    if (!form?.ok || session.kind !== 'signed_in' || !port.csrfAccess) return
    if (!retryable(state) || !budget.check().ok) return
    const request = form.request
    const owner = session.owner
    const epoch = session.epoch
    const sentKey = key
    drop()
    const mine = seq
    const controller = new AbortController()
    inflight = controller
    budget.spend()
    state = { status: 'loading' }
    publish()
    const sentMono = clock.monoMs()
    const result = await port.withCsrf(epoch, (csrf) => client.preview(route, request, { csrf, sessionOwner: owner, signal: controller.signal }))
    // Only the latest request, for the session it was sent under, may land.
    if (mine !== seq || key !== sentKey) return
    inflight = null
    if (result === SESSION_GONE) {
      state = resting()
      if (state.status === 'ready') state = { status: 'ineligible', block: 'signed_out', retryAfterS: null }
      publish()
      return
    }
    if (!result.ok) {
      if ('aborted' in result) return
      const { failure } = result
      expiredOnArrivalRun = 0
      if (failure.kind === 'rate_limited') budget.cooldown(failure.retryAfterS ?? 60)
      state = { status: 'failed', failure, requestId: result.requestId }
      publish()
      if ('denial' in failure && failure.denial) port.reportDenial(failure.denial, epoch)
      return
    }
    const receivedMono = clock.monoMs()
    const deadlineMono = previewDeadlineMono(result.preview, sentMono, receivedMono)
    if (deadlineMono <= receivedMono) {
      expiredOnArrivalRun += 1
      state = { status: 'failed', failure: { kind: 'expired_on_arrival', retry: 'manual', repeated: expiredOnArrivalRun >= 2 }, requestId: result.requestId }
      publish()
      return
    }
    expiredOnArrivalRun = 0
    state = {
      status: 'current',
      preview: result.preview,
      owner,
      deadlineMono,
      secondsLeft: secondsLeft(deadlineMono, receivedMono),
      requestId: result.requestId,
    }
    cancelExpiry = clock.setTimer(expire, deadlineMono - receivedMono)
    cancelTick = clock.setTimer(tick, TICK_MS)
    publish()
  }

  return {
    getView: () => view,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setForm(result) {
      if (form !== null && form.key === result.key && form.ok === result.ok) {
        form = result
        return
      }
      form = result
      // Any change of the inputs drops the preview and whatever is in flight.
      drop()
      state = resting()
      publish()
    },
    request() {
      void send()
    },
    start() {
      if (unsubscribeSession === null) {
        onSession()
        unsubscribeSession = port.subscribe(onSession)
        unsubscribeBudget = budget.subscribe(publish)
      }
      return stop
    },
    dispose: stop,
  }
}
