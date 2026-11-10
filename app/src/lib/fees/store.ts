/**
 * The fees store (DESIGN-V2 §15.4): one entry per position NFT, shared by every screen that shows it, behind the hooks in
 * useFeeHistory.ts and useFeeStates.ts.
 *
 * - `/state` is asked once per id (batched, at most eight ids a request) when a screen first shows it, then every
 *   STATE_REFRESH_MS while the page is visible and anything is shown (a position's page, or a state's subscriber).
 * - Changed on purpose 2026-10-02 (RPC-SPEC §11.4, rugged97's rule 2: never a pool's whole history; the fees history
 *   from eth_call and our own events): a history is no longer replayed from the pool's logs in a worker. It is the
 *   position's own ledger (POST /api/fees/v2/ledger, batched eight ids a request), asked once when a history is first
 *   shown, then only when a newer state shows a settlement the ledger does not hold (lib/fees/ledger.ts agreement: asked
 *   again, fresh). Folded with the newest state into the view (foldLedger): verified when exact, Fees ready to collect
 *   only otherwise. A ledger still being read (`reading`) is asked again in a moment; one that could not be read is asked
 *   again after 2, 10, 30, 60 and 120 s (RETRY_MS), only while the page is visible, the card keeping what it shows.
 * - 2026-10-30 (QA round 2, N45 a): a ledger still `reading` after MAX_READING answers in a row, or one whose fresh read
 *   for the newest state still does not hold its settlement, shows Fees ready to collect only (`why: 'unseen'`), never
 *   a skeleton for the visit; a history already drawn stays.
 * - 2026-11-09 (core flows, the owner: nothing may be slow, nothing may load forever): the ids still `reading` are asked
 *   again together, one request for up to eight, where each was asked alone; and a view still loading after
 *   LIST_LOADING_MS says so (`waited`), so a list row's APR is a dash while its ledger is read on, the rate in its place
 *   once read, with no notice.
 * - The Positions list shares state and ledger reads with the detail, at its slower visible-list interval.
 * - A position's page records each valid state read in a bounded live series (readings.ts); hourly samples are persisted. Since
 *   2026-10-02 every ledger answer records its own state too (the list's only for a position whose page this browser
 *   keeps readings of), and the chart's period starts read at past blocks (pastReads.ts) are folded in with them
 *   (`redraw`; `pastReadings` for those too old to keep).
 * - 2026-10-02 (review of the chart's tabs, finding 1): each id's ledger requests this visit and how the last ended
 *   (`traces`), for the screens' data attributes.
 * - 2026-09-28 (speed wave B, item 16): a position's page hands the store its own /state read (`offer`), so its cards
 *   start from it rather than reading it again, and follows the store's minute read (`position`).
 * - A verified public history may be saved for display on a later visit; it is restored as `cached`, never as a current
 *   chain state, and read again independently.
 *
 * Views are immutable objects replaced on change, so useSyncExternalStore can compare them by identity. Nothing here
 * reads a clock or renders, but the readings' and the cache's own `now`.
 */
import { LEDGER_READING_MS, LIST_STATE_REFRESH_MS, MAX_LEDGER_IDS, MAX_STATE_IDS, STATE_REFRESH_MS } from './constants'
import { wakeDue } from '../wake'
import { HISTORY_MAX_AGE_MS, savedHistoryMatches, type HistoryCache } from './historyCache'
import { agreement, foldLedger, ledgerMint, type LedgerRead } from './ledger'
import type { Reading, Readings } from './readings'
import type { FeeHistoryView, FeesReason, FeesScope, LedgerMintHint, LedgerResponse, PositionMint, PositionState, RelayAnswer, StatePositionOk, StateResponse } from './types'

export interface StoreDeps {
  historyCache?: HistoryCache
  /** This browser's reads of each position (readings.ts): measured points of its chart. */
  readings?: Readings
  /**
   * 2026-10-02 (the chart's periods): reads of a position at past blocks too old for `readings` to keep (a 30D start),
   * held in memory for the visit (lib/fees/pastReads.ts): measured points like the others.
   */
  pastReadings?: (id: string) => readonly Reading[]
  now?: () => number
  /**
   * The /state read of up to eight ids (client.ts chainState).
   * `background` (2026-10-01, item A10): a minute's refresh of what is on screen.
   */
  postState: (tokenIds: readonly string[], signal?: AbortSignal, background?: boolean) => Promise<RelayAnswer<StateResponse>>
  /** The ledger read of up to eight ids (client.ts chainLedger); `fresh` after a settlement the kept one does not hold. */
  postLedger: (tokenIds: readonly string[], fresh: boolean, signal?: AbortSignal, mintHints?: readonly LedgerMintHint[]) => Promise<RelayAnswer<LedgerResponse>>
  /** Calls `run` once `ms` have passed and the page is visible; returns a cancel. */
  later: (ms: number, run: () => void) => () => void
  /** A plain timer (for letting go of an id a moment after its last screen leaves); returns a cancel. */
  timer: (ms: number, run: () => void) => () => void
}

export interface FeesStore {
  /** Shows the shared histories and current states of `ids` until the returned function is called. */
  subscribeHistory(ids: readonly string[], scope: FeesScope, listener: () => void): () => void
  /** Shows the /state of `ids` (no history) to `listener` until the returned function is called. */
  subscribeStates(ids: readonly string[], listener: () => void): () => void
  /** Tells `listener` of every change to the views of `ids` without asking anything for them. */
  watch(ids: readonly string[], listener: () => void): () => void
  /** One id's view (idle when nothing shows it). */
  view(id: string): FeeHistoryView
  /** Several ids' views, the same Map object while none of them changed. */
  views(ids: readonly string[]): ReadonlyMap<string, FeeHistoryView>
  /** Several ids' states: null while none is known; the same Map object while none changed. */
  states(ids: readonly string[]): ReadonlyMap<string, PositionState | null> | null
  /**
   * Reads the /state of `ids` again at once, and once more AFTER_ACTION_MS later (a read right after the receipt may not
   * include it yet): after the owner's Collect or Close changed them. A state that then shows the settlement asks the
   * ledger again, fresh.
   */
  refresh(ids: readonly string[], minBlock?: number): void
  /**
   * A wake round (lib/wake.ts): reads again the shown entries whose last good /state answer is older than their own period
   * (STATE_REFRESH_MS for a page, LIST_STATE_REFRESH_MS for a list), without discarding their last good values; an entry
   * waiting out a failure keeps its wait. Changed on purpose 2026-10-14 (incident 2026-10-13, design 2.5, package Q1): it
   * re-read every shown entry, on every focus, online and visibility change.
   */
  resume(): void
  /** 2026-09-28 (speed wave B, item 16): a /state read made elsewhere (a position's page's own), taken as the store's. */
  offer(answer: RelayAnswer<StateResponse>): void
  /** Public indexed mint evidence; only the edge's verified answer can qualify history. */
  offerMint(hint: LedgerMintHint): void
  /** The newest /state position read for `id` and its block (the page's header follows it), or null. */
  position(id: string): Readonly<{ position: StatePositionOk; block: number }> | null
  /**
   * 2026-10-02 (the chart's periods): folds `id`'s view again from what the store holds, with this browser's readings as
   * they are now (a read at a past block was just kept, lib/fees/pastReads.ts). Asks nothing.
   */
  redraw(id: string): void
  /** Several ids' ledger traces (LedgerTrace), the same Map object while none of them changed; `watch` tells of changes. */
  traces(ids: readonly string[]): ReadonlyMap<string, LedgerTrace>
}

/**
 * 2026-10-02 (review of the chart's tabs, finding 1: the preview's log showed visits that asked no ledger, and a log line
 * says nothing of what a ledger answered): what this visit did with one id's ledger, for the page's data attributes
 * (data-ledger-asks, data-ledger-last). `asks`: the ledger requests sent for it. `last`: how the last one ended: `exact`;
 * the ledger's `why` when it is not exact (`reading` among them); the route's reason for the id (not_found, hooked_pool,
 * rpc_unavailable); the request's failure (unavailable, rate_limited, too_large, bad_request); or `unanswered` (dropped
 * after LEDGER_WAIT_MS). Null before any answered.
 */
export interface LedgerTrace {
  asks: number
  last: string | null
}
const NO_TRACE: LedgerTrace = Object.freeze({ asks: 0, last: null })

const IDLE: FeeHistoryView = { phase: 'idle' }
const U256 = (1n << 256n) - 1n
/** How long an id is kept running after its last screen leaves (a remount, or StrictMode's second mount, picks it up again). */
export const RELEASE_MS = 3_000
/**
 * After each read in a row that could not reach the chain, the wait before the next. The last wait is the cap, not a
 * permanent stop.
 */
export const RETRY_MS = [2_000, 10_000, 30_000, 60_000, 120_000] as const
const retryAfter = (failures: number) => RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]!
/** After an action, the second /state read: past the few blocks a read right after the receipt may still lack. */
export const AFTER_ACTION_MS = 11_000
/**
 * How many times in a row a ledger still `reading` is asked again before it waits for the retry ladder instead.
 * Changed on purpose 2026-11-09 (core flows): 10, was 30. An answer is no longer one window of a ledger but as many as
 * LEDGER_PASS_MS holds (functions/_lib/feesLedger.ts), up to some ten seconds, so ten answers in a row still `reading` are
 * about the minute and a half thirty were (30 × ~3 s), and cover months of history, not five weeks. The card then shows
 * Fees ready to collect only; the store asks on and draws the history once read through, as before.
 */
export const MAX_READING = 10
/**
 * Added on purpose 2026-11-09 (core flows, the owner: "I don't want slowness"): how long a view may load before it says
 * it has waited (`waited`): a list row's APR is a skeleton this long, then a dash while the ledger is read on, and the
 * rate in its place once read (components/positions/listApr.ts). A ledger an edge holds answers well within it.
 */
export const LIST_LOADING_MS = 5_000
/**
 * 2026-10-02 (the owner's preview, the iPhone session that never logged a ledger answer): a ledger request not answered in
 * this long is dropped and taken as one that could not reach the chain, so the retry ladder asks again; while it hung,
 * nothing could (askLedger skips an id whose read is on its way). The route answers well within it (its node calls end
 * in 30 s; a first read it cannot finish is `reading`).
 */
export const LEDGER_WAIT_MS = 45_000
const UNANSWERED: RelayAnswer<LedgerResponse> = { ok: false, failure: 'unavailable', retryAfterMs: 0 }

interface Entry {
  id: string
  listeners: Set<() => void>
  pageRefs: number
  listRefs: number
  stateRefs: number
  restored: boolean
  snapshotExpiry?: () => void
  /** The newest state, and that read's position as it came. */
  state: PositionState | null
  read: { position: StatePositionOk; block: number } | null
  /** Why the state could not be read, while none is known. */
  stateReason: FeesReason | null
  /** Whether a /state answer (or refusal) arrived for this id. */
  answered: boolean
  stateFailures: number
  stateRetry: (() => void) | null
  minBlock: number
  pollElapsed: number
  /** When the last good /state answer for this id arrived (`now`), for the wake rule; null before any. */
  goodAt: number | null
  view: FeeHistoryView
  /** The last ledger that answered for this id, and how the history may use it. */
  ledger: LedgerRead | null
  /** A ledger read of this id on its way. */
  asking: boolean
  ledgerFreshPending: boolean
  mintHint?: LedgerMintHint
  /** A hinted read supersedes an already-running cold scan for this NFT only. */
  ledgerEpoch: number
  /** A reason no further ledger read changes (not_found, hooked_pool, a ledger too large). */
  settled: FeesReason | null
  /** Ledger reads in a row that could not reach the chain (RETRY_MS), and the cancel of the next one's wait. */
  failures: number
  retry: (() => void) | null
  /** Ledger answers in a row still `reading`. */
  reading: number
  /** (2026-11-09) Since when its view has been loading (`now`), and the cancel of the timer that marks it `waited`. */
  loadingSince: number | null
  waiting: (() => void) | null
  /** The state block a fresh ledger was last asked for (one fresh read per newer state that disagrees). */
  freshFor: number
  release: (() => void) | null
  /** This visit's ledger requests for the id and how the last ended (LedgerTrace), replaced on change. */
  trace: LedgerTrace
}

/** A /state position as a PositionState. */
export function stateOf(position: StatePositionOk, block: number, timestamp: number): PositionState {
  return {
    block,
    timestamp,
    unclaimed: [BigInt(position.unclaimed0), BigInt(position.unclaimed1)],
    sqrtPriceX96: BigInt(position.sqrtPriceX96),
    tick: position.tick,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    liquidity: BigInt(position.liquidity),
    poolId: position.poolId,
    owner: position.owner,
    currencies: [{ ...position.currencies[0] }, { ...position.currencies[1] }],
    ...(position.protocolFee === undefined ? {} : { protocolFee: position.protocolFee }),
  }
}

/** The fee growth accrued since the position's last settlement, per token (a /state position's inside − insideLast). */
export function growthOf(position: StatePositionOk): readonly [bigint, bigint] {
  return [(BigInt(position.feeGrowthInside0X128) - BigInt(position.feeGrowthInside0LastX128)) & U256, (BigInt(position.feeGrowthInside1X128) - BigInt(position.feeGrowthInside1LastX128)) & U256]
}

export function createFeesStore(deps: StoreDeps): FeesStore {
  const clock = () => deps.now?.() ?? Date.now()
  const entries = new Map<string, Entry>()
  const viewMaps = new Map<string, { views: FeeHistoryView[]; map: ReadonlyMap<string, FeeHistoryView> }>()
  const stateMaps = new Map<string, { parts: Array<PositionState | null | undefined>; map: ReadonlyMap<string, PositionState | null> | null }>()
  const traceMaps = new Map<string, { parts: LedgerTrace[]; map: ReadonlyMap<string, LedgerTrace> }>()
  let refresh: (() => void) | null = null
  let refreshDelay = LIST_STATE_REFRESH_MS
  const asking = new Set<string>()
  const stateReads = new Map<string, { ids: readonly string[]; stop: AbortController; retained: boolean }>()
  /** An explicit after-action refresh also serves the store's cache when no screen is currently subscribed. */
  const retainedState = new Set<string>()
  const dirtyStates = new Set<string>()
  let queued: string[] = []
  let flushing = false
  const ledgerQueue = new Map<string, boolean>()
  let ledgerFlushing = false

  const entry = (id: string): Entry => {
    let found = entries.get(id)
    if (!found) {
      found = { id, listeners: new Set(), pageRefs: 0, listRefs: 0, stateRefs: 0, restored: false, state: null, read: null, stateReason: null, answered: false, stateFailures: 0, stateRetry: null, minBlock: 0, pollElapsed: 0, goodAt: null, view: IDLE, ledger: null, asking: false, ledgerFreshPending: false, ledgerEpoch: 0, settled: null, failures: 0, retry: null, reading: 0, loadingSince: null, waiting: null, freshFor: 0, release: null, trace: NO_TRACE }
      entries.set(id, found)
    }
    return found
  }
  const historyRefs = (e: Entry) => e.pageRefs + e.listRefs
  /**
   * Whether a screen showing `e` still needs its ledger asked: none answered yet, or the one kept is still `reading` (its
   * 2 s retry is lost when no screen showed the id as it answered or as the retry fired, and a kept ledger stopped every
   * later screen from asking). askLedger itself skips an id whose read is on its way or whose retry waits.
   */
  const needsLedger = (e: Entry) => !e.settled && (!e.ledger || e.ledger.position.why === 'reading')
  /** Detail, list and state-only consumers share the same batched current-state reads. */
  const reads = (e: Entry) => e.pageRefs + e.stateRefs + e.listRefs > 0
  const shown = (e: Entry) => historyRefs(e) + e.stateRefs > 0
  const notify = (e: Entry) => {
    // A copy: a listener may unsubscribe while the others are called.
    for (const listener of Array.from(e.listeners)) listener()
  }
  const setView = (e: Entry, view: FeeHistoryView) => {
    if (e.view === view) return
    if (view.phase !== 'cached') {
      e.snapshotExpiry?.()
      e.snapshotExpiry = undefined
    }
    e.view = waitedOf(e, view)
    notify(e)
  }
  /**
   * Added on purpose 2026-11-09 (core flows): a loading view as long as it has loaded. The first marks when (and a timer
   * marks it `waited` LIST_LOADING_MS later); a later one, the same wait going on, keeps the mark; any other view ends it.
   */
  function waitedOf(e: Entry, view: FeeHistoryView): FeeHistoryView {
    if (view.phase !== 'loading') {
      e.loadingSince = null
      e.waiting?.()
      e.waiting = null
      return view
    }
    if (view.waited) return view
    if (e.loadingSince === null || e.view.phase !== 'loading') {
      e.waiting?.()
      e.loadingSince = clock()
      e.waiting = deps.timer(LIST_LOADING_MS, () => {
        e.waiting = null
        if (e.view.phase === 'loading' && !e.view.waited) setView(e, { ...e.view, waited: true })
      })
      return view
    }
    return (e.view.phase === 'loading' && e.view.waited) || clock() - e.loadingSince >= LIST_LOADING_MS ? { ...view, waited: true } : view
  }
  function restore(e: Entry): void {
    if (e.restored) return
    e.restored = true
    const saved = deps.historyCache?.load(e.id)
    if (saved && e.view.phase === 'idle' && (!e.state || savedHistoryMatches(saved, e.state))) {
      setView(e, saved)
      const remaining = Math.min(saved.savedAt, saved.state.timestamp * 1000) + HISTORY_MAX_AGE_MS - (deps.now?.() ?? Date.now())
      e.snapshotExpiry = deps.timer(Math.max(0, remaining), () => {
        e.snapshotExpiry = undefined
        if (e.view.phase !== 'cached') return
        deps.historyCache?.remove(e.id)
        setView(e, e.state ? { phase: 'loading', state: e.state } : { phase: 'unavailable', reason: 'rpc_unavailable' })
      })
    }
  }

  // --- the view ----------------------------------------------------------------

  /**
   * 2026-10-30 (QA round 2, N45 a): Fees ready to collect only, as for a settlement Domino's reads cannot see (`unseen`),
   * where the card would otherwise wait for the visit. A history already drawn (verified, a saved copy, a ledger's own
   * settlements) stays; a view with none (waiting, unread, or a failed read's unclaimed figure) takes it.
   */
  function unseen(e: Entry, state: PositionState, mintedAt: PositionMint | undefined): void {
    const view = e.view
    const bare = view.phase === 'idle' || view.phase === 'unavailable' || view.phase === 'loading' || (view.phase === 'unclaimed-only' && (view.reason === 'rpc_unavailable' || view.why === 'unseen'))
    if (!bare) return
    if (view.phase === 'unclaimed-only' && view.why === 'unseen' && view.state === state && view.mintedAt?.block === mintedAt?.block) return
    setView(e, { phase: 'unclaimed-only', state, reason: 'not_exact', why: 'unseen', ...(mintedAt ? { mintedAt } : {}) })
  }

  /**
   * The view `e`'s state and ledger make now, or a fresh ledger asked for when the state shows a settlement the ledger does
   * not hold (what the card shows meanwhile stays).
   */
  function draw(e: Entry): void {
    if (historyRefs(e) === 0) return
    if (e.settled) {
      if (e.view.phase !== 'unavailable' || e.view.reason !== e.settled) setView(e, e.settled === 'not_exact' && e.state ? { phase: 'unclaimed-only', state: e.state, reason: 'not_exact', why: 'too_many' } : { phase: 'unavailable', reason: e.settled })
      return
    }
    const ledger = e.ledger
    const state = e.state
    if (!ledger || !state || !e.read) {
      if (state && (e.view.phase === 'idle' || e.view.phase === 'unavailable' || (e.view.phase === 'loading' && e.view.state !== state))) setView(e, { phase: 'loading', state })
      return
    }
    // Still being read: what it shows so far waits (the store asks again in a moment).
    if (ledger.position.why === 'reading') {
      const mintedAt = ledgerMint(ledger.position.mint, state)
      // Changed on purpose 2026-10-30 (QA round 2, N45 a): still `reading` after MAX_READING answers in a row (the
      // retry ladder asks on), the card stops waiting for it: Fees ready to collect only, as for a settlement Domino's
      // reads cannot see. It was a skeleton for the visit, in the Fees card and the list's APR.
      if (e.reading > MAX_READING) {
        unseen(e, state, mintedAt)
        return
      }
      if (e.view.phase === 'idle' || e.view.phase === 'unavailable' || (e.view.phase === 'loading' && (e.view.state !== state || e.view.mintedAt?.block !== mintedAt?.block || e.view.mintedAt?.sqrtPriceX96 !== mintedAt?.sqrtPriceX96))) setView(e, { phase: 'loading', state, ...(mintedAt ? { mintedAt } : {}) })
      return
    }
    const agrees = agreement(ledger, e.read.position, e.read.block)
    if (agrees === 'stale') {
      // A settlement the ledger does not hold: asked again, fresh, once for this state; meanwhile what is shown stays.
      if (e.read.block > ledger.block && e.freshFor < e.read.block) {
        e.freshFor = e.read.block
        askLedger(e, true)
      }
      // Changed on purpose 2026-10-30 (QA round 2, N45 a): the fresh ledger for this state answered and still does not
      // hold the settlement (a close by Auto-exit or a vault, say): Fees ready to collect only, instead of a skeleton for
      // the visit. A history already drawn stays, as before; a newer state asks once more.
      if (e.freshFor >= e.read.block && !e.asking && !e.ledgerFreshPending) {
        unseen(e, state, ledgerMint(ledger.position.mint, state))
        return
      }
      if (e.view.phase === 'idle' || e.view.phase === 'unavailable') setView(e, { phase: 'loading', state })
      return
    }
    const past = deps.pastReadings?.(e.id) ?? []
    const readings = deps.readings?.get(e.id) ?? []
    const view = foldLedger(ledger, state, past.length > 0 ? [...readings, ...past] : readings)
    if (view.phase === 'verified' && e.pageRefs > 0) deps.historyCache?.save(e.id, view)
    setView(e, view)
  }

  // --- the ledger ---------------------------------------------------------------

  /** Asks `e`'s ledger with the next batch (eight ids a request), unless one is on its way or waits for its retry. */
  function askLedger(e: Entry, fresh = false): void {
    // A fresh question while a read is on its way, or while a retry waits (fixed 2026-10-30 after review: it was dropped
    // then, and the retry asked a ledger that may predate the state), is asked when that read answers or the retry fires.
    if ((e.asking || e.retry) && fresh) e.ledgerFreshPending = true
    if (e.asking || e.retry || e.settled || historyRefs(e) === 0) return
    if (e.ledgerFreshPending) {
      e.ledgerFreshPending = false
      fresh = true
    }
    e.asking = true
    // 2026-10-02 (review of the rules, finding 11): a list's row has no state until its ledger answers (the list asks no
    // /state), so it was idle, a dash, all the while: it is being read.
    if (e.view.phase === 'idle' && e.pageRefs === 0 && !e.state) setView(e, { phase: 'loading', state: null })
    ledgerQueue.set(e.id, (ledgerQueue.get(e.id) ?? false) || fresh)
    if (ledgerFlushing) return
    ledgerFlushing = true
    void Promise.resolve().then(() => {
      ledgerFlushing = false
      const batch = [...ledgerQueue.entries()]
      ledgerQueue.clear()
      // The fresh ones apart: a fresh question must not be answered from a read that predates it.
      for (const fresh of [true, false]) {
        const ids = batch.filter(([, isFresh]) => isFresh === fresh).map(([id]) => id)
        for (let i = 0; i < ids.length; i += MAX_LEDGER_IDS) {
          const part = ids.slice(i, i + MAX_LEDGER_IDS)
          const epochs = new Map(part.map((id) => [id, entries.get(id)?.ledgerEpoch]))
          const mintHints = part.flatMap((id) => entries.get(id)?.mintHint ? [entries.get(id)!.mintHint!] : [])
          for (const id of part) {
            const one = entries.get(id)
            if (!one) continue
            one.trace = { asks: one.trace.asks + 1, last: one.trace.last }
            notify(one)
          }
          const stop = new AbortController()
          const late = new Promise<RelayAnswer<LedgerResponse>>((done) => stop.signal.addEventListener('abort', () => done(UNANSWERED), { once: true }))
          const cancel = deps.timer(LEDGER_WAIT_MS, () => stop.abort())
          Promise.race([deps.postLedger(part, fresh, stop.signal, mintHints.length ? mintHints : undefined), late])
            .catch((): RelayAnswer<LedgerResponse> => UNANSWERED)
            .then((answer) => {
              cancel()
              for (const id of part) {
                const one = entries.get(id)
                if (one && one.ledgerEpoch === epochs.get(id)) {
                  ledgerAnswered(one, answer)
                  // A transient failure keeps its Retry-After: the retry asks fresh (askLedger), with the newest state.
                  if (one.ledgerFreshPending && !one.retry) askLedger(one, true)
                }
              }
            })
        }
      }
    })
  }

  function ledgerAnswered(e: Entry, answer: RelayAnswer<LedgerResponse>): void {
    e.asking = false
    const position = answer.ok ? answer.value.positions.find((one) => one.tokenId === e.id) : undefined
    const last = answer === UNANSWERED ? 'unanswered' : !answer.ok ? answer.failure : !position ? 'unavailable' : !position.ok ? position.reason : position.exact ? 'exact' : (position.why ?? 'inexact')
    e.trace = { asks: e.trace.asks, last }
    notify(e)
    // A node/cache answer from before a confirmed action cannot establish a terminal absence. A successful older
    // history can still supplement a newer state, but an older refusal cannot invalidate that proven state either.
    if (answer.ok && (answer.value.block < e.minBlock || (position && !position.ok && e.read && answer.value.block < e.read.block))) {
      scheduleRetry(e, 0, true)
      return
    }
    if (answer.ok && position && position.ok) {
      e.failures = 0
      const read: LedgerRead = { position, block: answer.value.block, timestamp: answer.value.timestamp }
      // A ledger never replaces a newer one.
      if (!e.ledger || read.block >= e.ledger.block) e.ledger = read
      // Its own state is a chain read too: it is the store's when newer than the one it has (the list's only state).
      // 2026-10-02 (the chart's periods): and a measured point of the chart, kept as this browser's reading (at most
      // hourly, readings.ts); it costs no read. Changed on purpose 2026-10-02 (review of the chart's tabs, finding 4): from
      // the list only for a position this browser already keeps readings of (its page was opened): readings keep the
      // MAX_NFTS positions read last, so a list of more than that pushed out the points its pages had kept.
      if (e.pageRefs > 0 || (deps.readings?.get(e.id).length ?? 0) > 0) deps.readings?.note(e.id, { block: read.block, t: read.timestamp, unclaimed: [BigInt(position.state.unclaimed0), BigInt(position.state.unclaimed1)] })
      if (read.block >= e.minBlock && (!e.read || read.block > e.read.block)) {
        e.read = { position: position.state, block: read.block }
        e.state = stateOf(position.state, read.block, read.timestamp)
        e.stateReason = null
        notify(e)
      }
      if (position.why === 'reading' && historyRefs(e) > 0) {
        e.reading += 1
        if (e.reading <= MAX_READING) askAgainSoon(e)
        else scheduleRetry(e, 0)
      } else e.reading = 0
      draw(e)
      return
    }
    if (answer.ok && position && !position.ok && position.reason !== 'rpc_unavailable') {
      e.settled = position.reason
      draw(e)
      return
    }
    if (!answer.ok && answer.failure === 'too_large') {
      // More than one ledger may hold for this position: Fees ready to collect only, for the visit.
      e.settled = 'not_exact'
      draw(e)
      return
    }
    scheduleRetry(e, answer.ok ? 0 : answer.retryAfterMs)
    // What was shown stays; a first read that failed shows the unclaimed figure, calmly.
    if (e.state && (e.view.phase === 'idle' || e.view.phase === 'loading' || e.view.phase === 'unavailable')) setView(e, { phase: 'unclaimed-only', state: e.state, reason: 'rpc_unavailable' })
    else if (!e.state && (e.view.phase === 'idle' || e.view.phase === 'loading') && historyRefs(e) > 0) setView(e, { phase: 'unavailable', reason: 'rpc_unavailable' })
  }

  /**
   * Changed on purpose 2026-11-09 (core flows): a ledger still `reading` is asked again with every other one that is, on one
   * timer LEDGER_READING_MS after the first of them answered, so they go in one request (eight a request, askLedger) where
   * each went alone, each on its own timer, as soon as the first batch answered. Its `retry` takes it out again (a screen
   * left, a hint arrived).
   */
  const readingDue = new Set<Entry>()
  let readingTimer: (() => void) | null = null
  function askAgainSoon(e: Entry): void {
    readingDue.add(e)
    e.retry = () => {
      readingDue.delete(e)
      if (readingDue.size === 0) {
        readingTimer?.()
        readingTimer = null
      }
    }
    if (readingTimer) return
    readingTimer = deps.later(LEDGER_READING_MS, () => {
      readingTimer = null
      const due = [...readingDue]
      readingDue.clear()
      for (const one of due) {
        one.retry = null
        askLedger(one)
      }
    })
  }

  /** The next ledger read after a failure: the ladder's wait, never sooner than the route's Retry-After. */
  function scheduleRetry(e: Entry, wait: number, fresh = false): void {
    if (historyRefs(e) === 0 || e.retry) return
    const after = retryAfter(e.failures)
    e.failures = Math.min(e.failures + 1, RETRY_MS.length)
    e.retry = deps.later(Math.max(after, Number.isFinite(wait) ? wait : 0), () => {
      e.retry = null
      askLedger(e, fresh)
    })
  }

  // --- /state ----------------------------------------------------------------

  function applyState(e: Entry, answer: RelayAnswer<StateResponse>): void {
    // A request begun before a confirmed action cannot undo that action when it arrives late.
    if (answer.ok && answer.value.block < e.minBlock) {
      if (!e.stateRetry) {
        e.stateRetry = deps.later(retryAfter(e.stateFailures), () => { e.stateRetry = null; ask([e.id], true) })
        e.stateFailures = Math.min(e.stateFailures + 1, RETRY_MS.length)
      }
      return
    }
    if (answer.ok && e.read && answer.value.block < e.read.block) return
    const position = answer.ok ? answer.value.positions.find((p) => p.tokenId === e.id) : undefined
    e.answered = true
    if (!answer.ok || !position || (!position.ok && position.reason === 'rpc_unavailable')) {
      // A refresh that failed leaves what is known; a first read that failed shows nothing.
      if (!e.state) {
        e.stateReason = 'rpc_unavailable'
        if (historyRefs(e) > 0 && e.view.phase !== 'cached' && !e.ledger) setView(e, { phase: 'unavailable', reason: 'rpc_unavailable' })
        notify(e)
      }
        if (!e.stateRetry && shown(e)) {
          const wait = answer.ok ? 0 : answer.retryAfterMs
          e.stateRetry = deps.later(Math.max(retryAfter(e.stateFailures), Number.isFinite(wait) ? wait : 0), () => {
            e.stateRetry = null
            if (shown(e)) ask([e.id])
          })
          e.stateFailures = Math.min(e.stateFailures + 1, RETRY_MS.length)
        }
      return
    }
    e.stateRetry?.()
    e.stateRetry = null
    e.stateFailures = 0
    e.goodAt = clock()
    if (!position.ok) {
      deps.historyCache?.remove(e.id)
      e.state = null
      e.read = null
      e.stateReason = position.reason
      e.settled = position.reason
      setView(e, { phase: 'unavailable', reason: position.reason })
      notify(e)
      return
    }
    const block = answer.value.block
    if (e.read && block <= e.read.block) return
    const state = stateOf(position, block, answer.value.timestamp)
    if (e.view.phase === 'cached' && !savedHistoryMatches(e.view, state)) {
      deps.historyCache?.remove(e.id)
      setView(e, { phase: 'loading', state })
    }
    e.read = { position, block }
    e.state = state
    e.stateReason = null
    // A newly proven NFT can outlive an earlier not-found answer while the local node was catching up.
    if (e.settled === 'not_found') e.settled = null
    // A position's page keeps its reads: the measured points between its settlements.
    if (e.pageRefs > 0) deps.readings?.note(e.id, { block, t: state.timestamp, unclaimed: state.unclaimed })
    notify(e)
    if (historyRefs(e) > 0 && needsLedger(e)) askLedger(e)
    draw(e)
  }

  function ask(ids: readonly string[], retain = false, background = false): void {
    for (const id of ids) {
      if (retain) {
        const read = stateReads.get(id)
        if (read) read.retained = true
        else retainedState.add(id)
      }
      if (asking.has(id)) {
        if (retain) dirtyStates.add(id)
        continue
      }
      asking.add(id)
      queued.push(id)
    }
    if (flushing || queued.length === 0) return
    flushing = true
    void Promise.resolve().then(() => {
      flushing = false
      const batch = queued
      queued = []
      for (let i = 0; i < batch.length; i += MAX_STATE_IDS) {
        const part = batch.slice(i, i + MAX_STATE_IDS)
        const read = { ids: part, stop: new AbortController(), retained: part.some((id) => retainedState.has(id)) }
        for (const id of part) {
          stateReads.set(id, read)
          retainedState.delete(id)
        }
        deps
          .postState(part, read.stop.signal, background && part.every((id) => entries.get(id)?.state))
          .catch((): RelayAnswer<StateResponse> => ({ ok: false, failure: 'unavailable', retryAfterMs: 0 }))
          .then((answer) => {
            for (const id of part) {
              // An aborted request can resolve after a remount started its replacement. It owns neither that
              // replacement's dedup marker nor the new subscriber's state.
              if (stateReads.get(id) !== read) continue
              stateReads.delete(id)
              asking.delete(id)
              const e = entries.get(id)
              if (e) applyState(e, answer)
              if (dirtyStates.delete(id)) ask([id], true)
            }
          })
      }
    })
  }

  /** An entry's own period: a page's (or a state subscriber's), else a list's. */
  const periodOf = (e: Entry) => (e.pageRefs > 0 || e.stateRefs > 0 ? STATE_REFRESH_MS : LIST_STATE_REFRESH_MS)

  function refreshNow(elapsed: number): void {
    const ids = [...entries.values()].filter((e) => {
      if (!reads(e)) return false
      e.pollElapsed += elapsed
      const due = periodOf(e)
      if (e.pollElapsed < due || e.stateRetry) return false
      e.pollElapsed = 0
      return true
    }).map((e) => e.id)
    if (ids.length > 0) ask(ids, false, true)
    scheduleRefresh()
  }
  function scheduleRefresh(): void {
    const active = [...entries.values()].filter(reads)
    if (!active.length) return
    const delay = active.some((e) => e.pageRefs > 0 || e.stateRefs > 0) ? STATE_REFRESH_MS : LIST_STATE_REFRESH_MS
    if (refresh && refreshDelay <= delay) return
    refresh?.()
    refreshDelay = delay
    refresh = deps.later(delay, () => {
      refresh = null
      refreshNow(delay)
    })
  }

  // --- subscriptions ---------------------------------------------------------

  function hold(e: Entry): void {
    e.release?.()
    e.release = null
  }

  function releaseState(e: Entry): void {
    if (reads(e)) return
    if (!retainedState.has(e.id) && queued.includes(e.id)) {
      queued = queued.filter((id) => id !== e.id)
      asking.delete(e.id)
    }
    const read = stateReads.get(e.id)
    if (!read || read.retained || read.ids.some((id) => { const other = entries.get(id); return other && reads(other) })) return
    for (const id of read.ids) if (stateReads.get(id) === read) { stateReads.delete(id); asking.delete(id) }
    read.stop.abort()
  }

  /** Its history no longer shown: its retries stop a moment later. */
  function letGo(e: Entry): void {
    if (historyRefs(e) > 0) return
    e.release?.()
    e.release = deps.timer(RELEASE_MS, () => {
      e.release = null
      if (historyRefs(e) > 0) return
      e.retry?.()
      e.retry = null
      if (e.view.phase === 'loading') {
        e.view = IDLE
        e.loadingSince = null
        e.waiting?.()
        e.waiting = null
      }
      if (![...entries.values()].some(reads)) {
        refresh?.()
        refresh = null
      }
    })
  }

  function subscribe(ids: readonly string[], listener: () => void, add: (e: Entry, step: 1 | -1) => void): () => void {
    const own = [...new Set(ids)].map(entry)
    for (const e of own) {
      e.listeners.add(listener)
      add(e, 1)
      if (historyRefs(e) > 0) restore(e)
      // Its history shown again (a quick return, StrictMode's second mount): it goes on.
      if (historyRefs(e) > 0) hold(e)
    }
    ask(own.filter((e) => reads(e) && !e.state && !e.answered).map((e) => e.id))
    for (const e of own) {
      if (historyRefs(e) > 0 && needsLedger(e)) askLedger(e)
      // Shown again after a state was already known: pick up where it was.
      if (e.state && historyRefs(e) > 0 && e.view.phase === 'idle') setView(e, { phase: 'loading', state: e.state })
      else if (!e.state && e.stateReason && historyRefs(e) > 0 && e.view.phase === 'idle') setView(e, { phase: 'unavailable', reason: e.stateReason })
      draw(e)
    }
    if (own.some(reads)) scheduleRefresh()
    let open = true
    return () => {
      if (!open) return
      open = false
      for (const e of own) {
        e.listeners.delete(listener)
        add(e, -1)
        releaseState(e)
        letGo(e)
      }
    }
  }

  return {
    subscribeHistory(ids, scope, listener) {
      return subscribe(ids, listener, (e, step) => {
        if (scope === 'page') e.pageRefs += step
        else e.listRefs += step
      })
    },
    subscribeStates(ids, listener) {
      return subscribe(ids, listener, (e, step) => {
        e.stateRefs += step
      })
    },
    watch(ids, listener) {
      const own = [...new Set(ids)].map(entry)
      for (const e of own) e.listeners.add(listener)
      for (const e of own) restore(e)
      return () => {
        for (const e of own) e.listeners.delete(listener)
      }
    },
    view(id) {
      return entries.get(id)?.view ?? IDLE
    },
    refresh(ids, minBlock) {
      for (const id of ids) {
        deps.historyCache?.remove(id)
        const e = entry(id)
        if (Number.isSafeInteger(minBlock) && minBlock! > 0) e.minBlock = Math.max(e.minBlock, minBlock!)
        e.stateRetry?.()
        e.stateRetry = null
        if (e?.view.phase === 'cached') setView(e, e.state ? { phase: 'loading', state: e.state } : IDLE)
      }
      ask(ids, true)
      deps.timer(AFTER_ACTION_MS, () => ask(ids, true))
    },
    resume() {
      const now = clock()
      const due = [...entries.values()].filter((e) => reads(e) && !e.stateRetry && wakeDue(e.goodAt, periodOf(e), now))
      // Its period starts again from this read: the regular refresh does not read it again a moment later.
      for (const e of due) e.pollElapsed = 0
      ask(due.map((e) => e.id), false, true)
      scheduleRefresh()
    },
    offer(answer) {
      if (answer.ok) for (const position of answer.value.positions) applyState(entry(position.tokenId), answer)
    },
    offerMint(hint) {
      if (!/^[1-9][0-9]*$/.test(hint.tokenId) || !Number.isSafeInteger(hint.block) || hint.block <= 0 || !/^0x[0-9a-f]{64}$/i.test(hint.tx)) return
      const e = entry(hint.tokenId)
      const tx = hint.tx.toLowerCase()
      if (e.mintHint?.block === hint.block && e.mintHint.tx === tx) return
      e.mintHint = { tokenId: hint.tokenId, block: hint.block, tx }
      // Exact history already has stronger evidence; don't restart it just because Activity arrived later.
      if (e.ledger?.position.exact || e.settled === 'hooked_pool') return
      e.ledgerEpoch++
      e.asking = false
      e.retry?.()
      e.retry = null
      e.settled = null
      e.failures = 0
      e.reading = 0
      askLedger(e, true)
    },
    position: (id) => entries.get(id)?.read ?? null,
    redraw(id) {
      const e = entries.get(id)
      if (e) draw(e)
    },
    traces(ids) {
      const key = ids.join(',')
      const parts = ids.map((id) => entries.get(id)?.trace ?? NO_TRACE)
      const kept = traceMaps.get(key)
      if (kept && kept.parts.length === parts.length && kept.parts.every((part, i) => part === parts[i])) return kept.map
      const map: ReadonlyMap<string, LedgerTrace> = new Map(ids.map((id, i) => [id, parts[i]]))
      traceMaps.set(key, { parts, map })
      return map
    },
    views(ids) {
      const key = ids.join(',')
      const views = ids.map((id) => entries.get(id)?.view ?? IDLE)
      const kept = viewMaps.get(key)
      if (kept && kept.views.length === views.length && kept.views.every((view, i) => view === views[i])) return kept.map
      const map: ReadonlyMap<string, FeeHistoryView> = new Map(ids.map((id, i) => [id, views[i]]))
      viewMaps.set(key, { views, map })
      return map
    },
    states(ids) {
      const key = ids.join(',')
      const parts = ids.map((id) => {
        const e = entries.get(id)
        if (!e || !e.answered) return undefined
        return e.state
      })
      const kept = stateMaps.get(key)
      if (kept && kept.parts.length === parts.length && kept.parts.every((part, i) => part === parts[i])) return kept.map
      const known = ids.map((id, i) => [id, parts[i]] as const).filter((pair): pair is readonly [string, PositionState | null] => pair[1] !== undefined)
      const map = known.length === 0 ? null : new Map(known)
      stateMaps.set(key, { parts, map })
      return map
    },
  }
}
