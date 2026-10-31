import type { CSSProperties, ReactNode } from 'react'
import { numberFormat } from '../../lib/format/numberFormat'
import { logShare, numberOf, type DaySpan, type RangeGuide } from './plain'

/**
 * A price as the range's ends write it, six significant digits (QA round 2, N16: the title read 2233.295334248859, and
 * the bar's accessible name the pool price the same way).
 */
const priceText = (value: number) => numberFormat({ maximumSignificantDigits: 6 }).format(value)

/** Left and width of a stretch of the bar, in percent. */
const stretch = (from: number, to: number): CSSProperties => ({ left: `${from * 100}%`, width: `${Math.max(0.6, (to - from) * 100)}%` })

/**
 * A typical range for this pool, drawn plainly: the band New position starts on (0.7x to 1.5x the price now), the price
 * now on it, and where the price went over the last day, so a person sees at a glance what "in range" means here. Two
 * prices and two distances in words, then one line on what a narrower range trades. Nothing here is chosen, saved or
 * sent: the person picks a range of their own in New position. `unit` is how the prices are written ("USDG for 1
 * PONS"); `day` is the chart's last day in the same direction, or null.
 */
export function PoolRangeGuide({ guide, day, unit, saved = false }: { guide: RangeGuide | null; day: DaySpan | null; unit: ReactNode; saved?: boolean }) {
  if (!guide) {
    return (
      <section className="dm-card dm-pool-card dm-pool-guide" aria-labelledby="pool-range-title" data-pool-range-guide="none">
        <h2 id="pool-range-title" className="dm-title">
          Price range
        </h2>
        <p className="dm-pool-lead">A position earns fees only while the price stays inside the range you choose.</p>
        <p className="dm-pool-quiet-line">This pool’s price can’t be drawn as a range here.</p>
      </section>
    )
  }
  const { values } = guide
  const dayLow = numberOf(day?.low)
  const dayHigh = numberOf(day?.high)
  const moved = dayLow !== null && dayHigh !== null && dayLow > 0 && dayHigh >= dayLow ? { low: dayLow, high: dayHigh } : null
  // The bar spans the range with a third of its width either side, widened to take in the last day's moves.
  const span = Math.log(values.high) - Math.log(values.low)
  const from = Math.min(Math.exp(Math.log(values.low) - span / 3), moved ? moved.low / 1.05 : Infinity, values.now / 1.05)
  const to = Math.max(Math.exp(Math.log(values.high) + span / 3), moved ? moved.high * 1.05 : 0, values.now * 1.05)
  const at = (value: number) => logShare(value, from, to)
  const inside = moved ? moved.low >= values.low && moved.high <= values.high : null
  return (
    <section className="dm-card dm-pool-card dm-pool-guide" aria-labelledby="pool-range-title" data-pool-range-guide="ready">
      <h2 id="pool-range-title" className="dm-title">
        Price range
      </h2>
      <p className="dm-pool-lead">Earn fees while the price stays between these limits.</p>
      <div className="dm-pool-guide-plot">
        {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): "the pool price" whether or not it was kept
            from an earlier read; it used to say "the saved price". */}
        <div className="dm-pool-guide-bar" role="img" aria-label={`Starting range from ${guide.low} to ${guide.high}, with the pool price at ${priceText(values.now)}.`} data-saved-data={saved ? 'price' : undefined}>
          <span className="dm-pool-guide-band" style={stretch(at(values.low), at(values.high))} />
          {moved && <span className="dm-pool-guide-day" style={stretch(at(moved.low), at(moved.high))} title={`Last day: ${priceText(moved.low)} to ${priceText(moved.high)}`} />}
          <span className="dm-pool-guide-now" style={{ left: `${at(values.now) * 100}%` }} />
        </div>
        {/* V4 (pool.html .rg-ends): each end's price and distance sit centred under the band's edge (v4-pool.css). */}
        <div className="dm-pool-guide-ends tnum">
          <span style={{ left: `${at(values.low) * 100}%` }}>
            <b>{guide.low}</b> {guide.below}
          </span>
          <span className="dm-pool-guide-unit">{unit}</span>
          <span style={{ left: `${at(values.high) * 100}%` }}>
            <b>{guide.high}</b> {guide.above}
          </span>
        </div>
      </div>
      <ul className="dm-pool-guide-key" aria-hidden="true">
        <li data-key="band">Starting range</li>
        <li data-key="now">Pool price</li>
        {moved && <li data-key="day">Last day</li>}
      </ul>
      <details className="dm-pool-disclosure" data-pool-range-basis="">
        <summary>About this range<span aria-hidden="true" className="dm-pool-details-chevron" /></summary>
        <div className="dm-pool-disclosure-body">
          <p>You choose your own limits when you create a position. This starting range is {guide.below.replace('−', '')} below the pool price to {guide.above.replace('+', '')} above it.</p>
          {moved && inside !== null && <p>{inside ? 'Over the last day the price stayed inside it.' : 'Over the last day the price went past it at times.'}</p>}
          <p>A tighter range concentrates your tokens but can stop earning sooner.</p>
        </div>
      </details>
    </section>
  )
}
