/**
 * Your APR on the Your positions table (the owner, round 6, 2026-09-27: add each position's APR there). The same
 * number as the position page's Your APR (KeyFigures.tsx, lib/positionApr.ts: since the position opened), from the
 * same fees history, which the fees store keeps per position for the visit (lib/fees/store.ts): a position whose page
 * was opened shows its APR on the list at once, with nothing read again.
 *
 * 2026-09-28 (the owner: from that morning, for everyone, a position's Fees earned chart and Your APR often did not
 * show, and it took many reloads): the list measures nothing itself any more. Its queue replayed each open position's
 * history from the list, at a position page's budget, in every tab showing it: live that evening it drew the RPC's
 * refusals of the list's own read, and a history it could not finish stayed the fees store's answer for the visit, so
 * the position's page opened from the list showed its unclaimed figure only, read nothing more, and only a reload
 * brought the chart back. A row whose page was not opened this visit shows the calm dash ("Shown on the position's
 * page"). Pure and Node-safe; nothing is kept in the browser.
 */
import type { FeeHistoryView } from '../../lib/fees/types'
import { APR_MISSING, aprText, positionApr } from '../../lib/positionApr'
import { usdgSide } from './visual/value'

/** What a row's APR cell shows. */
export type RowApr =
  | { kind: 'rate'; text: string; estimated: boolean }
  /** The history is drawn but says no rate (under 6 hours, nothing earned yet...): a dash, the reason in words. */
  | { kind: 'missing'; words: string }
  /** No history drawn this visit (its page was not opened, or could not draw one): a calm dash. */
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

const NONE: RowApr = { kind: 'none' }

/** Each row's APR cell, by its token id: the drawn history's (the fees store's views, for the visit), else a dash. */
export function rowAprs(ids: readonly string[], views: ReadonlyMap<string, FeeHistoryView>): ReadonlyMap<string, RowApr> {
  const aprs = new Map<string, RowApr>()
  for (const id of ids) {
    const view = views.get(id)
    aprs.set(id, (view && aprOfView(view)) ?? NONE)
  }
  return aprs
}
