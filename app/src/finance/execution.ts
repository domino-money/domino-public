import type { ExecutionRequests, ExecutionResponses } from 'api-contracts/execution-v1/types'
import type { Clock } from '../lib/clock'
import { fetchRaw, jsonBody, classifyHeaderless, type FetchLike } from '../lib/http/rawReply'
import { sessionKey, SESSION_GONE, type SessionPort, type SessionSnapshot } from '../session/port'
import type { Validators } from './performance'
import { reaskWait, sameWallet } from './privateCards'

type Page = ExecutionResponses['list']
export type ExecutionItem = Page['items'][number]
type Route = keyof ExecutionRequests
type SignedIn = Extract<SessionSnapshot, { kind: 'signed_in' }>

/** execution-v1 allows one refresh per 30 seconds: a list page, a next page or one receipt's status each count as one. */
export const EXECUTION_READ_FLOOR_MS = 30_000
/**
 * After a failed list read the page asks again, silently, this long later
 * while the tab is visible, then twice as long each time, at most REASK_TRIES
 * times (finance/privateCards.ts); a failure asking again cannot fix is not asked again.
 */
export const EXECUTION_RETRY_MS = 60_000
/** A receipt that came back unchanged, or could not be refreshed, is asked again after twice as long each time, up to this. */
export const EXECUTION_STATUS_MAX_MS = 300_000
/** Unchanged or failed answers in a row after which a shown receipt is not refreshed again until the tab is shown again or a list read finds it changed. */
export const EXECUTION_STATUS_TRIES = 6
/**
 * How long a list read stays current (the owner, 2026-09-27, round 6): while
 * the tab is visible the list is read again, quietly, this long after the last
 * one took its last page, and at once when the tab comes back after longer
 * away. New receipts join and changed ones are patched in place; nothing
 * shown blanks.
 */
export const EXECUTION_LIST_EVERY_MS = 300_000
/**
 * Pages one list read takes on its own, one per floor. execution-v1 lists by
 * id, not by time, so the newest receipt can be on any page; past these,
 * Show more reads on, and every later read from the first page covers the
 * pages Show more reached too.
 */
export const EXECUTION_LIST_PAGES = 5
/** Receipts per page: the contract's most. */
export const EXECUTION_PAGE_SIZE = 20

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
  /**
   * checking: the wallet's session is being checked; loading: signed in, and no
   * list read has answered in this visit yet; unavailable: the last list read
   * failed (its code is `reason`). None of them clears what is shown.
   */
  state: 'signed_out' | 'checking' | 'loading' | 'ready' | 'unavailable'
  /** What is shown: this browser's copy until the first read answers, then every receipt read, kept through each refresh. Another wallet or session starts over. */
  items: ExecutionItem[]
  /** The service holds receipts past the ones read: Show more reads them. */
  more: boolean
  /** A Show more is waiting for its page, at most one floor. A quiet refresh never sets it. */
  busy: boolean
  /** A list page is on its way (the section is aria-busy); nothing shown changes for it. */
  reading: boolean
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
 * This browser's copy of what the receipts last showed, per wallet
 * (finance/privateCards.ts): read back checked, display only. The wallet
 * island forgets it once the session ends, on any page.
 */
export interface ExecutionCache {
  load(owner: string): ExecutionItem[] | null
  save(owner: string, items: readonly ExecutionItem[]): void
}

/**
 * Receipts turn on by themselves. Signed in, the card shows at once what this
 * browser kept for the wallet, then reads the list quietly while the tab is
 * visible: the first page and the ones after it, one per 30 s (the contract's
 * floor), up to EXECUTION_LIST_PAGES, and on past every receipt a read listed
 * before. Show more reads the next page past them as its own next read, ahead
 * of a list read under way, so it answers within one floor (2026-09-28,
 * round 6 review). Each read is merged into what is shown: new receipts join,
 * changed ones are patched where they stand, and one a whole read no longer
 * lists is dropped. Nothing shown is cleared for a refresh, a failure, a
 * hidden tab or a new session of the same wallet (the owner, 2026-09-27,
 * round 6: the list blanked, and Show more vanished, on every refresh); only
 * another wallet or a sign-out starts over. The list is read again five
 * minutes after the last one finished, and at once when the tab comes back
 * after longer away. A failed read keeps what is shown and is
 * asked again silently, 60 s later, then twice as long each time, three times
 * at most, from the page that failed; a failure asking again cannot fix (a
 * switched-off route, a contract this page does not speak, an answer it
 * cannot trust) is not asked again until the tab is shown again or a new
 * sign-in. Between reads, each shown receipt that can still change is
 * refreshed in place through `status`, one at a time within the same floor;
 * one that came back unchanged waits twice as long before the next ask, up to
 * five minutes; a refused refresh keeps the receipt as it was and waits the
 * same way. After six unchanged or failed answers in a row a receipt is left
 * as it stands until the tab is shown again or a list read finds it changed.
 * A hidden tab reads nothing. Signing out or changing account drops any
 * answer still on its way.
 */
export function createExecutionController(deps: { session: SessionPort; fetch: FetchLike; runtime: Validators; clock: Clock; visible(): boolean; cache?: ExecutionCache }) {
  let view: ExecutionView = { scope: null, state: 'signed_out', items: [], more: false, busy: false, reading: false, reason: null, receivedAt: null, refreshFailed: {} }
  const listeners = new Set<() => void>()
  let running = false, generation = 0, nextAt = 0, inFlight = false
  /** A read the last stop cut off: started again, it goes at once. */
  let dropped = false
  /** When the last read went out, on the monotonic clock: the contract's floor counts from it. */
  let lastReadAt = -Infinity
  /** Automatic asks that followed a failed list read since the last good page, sign-in or return to the tab. */
  let listTries = 0
  /** A failure asking again cannot fix, or the tries are spent: nothing reads the list on its own until then. */
  let listHeld = false
  /** The list read under way from the first page, a page at a time: its next page's cursor (null: the first), the pages it read, and the receipts it listed. */
  let sweep: { after: string | null; pages: number; seen: Set<string> } | null = null
  /** When the last whole list read took its last page, on the monotonic clock: the next one is due EXECUTION_LIST_EVERY_MS later. */
  let sweptAt = -Infinity
  /**
   * The cursor past every receipt read, where Show more goes on: undefined
   * until the first whole read ends, null once a read reached the list's end.
   * It only moves forward, or to the end.
   */
  let beyond: string | null | undefined
  /** The last id any list read listed in this session: a read from the first page covers it before it ends. */
  let reached = ''
  /** Show more was pressed: its page is the next read. */
  let wanted = false
  /** By intent id: when its status may be asked next, the wait that led there, and how many unchanged or failed answers came in a row. */
  const due = new Map<string, { at: number; interval: number; quiet: number }>()
  let abort: AbortController | null = null
  let stopTimer: (() => void) | null = null
  const publish = (patch: Partial<ExecutionView>) => { view = { ...view, ...patch }; listeners.forEach(fn => fn()) }
  /** Shows `items` for `owner`, and keeps this browser's copy of them. */
  const show = (owner: string, items: ExecutionItem[], patch: Partial<ExecutionView>) => { publish({ ...patch, items }); deps.cache?.save(owner, items) }
  const eligible = () => running && deps.visible() && deps.session.getSnapshot().kind === 'signed_in'
  const stopWork = () => { generation++; abort?.abort(); abort = null; inFlight = false; stopTimer?.(); stopTimer = null; if (view.reading) publish({ reading: false }) }
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
   * What to read next, as soon as the floor allows it: Show more's page, then
   * the list read under way or one that came due (unless its failures hold
   * it); else the open receipt due first, or the list when it comes due
   * before it. Never while hidden, signed out, stopped or with a read in
   * flight. Before the first whole read ends, Show more waits for its next page.
   */
  function pump() {
    stopTimer?.(); stopTimer = null
    if (!eligible() || inFlight || !view.scope) return
    const receipt = dueReceipt()
    const listAt = wanted ? 0 : listHeld ? Infinity : sweep ? 0 : sweptAt + EXECUTION_LIST_EVERY_MS
    let at: number, work: () => void
    if (receipt && receipt.at < listAt && listAt > deps.clock.monoMs()) { at = receipt.at; work = () => { void status(receipt.intentId) } }
    else if (listAt < Infinity) { at = listAt; work = () => { void list(wanted && beyond !== undefined) } }
    else return
    const wait = Math.max(at, nextAt) - deps.clock.monoMs()
    if (wait <= 0) work()
    // Checked again when the timer fires, so a timer that fires a little early waits out the rest.
    else stopTimer = deps.clock.setTimer(() => { stopTimer = null; pump() }, wait)
  }

  /**
   * One page merged into what is shown: Show more's past every receipt read
   * (`more`), else the next of the list read under way, a new one from the
   * first page when none is.
   */
  async function list(more: boolean) {
    const session = deps.session.getSnapshot(), scope = sessionKey(session)
    if (!eligible() || session.kind !== 'signed_in' || inFlight || deps.clock.monoMs() < nextAt) return
    const run = more ? null : sweep ??= { after: null, pages: 0, seen: new Set() }
    const after = run ? run.after : beyond ?? null
    const gen = ++generation, controller = new AbortController(); abort = controller
    inFlight = true
    lastReadAt = deps.clock.monoMs()
    nextAt = lastReadAt + EXECUTION_READ_FLOOR_MS
    publish({ reading: true })
    try {
      const page = await post('list', { afterIntentId: after, limit: EXECUTION_PAGE_SIZE }, session, controller.signal)
      if (gen !== generation || scope !== sessionKey(deps.session.getSnapshot()) || page === SESSION_GONE) return
      if (page.owner !== session.owner || page.chainId !== session.chainId || page.items.length > EXECUTION_PAGE_SIZE || page.items.some(item => after && item.intentId <= after)) throw new Error('owner_or_cursor_mismatch')
      listTries = 0; listHeld = false
      // Each listed receipt counts towards the furthest one read, and towards what a read from the first page covered.
      const listed = new Map(page.items.map(item => { if (item.intentId > reached) reached = item.intentId; run?.seen.add(item.intentId); return [item.intentId, item] }))
      // Patched where they stand: a receipt that changed is followed closely again; one that did not keeps its pace.
      let items = view.items.map(item => {
        const fresh = listed.get(item.intentId)
        if (!fresh) return item
        listed.delete(item.intentId)
        if (JSON.stringify(fresh) !== JSON.stringify(item)) due.delete(item.intentId)
        return fresh
      })
      items.push(...listed.values())
      // Show more is answered by its own page, or, before the first whole read ends, by that read's next one.
      const answered = wanted && (!run || beyond === undefined)
      if (answered) wanted = false
      const next = page.nextAfterIntentId
      if (!run) beyond = next
      else {
        run.pages++; run.after = next
        // Five pages, and on past every receipt a read listed (Show more's too), or the list's end: this read then covered every
        // id up to its cursor (all of them, at the end), and a receipt it did not list there is no longer this owner's to show.
        // A hundred pages at most, whatever the cursors say, so it always comes to an end.
        if (next === null || (run.pages >= EXECUTION_LIST_PAGES && (next >= reached || run.pages > 99))) {
          sweep = null; beyond = next; sweptAt = lastReadAt
          items = items.filter(item => run.seen.has(item.intentId) || (next !== null && item.intentId > next))
        }
      }
      show(session.owner, items, { state: 'ready', reason: null, reading: false, receivedAt: deps.clock.wallMs(), more: (beyond === undefined ? next : beyond) !== null, ...(answered && { busy: false }) })
    } catch (error) {
      if (gen !== generation) return
      const reason = code(error)
      // What is shown stays. Asked again a few times, further apart each time, from the page that failed; never for a
      // failure asking again cannot fix. A Show more that failed can be pressed again.
      const wait = reaskWait(reason, listTries, EXECUTION_RETRY_MS)
      if (wait === null) listHeld = true
      else { listTries += 1; nextAt = deps.clock.monoMs() + wait }
      wanted = false
      publish({ state: 'unavailable', reason, busy: false, reading: false })
    } finally {
      if (gen === generation) { abort = null; inFlight = false; if (view.reading) publish({ reading: false }); pump() }
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
        show(session.owner, view.items.filter(item => item.intentId !== intentId), { refreshFailed: others() })
        return
      }
      const unchanged = JSON.stringify(fresh) === JSON.stringify(view.items.find(item => item.intentId === intentId))
      const interval = unchanged ? Math.min(Math.max(last * 2, EXECUTION_READ_FLOOR_MS), EXECUTION_STATUS_MAX_MS) : EXECUTION_READ_FLOOR_MS
      // A receipt that moved on is followed closely again; one that keeps answering the same counts towards the bound.
      due.set(intentId, { at: started + interval, interval, quiet: unchanged ? quiet + 1 : 0 })
      show(session.owner, view.items.map(item => item.intentId === intentId ? fresh : item), { refreshFailed: others() })
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

  /**
   * The same session keeps what it shows. A new one for the same wallet and
   * connector keeps its rows too, and where Show more reached, and reads the
   * list at once; another wallet starts from this browser's copy of it, and a
   * sign-out from nothing.
   */
  function changed() {
    const snapshot = deps.session.getSnapshot(), scope = sessionKey(snapshot), before = view.scope
    const state = scope ? 'loading' : snapshot.kind === 'pending' ? 'checking' : 'signed_out'
    if (scope === before && (scope !== null || state === view.state)) return
    const same = before && scope && sameWallet(before, scope)
    stopWork(); nextAt = 0; lastReadAt = -Infinity; listTries = 0; listHeld = false; sweep = null; sweptAt = -Infinity; wanted = false; due.clear()
    if (!same) { beyond = undefined; reached = '' }
    const items = snapshot.kind !== 'signed_in' ? [] : same ? view.items : deps.cache?.load(snapshot.owner) ?? []
    publish({ scope, state, items, more: (beyond ?? null) !== null, busy: false, reading: false, reason: null, receivedAt: null, refreshFailed: {} })
    pump()
  }
  // The first view paints where the session already stands (a signed-in wallet's rows from this browser's copy), never a
  // signed-out line for a frame before its start (the chunk loads once the wallet is usually signed in).
  changed()

  return {
    getSnapshot: () => view,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    /** Show more past the receipts read, as the next read: asked inside the 30 s, it waits for them. */
    nextPage: () => {
      if (view.busy || !view.more || !eligible()) return
      wanted = true
      publish({ busy: true })
      pump()
    },
    visibilityChanged: () => {
      // Hidden: nothing is read, and what is shown stays; a list read under way goes on from its page once the tab is back.
      if (!deps.visible()) { stopWork(); return }
      // The owner came back: a failed list is asked once more as soon as the contract's floor allows, counted afresh, as
      // is each receipt left as it stood.
      if (view.state === 'unavailable') sweptAt = -Infinity
      listTries = 0; listHeld = false; nextAt = Math.min(nextAt, lastReadAt + EXECUTION_READ_FLOOR_MS)
      for (const [intentId, entry] of due) due.set(intentId, { ...entry, quiet: 0 })
      pump()
    },
    start: () => {
      running = true
      const stop = deps.session.subscribe(changed)
      // Started again (a view shown again, or React's development double mount): the same session keeps what it showed,
      // and a read the last stop cut off goes again at once.
      if (dropped) nextAt = lastReadAt
      dropped = false
      changed(); pump()
      return () => { running = false; stop(); dropped = inFlight; wanted = false; stopWork(); publish({ busy: false }) }
    },
  }
}
