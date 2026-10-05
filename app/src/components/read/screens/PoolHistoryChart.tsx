import { useEffect, useId, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import type { HistoryResponse } from 'api-contracts/read-v3/types'
import type { Market } from '../../../lib/markets'
import { reasonText } from '../../../lib/read/describe'
import { watchPublicHistory, type HistoryEvent } from '../../../lib/read/historyRead'
import { ratioCandleText, ratioGeometry, ratioText } from '../../../lib/read/ratioSeries'
import type { PoolOption } from '../../../lib/read/screens/poolsList'
import type { ReadSource } from '../../../lib/read/types'
import { useNow } from '../../../lib/read/useNow'
import { useLoadMilestone } from '../../../lib/useLoadMilestone'
import { areaUnder, curveFor, linePath } from '../../../lib/chart/paths'
import { timeTicks } from '../../../lib/chart/scale'
import { percentChange } from '../../../lib/format/change'
import { axisLabel } from '../../../lib/format/time'
import { Segmented, Skeleton } from '../../ui'
import { PoolTokenLabel } from '../../PoolCatalogueIdentity'
import { daySpan, type DaySpan } from '../../pool/plain'
import { CANDLES_TITLE, PoolPriceChart } from './PoolPriceChart'

const WINDOWS = { day: 86400, week: 604800, month: 2592000 } as const
const at = (timestamp: number) => new Date(timestamp * 1000).toISOString().slice(5, 16).replace('T', ' ') + ' UTC'
type Answer = { key: string; state: HistoryEvent['state']; data: HistoryResponse | null; failed: boolean }

/**
 * The plot's own geometry (DESIGN-V2 §9.1): the whole requested window edge to edge, room above the high and below
 * the low for their labels. The labels and the last-value chip sit in an HTML column at the plot's right
 * (pool.css), so the stretched SVG draws only what survives stretching: areas, lines, the crosshair.
 */
const PLOT = { width: 720, height: 240, pad: { left: 0, right: 0, top: 20, bottom: 20 } }
/** A y label this close to the last-value chip (in plot units, about 15px) gives way to it. */
const CHIP_CLEARANCE = 12

/** A close as the header shows it: the exact ratio text, its whole part grouped in thousands ("2,656.07"). */
const grouped = (text: string) => text.replace(/^\d+/, (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ','))

/**
 * The points of each of the plot's paths: every ratioGeometry path is one run of consecutive points, in order, so a
 * run can be drawn again as a curve (monotone from 20 points, §4.1; shorter runs stay straight).
 */
function runsOf<P>(paths: readonly string[], points: readonly P[]): P[][] {
  const runs: P[][] = []
  let at = 0
  for (const path of paths) {
    const count = path.split(' L').length
    runs.push(points.slice(at, at + count))
    at += count
  }
  return runs
}

/**
 * The time axis between its two edge labels (DESIGN-V2 §4.3): UTC-aligned ticks (six-hourly on 24h, daily on 7d,
 * weekly on 30d), the time of day, or the date at midnight, as the position charts label theirs. Numbers only. A
 * tick nearer an edge than a quarter of the plot is left out; `room` (its distance to the nearer edge, in steps of
 * 2.5 %) lets pool.css hide one that would crowd an edge label on a narrower plot.
 */
function interiorTicks(start: number, end: number, count: number) {
  const span = end - start
  if (!(span > 0)) return []
  return timeTicks(start, end, count).flatMap((t) => {
    const at = (t - start) / span
    const near = Math.min(at, 1 - at)
    if (near < 0.25) return []
    return [{ t, at, room: String(Math.floor(near * 40) * 25), text: axisLabel(t, t % 86400 === 0 ? 3 * 86400 : span) }]
  })
}

/** Where a plot point sits in the HTML layers, as percentages of the plot box. */
const place = (x: number, y: number): CSSProperties => ({ left: `${(x / PLOT.width) * 100}%`, top: `${(y / PLOT.height) * 100}%` })

/**
 * The pool's price over time, from its own swaps on Robinhood Chain (read-v3 history): one token's price in the other,
 * over 24 hours, 7 or 30 days. It opens on the page's direction (`quote`: USDG where the pool holds it), and a person
 * can flip which token is priced. Where the history route is not listed, the provider's USD chart stands in. While the
 * 24-hour window shows, `onDay` hears its span, for the range guide and the activity summary. Coverage is said only
 * when something is missing, in plain words; the exact candles are in each point's accessible text.
 */
export function PoolHistoryChart({ source, option, market, loading, failed, quote: quoteIndex = 1, onDay }: {
  source: ReadSource; option: PoolOption; market: Market | null; loading: boolean; failed?: string; quote?: 0 | 1; onDay?: (day: DaySpan) => void
}) {
  const opening = quoteIndex === 1 ? 'zero' : 'one'
  const [side, setSide] = useState<'zero' | 'one'>(opening)
  const [window, setWindow] = useState<keyof typeof WINDOWS>('day')
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [inspected, setInspected] = useState<{ key: string; index: number } | null>(null)
  const titleId = `pool-history-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const fillId = `${titleId}-fill`
  const currency = option.currencies[side === 'zero' ? 0 : 1]
  const quote = option.currencies[side === 'zero' ? 1 : 0]
  const key = `${option.key}:${currency.address}:${window}`
  const current = answer?.key === key ? answer : null
  const data = current?.data ?? null
  const disabled = current?.state === 'not_enabled'
  const now = useNow(!disabled)
  // Nothing to show yet: the card rests at its loaded height, each row a bubble (pool.css .dm-pool-skel-*).
  const reading = !current || (current.state === 'reading' && !data)

  useEffect(() => {
    const controller = new AbortController()
    void watchPublicHistory(source, { poolId: option.key, currency: currency.address,
      windowSeconds: WINDOWS[window], resolutionSeconds: window === 'month' ? 86400 : 3600 }, event => {
      if (controller.signal.aborted) return
      setAnswer(prior => {
        const retained = prior?.key === key ? prior.data : null
        const received = event.state === 'answer' && event.outcome.state === 'ok' ? event.outcome.data : null
        const mismatch = received !== null && received.quoteCurrency !== null && received.quoteCurrency !== quote.address
        return { key, state: event.state, data: received && !mismatch ? received : retained,
          failed: event.state === 'reading' ? prior?.key === key && prior.failed :
            mismatch || event.state === 'capability_failed' || (event.state === 'answer' && event.outcome.state !== 'ok') }
      })
    }, { signal: controller.signal })
    return () => controller.abort()
  }, [source, option.key, currency.address, quote.address, key, window])

  // The last day, once per answer: the page keeps the last span it heard for this pool.
  useEffect(() => {
    const span = window === 'day' && data ? daySpan(data, currency.address) : null
    if (span) onDay?.(span)
  }, [onDay, window, data, currency.address])

  const provider = () => market ? <PoolPriceChart market={market} /> : <div className="dm-card dm-pool-chart">
    <div className="dm-pool-chart-head">
      <h2 className="dm-title">USD price and volume</h2>
    </div>
    <div className="dm-pool-plot dm-dots-chart mt-4" title={CANDLES_TITLE} data-chart-provider="GeckoTerminal">
      <div className="dm-pool-plot-empty">{loading ? <Skeleton className="dm-pool-plot-baseline" /> : <span className="text-fg-subtle" title={failed}>—</span>}</div>
    </div>
  </div>
  const plot = data ? ratioGeometry(data, PLOT.width, PLOT.height, PLOT.pad) : null
  const inspecting = !!plot && inspected?.key === key
  const index = plot ? Math.min(inspecting && inspected ? inspected.index : plot.points.length - 1, plot.points.length - 1) : -1
  const point = plot?.points[index]
  const recentFailure = current?.failed === true
  const aged = data?.snapshot && now.wall / 1000 - data.snapshot.timestamp > 120
  const stale = data?.status === 'stale' || aged || recentFailure
  useLoadMilestone('pool', 'chart', !disabled && !reading && plot && point ? stale ? 'cached' : data?.status === 'partial' ? 'partial' : 'current' : null)
  if (disabled) return <div data-history-mode="provider">{provider()}</div>
  // The producer's `reason` defaults to a restatement of the status
  // (backend/public_history.py: history_refresh_pending for stale,
  // history_acquisition_pending for not_built and partial). Appending those
  // says the same thing twice. Anything else is a real cause — a recorded
  // last_error, or the DataError code behind an unavailable window — and is
  // the only thing on this card that could tell a person why. history_partial (read-v3's own fixture) restates the
  // missing hours the card already names.
  const RESTATED = ['history_refresh_pending', 'history_acquisition_pending', 'history_partial']
  const said = (code: string) => { const words = reasonText(code); return ` ${words.charAt(0).toUpperCase()}${words.slice(1)}.` }
  const cause = data?.reason && !RESTATED.includes(data.reason) ? said(data.reason) : ''
  // Said only when something is missing, and in plain words; a whole window says nothing.
  const coverage = data?.status === 'not_built' ? 'Price history for this pool is still being collected.' : data?.status === 'unavailable' ? 'Price history isn’t available for this pool yet.' :
    data?.gaps.length ? 'Some hours are missing: they are shaded.' : ''

  // The change beside the header price: from the first close the line draws (its left end, the price a reader sees
  // the line start from) to the close shown (the latest, or the inspected hour), only when that first hour opens the
  // window, so a partial window never claims a whole one.
  const first = data?.candles[0]
  const opensWindow = !!data && !!first && first.startTimestamp - data.requestedWindow.startTimestamp <= data.resolutionSeconds
  const change = point && first && opensWindow && data && data.candles.length > 1 ? percentChange(first.close, point.candle.close) : null

  // The latest point, and the open hour joined to the closed one before it (lighter), so the line never ends in a detached dot.
  const last = plot ? plot.points[plot.points.length - 1] : null
  const before = plot && plot.points.length > 1 ? plot.points[plot.points.length - 2] : null
  const openJoin = data && last && before && !last.candle.complete && before.candle.complete && last.candle.startTimestamp - before.candle.startTimestamp === data.resolutionSeconds &&
    !data.gaps.some(gap => gap.startTimestamp < last.candle.startTimestamp && gap.endTimestamp > before.candle.startTimestamp)
    ? `M${before.x.toFixed(2)} ${before.y.toFixed(2)} L${last.x.toFixed(2)} ${last.y.toFixed(2)}` : null
  const lone = plot ? plot.points.filter(p => plot.paths.includes(`M${p.x.toFixed(2)} ${p.y.toFixed(2)}`) && !(openJoin && p === last)) : []
  // Each run of two points or more, as a line: monotone from 20 points, straight below (the open-hour join stays straight).
  const lines = plot ? runsOf(plot.paths, plot.points).filter(run => run.length > 1).map(run => linePath(run, curveFor(run.length))) : []

  const inspectAt = (event: PointerEvent<SVGSVGElement>) => {
    if (!plot) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - bounds.left) * plot.width / Math.max(1, bounds.width)
    let nearest = 0
    plot.points.forEach((p, at) => { if (Math.abs(p.x - x) < Math.abs(plot.points[nearest].x - x)) nearest = at })
    setInspected({ key, index: nearest })
  }
  const inspectByKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!plot) return
    if (event.key === 'Escape') { setInspected(null); return }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    setInspected({ key, index: event.key === 'Home' ? 0 : event.key === 'End' ? plot.points.length - 1 : Math.max(0, Math.min(plot.points.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1))) })
  }
  const verified = data?.snapshot ? ` Verified through block ${data.snapshot.number}.` : ''
  const staleWords = stale ? (recentFailure ? ' Showing the last stored prices.' : ' Stored prices, not the latest.') : ''

  return <div data-history-mode="chain" data-history-reason={data?.reason ?? undefined}>
    <section className="dm-card dm-pool-chart" aria-labelledby={titleId} data-pool-ratio-chart="" data-ratio-status={data?.status ?? current?.state ?? 'reading'} data-ratio-stale={stale ? '' : undefined}>
      <div className="dm-pool-chart-head">
        <h2 id={titleId} className="dm-title">Price history</h2>
        <Segmented size="sm" label="History window" value={window} onChange={setWindow}
          items={[{ key: 'day', label: '24h' }, { key: 'week', label: '7d' }, { key: 'month', label: '30d' }]} />
      </div>
      {point && <div className="dm-pool-chart-figure" aria-live="off">
        <div className="dm-pool-chart-price">
          <p className="dm-fig-xl dm-pool-chart-close" title={`${point.candle.close}. Prices from swaps on Robinhood Chain.${verified}${staleWords}`}>{grouped(ratioText(point.candle.close))}</p>
          <span className="dm-pool-chart-unit"><PoolTokenLabel token={quote} /> for 1 <PoolTokenLabel token={currency} /></span>
          {change && (
            <span className="dm-delta dm-delta--md" data-sign={change.sign} data-variant="text">
              <span className="dm-delta-arrow" aria-hidden="true" />
              {change.sign !== 0 && <span className="sr-only">{change.sign > 0 ? '+' : '−'}</span>}
              {change.text}
            </span>
          )}
        </div>
        <p className="dm-pool-chart-date">{inspecting ? `${at(point.candle.startTimestamp)} · ${point.candle.swapCount} swaps` : `${stale ? 'Saved' : 'Latest'} · ${at(point.candle.startTimestamp)}`}</p>
      </div>}
      {!point && reading && <div aria-hidden="true" className="dm-pool-skel-figure"><Skeleton className="dm-pool-skel-price" /><Skeleton className="dm-pool-skel-date" /></div>}
      <div className="dm-pool-chart-body" data-ratio-unit="quote_per_base">
        <div role="status" aria-live="polite" className="sr-only">
          {reading ? 'Reading the pool’s price history…' :
            !data ? 'Price history is temporarily unavailable.' :
            !plot || !point ? (data.status === 'available' ? 'No swaps in this window.' : `No prices to draw for this window. ${coverage}`) : ''}
        </div>
        {reading ? <>
            <div className="dm-pool-plot dm-pool-plot-empty"><Skeleton className="dm-pool-plot-baseline" /></div>
            <div aria-hidden="true" className="dm-pool-skel-axis"><Skeleton className="dm-pool-skel-tick" /><Skeleton className="dm-pool-skel-tick" /></div>
          </> :
          !data ? <div className="dm-pool-plot dm-pool-plot-empty"><p className="text-body text-fg-muted">Price history is temporarily unavailable.</p></div> :
          !plot || !point || !last ? <div className="dm-pool-plot dm-pool-plot-empty"><p className="text-body text-fg-muted">{data.status === 'available' ? 'No swaps in this window.' : coverage || 'No prices to draw for this window.'}</p></div> : <>
            <div className="dm-pool-canvas">
              <svg width="100%" height="15rem" viewBox={`0 0 ${plot.width} ${plot.height}`} preserveAspectRatio="none" role="slider"
                aria-label="Inspect the pool’s price by hour" aria-valuemin={1} aria-valuemax={plot.points.length} aria-valuenow={index + 1}
                aria-valuetext={ratioCandleText(point.candle)} tabIndex={0} className="dm-pool-chart-svg"
                onPointerMove={inspectAt} onPointerDown={inspectAt} onPointerLeave={() => setInspected(null)}
                onKeyDown={inspectByKey} onBlur={() => setInspected(null)}>
                <defs>
                  <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" className="dm-stop-top" />
                    <stop offset="0.4" className="dm-stop-mid" />
                    <stop offset="1" className="dm-stop-bottom" />
                  </linearGradient>
                </defs>
                {plot.gaps.map((gap, index) => <rect key={index} x={gap.x} width={gap.width} y={0} height={plot.height} className="dm-pool-gap" />)}
                {lines.map((path, index) => <path key={`a${index}`} d={areaUnder(path, plot.height)} fill={`url(#${fillId})`} />)}
                {openJoin && <path d={areaUnder(openJoin, plot.height)} fill={`url(#${fillId})`} opacity="0.55" />}
                {lines.map((path, index) => <path key={`g${index}`} d={path} className="dm-series-glow" />)}
                {lines.map((path, index) => <path key={`l${index}`} d={path} className="dm-series-line" />)}
                {openJoin && <path d={openJoin} className="dm-series-line" data-open="" />}
                <line x1={last.x} x2={plot.width} y1={last.y} y2={last.y} className="dm-last-line" />
                {inspecting && <line x1={point.x} x2={point.x} y1={0} y2={plot.height} className="dm-crosshair" />}
                {inspecting && <line x1={0} x2={plot.width} y1={point.y} y2={point.y} className="dm-crosshair" data-axis="y" />}
              </svg>
              <div className="dm-pool-overlay" aria-hidden="true">
                {lone.map(p => <span key={p.candle.startTimestamp} className="dm-pool-lone" style={place(p.x, p.y)} />)}
                <span className="dm-pool-end" style={place(last.x, last.y)} />
                {inspecting && <span className="dm-pool-hover" style={place(point.x, point.y)} />}
              </div>
              <div className="dm-pool-yaxis" aria-hidden="true">
                {/* The high over the low; a label beside the chip gives way to it where the chip shows (pool.css), and a
                    phone, which has no chip, sets both just outside the line's band. */}
                {plot.labels.map((label, at) =>
                  <span key={label.y} className="dm-pool-ylabel" data-edge={plot.labels.length === 2 ? (at === 0 ? 'high' : 'low') : 'mid'}
                    data-by-chip={Math.abs(label.y - last.y) < CHIP_CLEARANCE ? '' : undefined} style={{ top: `${(label.y / plot.height) * 100}%` }}>{grouped(label.text)}</span>)}
                <span className="dm-last-chip dm-pool-chip" style={{ top: `${(last.y / plot.height) * 100}%` }}>{grouped(ratioText(last.candle.close))}</span>
              </div>
            </div>
            <div className="dm-pool-xaxis">
              <span>{at(data.requestedWindow.startTimestamp)}</span>
              {interiorTicks(data.requestedWindow.startTimestamp, data.requestedWindow.endTimestamp, window === 'week' ? 7 : 5).map((tick) =>
                <span key={tick.t} aria-hidden="true" className="dm-pool-xtick" data-room={tick.room} style={{ left: `${tick.at * 100}%` }}>{tick.text}</span>)}
              <span>{at(data.requestedWindow.endTimestamp)}</span>
            </div>
          </>}
      </div>
      <div className="dm-pool-chart-foot">
        {/* Which token is priced: the page's direction first; a flip is one press. With nothing drawn in the page's own
            direction there is nothing to flip, so no switch sits under an empty chart (round 6); once flipped, it stays,
            so the way back is always there. */}
        {(reading || (plot && point) || side !== opening) && <Segmented size="sm" label="Price of" value={side} onChange={setSide}
          items={[{ key: 'zero', label: <PoolTokenLabel token={option.currencies[0]} /> }, { key: 'one', label: <PoolTokenLabel token={option.currencies[1]} /> }]} />}
        {data && plot && point && (coverage || cause) && <p className="dm-pool-coverage">{coverage}{cause}</p>}
      </div>
    </section>
  </div>
}
