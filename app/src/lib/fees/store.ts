/**
 * The fees store (DESIGN-V2 §15.4, §15.5): one entry per position NFT, shared
 * by every screen that shows it, behind the hooks in useFeeHistory.ts and
 * useFeeStates.ts.
 *
 * - `/state` is asked once per id (batched, at most eight ids a request) when
 *   a screen first shows it, then every STATE_REFRESH_MS while the page is
 *   visible and anything is shown.
 * - A history is rebuilt by the replay worker, one run per id at a time; every
 *   screen showing the id shares it. When a later `/state` answer names a newer
 *   block, the worker resumes from the last checkpoint for the new logs only.
 * - 2026-09-25: a busy pool's run hands an estimated history first (the worker's
 *   `estimate` message): it is shown (`estimated`) until the exact one verifies,
 *   and stays when the exact read runs out of its budget or its time; only a
 *   replay that disagrees with the chain takes it down.
 * - 2026-09-25 (review): an estimate follows every newer `/state` (its end is the
 *   chain's figures: `carriedEstimate`); after a settlement it gives way to the
 *   quiet card with the new figures. A price path's read that runs out of its
 *   run's budget or time keeps its place (`later`), and the next newer state
 *   block goes on from it; a verified history's later run that gets no further
 *   waits for a newer block too, three times at most. No run starts again at
 *   once after a stop.
 * - 2026-09-27 (the owner: the Fees earned chart took far too long): a run
 *   that could not reach the chain (the RPC refused a read, or answered too
 *   slowly) is asked again as soon as the worker's lane may ask the RPC again
 *   (the `wait` its `done` carries: the lane's rest after a refusal, 30 s
 *   before 2026-09-28; since, the lane's staged rest from 6 s,
 *   lib/chain/browser.ts restAfter), no longer at the next minute's newer
 *   block (about 67 s to the chart, seen live on the owner's 3325113); then
 *   after 30, 60 and 120 s (2026-09-28, speed wave B, item 19: 10, 30, 60 and
 *   120 s, with the lane's staged rest), each no sooner than the lane's wait
 *   (RETRY_MS), only while the page is visible. After that ladder, transient
 *   failures are probed at its capped interval, never permanently latched for
 *   the visit. Nothing else starts it meanwhile, and what the card shows stays.
 *   2026-09-28 (hotfix/charts' review): a position page's run that ran out of
 *   its time, not of its bytes, is one of those too (the worker says
 *   rpc_unavailable: pipeline.ts outOfTime), no longer too_much_history for
 *   the rest of the visit.
 * - The worker is created on the first run (2026-09-28, speed wave B, item 37:
 *   or as soon as Positions opens, `warm`) and kept for the visit (item 21: it
 *   was terminated a few seconds after the last card left, and with it the
 *   units it had read, which another position of the same pool read again; its
 *   memory is bounded at 32 MB, lib/chain/browser.ts memoryCache). If it fails
 *   (onerror, messageerror: a stale worker file after a deploy answers with the
 *   page), any history not drawn yet shows its unclaimed figure (worker_failed)
 *   and the worker is recreated after a bounded, visibility-aware backoff. Old worker
 *   messages cannot complete a new worker's run.
 * - 2026-09-28 (speed wave B, item 16): a position's page hands the store its own
 *   /state read (`offer`), so its cards start from it rather than reading it
 *   again, and follows the store's minute read (`position`) rather than keeping
 *   a clock of its own. Item 15: the minute read waits while a page's run is on
 *   its way (a chart being drawn) and goes as soon as it is over.
 * - Replay checkpoints and live state stay memory-only. A successful public history
 *   may be saved for display on a later visit; it is restored as `cached`, never
 *   as a current chain state, and re-read independently in the background.
 *
 * Views are immutable objects replaced on change, so useSyncExternalStore can
 * compare them by identity. Nothing here reads a clock or renders.
 */
import { BUDGET_BYTES, HOUR_SPAN, MAX_STATE_IDS, STATE_REFRESH_MS } from './constants'
import { HISTORY_MAX_AGE_MS, savedHistoryMatches, type HistoryCache } from './historyCache'
import type { Checkpoint, FeeHistoryView, FeesReason, FeesScope, FromWorker, PositionState, RelayAnswer, StatePositionOk, StateResponse, ToWorker, WorkerResult } from './types'

/** The part of a Worker the store uses (a real one from spawn.ts; a fake in the tests). */
export interface WorkerLike {
  postMessage(message: ToWorker): void
  terminate(): void
  onmessage: ((event: { data: FromWorker }) => void) | null
  onerror: ((event: unknown) => void) | null
  onmessageerror: ((event: unknown) => void) | null
}

export interface StoreDeps {
  historyCache?: HistoryCache
  now?: () => number
  spawn: () => WorkerLike
  /** The /state read of up to eight ids (client.ts chainState: the relay's read, from the chain since 2026-09-25). */
  postState: (tokenIds: readonly string[]) => Promise<RelayAnswer<StateResponse>>
  /** Calls `run` once `ms` have passed and the page is visible; returns a cancel. */
  later: (ms: number, run: () => void) => () => void
  /** A plain timer (for letting go of an id a moment after its last screen leaves); returns a cancel. */
  timer: (ms: number, run: () => void) => () => void
}

export interface FeesStore {
  /** Shows the histories of `ids` to `listener` until the returned function is called. */
  subscribeHistory(ids: readonly string[], scope: FeesScope, listener: () => void): () => void
  /** Low-priority, immediately cancellable public replay; refused while any detail is open. */
  prefetchHistory(id: string, listener: (end?: 'failed' | 'yielded') => void, options?: { revalidate?: boolean }): (() => void) | null
  /** Shows the /state of `ids` (no history) to `listener` until the returned function is called. */
  subscribeStates(ids: readonly string[], listener: () => void): () => void
  /** Tells `listener` of every change to the views of `ids` without asking anything for them (the list's aggregate, useFeeHistories). */
  watch(ids: readonly string[], listener: () => void): () => void
  /** One id's view (idle when nothing shows it). */
  view(id: string): FeeHistoryView
  /** Several ids' views, the same Map object while none of them changed. */
  views(ids: readonly string[]): ReadonlyMap<string, FeeHistoryView>
  /** Several ids' states: null while none is known; the same Map object while none changed. */
  states(ids: readonly string[]): ReadonlyMap<string, PositionState | null> | null
  /**
   * Reads the /state of `ids` again at once, and once more AFTER_ACTION_MS later (a read at head − 2 right after the
   * receipt may not include it yet): after the owner's Collect or Close changed them (2026-09-25, audit of 754014c: the
   * fees card kept its unclaimed figure for up to a minute, STATE_REFRESH_MS, while the page above it showed the new one).
   */
  refresh(ids: readonly string[]): void
  /** 2026-09-28 (speed wave B, item 16): a /state read made elsewhere (a position's page's own), taken as the store's. */
  offer(answer: RelayAnswer<StateResponse>): void
  /** The newest /state position read for `id` and its block (the page's header follows it), or null. */
  position(id: string): Readonly<{ position: StatePositionOk; block: number }> | null
  /** 2026-09-28 (speed wave B, item 37): creates the worker now, so its file is in before the first run. */
  warm(): void
}

const IDLE: FeeHistoryView = { phase: 'idle' }
const U256 = (1n << 256n) - 1n
/** How long an id is kept running after its last screen leaves (a remount, or StrictMode's second mount, picks it up again). */
export const RELEASE_MS = 3_000
/** Later runs of a verified history that got no further, per id and visit, before the store stops asking. */
const RUN_ATTEMPTS = 3
/**
 * 2026-09-27: after each run in a row that could not reach the chain, the wait before the next (never less than the
 * worker's lane's own wait, its rest after a refusal, and REST_MARGIN_MS). The last wait is the cap, not a permanent stop.
 */
export const RETRY_MS = [2_000, 10_000, 30_000, 60_000, 120_000] as const
const retryAfter = (failures: number) => RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]!
/** Past the lane's wait, for the message on its way from the worker: a run started while the lane still rests fails at once. */
const REST_MARGIN_MS = 250
/** After an action, the second /state read: past the few blocks head − 2 may still lack (as the position page reads again). */
export const AFTER_ACTION_MS = 11_000
/**
 * 2026-09-25 (review): how many times per id and visit a price path's read that ran out of its run's budget or time goes
 * on from its place (each a newer state block later, each run at most the page's budget: 16 MB in all at most).
 */
export const MAX_RESUMES = 8

interface Run {
  runId: number
  state: PositionState
  budget: number
  cacheable: boolean
}

interface Entry {
  id: string
  listeners: Set<() => void>
  pageRefs: number
  listRefs: number
  stateRefs: number
  prefetchRefs: number
  /** A bounded list attempt must not replay an old in-memory state before its fresh state read answers. */
  prefetchRevalidating?: boolean
  prefetchListeners: Set<(end?: 'failed' | 'yielded') => void>
  restored: boolean
  snapshotExpiry?: () => void
  /** The newest state read, and the chain's inside − insideLast with it; `read`, that read's position as it came. */
  state: PositionState | null
  read: { position: StatePositionOk; block: number } | null
  growth: readonly [bigint, bigint] | null
  /** Why the state could not be read, while none is known. */
  stateReason: FeesReason | null
  /** Whether a /state answer (or refusal) arrived for this id. */
  answered: boolean
  /** Initial state failures retry quietly; successful reads still use the normal minute refresh. */
  stateFailures: number
  stateRetry: (() => void) | null
  view: FeeHistoryView
  running: Run | null
  checkpoint: Checkpoint | null
  /** A reason no further run changes (replay_mismatch; too_much_history at `settledBudget`). */
  settled: FeesReason | null
  settledBudget: number
  /** A verified history's later runs that got no further (RUN_ATTEMPTS). */
  failures: number
  /** Runs in a row that could not reach the chain (RETRY_MS), and the cancel of the next one's wait while it waits. */
  refused: number
  retry: (() => void) | null
  /** Price-path runs that went on from a place kept (MAX_RESUMES), since the last verified one. */
  resumes: number
  /**
   * The state block of the last run that stopped at its budget with a later one to come (a price path's place kept, a
   * verified history's later run): the next run waits for a newer block (the next /state read, a minute later), never
   * starting again at once (2026-09-25: the RPC limits each visitor's address). Until 2026-09-27, a run that could not
   * reach the chain waited here too; it now waits for the lane's rest (`retry`).
   */
  failedAt: number | null
  release: (() => void) | null
}

/** A /state position as a PositionState and the fee growth accrued since its last settlement. */
export function stateOf(position: StatePositionOk, block: number, timestamp: number): { state: PositionState; growth: readonly [bigint, bigint] } {
  const state: PositionState = {
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
  const growth: readonly [bigint, bigint] = [
    (BigInt(position.feeGrowthInside0X128) - BigInt(position.feeGrowthInside0LastX128)) & U256,
    (BigInt(position.feeGrowthInside1X128) - BigInt(position.feeGrowthInside1LastX128)) & U256,
  ]
  return { state, growth }
}

type Estimated = Extract<FeeHistoryView, { phase: 'estimated' }>

/**
 * An estimated history carried to a newer state (2026-09-25, review: an estimate whose exact read had stopped kept its
 * first figures for the visit, and after the owner's Collect contradicted the page above it). Its end is the chain's own
 * figures, so with no settlement since (the same liquidity and range, no unclaimed amount lower) the end moves to the
 * new state's, and the hours from the old end to it are drawn straight between the two (by blocks); the in-range time
 * of those hours follows the new tick. Null after a settlement: what it collected would be a guess.
 */
export function carriedEstimate(view: Estimated, state: PositionState): Estimated | null {
  const old = view.state
  if (state.block <= old.block) return view
  if (
    state.poolId !== old.poolId ||
    state.tickLower !== old.tickLower ||
    state.tickUpper !== old.tickUpper ||
    state.liquidity !== old.liquidity ||
    state.unclaimed[0] < old.unclaimed[0] ||
    state.unclaimed[1] < old.unclaimed[1]
  )
    return null
  const hours = view.history.hourly
  const last = hours[hours.length - 1]
  if (!last) return null
  const span = BigInt(state.block - old.block)
  const at = (block: number, side: 0 | 1) => old.unclaimed[side] + ((state.unclaimed[side] - old.unclaimed[side]) * BigInt(block - old.block)) / span
  const timeAt = (block: number) => old.timestamp + Math.round(((state.timestamp - old.timestamp) * (block - old.block)) / (state.block - old.block))
  const inRange = state.tickLower <= state.tick && state.tick < state.tickUpper
  const hourly = hours.slice(0, -1)
  const lastAnchor = Math.floor(state.block / HOUR_SPAN)
  let from = old.timestamp
  let added = 0
  for (let anchor = last.anchor; anchor <= lastAnchor; anchor++) {
    const end = anchor === lastAnchor ? state.block : (anchor + 1) * HOUR_SPAN
    const t = anchor === lastAnchor ? state.timestamp : timeAt(end)
    const seconds = inRange ? Math.max(0, t - from) : 0
    added += seconds
    from = t
    hourly.push({
      anchor,
      t,
      earned: anchor === lastAnchor ? [state.unclaimed[0], state.unclaimed[1]] : [at(end, 0), at(end, 1)],
      collected: [0n, 0n],
      inRangeSeconds: (anchor === last.anchor ? last.inRangeSeconds : 0) + seconds,
      sqrtPriceX96Close: anchor === lastAnchor ? state.sqrtPriceX96 : last.sqrtPriceX96Close,
      tickClose: anchor === lastAnchor ? state.tick : last.tickClose,
    })
  }
  const { timeInRange } = view.history
  const history = {
    ...view.history,
    earned: [state.unclaimed[0], state.unclaimed[1]] as const,
    timeInRange: { inSeconds: timeInRange.inSeconds + added, totalSeconds: timeInRange.totalSeconds + Math.max(0, state.timestamp - old.timestamp) },
    hourly,
  }
  return { phase: 'estimated', state, history, prices: view.prices }
}

export function createFeesStore(deps: StoreDeps): FeesStore {
  const entries = new Map<string, Entry>()
  const viewMaps = new Map<string, { views: FeeHistoryView[]; map: ReadonlyMap<string, FeeHistoryView> }>()
  const stateMaps = new Map<string, { parts: Array<PositionState | null | undefined>; map: ReadonlyMap<string, PositionState | null> | null }>()
  let worker: WorkerLike | null = null
  let workerBroken = false
  let workerFailures = 0
  let nextRunId = 0
  let refresh: (() => void) | null = null
  /** The minute read came while a page's run was on its way: it goes once that run is over (item 15). */
  let held = false
  const asking = new Set<string>()
  let queued: string[] = []
  let flushing = false

  const entry = (id: string): Entry => {
    let found = entries.get(id)
    if (!found) {
      found = { id, listeners: new Set(), pageRefs: 0, listRefs: 0, stateRefs: 0, prefetchRefs: 0, prefetchListeners: new Set(), restored: false, state: null, read: null, growth: null, stateReason: null, answered: false, stateFailures: 0, stateRetry: null, view: IDLE, running: null, checkpoint: null, settled: null, settledBudget: 0, failures: 0, refused: 0, retry: null, resumes: 0, failedAt: null, release: null }
      entries.set(id, found)
    }
    return found
  }
  const historyRefs = (e: Entry) => e.pageRefs + e.listRefs + e.prefetchRefs
  const detailOpen = () => [...entries.values()].some((e) => e.pageRefs > 0)
  const shown = (e: Entry) => historyRefs(e) + e.stateRefs > 0
  const budgetOf = (e: Entry) => (e.pageRefs > 0 ? BUDGET_BYTES.page : BUDGET_BYTES.list)
  const notify = (e: Entry) => {
    // A copy: a listener may unsubscribe while the others are called.
    for (const listener of Array.from(e.listeners)) listener()
  }
  const setView = (e: Entry, view: FeeHistoryView) => {
    if (e.view === view) return
    if (view.phase !== 'cached') { e.snapshotExpiry?.(); e.snapshotExpiry = undefined }
    e.view = view
    notify(e)
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
  function stopRun(e: Entry): void {
    if (e.running) {
      try { worker?.postMessage({ type: 'cancel', id: e.id, runId: e.running.runId }) } catch { /* A failed worker has nothing to cancel. */ }
      e.running = null
    }
  }
  function endPrefetch(e: Entry, why: 'failed' | 'yielded'): void {
    for (const listener of Array.from(e.prefetchListeners)) listener(why)
  }
  function invalidate(e: Entry): void {
    deps.historyCache?.remove(e.id)
    e.checkpoint = null
    stopRun(e)
    e.retry?.(); e.retry = null
    e.failedAt = null
    if (e.view.phase === 'cached') setView(e, { phase: 'loading', state: e.state })
  }

  // --- the worker ------------------------------------------------------------

  function broken(): void {
    if (workerBroken) return
    workerBroken = true
    const dead = worker
    worker = null
    if (dead) dead.onmessage = dead.onerror = dead.onmessageerror = null
    dead?.terminate()
    for (const e of entries.values()) {
      if (!e.running) continue
      e.running = null
      endPrefetch(e, 'failed')
      if (e.view.phase !== 'verified' && e.view.phase !== 'estimated' && e.view.phase !== 'cached') setView(e, e.state ? { phase: 'unclaimed-only', state: e.state, reason: 'worker_failed', prices: null } : { phase: 'unavailable', reason: 'worker_failed' })
    }
    const after = retryAfter(workerFailures)
    workerFailures = Math.min(workerFailures + 1, RETRY_MS.length)
    deps.later(after, () => {
      workerBroken = false
      for (const e of entries.values()) next(e)
    })
    if (held && !drawing()) refreshNow()
  }

  function theWorker(): WorkerLike | null {
    if (workerBroken) return null
    if (worker) return worker
    try {
      worker = deps.spawn()
    } catch {
      broken()
      return null
    }
    const active = worker
    worker.onmessage = (event) => {
      if (worker === active) received(event.data)
    }
    worker.onerror = () => { if (worker === active) broken() }
    worker.onmessageerror = () => { if (worker === active) broken() }
    return worker
  }

  function received(message: FromWorker): void {
    if (!message || typeof message !== 'object') return
    const e = entries.get(message.id)
    // Cancellation cannot retract a message already queued by the worker. Match the exact attempt before touching
    // its display, checkpoint, retry state or persistent snapshot; an absent token is never a legacy fallback.
    if (!e?.running || message.runId !== e.running.runId) return
    if (message.type === 'estimate') {
      // An estimate never takes the place of a verified history; it is carried to a state read since its run began.
      if (e.view.phase !== 'verified') carry(e, { phase: 'estimated', state: e.running.state, history: message.history, prices: message.prices })
      return
    }
    if (message.type !== 'done') return
    workerFailures = 0
    const run = e.running
    e.running = null
    finished(e, run, message.result, Number(message.wait) || 0)
    next(e)
    if (held && !drawing()) refreshNow()
  }

  /**
   * Shows `view` (an estimate; by default the one shown) carried to the newest state: the same estimate when nothing
   * newer was read, the quiet card with the new figures after a settlement.
   */
  function carry(e: Entry, view: FeeHistoryView = e.view): void {
    if (view.phase !== 'estimated') return
    const carried = e.state ? carriedEstimate(view, e.state) : view
    setView(e, carried ?? { phase: 'unclaimed-only', state: e.state ?? view.state, reason: 'too_much_history', prices: null })
  }

  /** `wait`: how long before the worker's lane asks the RPC again (its rest after a refusal). */
  function finished(e: Entry, run: Run, result: WorkerResult, wait: number): void {
    if (result.ok) {
      e.checkpoint = result.checkpoint
      e.failures = 0
      e.refused = 0
      e.resumes = 0
      e.failedAt = null
      e.settled = null
      const verified = { phase: 'verified' as const, state: run.state, history: result.history, prices: result.prices }
      if (run.cacheable) deps.historyCache?.save(e.id, verified)
      setView(e, verified)
      return
    }
    endPrefetch(e, 'failed')
    if (result.reason === 'hooked_pool' || result.reason === 'not_found') {
      invalidate(e)
      e.settled = result.reason
      setView(e, { phase: 'unavailable', reason: result.reason })
      return
    }
    if (result.reason === 'rpc_unavailable' || result.reason === 'worker_failed') {
      // Only the worker can construct this in-memory coherent prefix. Never load it from storage.
      if (result.reason === 'rpc_unavailable' && result.later && result.checkpoint !== null) e.checkpoint = result.checkpoint
      // 2026-09-27: asked again once the lane's rest is over, then after 10, 30, 60 and 120 s (RETRY_MS), the page visible.
      const after = retryAfter(e.refused)
      e.refused = Math.min(e.refused + 1, RETRY_MS.length)
      if (historyRefs(e) > 0) e.retry = deps.later(Math.max(after, wait + REST_MARGIN_MS), () => {
        e.retry = null
        next(e)
      })
    } else if (result.reason === 'too_much_history' && result.later && result.checkpoint !== null && e.resumes < MAX_RESUMES) {
      // 2026-09-25 (review): a price path's read that ran out of its run's budget or time kept its place, and the next
      // newer state block goes on from it, never at once (the RPC limits the visitor's address).
      e.checkpoint = result.checkpoint
      e.resumes += 1
      e.failedAt = run.state.block
    } else if (result.reason === 'too_much_history' && e.view.phase === 'verified') {
      // A verified history's later run that got no further (2026-09-25, review: it used to be asked again at once, over and
      // over): the chart stays, the chain's at its own block, and the next run waits for a newer block, three at most.
      e.failures += 1
      e.failedAt = run.state.block
    } else {
      e.settled = result.reason
      e.settledBudget = run.budget
      if (result.reason === 'too_much_history') e.checkpoint = result.checkpoint
      else e.checkpoint = null
    }
    if (result.reason === 'replay_mismatch') deps.historyCache?.remove(e.id)
    // A verified history (or an estimated one) stays up past a stop or a bad moment of the RPC; a replay that disagrees
    // with the chain takes an estimate down.
    if (e.view.phase === 'verified' && result.reason !== 'replay_mismatch') return
    if (e.view.phase === 'cached' && result.reason !== 'replay_mismatch') return
    if (e.view.phase === 'estimated' && result.reason !== 'replay_mismatch') return carry(e)
    const state = e.state ?? run.state
    setView(e, { phase: 'unclaimed-only', state, reason: result.reason, prices: result.prices })
  }

  /** Starts the run `e` needs now, if any. */
  function next(e: Entry): void {
    if (historyRefs(e) === 0 || e.running || !e.state || !e.growth) return
    if (e.prefetchRevalidating && e.pageRefs + e.listRefs === 0) return
    if (e.prefetchRefs > 0 && e.pageRefs + e.listRefs === 0 && detailOpen()) return
    const state = e.state
    const view = e.view
    if (view.phase === 'verified' && view.state.block >= state.block) return
    if (e.settled === 'replay_mismatch' || e.settled === 'hooked_pool' || e.settled === 'not_found') return
    // A budget stop is final for that budget; a larger one (a position page after the list) goes on from its checkpoint,
    // or starts over when the stop came before the swap days (2026-09-25: the budget now bounds those steps too).
    if (e.settled === 'too_much_history' && budgetOf(e) <= e.settledBudget) return
    if (e.failures >= RUN_ATTEMPTS) return
    // A transient failure always waits for its timer, even when a newer block arrives.
    if (e.retry) return
    if (e.failedAt !== null && state.block <= e.failedAt) return
    const target = theWorker()
    if (!target) {
      if (view.phase !== 'verified' && view.phase !== 'estimated' && view.phase !== 'cached') setView(e, { phase: 'unclaimed-only', state, reason: 'worker_failed', prices: null })
      return
    }
    const run: Run = { runId: ++nextRunId, state, budget: budgetOf(e), cacheable: true }
    e.running = run
    if (view.phase === 'idle' || view.phase === 'unavailable' || (view.phase === 'loading' && view.state !== state)) setView(e, { phase: 'loading', state })
    try {
      target.postMessage({ type: 'run', id: e.id, runId: run.runId, state, growth: e.growth, budgetBytes: run.budget, checkpoint: e.checkpoint })
    } catch {
      broken()
    }
  }

  // --- /state ----------------------------------------------------------------

  function applyState(e: Entry, answer: RelayAnswer<StateResponse>): void {
    e.prefetchRevalidating = false
    const position = answer.ok ? answer.value.positions.find((p) => p.tokenId === e.id) : undefined
    e.answered = true
    if (!answer.ok || !position || (!position.ok && position.reason === 'rpc_unavailable')) {
      endPrefetch(e, 'failed')
      // A refresh that failed leaves what is known; a first read that failed shows nothing.
      if (!e.state) {
        e.stateReason = 'rpc_unavailable'
        if (historyRefs(e) > 0 && e.view.phase !== 'cached') setView(e, { phase: 'unavailable', reason: 'rpc_unavailable' })
        notify(e)
        if (!e.stateRetry && shown(e)) {
          const wait = answer.ok ? 0 : answer.retryAfterMs
          e.stateRetry = deps.later(Math.max(retryAfter(e.stateFailures), Number.isFinite(wait) ? wait : 0), () => {
            e.stateRetry = null
            if (shown(e) && !e.state) ask([e.id])
          })
          e.stateFailures = Math.min(e.stateFailures + 1, RETRY_MS.length)
        }
      }
      return
    }
    e.stateRetry?.()
    e.stateRetry = null
    e.stateFailures = 0
    if (!position.ok) {
      endPrefetch(e, 'failed')
      invalidate(e)
      e.state = null
      e.read = null
      e.growth = null
      e.stateReason = position.reason
      e.settled = position.reason
      setView(e, { phase: 'unavailable', reason: position.reason })
      notify(e)
      return
    }
    const { state, growth } = stateOf(position, answer.value.block, answer.value.timestamp)
    if (e.view.phase === 'cached' && !savedHistoryMatches(e.view, state)) invalidate(e)
    if (e.state && state.block <= e.state.block) return
    e.read = { position, block: answer.value.block }
    e.state = state
    e.growth = growth
    e.stateReason = null
    const view = e.view
    if (historyRefs(e) > 0) {
      if (view.phase === 'idle' || view.phase === 'unavailable') setView(e, { phase: 'loading', state })
      else if (view.phase === 'loading') setView(e, { phase: 'loading', state })
      else if (view.phase === 'unclaimed-only') setView(e, { ...view, state })
      else if (view.phase === 'estimated') carry(e)
    }
    notify(e)
    next(e)
  }

  function ask(ids: readonly string[]): void {
    for (const id of ids) {
      if (asking.has(id)) continue
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
        deps
          .postState(part)
          .catch((): RelayAnswer<StateResponse> => ({ ok: false, failure: 'unavailable', retryAfterMs: 0 }))
          .then((answer) => {
            for (const id of part) {
              asking.delete(id)
              const e = entries.get(id)
              if (e) applyState(e, answer)
            }
          })
      }
    })
  }

  /** Whether a page's run (its chart) is on its way. */
  const drawing = () => [...entries.values()].some((e) => e.running && e.pageRefs > 0)
  function refreshNow(): void {
    held = false
    const ids = [...entries.values()].filter(shown).map((e) => e.id)
    if (ids.length === 0) return
    ask(ids)
    scheduleRefresh()
  }
  function scheduleRefresh(): void {
    if (refresh) return
    refresh = deps.later(STATE_REFRESH_MS, () => {
      refresh = null
      if (drawing()) held = true
      else refreshNow()
    })
  }

  // --- subscriptions ---------------------------------------------------------

  function hold(e: Entry): void {
    e.release?.()
    e.release = null
  }

  /**
   * Its history no longer shown: its run stops a moment later (2026-09-28, speed wave B, item 22: a state still shown
   * keeps only its minute read; the list measures no APR since the log-limits hotfix, so no list holds a state).
   */
  function letGo(e: Entry): void {
    if (historyRefs(e) > 0) return
    e.release?.()
    e.release = deps.timer(RELEASE_MS, () => {
      e.release = null
      if (historyRefs(e) > 0) return
      if (e.running) {
        worker?.postMessage({ type: 'cancel', id: e.id, runId: e.running.runId })
        e.running = null
        if (e.view.phase === 'loading') e.view = IDLE
      }
      if (![...entries.values()].some(shown)) {
        refresh?.()
        refresh = null
        held = false
      }
    })
  }

  function subscribe(ids: readonly string[], listener: () => void, add: (e: Entry, step: 1 | -1) => void): () => void {
    const own = [...new Set(ids)].map(entry)
    for (const e of own) {
      e.listeners.add(listener)
      add(e, 1)
      if (historyRefs(e) > 0) restore(e)
      // Its history shown again (a quick return, StrictMode's second mount): its run goes on.
      if (historyRefs(e) > 0) hold(e)
    }
    if (detailOpen()) for (const e of entries.values()) {
      if (e.prefetchRefs > 0 && e.pageRefs + e.listRefs === 0) { stopRun(e); endPrefetch(e, 'yielded') }
    }
    ask(own.filter((e) => !e.state && !e.answered).map((e) => e.id))
    for (const e of own) {
      // Shown again after a state was already known: pick up where it was.
      if (e.state && historyRefs(e) > 0 && e.view.phase === 'idle') setView(e, { phase: 'loading', state: e.state })
      else if (!e.state && e.stateReason && historyRefs(e) > 0 && e.view.phase === 'idle') setView(e, { phase: 'unavailable', reason: e.stateReason })
      next(e)
    }
    scheduleRefresh()
    let open = true
    return () => {
      if (!open) return
      open = false
      for (const e of own) {
        e.listeners.delete(listener)
        add(e, -1)
        letGo(e)
      }
      if (!detailOpen()) for (const e of entries.values()) if (e.prefetchRefs > 0) next(e)
    }
  }

  return {
    subscribeHistory(ids, scope, listener) {
      return subscribe(ids, listener, (e, step) => {
        if (scope === 'page') e.pageRefs += step
        else e.listRefs += step
      })
    },
    prefetchHistory(id, listener, options) {
      if (detailOpen()) return null
      const e = entry(id)
      if (options?.revalidate) {
        e.prefetchRevalidating = true
        if (e.pageRefs + e.listRefs === 0) stopRun(e)
      }
      e.prefetchListeners.add(listener)
      const unsubscribe = subscribe([id], listener, (target, step) => { target.prefetchRefs += step })
      if (options?.revalidate) ask([id])
      let active = true
      return () => {
        if (!active) return
        active = false
        e.prefetchListeners.delete(listener)
        unsubscribe()
        if (historyRefs(e) === 0) {
          e.prefetchRevalidating = false
          // A queued request has not reached the RPC yet: navigation/cancellation can still withdraw it.
          if (e.stateRefs === 0 && queued.includes(id)) {
            queued = queued.filter((pending) => pending !== id)
            asking.delete(id)
          }
          stopRun(e)
          e.retry?.(); e.retry = null
          e.stateRetry?.(); e.stateRetry = null
          e.release?.(); e.release = null
        }
      }
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
    refresh(ids) {
      for (const id of ids) {
        deps.historyCache?.remove(id)
        const e = entries.get(id)
        // Preserve the current visit's existing carry/replay behavior, but an
        // in-flight pre-action result must not resurrect the persisted snapshot.
        if (e?.running) e.running.cacheable = false
        if (e?.view.phase === 'cached') invalidate(e)
      }
      const known = (list: readonly string[]) => list.filter((id) => entries.get(id)?.answered)
      ask(known(ids))
      deps.timer(AFTER_ACTION_MS, () => ask(known(ids)))
    },
    offer(answer) {
      if (answer.ok) for (const position of answer.value.positions) applyState(entry(position.tokenId), answer)
    },
    position: (id) => entries.get(id)?.read ?? null,
    warm: () => void theWorker(),
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
