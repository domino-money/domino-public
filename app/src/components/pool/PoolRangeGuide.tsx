import type { CSSProperties, ReactNode } from 'react'
import { logShare, numberOf, type DaySpan, type RangeGuide } from './plain'

/** Left and width of a stretch of the bar, in percent. */
const stretch = (from: number, to: number): CSSProperties => ({ left: `${from * 100}%`, width: `${Math.max(0.6, (to - from) * 100)}%` })

/**
 * A typical range for this pool, drawn plainly: the band New position starts on (0.7x to 1.5x the price now), the price
 * now on it, and where the price went over the last day, so a person sees at a glance what "in range" means here. Two
 * prices and two distances in words, then one line on what a narrower range trades. Nothing here is chosen, saved or
 * sent: the person picks a range of their own in New position. `unit` is how the prices are written ("USDG for 1
 * PONS"); `day` is the chart's last day in the same direction, or null.
 */
export function PoolRangeGuide({ guide, day, unit }: { guide: RangeGuide | null; day: DaySpan | null; unit: ReactNode }) {
  if (!guide) {
    return (
      <section className="dm-card dm-pool-card dm-pool-guide" aria-labelledby="pool-range-title" data-pool-range-guide="none">
        <h2 id="pool-range-title" className="dm-title">
          A typical range
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
        A typical range
      </h2>
      <p className="dm-pool-lead">A position earns fees only while the price stays inside the range you choose.</p>
      <div className="dm-pool-guide-plot">
        <div className="dm-pool-guide-bar" role="img" aria-label={`A typical range from ${guide.low} to ${guide.high}, with the price now at ${values.now}.`}>
          <span className="dm-pool-guide-band" style={stretch(at(values.low), at(values.high))} />
          {moved && <span className="dm-pool-guide-day" style={stretch(at(moved.low), at(moved.high))} title={`Last day: ${day?.low} to ${day?.high}`} />}
          <span className="dm-pool-guide-now" style={{ left: `${at(values.now) * 100}%` }} />
        </div>
        <div className="dm-pool-guide-ends tnum">
          <span>
            <b>{guide.low}</b> {guide.below}
          </span>
          <span className="dm-pool-guide-unit">{unit}</span>
          <span>
            <b>{guide.high}</b> {guide.above}
          </span>
        </div>
      </div>
      <ul className="dm-pool-guide-key" aria-hidden="true">
        <li data-key="band">Typical range</li>
        <li data-key="now">Price now</li>
        {moved && <li data-key="day">Last day</li>}
      </ul>
      <p className="dm-pool-guide-text">
        From <b className="tnum">{guide.low}</b> to <b className="tnum">{guide.high}</b>: {guide.below.replace('−', '')} below today’s price to {guide.above.replace('+', '')} above it.
        {moved && inside !== null && (inside ? ' Over the last day the price stayed inside it.' : ' Over the last day the price went past it at times.')}
      </p>
      <p className="dm-pool-guide-note">A narrower range earns more while the price is inside it, but leaves it sooner. You choose your own range when you create a position.</p>
    </section>
  )
}
