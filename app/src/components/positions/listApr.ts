/**
 * The list uses the detail page's APR arithmetic over the same history. This pure module never starts a read.
 * Visible rows may be warmed by the separately bounded, cancellable useAprPrefetch adapter; an open detail wins.
 * A restored public history keeps its original block/time and an explicit saved label, never current authority.
 */
import type { FeeHistoryView } from '../../lib/fees/types'
import { APR_MISSING, aprText, positionApr } from '../../lib/positionApr'
import { usdgSide } from './visual/value'

/** What a row's APR cell shows. */
export type RowApr =
  | { kind: 'rate'; text: string; estimated: boolean; saved?: { at: number; block: number; timestamp: number } }
  /** The history is drawn but says no rate (under 6 hours, nothing earned yet...): a dash, the reason in words. */
  | { kind: 'missing'; words: string }
  /** No usable current or saved history: a calm dash. */
  | { kind: 'none' }

const drawnMemo = new WeakMap<object, RowApr>()

/** The APR a drawn history gives, as the page's Your APR writes it; null while the view has no history to draw. */
export function aprOfView(view: FeeHistoryView): RowApr | null {
  if (view.phase !== 'verified' && view.phase !== 'estimated' && view.phase !== 'cached') return null
  const kept = drawnMemo.get(view)
  if (kept) return kept
  const all = positionApr(view.history, view.state, usdgSide(view.state.currencies) ?? 1, 'all')
  const apr: RowApr = all.ok ? { kind: 'rate', text: aprText(all.rate), estimated: view.phase === 'estimated', ...(view.phase === 'cached' ? { saved: { at: view.savedAt, block: view.state.block, timestamp: view.state.timestamp } } : {}) } : { kind: 'missing', words: view.phase === 'cached' ? `Saved history: ${APR_MISSING[all.reason]}. Not current.` : APR_MISSING[all.reason] }
  drawnMemo.set(view, apr)
  return apr
}

const NONE: RowApr = { kind: 'none' }

/** Each row's APR cell, by its token id: the store's drawn history, else a dash. */
export function rowAprs(ids: readonly string[], views: ReadonlyMap<string, FeeHistoryView>): ReadonlyMap<string, RowApr> {
  const aprs = new Map<string, RowApr>()
  for (const id of ids) {
    const view = views.get(id)
    aprs.set(id, (view && aprOfView(view)) ?? NONE)
  }
  return aprs
}
