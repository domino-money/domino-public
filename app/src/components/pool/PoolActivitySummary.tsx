import type { ReactNode } from 'react'
import type { Instant } from '../../lib/markets'
import { activityAge, heldSeconds, poolActivityView, type AmountPair } from '../../lib/read/screens/figures'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import type { ScreenOutcome } from '../../lib/read/screens/screenRead'
import { SymbolText } from '../read/screens/SymbolText'
import { duration } from '../read/screens/PoolActivityCard'
import { Skeleton } from '../ui'
import { countText, moveWords, numberOf, usdShort, type DaySpan } from './plain'

const DAY = 86_400

/** Both amounts of a pair in words, "15,584 PONS and 9,177.29 USDG"; null when they are not both known. */
function pairWords(pair: AmountPair, option: PoolOption): ReactNode | null {
  if (pair.state !== 'amounts' || pair.amounts.some((amount) => amount.text === null)) return null
  return (
    <>
      <b className="tnum">{pair.amounts[0].text}</b> <SymbolText token={option.currencies[0]} /> and <b className="tnum">{pair.amounts[1].text}</b> <SymbolText token={option.currencies[1]} />
    </>
  )
}

/**
 * The pool's last day in a few plain sentences: how many swaps and how much they were worth, what the people who
 * provide its money earned (in dollars where the pool holds USDG, valued at its own price with 1 USDG = $1, else in
 * each token), which way the price went, and whether the pool is new. From the pool's own chain activity
 * (pool-activity, `read`, where it is listed), its 24h volume (`volume`, the key figure's text) and the chart's last
 * day, each only when it is there: with no chain activity, the volume and the price still speak. While the first
 * figures are read, resting lines; with nothing to say, one calm line (a failed read's reason in its title).
 * `usd` values the fees: the index of USDG in the pool and the price of the other token in USDG.
 */
export function PoolActivitySummary({ read, listed, option, now, day, usd, volume, loading }: {
  read: ScreenOutcome<'pool-activity'> | null
  listed: boolean
  option: PoolOption
  now: Instant
  day: DaySpan | null
  usd: { usdgIndex: 0 | 1; price: number } | null
  volume: string | null
  loading: boolean
}) {
  const answer = read?.state === 'ok' ? read : null
  const age = answer ? activityAge(answer.data.freshness, heldSeconds(answer.provenance, now)) : null
  const view = answer && age?.state !== 'too_old' ? poolActivityView(answer.data, option.currencies) : null
  const lines: ReactNode[] = []
  const worth = volume ? <>, worth about <b className="tnum">{volume}</b></> : null
  if (view) {
    const span = view.windowSeconds === DAY ? 'the last 24 hours' : `the last ${duration(view.windowSeconds)}`
    lines.push(<><b className="tnum">{countText(view.swaps)}</b> {view.swaps === 1 ? 'swap' : 'swaps'} in {span}{view.windowSeconds === DAY ? worth : null}.</>)
    const fees = view.lpFees
    let feeUsd: number | null = null
    if (usd && fees.state === 'amounts') {
      const usdg = numberOf(fees.amounts[usd.usdgIndex].exact)
      const other = numberOf(fees.amounts[usd.usdgIndex === 0 ? 1 : 0].exact)
      feeUsd = usdg !== null && other !== null && usd.price > 0 ? usdg + other * usd.price : null
    }
    const pair = pairWords(fees, option)
    // Swaps that paid the providers nothing (a pool whose extra code takes the fee itself, say) say so, never "$0.00".
    if (fees.state === 'amounts' && fees.amounts.every((amount) => numberOf(amount.exact) === 0)) lines.push(<>These swaps paid no fees to the people who provide the pool’s money.</>)
    else if (feeUsd !== null) lines.push(<>People who provide the pool’s money earned about <b className="tnum">{usdShort(feeUsd)}</b> in fees.</>)
    else if (pair) lines.push(<>People who provide the pool’s money earned {pair} in fees.</>)
    if (view.age) lines.push(<>The pool is new: it opened {duration(view.age.seconds)} ago.</>)
  } else if (volume) lines.push(<>People swapped about <b className="tnum">{volume}</b> here in the last 24 hours.</>)
  const first = numberOf(day?.first)
  const last = numberOf(day?.last)
  if (day?.whole && first !== null && last !== null) lines.push(<>The price {moveWords(first, last)} over the last day.</>)

  // Resting while the figures that speak first are still on their way (so no sentence is swapped for another), and one
  // calm line when nothing can speak.
  const waiting = (listed && read === null) || (loading && !view)
  const state = waiting ? 'loading' : lines.length ? 'ready' : 'none'
  return (
    // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): no title with a failed read's words or "The
    // pool’s activity has not been indexed recently.", and with nothing to say the card shows the dash every empty value
    // shows; it used to say "Recent activity for this pool isn’t available right now."
    <section className="dm-card dm-pool-card dm-pool-recent" aria-labelledby="pool-recent-title" data-pool-activity-summary={state} data-activity-source={view ? 'chain' : 'market'}>
      <details className="dm-pool-recent-disclosure">
      <summary><h2 id="pool-recent-title" className="dm-title">Recent activity</h2><span aria-hidden="true" className="dm-pool-details-chevron" /></summary>
      {state === 'ready' ? (
        <ul className="dm-pool-recent-list">
          {lines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      ) : state === 'loading' ? (
        <div className="dm-pool-recent-list" aria-hidden="true">
          <Skeleton className="dm-pool-recent-skel" />
          <Skeleton className="dm-pool-recent-skel" />
        </div>
      ) : (
        <p className="dm-pool-quiet-line"><span className="text-fg-subtle">—</span></p>
      )}
      <p role="status" className="sr-only">
        {state === 'loading' ? 'Reading recent activity…' : ''}
      </p>
      </details>
    </section>
  )
}
