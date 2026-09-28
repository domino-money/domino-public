/**
 * Your APR on the Your positions table (the owner, round 6, 2026-09-27: add each position's APR there). The same
 * number as the position page's Your APR (KeyFigures.tsx, lib/positionApr.ts: since the position opened), from the
 * same fees history, which the fees store keeps per position for the visit (lib/fees/store.ts): a position whose page
 * was opened shows its APR on the list at once, with nothing read again.
 *
 * The others are measured here, lazily (the queue below): one position at a time, only the list's open rows that are
 * on the screen, only while the tab is visible, each through the fees store exactly as its page would (the same run,
 * so a page opened meanwhile takes that run over, and one opened later has its history at once). Low priority by the
 * fees worker's own lane (lib/chain/browser.ts LANE_PACE): it reads the RPC paced, one request at a time, never while
 * the page itself reads nor just after, and rests after a refusal. And bounded here:
 *
 * - a position is let go as soon as its history can be drawn (verified, or a busy pool's estimate: the page's own first
 *   figure), or said it cannot be, or at CAP_MS: the store then stops its run within its RELEASE_MS, cleanly, inside
 *   the page's own time (BUDGET_MS.page), so a page opened later starts it afresh, estimate first;
 * - each position is asked once a visit; one the RPC refused, once more a minute later at the earliest (its /state read
 *   asked again too); one let go at its cap, once more after the lane's rest; a second try only once no first ask is
 *   left on the screen;
 * - after a refusal nothing more is asked for REST_MS (the lane's rest, LANE_PACE.restMs);
 * - a pool whose history is too much even for a position's page (too_much_history) is not asked again for its other
 *   positions this visit;
 * - GAP_MS between two positions, SETTLE_MS when the one let go still had a run on its way: never two runs at once.
 *
 * A row waits with a calm pulse as long as it will be asked (a second try included), so its cell never goes from a dash
 * back to a pulse. Nothing is kept in the browser: memory only, for the visit, as the fees store. Pure and Node-safe
 * (the tests drive the queue with the real fees store or a fake); OwnedPositions.tsx gives it the page's fees store.
 */
import type { FeesStore } from '../../lib/fees/store'
import type { FeeHistoryView, FeesReason } from '../../lib/fees/types'
import { APR_MISSING, aprText, positionApr } from '../../lib/positionApr'
import { usdgSide } from './visual/value'

/** What a row's APR cell shows. */
export type RowApr =
  | { kind: 'rate'; text: string; estimated: boolean }
  /** The history is drawn but says no rate (under 6 hours, nothing earned yet...): a dash, the reason in words. */
  | { kind: 'missing'; words: string }
  /** Being measured, or waiting its turn: a calm placeholder. */
  | { kind: 'waiting' }
  /** Not measured on the list (asked and not drawable, or not asked in this build): a dash. */
  | { kind: 'none' }

const drawnMemo = new WeakMap<object, RowApr>()

/** The APR a drawn history gives, as the page's Your APR writes it; null while the view has no history to draw. */
export function aprOfView(view: FeeHistoryView): RowApr | null {
  if (view.phase !== 'verified' && view.phase !== 'estimated') return null
  const kept = drawnMemo.get(view)
  if (kept) return kept
  const all = positionApr(view.history, view.state, usdgSide(view.state.currencies) ?? 1, 'all')
  const apr: RowApr = all.ok ? { kind: 'rate', text: aprText(all.rate), estimated: view.phase === 'estimated' } : { kind: 'missing', words: APR_MISSING[all.reason] }
  drawnMemo.set(view, apr)
  return apr
}

/**
 * How long one position is held at most, from the moment it is asked (its /state read and the worker's start count):
 * the page's own time (BUDGET_MS.page, 30 s from its run's start) less the store's RELEASE_MS and a margin, so the store
 * stops the run before it could stop at its time with its place kept (a page opened later then starts afresh).
 * 2026-09-28 (review): 14 s let the owner's own 3325113 go for good when the RPC answered in 400 ms a call (its page drew
 * it in 19.6 s).
 */
export const CAP_MS = 24_000
/** Between two positions whose runs are over. */
export const GAP_MS = 1_000
/**
 * After a position let go with its run still on its way (at its cap, mid-way, or at a busy pool's estimate, whose exact
 * read goes on): past the store's RELEASE_MS, which stops it, so two runs never share the worker. Also how long a run
 * found on its way (a page's, just left) is given before it is looked at again.
 */
export const SETTLE_MS = 4_000
/** After a refusal: the lane's rest (lib/chain/browser.ts LANE_PACE.restMs), nothing asked meanwhile; a capped position's second try waits as long. */
export const REST_MS = 30_000
/** A position the RPC refused is asked once more, no sooner than this after. */
export const AGAIN_MS = 60_000

/** One open row on the screen: its NFT and its pool. */
export interface AprRow {
  id: string
  pool: string
}

/** The part of the fees store the queue uses (lib/fees/store.ts: spawn.ts feesStore in the app; the real store or a fake in the tests). */
export type AprStore = Pick<FeesStore, 'view' | 'subscribeHistory' | 'refresh'>

export interface AprQueueDeps {
  store: AprStore
  /** A plain timer; returns its cancel. */
  timer(ms: number, run: () => void): () => void
  /** Whether the tab is visible. */
  visible(): boolean
  now(): number
}

export interface AprQueue {
  /** The open rows on the screen now, in the list's order (none: stop). */
  want(rows: readonly AprRow[]): void
  /** The tab was shown or hidden. */
  wake(): void
  /** Whether a position will be (or is being) measured, now or on a later try: its cell waits calmly meanwhile. */
  pending(id: string, pool: string): boolean
  /** Tells `listener` when `pending` may have changed. */
  subscribe(listener: () => void): () => void
  /** A number that changes whenever `pending` may have (for useSyncExternalStore). */
  version(): number
}

type Tried = { at: number; reason: FeesReason | 'drawn' | 'cap'; times: number }

export function createAprQueue({ store, timer, visible, now }: AprQueueDeps): AprQueue {
  let wanted: readonly AprRow[] = []
  const tried = new Map<string, Tried>()
  const heavyPools = new Set<string>()
  const listeners = new Set<() => void>()
  let current: { row: AprRow; stop: () => void } | null = null
  let restUntil = 0
  let waking: (() => void) | null = null
  let changes = 0

  const tell = () => {
    changes += 1
    for (const listener of Array.from(listeners)) listener()
  }
  /** Whether `row` may be asked now (false: not again this visit; a time: not before it). */
  const due = (row: AprRow): boolean | number => {
    const view = store.view(row.id)
    // Drawn already (its page was opened, or measured before), or its pool's history is too much: nothing to ask.
    if (heavyPools.has(row.pool) || view.phase === 'verified' || view.phase === 'estimated') return false
    const before = tried.get(row.id)
    const at = now()
    // Asked here before: once more after a refusal (a minute later) or its cap (after the lane's rest), never a third
    // time. Not yet: a position no page read, one on its way elsewhere, or one whose read the RPC refused elsewhere.
    let when = before
      ? before.times < 2 && (before.reason === 'rpc_unavailable' ? before.at + AGAIN_MS : before.reason === 'cap' && before.at + REST_MS)
      : view.phase === 'idle' || view.phase === 'loading' || (view as { reason?: FeesReason }).reason === 'rpc_unavailable'
    // A run still on its way (one let go a moment ago: the store stops it RELEASE_MS later): looked at after that.
    if (when !== false && view.phase === 'loading') when = Math.max(+when, at + SETTLE_MS)
    return typeof when === 'number' ? when <= at || when : when
  }

  function schedule(ms: number): void {
    waking?.()
    waking = timer(ms, () => {
      waking = null
      pump()
    })
  }

  function pump(): void {
    if (current || wanted.length === 0 || !visible()) return
    const at = now()
    if (at < restUntil) return schedule(restUntil - at)
    let soonest = Infinity
    let again: AprRow | undefined
    for (const row of wanted) {
      const when = due(row)
      // A first ask goes before a second try (a refused or capped position), whatever its place in the list.
      if (when === true && !tried.has(row.id)) return start(row)
      if (when === true) again ??= row
      else if (when) soonest = Math.min(soonest, when)
    }
    if (again) return start(again)
    if (soonest < Infinity) schedule(soonest - at)
  }

  function start(row: AprRow): void {
    const before = store.view(row.id)
    let done = false
    let release: (() => void) | null = null
    const finish = (reason: Tried['reason'] | null) => {
      if (done) return
      done = true
      cap()
      release?.()
      current = null
      const at = now()
      // The pause before the next, whatever asks for it (a scroll, the list's refresh): the lane's rest after a refusal,
      // and past the store's stop of a run still on its way.
      const live = !reason || reason === 'cap' || store.view(row.id).phase === 'estimated'
      restUntil = at + (reason === 'rpc_unavailable' || reason === 'worker_failed' ? REST_MS : live ? SETTLE_MS : GAP_MS)
      // Let go without an outcome (the row left the screen, the tab was hidden): asked again when it is back.
      if (reason) {
        tried.set(row.id, { at, reason, times: (tried.get(row.id)?.times ?? 0) + 1 })
        if (reason === 'too_much_history') heavyPools.add(row.pool)
      }
      tell()
      pump()
    }
    const check = () => {
      const view = store.view(row.id)
      if (view.phase === 'verified' || view.phase === 'estimated') finish('drawn')
      // A view that was already quiet before this run (an earlier refusal) is its old answer: wait for this run's own.
      else if ((view.phase === 'unclaimed-only' || view.phase === 'unavailable') && view !== before) finish(view.reason)
    }
    const cap = timer(CAP_MS, () => finish('cap'))
    current = { row, stop: () => finish(null) }
    // 2026-09-28 (review): a /state read the RPC refused stays the store's answer (it asks a position's state once a
    // visit, then only for what is shown): this try asks it again, through the store's public refresh.
    if (before.phase === 'unavailable' && before.reason === 'rpc_unavailable') store.refresh([row.id])
    // The page's own scope: the same run its page would start, so the page takes it over or finds it done.
    const held = store.subscribeHistory([row.id], 'page', check)
    // Answered while it was being held (a store that knew it could not be read): let go at once.
    if (done) return held()
    release = held
    tell()
    check()
  }

  return {
    want(rows) {
      wanted = rows
      // The one being measured left the screen: let go, and the next after the usual pause.
      if (current && !rows.some((row) => row.id === current?.row.id)) return current.stop()
      pump()
    },
    wake() {
      if (!visible()) current?.stop()
      pump()
    },
    pending(id, pool) {
      return current?.row.id === id || due({ id, pool }) !== false
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    version: () => changes,
  }
}

const WAITING: RowApr = { kind: 'waiting' }
const NONE: RowApr = { kind: 'none' }

/**
 * Each open row's APR cell: the drawn history's (the store's views, for the visit), else a calm bubble while `queue`
 * will measure it, else a dash. `queue` null: nothing is measured here (a test build that did not ask for it).
 */
export function rowAprs(rows: readonly AprRow[], views: ReadonlyMap<string, FeeHistoryView>, queue: AprQueue | null): ReadonlyMap<string, RowApr> {
  const aprs = new Map<string, RowApr>()
  for (const row of rows) {
    const view = views.get(row.id)
    aprs.set(row.id, (view && aprOfView(view)) ?? (queue?.pending(row.id, row.pool) ? WAITING : NONE))
  }
  return aprs
}
