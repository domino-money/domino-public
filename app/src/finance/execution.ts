import type { ExecutionRequests, ExecutionResponses } from 'api-contracts/execution-v1/types'
import type { Clock } from '../lib/clock'
import { fetchRaw, jsonBody, classifyHeaderless, type FetchLike } from '../lib/http/rawReply'
import { sessionKey, SESSION_GONE, type SessionPort, type SessionSnapshot } from '../session/port'
import type { Validators } from './performance'
import { reaskWait } from './reask'

type Page = ExecutionResponses['list']
export type ExecutionItem = Page['items'][number]
type Route = keyof ExecutionRequests
type SignedIn = Extract<SessionSnapshot, { kind: 'signed_in' }>

/** execution-v1 allows one refresh per 30 seconds: a list page, a next page or one receipt's status each count as one. */
export const EXECUTION_READ_FLOOR_MS = 30_000
/**
 * After a failed list read the page asks again, silently, this long later
 * while the tab is visible, then twice as long each time, at most REASK_TRIES
 * times (finance/reask.ts); a failure asking again cannot fix is not asked again.
 */
export const EXECUTION_RETRY_MS = 60_000
/** A receipt that came back unchanged, or could not be refreshed, is asked again after twice as long each time, up to this. */
export const EXECUTION_STATUS_MAX_MS = 300_000
/** Unchanged or failed answers in a row after which a shown receipt is not refreshed again until the tab is shown again or the list is read. */
export const EXECUTION_STATUS_TRIES = 6
const PAGE_SIZE = 10

/**
 * The states an intent never leaves: a finalized receipt, a finalized revert,
 * or an intent cancelled before signing. Every other shown receipt is
 * refreshed in place through `status`. `attention` and `reorged` are not among
 * them: the executor checks every recorded attempt again on its next step, so
 * a transaction re-included after a reorganization, or one that qualifies
 * after review, still moves on to included, finalized or reverted
 * (backend/execution_runner.py). They are refreshed like any open receipt,
 * within the same per-visit bound.
 */
export const EXECUTION_SETTLED: ReadonlySet<ExecutionItem['state']> = new Set(['reconciled', 'reverted', 'cancelled'])

export interface ExecutionView {
  scope: string | null
  /** loading: signed in, nothing read yet; unavailable: the last read failed (its code is `reason`). */
  state: 'signed_out' | 'loading' | 'ready' | 'unavailable'
  items: ExecutionItem[]
  more: boolean
  busy: boolean
  /** Why the last read failed, as a closed code. For titles and data attributes only, never shown as text. */
  reason: string | null
  receivedAt: number | null
  /**
   * By intent id: why the last in-place refresh of a shown receipt failed, as
   * a closed code. The receipt stays as it was last read; the code is for its
   * title and data attributes only.
   */
  refreshFailed: Readonly<Record<string, string>>
}

/** Every intent state in plain words. */
export const EXECUTION_STATE_TEXT: Readonly<Record<ExecutionItem['state'], string>> = {
  planned: 'Planned',
  reserved: 'Reserved',
  cancelled: 'Cancelled',
  signing: 'Signing',
  signed: 'Signed',
  submitted: 'Submitted',
  broadcast_unknown: 'Sent, outcome unknown',
  included: 'Included, not final',
  reconciled: 'Finalized',
  reverted: 'Reverted',
  attention: 'Needs attention',
  reorged: 'Chain reorganized',
}

/**
 * One sentence per state for an intent shown without a finalized receipt, in
 * plain words (2026-09-27, round 5 review: a receipt's detail spoke of slots,
 * inclusion, finality, nonces and the canonical chain). The exact state is the
 * chip's title (EXECUTION_STATE_TEXT).
 */
export const EXECUTION_STATE_NOTE: Readonly<Record<ExecutionItem['state'], string>> = {
  planned: 'Planned within your automation limits. Nothing has been sent.',
  reserved: 'Getting ready. Nothing has been sent.',
  cancelled: 'Cancelled before it was sent.',
  signing: 'Being signed. Nothing has been sent.',
  signed: 'Signed and ready. Nothing has been sent.',
  submitted: 'Sent. Waiting for the network to confirm it.',
  broadcast_unknown: 'Sent. The network hasn’t confirmed it, and it is never sent twice.',
  included: 'Almost done: waiting for the network’s final confirmation.',
  reconciled: 'Done.',
  reverted: 'The network turned it down: nothing changed and no fee was taken.',
  attention: 'On hold for a check, so it isn’t counted as done yet.',
  reorged: 'The network is checking it again, so it isn’t counted as done yet.',
}

/**
 * Receipts turn on by themselves: signed in and visible, the first page is
 * read at once, and again whenever the tab becomes visible. A failed read is
 * asked again silently while the tab stays visible, 60 s later, then twice as
 * long each time, three times at most; a failure asking again cannot fix (a
 * switched-off route, a contract this page does not speak, an answer it
 * cannot trust) is not asked again at all. Showing the tab again, a new
 * sign-in or a good page starts that count over. A good page is never read
 * again on a timer; instead each shown receipt that can still change is
 * refreshed in place through `status`, one at a time, never more often than
 * the contract's one refresh per 30 s. One that came back unchanged waits
 * twice as long before the next ask, up to five minutes; a refused refresh
 * keeps the receipt as it was and waits the same way. After six unchanged or
 * failed answers in a row a receipt is left as it stands until the tab is
 * shown again or the list is read. Hiding the tab, signing out or changing
 * account clears what was shown and drops any answer still on its way.
 */
export function createExecutionController(deps: { session: SessionPort; fetch: FetchLike; runtime: Validators; clock: Clock; visible(): boolean }) {
  let view: ExecutionView = { scope: null, state: 'signed_out', items: [], more: false, busy: false, reason: null, receivedAt: null, refreshFailed: {} }
  const listeners = new Set<() => void>()
  let running = false, generation = 0, nextAt = 0, inFlight = false
  /** When the last read went out, on the monotonic clock: the contract's floor counts from it. */
  let lastReadAt = Number.NEGATIVE_INFINITY
  /** Automatic asks that followed a failed list read since the last good page, sign-in or return to the tab. */
  let listTries = 0
  /** A failure asking again cannot fix, or the tries are spent: nothing reads the list on its own until then. */
  let listHeld = false
  let nextAfter: string | null = null
  /** A next page the owner asked for, waiting for the floor or for the read in flight. */
  let pendingPage: string | null = null
  /** By intent id: when its status may be asked next, the wait that led there, and how many unchanged or failed answers came in a row. */
  const due = new Map<string, { at: number; interval: number; quiet: number }>()
  let abort: AbortController | null = null
  let stopTimer: (() => void) | null = null
  const publish = (patch: Partial<ExecutionView>) => { view = { ...view, ...patch }; listeners.forEach(fn => fn()) }
  const eligible = () => running && deps.visible() && deps.session.getSnapshot().kind === 'signed_in'
  const stopWork = () => { generation++; abort?.abort(); abort = null; inFlight = false; stopTimer?.(); stopTimer = null }
  const code = (error: unknown) => error instanceof Error ? error.message : 'unavailable'

  /** One private POST, read through the bounded parser. Resolves SESSION_GONE when the session asked for has ended; throws a closed code. */
  async function post<R extends Route>(route: R, body: ExecutionRequests[R], session: SignedIn, signal: AbortSignal): Promise<ExecutionResponses[R] | typeof SESSION_GONE> {
    const result = await deps.session.withCsrf(session.epoch, csrf => fetchRaw(deps.fetch, `/api/execution/v1/${route}`,
      { headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Domino-CSRF': csrf, 'X-Domino-Execution-Contract': deps.runtime.CONTRACT_VERSION }, body: JSON.stringify(body) },
      { clock: deps.clock, signal, timeoutMs: 20_000, maxBytes: 131072, contractHeader: 'X-Domino-Execution-Contract' }))
    if (result === SESSION_GONE || signal.aborted) return SESSION_GONE
    if (result.kind !== 'reply') throw new Error(result.kind)
    const reply = result.reply
    if (!reply.contractHeader) throw new Error(classifyHeaderless(reply))
    if (reply.opaqueRedirect || reply.contractHeader !== deps.runtime.CONTRACT_VERSION) throw new Error('contract_mismatch')
    const parsed = jsonBody(reply)
    if (!parsed.ok) throw new Error('invalid_response')
    if (reply.status !== 200) {
      if (!deps.runtime.validateError(reply.status, parsed.value)) throw new Error('invalid_response')
      const refused = (parsed.value as { error: string }).error
      if (refused === 'session_required' || refused === 'csrf_invalid' || refused === 'account_unsupported') deps.session.reportDenial(refused, session.epoch)
      throw new Error(refused)
    }
    if (!deps.runtime.validateResponse(route, parsed.value)) throw new Error('invalid_response')
    return parsed.value as ExecutionResponses[R]
  }

  /** The shown receipt that can still change, is still refreshed in this visit, and is due first; or null when none is. */
  function dueReceipt(): { intentId: string; at: number } | null {
    let next: { intentId: string; at: number } | null = null
    for (const item of view.items) {
      if (EXECUTION_SETTLED.has(item.state)) continue
      const entry = due.get(item.intentId)
      if (entry && entry.quiet >= EXECUTION_STATUS_TRIES) continue
      const at = entry?.at ?? 0
      if (!next || at < next.at) next = { intentId: item.intentId, at }
    }
    return next
  }

  /**
   * What to read next, as soon as the floor allows it: a page the owner asked
   * for, then a first page that is not read yet (unless its failures hold it),
   * then the open receipt that is due first. Never while hidden, signed out,
   * stopped or with a read in flight.
   */
  function pump() {
    stopTimer?.(); stopTimer = null
    if (!eligible() || inFlight || !view.scope) return
    let at = nextAt, work: () => void
    if (pendingPage !== null) {
      const after = pendingPage
      work = () => { pendingPage = null; void read(after) }
    } else if (view.state !== 'ready') {
      if (listHeld) return
      work = () => { void read(null) }
    } else {
      const next = dueReceipt()
      if (!next) return
      at = Math.max(at, next.at)
      work = () => { void status(next.intentId) }
    }
    const wait = at - deps.clock.monoMs()
    if (wait <= 0) work()
    // Checked again when the timer fires, so a timer that fires a little early waits out the rest.
    else stopTimer = deps.clock.setTimer(() => { stopTimer = null; pump() }, wait)
  }

  async function read(after: string | null) {
    const session = deps.session.getSnapshot(), scope = sessionKey(session)
    if (!eligible() || session.kind !== 'signed_in' || inFlight || deps.clock.monoMs() < nextAt) return
    const gen = ++generation, controller = new AbortController(); abort = controller
    inFlight = true
    lastReadAt = deps.clock.monoMs()
    nextAt = lastReadAt + EXECUTION_READ_FLOOR_MS
    publish(after === null
      ? { scope, busy: true, items: [], more: false, refreshFailed: {}, state: view.state === 'unavailable' ? 'unavailable' : 'loading' }
      : { scope, busy: true })
    try {
      const page = await post('list', { afterIntentId: after, limit: PAGE_SIZE }, session, controller.signal)
      if (gen !== generation || scope !== sessionKey(deps.session.getSnapshot()) || page === SESSION_GONE) return
      if (page.owner !== session.owner || page.chainId !== session.chainId || page.items.length > PAGE_SIZE || page.items.some(item => after && item.intentId <= after)) throw new Error('owner_or_cursor_mismatch')
      const shown = after === null ? [] : view.items
      const known = new Set(shown.map(item => item.intentId))
      nextAfter = page.nextAfterIntentId
      listTries = 0; listHeld = false
      // A list read starts every receipt's count over: the first page forgets the schedule, a next page keeps it.
      if (after === null) due.clear()
      else for (const [intentId, entry] of due) due.set(intentId, { ...entry, quiet: 0 })
      publish({ state: 'ready', reason: null, items: [...shown, ...page.items.filter(item => !known.has(item.intentId))], more: nextAfter !== null, receivedAt: deps.clock.wallMs() })
    } catch (error) {
      if (gen !== generation) return
      const reason = code(error)
      // Asked again a few times, further apart each time; never for a failure asking again cannot fix.
      const wait = reaskWait(reason, listTries, EXECUTION_RETRY_MS)
      if (wait === null) listHeld = true
      else { listTries += 1; nextAt = deps.clock.monoMs() + wait }
      // An older page is never presented as current after a failure.
      nextAfter = null; pendingPage = null; due.clear()
      publish({ state: 'unavailable', items: [], more: false, receivedAt: null, refreshFailed: {}, reason })
    } finally {
      if (gen === generation) { abort = null; inFlight = false; publish({ busy: false }); pump() }
    }
  }

  /** One shown receipt, read again through `status` and replaced where it stands. */
  async function status(intentId: string) {
    const session = deps.session.getSnapshot(), scope = sessionKey(session)
    if (!eligible() || session.kind !== 'signed_in' || inFlight || deps.clock.monoMs() < nextAt || !view.items.some(item => item.intentId === intentId)) return
    const gen = ++generation, controller = new AbortController(); abort = controller
    const started = deps.clock.monoMs(), entry = due.get(intentId), last = entry?.interval ?? 0, quiet = entry?.quiet ?? 0
    inFlight = true
    lastReadAt = started
    nextAt = started + EXECUTION_READ_FLOOR_MS
    const others = () => Object.fromEntries(Object.entries(view.refreshFailed).filter(([id]) => id !== intentId))
    try {
      const body = { intentId }
      if (!deps.runtime.validateRequest('status', body)) throw new Error('invalid_request')
      const answer = await post('status', body, session, controller.signal)
      if (gen !== generation || scope !== sessionKey(deps.session.getSnapshot()) || answer === SESSION_GONE) return
      if (answer.owner !== session.owner || answer.chainId !== session.chainId || (answer.item !== null && answer.item.intentId !== intentId)) throw new Error('owner_or_intent_mismatch')
      const fresh = answer.item
      if (fresh === null) {
        // Missing and foreign intents answer alike: this receipt is no longer this owner's to show.
        due.delete(intentId)
        publish({ items: view.items.filter(item => item.intentId !== intentId), refreshFailed: others() })
        return
      }
      const unchanged = JSON.stringify(fresh) === JSON.stringify(view.items.find(item => item.intentId === intentId))
      const interval = unchanged ? Math.min(Math.max(last * 2, EXECUTION_READ_FLOOR_MS), EXECUTION_STATUS_MAX_MS) : EXECUTION_READ_FLOOR_MS
      // A receipt that moved on is followed closely again; one that keeps answering the same counts towards the bound.
      due.set(intentId, { at: started + interval, interval, quiet: unchanged ? quiet + 1 : 0 })
      publish({ items: view.items.map(item => item.intentId === intentId ? fresh : item), refreshFailed: others() })
    } catch (error) {
      if (gen !== generation) return
      // The receipt stays as it was last read; only its title says the refresh failed.
      const interval = Math.min(Math.max(last * 2, EXECUTION_RETRY_MS), EXECUTION_STATUS_MAX_MS)
      due.set(intentId, { at: started + interval, interval, quiet: quiet + 1 })
      publish({ refreshFailed: { ...others(), [intentId]: code(error) } })
    } finally {
      if (gen === generation) { abort = null; inFlight = false; pump() }
    }
  }

  function changed(force = false) {
    const scope = sessionKey(deps.session.getSnapshot())
    if (!force && scope === view.scope) return
    stopWork(); nextAt = 0; lastReadAt = Number.NEGATIVE_INFINITY; listTries = 0; listHeld = false; nextAfter = null; pendingPage = null; due.clear()
    publish({ scope, state: scope ? 'loading' : 'signed_out', items: [], more: false, busy: false, reason: null, receivedAt: null, refreshFailed: {} })
    pump()
  }

  return {
    getSnapshot: () => view,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    /** The first page, when the floor allows. The screen has no control for it: reads start on their own. */
    refresh: () => read(null),
    /** The next page, added below the shown ones at the floor's pace: asked inside the 30 s, it waits for them. */
    nextPage: () => {
      if (view.busy || pendingPage !== null || !nextAfter || !eligible()) return
      pendingPage = nextAfter
      publish({ busy: true })
      pump()
    },
    visibilityChanged: () => {
      if (!deps.visible()) {
        stopWork(); nextAfter = null; pendingPage = null; due.clear()
        publish({ items: [], more: false, busy: false, receivedAt: null, refreshFailed: {}, state: !view.scope ? 'signed_out' : view.state === 'unavailable' ? 'unavailable' : 'loading' })
      } else {
        // The owner came back: a failed list is asked once more as soon as the contract's floor allows, and counted afresh.
        listTries = 0; listHeld = false; nextAt = Math.min(nextAt, lastReadAt + EXECUTION_READ_FLOOR_MS)
        pump()
      }
    },
    start: () => {
      running = true
      const stop = deps.session.subscribe(() => changed())
      // Forced: a controller started again (React's development double mount) reads again instead of keeping a dropped read.
      changed(true)
      return () => { running = false; stop(); stopWork(); publish({ busy: false }) }
    },
  }
}
