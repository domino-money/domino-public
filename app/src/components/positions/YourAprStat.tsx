import { useMemo, type ReactNode } from 'react'
import { Skeleton, Stat } from '../ui'
import { useLoadMilestone } from '../../lib/useLoadMilestone'
import { historyLoadQuality } from '../../lib/fees/freshness'
import type { FeeHistoryView } from '../../lib/fees/types'
import { shortDate, shortTime } from '../../lib/format/time'
import { APR_MISSING, aprText, positionApr, spanText } from '../../lib/positionApr'
import { usdgSide } from './visual/value'

/**
 * Your APR: the rate since the position opened, at today's prices, and over the last 24 hours when its chart has a
 * measured point about a day old (lib/positionApr.ts). A skeleton while its history is read; a dash with a few plain
 * words when no rate can be said. Changed on purpose 2026-10-02 (RPC-SPEC §11.4): no estimate any more, and the last
 * 24 hours only from a measured point. Since the chart's periods came back (the same day), that point is the card's 24H
 * start, read at a past block when the history has none a day old (lib/fees/pastReads.ts); the line's title says from
 * when and which block. Changed on purpose 2026-11-04 (the owner: every chain the same): the view is handed in, so one
 * tile serves Robinhood Chain's ledger (KeyFigures.tsx) and read-v6's stored history.
 */
export function YourAprStat({ fees, compact = false, closed = false }: { fees: FeeHistoryView; compact?: boolean; closed?: boolean }) {
  const drawn = fees.phase === 'verified' || fees.phase === 'cached' ? fees : null
  const rates = useMemo(() => {
    if (!drawn) return null
    const into = usdgSide(drawn.state.currencies) ?? 1
    return { all: positionApr(drawn.history, drawn.state, into, 'all'), day: positionApr(drawn.history, drawn.state, into, '24h') }
  }, [drawn])
  const saved = fees.phase === 'cached' ? fees : null
  useLoadMilestone('position', 'apr', rates?.all.ok ? historyLoadQuality(fees) : null)
  let figure: ReactNode = <span className="text-fg-subtle">—</span>
  // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): a dash with nothing under it while there is no
  // rate; it said "Couldn’t load yet", "Not measured for this position", "Not measured yet" or lib/positionApr.ts
  // APR_MISSING ("Waiting for the first reading", "No price to measure it", "Not measured a day ago"), except "Nothing in
  // the position", which is the position's own state. A saved copy's rate said "Last available history" and "Through …
  // · not current" to a screen reader, and its title that it was not a current rate.
  let sub: ReactNode = null
  // (QA round 2, N45) Never a skeleton for a closed position: its history may never settle (a close the ledger does not
  // hold), and the grey bar stayed forever. The dash until a rate can be said; the rate itself is unchanged (D9).
  if ((fees.phase === 'idle' || fees.phase === 'loading') && !closed) {
    figure = <Skeleton className="dm-pos-skel-fig" />
  } else if (rates && !rates.all.ok) sub = rates.all.reason === 'empty' ? APR_MISSING.empty : null
  else if (rates?.all.ok) {
    const { all, day } = rates
    figure = aprText(all.rate)
    // A history that starts at Domino's first block on its chain, not at the mint, says from when.
    const from = drawn?.history.fromFloor ? `Since ${shortDate(all.from.t)}` : `Since opened (${spanText(all.seconds)})`
    sub = (
      <span className="dm-pos-lines">
        <span title={`Measured from ${shortDate(all.from.t)} ${shortTime(all.from.t)}, block ${all.from.block}, over ${spanText(all.seconds)}`}>{from}</span>
        {day.ok && (
          <span data-apr-day="" title={`Measured from ${shortDate(day.from.t)} ${shortTime(day.from.t)}, block ${day.from.block}, to now (${spanText(day.seconds)})`}>
            Last 24 hours: {aprText(day.rate)}
          </span>
        )}
      </span>
    )
  }
  return (
    <Stat
      label="Your APR"
      info="This position’s own fees so far, annualized at today’s prices over the money in it. Short periods can change quickly. Not a forecast of future earnings."
      className="dm-pos-stat"
      data-cell="apr"
      data-apr={rates ? (rates.all.ok ? 'ready' : rates.all.reason) : fees.phase}
      data-apr-source={saved ? 'saved-public-history' : undefined}
      sub={compact && rates?.all.ok ? <details className="dm-position-figure-detail"><summary>Period details</summary>{sub}</details> : sub}
    >
      <span className="dm-fig-lg dm-pos-apr">{figure}</span>
    </Stat>
  )
}
