import { useState } from 'react'
import { Skeleton } from '../ui'
import { aboutPercent, earnings, parseAmount, usdShort, usdText } from './plain'

/** The amounts a person can pick with one press. */
const PRESETS = [100, 1_000, 10_000] as const
const presetText = (value: number) => `$${new Intl.NumberFormat('en-US').format(value)}`

/**
 * "If you put in $1,000, you could earn about $X a month": an amount the person types, its share of the pool's fees
 * at the pool's own yearly rate (its APR, the page's figure), per month, year and day. The money in the pool (`tvl`,
 * its TVL, where the page has one) shares the same fees, so an amount earns amount / (TVL + amount) of them (plain.ts
 * earnings). Clearly an estimate. `apr` null while the figure is read (`loading`) or when there is none: then one calm
 * line and no amount to type, never a box that can't answer. Shown only for a pool Domino can open positions in.
 */
export function PoolEarnings({ apr, tvl, loading }: { apr: number | null; tvl: number | null; loading: boolean }) {
  const [typed, setTyped] = useState('1,000')
  const amount = parseAmount(typed)
  const shown = apr !== null && amount !== null ? earnings(amount, apr, tvl) : null
  const state = apr === null ? (loading ? 'loading' : 'none') : amount === null ? 'no-amount' : 'ready'
  const shared = tvl !== null && tvl > 0
  return (
    <section className="dm-card dm-pool-card dm-pool-earn" aria-labelledby="pool-earn-title" data-pool-earnings={state}>
      <h2 id="pool-earn-title" className="dm-title">
        Estimate your earnings
      </h2>
      {state === 'none' ? (
        <p className="dm-pool-lead">There’s no recent fee rate for this pool to estimate from.</p>
      ) : (
        <>
          <label className="dm-pool-earn-ask" htmlFor="pool-earn-amount">
            If you put in
          </label>
          <div className="dm-pool-earn-field">
            <span aria-hidden="true">$</span>
            <input
              id="pool-earn-amount"
              className="dm-pool-earn-input tnum"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              aria-invalid={amount === null || undefined}
              aria-describedby="pool-earn-note"
              onChange={(event) => setTyped(event.currentTarget.value.slice(0, 16))}
            />
          </div>
          <div className="dm-pool-earn-presets" role="group" aria-label="Amounts">
            {PRESETS.map((value) => (
              <button key={value} type="button" className="dm-pool-earn-preset" aria-pressed={amount === value} onClick={() => setTyped(new Intl.NumberFormat('en-US').format(value))}>
                {presetText(value)}
              </button>
            ))}
          </div>
          <div className="dm-pool-earn-result" aria-live="polite">
            {shown ? (
              <>
                <p className="dm-pool-earn-lead">You could earn about</p>
                <p className="dm-pool-earn-month">
                  <span className="dm-fig-lg tnum">{usdText(shown.month)}</span> <span>a month</span>
                </p>
                <p className="dm-pool-earn-more tnum">
                  {usdText(shown.year)} a year · {usdText(shown.day)} a day
                </p>
              </>
            ) : state === 'loading' ? (
              <>
                <Skeleton className="dm-pool-earn-skel-lead" />
                <Skeleton className="dm-pool-earn-skel-fig" />
                <Skeleton className="dm-pool-earn-skel-more" />
              </>
            ) : (
              <p className="dm-pool-earn-quiet">Type an amount in dollars.</p>
            )}
          </div>
        </>
      )}
      <p id="pool-earn-note" className="dm-pool-earn-note">
        {apr !== null && `An estimate at the pool’s recent rate, about ${aboutPercent(apr)} a year${shared ? `, shared with the ${usdShort(tvl)} already in the pool` : ''}. `}Real earnings change with trading, and a position earns only while the price is inside its range.
      </p>
    </section>
  )
}
