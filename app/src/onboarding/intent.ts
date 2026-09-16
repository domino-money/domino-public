/**
 * When a product screen asks the preview controller for a preview on the
 * person's behalf, and what its figures show meanwhile.
 *
 * The lab screen (#/live-preview) sends only when Get preview is pressed. A
 * product screen has no such button, so the person's intent is what they do
 * on the page itself (controller.ts keeps every other rule):
 *
 *   - opening the figures is one intent (New position's Review); where the
 *     figures should follow only what is typed (Setup's assisted swap,
 *     `openingAsks: false`), opening serves only a request that no intent
 *     has served yet;
 *   - a changed request while they are open is another, sent after a short
 *     pause so a burst of typing is one request;
 *   - a sign-in while they are open finishes an intent that was waiting for
 *     it, once per server session.
 *
 * Each intent is served at most once. Nothing is sent on a timer, when a
 * preview expires, after a failure, when the page's preview budget frees, or
 * while the figures are folded away; a failure stays a dash until the next
 * intent. An intent that meets a current preview or a failure asking again
 * cannot fix is served by it. An intent that meets the page's own preview
 * budget or the server's cooldown is dropped: the figures say unavailable,
 * with that reason, and the next opening or change asks again. A route that
 * answers that it is not available (a switched-off service, the site's access
 * gate) is not asked again while the screen stays mounted: coming back to the
 * screen, or loading the page again, asks again.
 */
import type { Clock } from '../lib/clock'
import { sessionKey, type SessionPort } from '../session/port'
import type { EligibilityBlock, PreviewController } from './controller'
import type { BuildResult } from './inputs'
import type { OnboardingRequests, OnboardingRoute, PreviewOf } from './types'

/** How long a changed request waits for the next change before it is sent. */
export const INTENT_PAUSE_MS = 400

/**
 * What the figures show, for `data-*` attributes and the screen's words:
 *   off          nothing can be asked here: no sign-in in this build, the service or the site's access refused, or no request can be formed
 *   signed-out   a sign-in would let the figures be asked for
 *   loading      asked, or about to be
 *   current      a preview is current
 *   expired      the preview expired; its figures are gone
 *   unavailable  the last request failed, or an intent met the page's preview budget or a cooldown (reason `budget` or `cooldown`)
 */
export type IntentStatus = 'off' | 'signed-out' | 'loading' | 'current' | 'expired' | 'unavailable'

export interface IntentView<R extends OnboardingRoute> {
  status: IntentStatus
  /** A closed code saying why, for `data-*` attributes and titles only. Null while loading or current. */
  reason: string | null
  /** The current preview, only while `status` is current. */
  preview: PreviewOf<R> | null
  /** Wall-clock time a current preview stops being current. Display only; the controller's monotonic deadline decides. */
  currentUntilWallMs: number | null
  /** Wall-clock time the preview expired. Display only. */
  expiredAtWallMs: number | null
}

export interface IntentDriver<R extends OnboardingRoute> {
  getView(): IntentView<R>
  subscribe(listener: () => void): () => void
  /** What would be sent. A different request drops the preview (the controller's rule) and, while open, is a new intent. */
  setForm(result: BuildResult<R>): void
  /** Whether the figures are open. Opening them is a new intent (with `openingAsks: false`, only for a request not served yet); folding them sends nothing more. */
  setOpen(open: boolean): void
  /** Follows the controller, the session and the budget; returns what stops it, which also drops any preview. */
  start(): () => void
}

/** Session blocks under which no sign-in on this page could bring the figures. */
const OFF_BLOCKS: ReadonlySet<EligibilityBlock> = new Set<EligibilityBlock>([
  'session_off',
  'session_disabled',
  'session_access_unavailable',
  'gate_required',
  'gate_unavailable',
  'browser_unsupported',
  'session_error',
  'account_unsupported',
])

/** Answers that say the route is not there for this page; asking again cannot change them. */
const OFF_FAILURES: ReadonlySet<string> = new Set(['feature_unavailable', 'gate_required', 'gate_unavailable', 'account_unsupported'])

/**
 * The controller's form for a request formed elsewhere, from validated values
 * (New position's journey, Setup's swap fields). The key is the request
 * itself, as inputs.ts keys the lab's forms.
 */
export function formFromRequest<R extends OnboardingRoute>(route: R, request: OnboardingRequests[R] | null, why: string): BuildResult<R> {
  if (request === null) return { ok: false, issues: [{ field: 'request', message: why }], key: `${route}|none|${why}` }
  return { ok: true, request, key: `${route}|${JSON.stringify(request)}` }
}

const sameView = <R extends OnboardingRoute>(a: IntentView<R>, b: IntentView<R>) =>
  a.status === b.status && a.reason === b.reason && a.preview === b.preview && a.currentUntilWallMs === b.currentUntilWallMs && a.expiredAtWallMs === b.expiredAtWallMs

export function createIntentDriver<R extends OnboardingRoute>({
  controller,
  port,
  clock,
  pauseMs = INTENT_PAUSE_MS,
  openingAsks = true,
}: {
  controller: PreviewController<R>
  port: SessionPort
  clock: Clock
  pauseMs?: number
  /** Whether each opening of the figures is an intent of its own. False: opening serves only a request no intent has served yet. */
  openingAsks?: boolean
}): IntentDriver<R> {
  const listeners = new Set<() => void>()
  let open = false
  let visit = 0
  let formKey: string | null = null
  let served: string | null = null
  /** The last intent the page's preview budget or a cooldown turned away, and which of the two it was. */
  let dropped: { intent: string; reason: 'budget' | 'cooldown' } | null = null
  let off: string | null = null
  let cancelPause: (() => void) | null = null
  let shownPreview: PreviewOf<R> | null = null
  let shownUntil: number | null = null
  let view: IntentView<R> = { status: 'off', reason: 'not_open', preview: null, currentUntilWallMs: null, expiredAtWallMs: null }

  /** The intent the page holds now: this opening (where each opening asks), this session, this request. Null while folded or without a request. */
  const intent = () => (open && formKey !== null ? `${openingAsks ? visit : 'open'}|${sessionKey(port.getSnapshot()) ?? '-'}|${formKey}` : null)

  const make = (status: IntentStatus, reason: string | null, extra: Partial<IntentView<R>> = {}): IntentView<R> => ({
    status,
    reason,
    preview: null,
    currentUntilWallMs: null,
    expiredAtWallMs: null,
    ...extra,
  })

  function project(): IntentView<R> {
    const { state, budget } = controller.getView()
    if (state.status === 'current') {
      if (state.preview !== shownPreview) {
        shownPreview = state.preview
        shownUntil = clock.wallMs() + Math.max(0, state.deadlineMono - clock.monoMs())
      }
      return make('current', null, { preview: state.preview, currentUntilWallMs: shownUntil })
    }
    if (off !== null) return make('off', off)
    // An intent the budget or a cooldown turned away says so until another intent replaces it.
    if (dropped !== null && dropped.intent === intent() && state.status !== 'loading') return make('unavailable', dropped.reason)
    switch (state.status) {
      case 'expired':
        return make('expired', 'expired', { expiredAtWallMs: state.expiredAtWallMs })
      case 'loading':
        return make('loading', null)
      case 'ineligible':
        return make(OFF_BLOCKS.has(state.block) ? 'off' : 'signed-out', state.block)
      case 'editing':
        return make('off', 'not_formed')
      case 'failed': {
        const failure = state.failure
        const wanted = intent()
        const asksAgain = failure.retry === 'manual' || failure.retry === 'after'
        // A new intent after a failure the same request could get past, waiting for the page's budget: say that.
        if (asksAgain && wanted !== null && wanted !== served && !budget.ok) return make('unavailable', budget.reason)
        if (failure.kind === 'expired_on_arrival') return make('unavailable', 'expired_on_arrival')
        if (OFF_FAILURES.has(failure.kind)) return make('off', failure.kind)
        if (failure.kind === 'signed_out') return make('signed-out', 'session_required')
        const code = 'code' in failure && failure.code ? failure.code : 'detail' in failure && failure.detail ? failure.detail : failure.kind
        return make('unavailable', code)
      }
      case 'ready': {
        const wanted = intent()
        if (wanted !== null && wanted !== served) return budget.ok ? make('loading', null) : make('unavailable', budget.reason)
        return make('off', formKey === null ? 'not_formed' : 'not_open')
      }
      default:
        return state satisfies never
    }
  }

  function publish() {
    const next = project()
    if (sameView(next, view)) return
    view = next
    for (const listener of listeners) listener()
  }

  /** Serves the intent the page holds, if it is still waiting and the controller can take it now. */
  function serve() {
    const wanted = intent()
    if (wanted === null || wanted === served || off !== null || cancelPause !== null) return
    const { state, canRequest, budget } = controller.getView()
    if (canRequest) {
      served = wanted
      dropped = null
      controller.request()
      return
    }
    // What is already on the page answers this intent: the preview it would ask for, the request in flight, or a
    // failure the same request cannot fix.
    const asksAgain = state.status === 'failed' && (state.failure.retry === 'manual' || state.failure.retry === 'after')
    if (state.status === 'current' || state.status === 'loading' || (state.status === 'failed' && !asksAgain)) {
      served = wanted
      return
    }
    // Everything but the page's preview budget or the server's cooldown would let it go: the intent is dropped, never
    // kept for the moment the budget frees, which is a timer. An ineligible session still leaves the intent waiting
    // for the sign-in that can finish it.
    if (!budget.ok && (state.status === 'ready' || state.status === 'expired' || asksAgain)) {
      served = wanted
      dropped = { intent: wanted, reason: budget.reason }
    }
  }

  function pause() {
    cancelPause?.()
    cancelPause = clock.setTimer(() => {
      cancelPause = null
      serve()
      publish()
    }, pauseMs)
  }

  function onController() {
    const { state } = controller.getView()
    if (state.status === 'failed' && OFF_FAILURES.has(state.failure.kind)) off = state.failure.kind
    serve()
    publish()
  }

  return {
    getView: () => view,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setForm(result) {
      const key = result.ok ? result.key : null
      // The pause starts before the controller hears of the change, so its announcement cannot send the new request early.
      if (key !== formKey) {
        formKey = key
        if (open && key !== null) pause()
        else {
          cancelPause?.()
          cancelPause = null
        }
      }
      controller.setForm(result)
      publish()
    },
    setOpen(next) {
      if (next === open) return
      open = next
      if (open) {
        visit += 1
        serve()
      } else {
        cancelPause?.()
        cancelPause = null
      }
      publish()
    },
    start() {
      // A fresh start is a fresh page for the intent: what an earlier start served or turned away went with it.
      served = null
      dropped = null
      const stopController = controller.start()
      const unsubscribe = controller.subscribe(onController)
      onController()
      return () => {
        unsubscribe()
        stopController()
        cancelPause?.()
        cancelPause = null
        // Opening again after a stop is a new visit.
        open = false
        publish()
      }
    },
  }
}
