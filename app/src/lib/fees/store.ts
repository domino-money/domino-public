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
 * - The worker is created on the first run and terminated once nothing has
 *   been shown for a moment. If it fails (onerror, messageerror: a stale
 *   worker file after a deploy answers with the page), every history shows its
 *   unclaimed figure only (worker_failed) and no worker is created again in
 *   this session.
 * - Memory only, for this visit: no localStorage, sessionStorage or IndexedDB.
 *
 * Views are immutable objects replaced on change, so useSyncExternalStore can
 * compare them by identity. Nothing here reads a clock or renders.
 */
import { BUDGET_BYTES, HOUR_SPAN, MAX_STATE_IDS, STATE_REFRESH_MS } from './constants'
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
}

const IDLE: FeeHistoryView = { phase: 'idle' }
const U256 = (1n << 256n) - 1n
/** How long an id is kept running after its last screen leaves (a remount, or StrictMode's second mount, picks it up again). */
export const RELEASE_MS = 3_000
/** Runs that failed to reach the relay, per id and visit, before the store stops asking. */
const RUN_ATTEMPTS = 3
/** After an action, the second /state read: past the few blocks head − 2 may still lack (as the position page reads again). */
export const AFTER_ACTION_MS = 11_000
/**
 * 2026-09-25 (review): how many times per id and visit a price path's read that ran out of its run's budget or time goes
 * on from its place (each a newer state block later, each run at most the page's budget: 16 MB in all at most).
 */
export const MAX_RESUMES = 8

interface Run {
  state: PositionState
  budget: number
}

interface Entry {
  id: string
  listeners: Set<() => void>
  pageRefs: number
  listRefs: number
  stateRefs: number
  /** The newest state read, and the chain's inside − insideLast with it. */
  state: PositionState | null
  growth: readonly [bigint, bigint] | null
  /** Why the state could not be read, while none is known. */
  stateReason: FeesReason | null
  /** Whether a /state answer (or refusal) arrived for this id. */
  answered: boolean
  view: FeeHistoryView
  running: Run | null
  checkpoint: Checkpoint | null
  /** A reason no further run changes (replay_mismatch; too_much_history at `settledBudget`). */
  settled: FeesReason | null
  settledBudget: number
  failures: number
  /** Price-path runs that went on from a place kept (MAX_RESUMES), since the last verified one. */
  resumes: number
  /**
   * The state block of the last run that could not reach the chain: the next run waits for a newer block (the next
   * /state read, a minute later), never starting again at once (2026-09-25: the RPC limits each visitor's address, and
   * a run asked again straight after a refusal is refused too, and the page's own reads with it).
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
  let stopWorker: (() => void) | null = null
  let refresh: (() => void) | null = null
  const asking = new Set<string>()
  let queued: string[] = []
  let flushing = false

  const entry = (id: string): Entry => {
    let found = entries.get(id)
    if (!found) {
      found = { id, listeners: new Set(), pageRefs: 0, listRefs: 0, stateRefs: 0, state: null, growth: null, stateReason: null, answered: false, view: IDLE, running: null, checkpoint: null, settled: null, settledBudget: 0, failures: 0, resumes: 0, failedAt: null, release: null }
      entries.set(id, found)
    }
    return found
  }
  const historyRefs = (e: Entry) => e.pageRefs + e.listRefs
  const shown = (e: Entry) => historyRefs(e) + e.stateRefs > 0
  const budgetOf = (e: Entry) => (e.pageRefs > 0 ? BUDGET_BYTES.page : BUDGET_BYTES.list)
  const notify = (e: Entry) => {
    // A copy: a listener may unsubscribe while the others are called.
    for (const listener of Array.from(e.listeners)) listener()
  }
  const setView = (e: Entry, view: FeeHistoryView) => {
    if (e.view === view) return
    e.view = view
    notify(e)
  }

  // --- the worker ------------------------------------------------------------

  function broken(): void {
    workerBroken = true
    const dead = worker
    worker = null
    dead?.terminate()
    for (const e of entries.values()) {
      if (!e.running) continue
      e.running = null
      if (e.view.phase !== 'verified' && e.view.phase !== 'estimated') setView(e, e.state ? { phase: 'unclaimed-only', state: e.state, reason: 'worker_failed', prices: null } : { phase: 'unavailable', reason: 'worker_failed' })
    }
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
    worker.onmessage = (event) => received(event.data)
    worker.onerror = () => broken()
    worker.onmessageerror = () => broken()
    return worker
  }

  function received(message: FromWorker): void {
    if (!message || typeof message !== 'object') return
    if (message.type === 'estimate') {
      const e = entries.get(message.id)
      // An estimate never takes the place of a verified history; it is carried to a state read since its run began.
      if (e?.running && e.view.phase !== 'verified') carry(e, { phase: 'estimated', state: e.running.state, history: message.history, prices: message.prices })
      return
    }
    if (message.type !== 'done') return
    const e = entries.get(message.id)
    if (!e || !e.running) return
    const run = e.running
    e.running = null
    finished(e, run, message.result)
    next(e)
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

  function finished(e: Entry, run: Run, result: WorkerResult): void {
    if (result.ok) {
      e.checkpoint = result.checkpoint
      e.failures = 0
      e.resumes = 0
      e.failedAt = null
      e.settled = null
      setView(e, { phase: 'verified', state: run.state, history: result.history, prices: result.prices })
      return
    }
    if (result.reason === 'hooked_pool' || result.reason === 'not_found') {
      e.settled = result.reason
      setView(e, { phase: 'unavailable', reason: result.reason })
      return
    }
    if (result.reason === 'rpc_unavailable' || result.reason === 'worker_failed') {
      e.failures += 1
      e.failedAt = run.state.block
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
    // A verified history (or an estimated one) stays up past a stop or a bad moment of the RPC; a replay that disagrees
    // with the chain takes an estimate down.
    if (e.view.phase === 'verified' && result.reason !== 'replay_mismatch') return
    if (e.view.phase === 'estimated' && result.reason !== 'replay_mismatch') return carry(e)
    const state = e.state ?? run.state
    setView(e, { phase: 'unclaimed-only', state, reason: result.reason, prices: result.prices })
  }

  /** Starts the run `e` needs now, if any. */
  function next(e: Entry): void {
    if (historyRefs(e) === 0 || e.running || !e.state || !e.growth) return
    const state = e.state
    const view = e.view
    if (view.phase === 'verified' && view.state.block >= state.block) return
    if (e.settled === 'replay_mismatch' || e.settled === 'hooked_pool' || e.settled === 'not_found') return
    // A budget stop is final for that budget; a larger one (a position page after the list) goes on from its checkpoint,
    // or starts over when the stop came before the swap days (2026-09-25: the budget now bounds those steps too).
    if (e.settled === 'too_much_history' && budgetOf(e) <= e.settledBudget) return
    if (e.failures >= RUN_ATTEMPTS) return
    if (e.failedAt !== null && state.block <= e.failedAt) return
    const target = theWorker()
    if (!target) {
      if (view.phase !== 'verified') setView(e, { phase: 'unclaimed-only', state, reason: 'worker_failed', prices: null })
      return
    }
    const run: Run = { state, budget: budgetOf(e) }
    e.running = run
    if (view.phase === 'idle' || view.phase === 'unavailable' || (view.phase === 'loading' && view.state !== state)) setView(e, { phase: 'loading', state })
    target.postMessage({ type: 'run', id: e.id, state, growth: e.growth, budgetBytes: run.budget, checkpoint: e.checkpoint })
  }

  // --- /state ----------------------------------------------------------------

  function applyState(e: Entry, answer: RelayAnswer<StateResponse>): void {
    const position = answer.ok ? answer.value.positions.find((p) => p.tokenId === e.id) : undefined
    e.answered = true
    if (!answer.ok || !position || (!position.ok && position.reason === 'rpc_unavailable')) {
      // A refresh that failed leaves what is known; a first read that failed shows nothing.
      if (!e.state) {
        e.stateReason = 'rpc_unavailable'
        if (historyRefs(e) > 0) setView(e, { phase: 'unavailable', reason: 'rpc_unavailable' })
        notify(e)
      }
      return
    }
    if (!position.ok) {
      e.state = null
      e.growth = null
      e.stateReason = position.reason
      e.settled = position.reason
      setView(e, { phase: 'unavailable', reason: position.reason })
      notify(e)
      return
    }
    const { state, growth } = stateOf(position, answer.value.block, answer.value.timestamp)
    if (e.state && state.block <= e.state.block) return
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

  function scheduleRefresh(): void {
    if (refresh) return
    refresh = deps.later(STATE_REFRESH_MS, () => {
      refresh = null
      const ids = [...entries.values()].filter(shown).map((e) => e.id)
      if (ids.length === 0) return
      ask(ids)
      scheduleRefresh()
    })
  }

  // --- subscriptions ---------------------------------------------------------

  function hold(e: Entry): void {
    e.release?.()
    e.release = null
    stopWorker?.()
    stopWorker = null
  }

  function letGo(e: Entry): void {
    if (shown(e)) return
    e.release?.()
    e.release = deps.timer(RELEASE_MS, () => {
      e.release = null
      if (shown(e)) return
      if (e.running) {
        worker?.postMessage({ type: 'cancel', id: e.id })
        e.running = null
        if (e.view.phase === 'loading') e.view = IDLE
      }
      if (![...entries.values()].some(shown)) {
        refresh?.()
        refresh = null
        stopWorker?.()
        stopWorker = deps.timer(RELEASE_MS, () => {
          stopWorker = null
          if ([...entries.values()].some((other) => other.running)) return
          worker?.terminate()
          worker = null
        })
      }
    })
  }

  function subscribe(ids: readonly string[], listener: () => void, add: (e: Entry, step: 1 | -1) => void): () => void {
    const own = [...new Set(ids)].map(entry)
    for (const e of own) {
      e.listeners.add(listener)
      add(e, 1)
      hold(e)
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
      return () => {
        for (const e of own) e.listeners.delete(listener)
      }
    },
    view(id) {
      return entries.get(id)?.view ?? IDLE
    },
    refresh(ids) {
      const known = (list: readonly string[]) => list.filter((id) => entries.get(id)?.answered)
      ask(known(ids))
      deps.timer(AFTER_ACTION_MS, () => ask(known(ids)))
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
