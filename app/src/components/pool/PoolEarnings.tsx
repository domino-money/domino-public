import { useState, type ReactNode } from 'react'
import { Skeleton } from '../ui'
import { aboutDigits, aboutPercent, amountProblem, earnings, parseAmount, usdShort, usdText } from './plain'
import { numberFormat } from '../../lib/format/numberFormat'

/** The amounts a person can pick with one press. */
const PRESETS = [100, 1_000, 10_000] as const
const presetText = (value: number) => `$${numberFormat().format(value)}`

/**
 * "If you put in $1,000, you could earn about $X a month": an amount the person types, its share of the pool's fees
 * at the pool's own yearly rate (its APR, the page's figure), per month, year and day. The money in the pool (`tvl`,
 * its TVL, where the page has one) shares the same fees, so an amount earns amount / (TVL + amount) of them (plain.ts
 * earnings). Clearly an estimate. `apr` null while the figure is read (`loading`) or when there is none: then one calm
 * line and no amount to type, never a box that can't answer. Shown only for a pool Domino can open positions in.
 * `action` (QA round 2, N84, the owner's yes): the way into New position again, under the estimate, for the one-column
 * page only (phone and tablet portrait, v4-pool.css); the two-column page keeps it in the title row alone.
 * `aprDigits` (QA round 2, N8): the digits the page's APR tile shows for that same rate ("38.8"), so "about X% a year"
 * says exactly the tile's figure; without them the sentence rounds `apr` by the same rule.
 */
export function PoolEarnings({ apr, aprDigits, tvl, loading, saved = false, action }: { apr: number | null; aprDigits?: string | null; tvl: number | null; loading: boolean; saved?: boolean; action?: ReactNode }) {
  const [typed, setTyped] = useState('1,000')
  // V4 (pool.html .eres-v tick): a preset press is one deliberate act, so the figure ticks in; typing updates it at once.
  const [tick, setTick] = useState(0)
  const amount = parseAmount(typed)
  const shown = apr !== null && amount !== null ? earnings(amount, apr, tvl) : null
  const state = apr === null ? (loading ? 'loading' : 'none') : amount === null ? 'no-amount' : 'ready'
  const shared = tvl !== null && tvl > 0
  // The pool's rate in the tile's own digits where the page gives them (N8), else rounded by the same rule.
  const rate = apr === null ? '' : aprDigits && apr > 0 ? aboutDigits(aprDigits) : aboutPercent(apr)
  // The yearly rate the typed amount itself earns (QA round 2, N35): money added shares the fees with the money already in
  // the pool, so it earns less than the pool's own rate, by far for a large amount. Worked out from the figure shown.
  const yours = shown && amount !== null && amount > 0 ? (shown.year / amount) * 100 : null
  // Why the typed text is not an amount, in words that say what to type instead (QA round 2, Q21). While the field is
  // being typed in, a thousands group half typed ("25,0" on the way to "25,000") is not called a decimal comma: that line
  // waits until the field is left (QA round 2 review).
  const [editing, setEditing] = useState(false)
  const midGroup = editing && /,\d{1,2}$/.test(typed.trim())
  const raw = amountProblem(typed)
  const problem = raw === 'format' && midGroup ? null : raw
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
              aria-invalid={(amount === null && !midGroup) || undefined}
              aria-describedby="pool-earn-note"
              // Changed on purpose 2026-10-30 (QA round 2, Q21): no silent cut at 16 characters (twenty nines became
              // 9999999999999999 without a word); the generous cap only keeps a pasted page out. N75: an amount gets its
              // thousands commas once the field is left, never while typing, so the caret never jumps.
              // Cents keep both digits ("1,000.50", never "1,000.5"), as the site writes money.
              onChange={(event) => setTyped(event.currentTarget.value.slice(0, 40))}
              onFocus={() => setEditing(true)}
              onBlur={() => {
                setEditing(false)
                if (amount !== null) setTyped(numberFormat(Number.isInteger(amount) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount))
              }}
            />
          </div>
          <div className="dm-pool-earn-presets" role="group" aria-label="Amounts">
            {PRESETS.map((value) => (
              <button key={value} type="button" className="dm-pool-earn-preset" aria-pressed={amount === value} onClick={() => { setTyped(numberFormat().format(value)); setTick((count) => count + 1) }}>
                {presetText(value)}
              </button>
            ))}
          </div>
          <div className="dm-pool-earn-result" aria-live="polite">
            {shown ? (
              <>
                <p className="dm-pool-earn-lead">You could earn about</p>
                <p key={tick} className="dm-pool-earn-month" data-tick={tick ? '' : undefined}>
                  <span className="dm-fig-lg tnum">{usdText(shown.month)}</span> <span>a month</span>
                </p>
              </>
            ) : state === 'loading' ? (
              <>
                <Skeleton className="dm-pool-earn-skel-lead" />
                <Skeleton className="dm-pool-earn-skel-fig" />
                <Skeleton className="dm-pool-earn-skel-more" />
              </>
            ) : problem === 'large' ? (
              <p className="dm-pool-earn-quiet">Enter an amount up to $1,000,000,000.</p>
            ) : problem === 'format' ? (
              <p className="dm-pool-earn-quiet">Use commas for thousands and a dot for cents, like 1,000.50.</p>
            ) : problem === 'small' ? (
              <p className="dm-pool-earn-quiet">Enter an amount above $0.</p>
            ) : (
              <p className="dm-pool-earn-quiet">Type an amount in dollars.</p>
            )}
          </div>
        </>
      )}
      <p id="pool-earn-note" className="dm-pool-earn-note" data-saved-data={saved ? 'estimate' : undefined}>
        {/* Changed on purpose 2026-10-04: the copy promises nothing, not even in the negative (tests/screen-words.test.mjs).
            Changed on purpose 2026-10-30 (QA round 2, Q8 and N55): it says what the figure leaves out, as Docs > Risks does
            ("fees are not profit"): a price move can cost more than the fees earn, and the network fees. The figure and
            its formula stay as they are (D9). */}
        Estimate only. Fees are earned only inside your range, and a price move can cost more than the fees earn. Network fees to open and close are extra.
      </p>
      {action && <div className="dm-pool-earn-action">{action}</div>}
      {apr !== null && <details className="dm-pool-disclosure" data-pool-earnings-basis="">
        <summary>How it’s estimated<span aria-hidden="true" className="dm-pool-details-chevron" /></summary>
        <div className="dm-pool-disclosure-body">
          {shown && <p className="tnum">{usdText(shown.year)} a year · {usdText(shown.day)} a day</p>}
          {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): "recent rate" whether or not the rate was
              kept from an earlier read; it used to say "At the pool’s saved rate". `saved` stays as data on the note. */}
          {/* QA round 2, N35: with the money already in the pool known, the rate the typed amount itself could earn, so the
              figures above add up; the pool's own rate stays the reference. */}
          {shared && yours !== null && amount !== null
            ? <p>At the pool’s recent rate, about {rate} a year. Your {usdText(amount)} joins the {usdShort(tvl)} already in the pool, so it could earn about {aboutPercent(yours)} a year. Real earnings change with trading and your chosen range.</p>
            : <p>At the pool’s recent rate, about {rate} a year{shared ? `, shared with the ${usdShort(tvl)} already in the pool` : ''}. Real earnings change with trading and your chosen range.</p>}
        </div>
      </details>}
    </section>
  )
}
