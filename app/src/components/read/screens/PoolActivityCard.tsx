import type { ReactNode } from 'react'
import type { Instant } from '../../../lib/markets'
import { COPY } from '../../../lib/read/screens/copy'
import { ACTIVITY_TOO_OLD, activityAge, heldSeconds, poolActivityView, type AmountPair, type TokenAmount } from '../../../lib/read/screens/figures'
import type { PoolOption } from '../../../lib/read/screens/poolsList'
import type { ScreenOutcome } from '../../../lib/read/screens/screenRead'
import { Skeleton } from '../../ui'
import { SymbolText } from './SymbolText'

/** A duration the way the activity card says it: seconds, minutes, then hours and minutes. */
export const duration = (seconds: number) =>
  seconds < 120 ? `${seconds} s` : seconds < 7200 ? `${Math.floor(seconds / 60)} min` : `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`

const DAY_SECONDS = 86400

const Dash = ({ title }: { title?: string }) => (
  <span className="text-fg-subtle" title={title}>
    —
  </span>
)

/**
 * One amount in its token's units, the exact amount in its title; a dash when the token's decimals were not read.
 * Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the dashes have no title; they used to say "Not
 * reported" and "Raw amount <raw>: the token’s decimals were not read".
 */
export function Amount({ amount }: { amount: TokenAmount | null }) {
  if (!amount) return <Dash />
  if (amount.text === null) return <Dash />
  return (
    <span className="tnum" title={amount.exact ?? undefined}>
      {amount.text}
    </span>
  )
}

/**
 * Both amounts of a pair, or a dash in each cell where there are none.
 * Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the dashes no longer carry "Unavailable: <reason>".
 */
export function PairCells({ pair }: { pair: AmountPair }) {
  if (pair.state === 'unavailable') {
    return (
      <>
        <td><Dash /></td>
        <td><Dash /></td>
      </>
    )
  }
  return (
    <>
      <td><Amount amount={pair.amounts[0]} /></td>
      <td><Amount amount={pair.amounts[1]} /></td>
    </>
  )
}

/** The two currencies over a table's amount columns, in the pool's order. */
export function CurrencyHead({ option, first }: { option: PoolOption; first: ReactNode }) {
  return (
    <thead>
      <tr>
        <th scope="col">{first}</th>
        <th scope="col"><SymbolText token={option.currencies[0]} /></th>
        <th scope="col"><SymbolText token={option.currencies[1]} /></th>
      </tr>
    </thead>
  )
}

/**
 * The pool's own chain activity over the window up to its last indexed block —
 * 24 hours from the index, or the hours a live window reached back, which the
 * card's own labels say: swaps, turnover per token, LP fees once fee accounting is
 * reconciled, and the pool's LP assets, in each token's units. Nothing here
 * is in dollars and nothing is an APR. The card is on the page only where
 * pool-activity is listed; while its read runs the figures rest, and when
 * there is no answer each figure is a dash with the reason in the card's
 * title. Activity a little behind the chain reads the same, stale in its
 * title; activity more than 15 minutes behind (figures.ts) is not the last
 * 24 hours, so it is dashes too, with how far behind in the title. Its age
 * counts on while the page is open (`now`). `embedded`: drawn inside the pool page's Details, without a card of its own.
 */
export function PoolActivityCard({ read, option, now, embedded = false }: { read: ScreenOutcome<'pool-activity'> | null; option: PoolOption; now?: Instant; embedded?: boolean }) {
  const answer = read?.state === 'ok' ? read : null
  const age = answer ? activityAge(answer.data.freshness, now ? heldSeconds(answer.provenance, now) : 0) : null
  const tooOld = age?.state === 'too_old'
  // Pool age, the window and every amount come from the snapshot, so a snapshot too far behind gives none of them.
  const view = answer && !tooOld ? poolActivityView(answer.data, option.currencies) : null
  const failure = read && read.state !== 'ok' && read.state !== 'aborted' ? read : null
  // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): no reason on the card, its dashes or its live
  // region any more: the failed read's words (failureText), "Stale: indexed <lag> behind the chain head, at block <n>."
  // and "…, too far behind to show as the last 24 hours." are gone; `data-pool-activity` and `data-activity-reason` keep
  // the state, as data.
  const blocked = failure !== null || tooOld
  const state = view ? (age?.state === 'stale' ? 'stale' : 'ok') : blocked ? 'unavailable' : 'loading'
  const code = failure ? (failure.state === 'unavailable' && failure.cause.kind === 'producer' ? failure.cause.code : failure.state) : tooOld ? ACTIVITY_TOO_OLD : undefined
  const cell = (node: ReactNode) => (view ? node : blocked ? <Dash /> : <Skeleton className="ml-auto h-4 w-16" />)
  // The facts are tiles with their figures on the left: their resting bubbles sit there too.
  const fact = (node: ReactNode) => (view ? node : blocked ? <Dash /> : <Skeleton className="dm-pool-fact-skel" />)
  // The figures cover the span the read asked for. That is 24 h for a stored
  // window; a live window is bounded by a block count and blocks here are far
  // shorter than a second, so it reaches back hours. The card says which it is
  // rather than labelling hours as a day.
  const windowSeconds = view?.windowSeconds ?? DAY_SECONDS
  const span = windowSeconds === DAY_SECONDS ? '24h' : duration(windowSeconds)
  const spanText = span === '24h' ? '24 h' : span
  const Heading = embedded ? 'h3' : 'h2'
  const blank = (
    <>
      <td>{cell(null)}</td>
      <td>{cell(null)}</td>
    </>
  )
  return (
    <section className={embedded ? 'dm-pool-embedded' : 'dm-card dm-pool-card dm-pool-a-activity animate-rise [--delay:80ms]'} aria-labelledby="pool-activity-title" data-pool-activity={state} data-activity-reason={code}>
      {/* Inside the pool page's Details (round 6) it is a part of that card, under its own smaller heading. */}
      <Heading id="pool-activity-title" className={embedded ? 'dm-pool-embedded-title' : 'dm-title'} title={COPY.figures.activityScope}>On-chain activity</Heading>
      <p role="status" className="sr-only">{state === 'loading' ? 'Reading pool activity…' : ''}</p>
      {/* The four facts as tiles (pool.css); the dt/dd order is the reading order. */}
      <dl className="dm-pool-facts">
        <div><dt>Swaps ({span})</dt><dd>{fact(view && view.swaps.toLocaleString('en-US'))}</dd></div>
        <div><dt>Pool age</dt><dd>{fact(view && (view.age ? duration(view.age.seconds) : `Older than ${spanText}`))}</dd></div>
        <div><dt>Window</dt><dd>{fact(view && (view.window === 'covered' ? `${spanText} covered` : `${duration(view.observedSeconds)} observed`))}</dd></div>
        <div><dt>Blocks covered</dt><dd>{fact(view && `${view.coveredFromBlock} to ${view.block}`)}</dd></div>
      </dl>
      {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the note under a live window ("This pool is
          not in the activity index yet. … its positions are unavailable until indexing catches up.") is gone; the labels
          already name the span, and `data-activity-live` stays as data. */}
      {view?.live ? <span hidden data-activity-live="" /> : null}
      <div className="dm-pool-table-wrap">
        <table className="dm-pool-table" data-activity-amounts="">
          <CurrencyHead option={option} first={<span className="sr-only">Figure</span>} />
          <tbody>
            <tr data-activity-row="turnover">
              <th scope="row">Turnover ({span})</th>
              {view ? <><td><Amount amount={view.turnover[0]} /></td><td><Amount amount={view.turnover[1]} /></td></> : blank}
            </tr>
            <tr data-activity-row="lp-fees">
              <th scope="row">LP fees ({span})</th>
              {view ? <PairCells pair={view.lpFees} /> : blank}
            </tr>
            <tr data-activity-row="lp-assets">
              <th scope="row">LP assets</th>
              {view ? <PairCells pair={view.lpAssets} /> : blank}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  )
}
