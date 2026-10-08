/**
 * The list uses the detail page's APR arithmetic over the same history. This pure module never starts a read. Changed on
 * purpose 2026-10-02 (RPC-SPEC §11.4): the list's rows ask their ledgers (eight a request, useRowAprs in
 * OwnedPositions.tsx), so every row whose ledger is exact shows its rate since opened; there is no estimate any more.
 * A restored public history keeps its original block/time and an explicit saved label, never current authority.
 */
import type { FeeHistoryView } from '../../lib/fees/types'
import { APR_MISSING, aprText, positionApr } from '../../lib/positionApr'
import { usdgSide } from './visual/value'

/** What a row's APR cell shows. */
export type RowApr =
  | { kind: 'rate'; text: string; saved?: { at: number; block: number; timestamp: number } }
  /**
   * The history is drawn but has no elapsed time or usable value: a dash, the reason in words. `short`: a
   * word shown beside the dash in place of "on its page", when its page has no figure either (2026-10-02, finding 11).
   */
  | { kind: 'missing'; words: string; short?: string }
  /** No usable current or saved history: a calm dash. */
  | { kind: 'none' }
  /** 2026-10-01 (item A18): its history is being read now: a skeleton, not a dash. */
  | { kind: 'loading' }

const drawnMemo = new WeakMap<object, RowApr>()

/** The APR a drawn history gives, as the page's Your APR writes it; null while the view has no history to draw. */
export function aprOfView(view: FeeHistoryView): RowApr | null {
  if (view.phase !== 'verified' && view.phase !== 'cached') return null
  const kept = drawnMemo.get(view)
  if (kept) return kept
  const all = positionApr(view.history, view.state, usdgSide(view.state.currencies) ?? 1, 'all')
  const apr: RowApr = all.ok ? { kind: 'rate', text: aprText(all.rate), ...(view.phase === 'cached' ? { saved: { at: view.savedAt, block: view.state.block, timestamp: view.state.timestamp } } : {}) } : { kind: 'missing', words: view.phase === 'cached' ? `Saved history: ${APR_MISSING[all.reason]}. Not current.` : APR_MISSING[all.reason] }
  drawnMemo.set(view, apr)
  return apr
}

const NONE: RowApr = { kind: 'none' }
const LOADING: RowApr = { kind: 'loading' }

/** A ledger that cannot measure this position's fees earned (an owner's add or withdrawal, say): a dash and why, in its title. */
const NOT_MEASURED: RowApr = { kind: 'missing', words: 'Not measured for this position', short: 'not measured' }

/** Each row's APR cell, by its token id: the store's drawn history, a skeleton while one is read, else a dash. */
export function rowAprs(ids: readonly string[], views: ReadonlyMap<string, FeeHistoryView>): ReadonlyMap<string, RowApr> {
  const aprs = new Map<string, RowApr>()
  for (const id of ids) {
    const view = views.get(id)
    aprs.set(id, (view && aprOfView(view)) ?? (view?.phase === 'loading' ? LOADING : view?.phase === 'unclaimed-only' && view.reason === 'not_exact' ? NOT_MEASURED : NONE))
  }
  return aprs
}
