import { useEffect, useId, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import type { HistoryResponse, RatioCandle } from 'api-contracts/read-v3/types'
import type { Market } from '../../../lib/markets'
import { watchPublicHistory, type HistoryEvent } from '../../../lib/read/historyRead'
import { marketPoolPrice, plainClose } from '../../../lib/read/marketPrice'
import { ratioGeometry, ratioText } from '../../../lib/read/ratioSeries'
import type { PoolOption } from '../../../lib/read/screens/poolsList'
import type { ReadSource } from '../../../lib/read/types'
import { useNow } from '../../../lib/read/useNow'
import { useLoadMilestone } from '../../../lib/useLoadMilestone'
import { areaUnder, curveFor, linePath } from '../../../lib/chart/paths'
import { timeTicks } from '../../../lib/chart/scale'
import { percentChange } from '../../../lib/format/change'
import { axisLabel } from '../../../lib/format/time'
import { rootScale } from '../../../lib/rootScale'
import { Segmented, Skeleton } from '../../ui'
import { PoolTokenLabel } from '../../PoolCatalogueIdentity'
import { daySpan, type DaySpan } from '../../pool/plain'
import { CANDLES_TITLE, PoolPriceChart } from './PoolPriceChart'

const WINDOWS = { day: 86400, week: 604800, month: 2592000 } as const
const at = (timestamp: number) => new Date(timestamp * 1000).toISOString().slice(5, 16).replace('T', ' ') + ' UTC'
type Answer = { key: string; state: HistoryEvent['state']; data: HistoryResponse | null; failed: boolean }
export type PoolHistoryOption = Pick<PoolOption, 'key' | 'currencies'>

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
 * One hour as the slider says it (QA round 2, N16): "10-29 21:00 UTC, close 2,280.37 USDG, high 2,290.1, low 2,270.05,
 * 262 swaps", every price as the header writes it (plainClose, the table's form). It used to read each raw decimal, up
 * to 160 digits, with the open and "complete interval" (ratioSeries.ts ratioCandleText): over 700 characters a screen
 * reader spelled out.
 */
function hourText(candle: RatioCandle, unit: string | null): string {
  const price = plainClose
  const swaps = `${candle.swapCount} ${candle.swapCount === 1 ? 'swap' : 'swaps'}`
  return `${at(candle.startTimestamp)}, close ${price(candle.close)}${unit ? ` ${unit}` : ''}, high ${price(candle.high)}, low ${price(candle.low)}, ${swaps}`
}

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

/** The plot's three faint lines (V4 pool.html .p-grid): the top of the line's band, its middle and its bottom. */
const GRID = [PLOT.pad.top, PLOT.height / 2, PLOT.height - PLOT.pad.bottom]
/**
 * Where the ember lights the line (V4 pool.html .lit), in design px around the plot: the pointer within 40px of its
 * sides, 60px above it or 40px below it; at rest the light parks 40px left of and 30px above the line's last point.
 */
const LIT_ZONE = { side: 40, above: 60, below: 40 }
const LIT_REST = { x: -40, y: -30 }
const cssPx = (value: number) => `${Math.round(value * 10) / 10}px`

/**
 * The pool's price over time, from its own swaps on Robinhood Chain (read-v3 history): one token's price in the other,
 * over 24 hours, 7 or 30 days. It opens on the page's direction (`quote`: USDG where the pool holds it), and a person
 * can flip which token is priced. Where the history route is not listed, the provider's USD chart stands in. While the
 * 24-hour window shows, `onDay` hears its span, for the range guide and the activity summary. Coverage is said only
 * when something is missing, in plain words; the exact candles are in each point's accessible text.
 */
export function PoolHistoryChart({ source, option, market, loading, quote: quoteIndex = 1, onDay, compact = false }: {
  source: ReadSource; option: PoolHistoryOption; market: Market | null; loading: boolean; quote?: 0 | 1; onDay?: (day: DaySpan) => void; compact?: boolean
}) {
  const opening = quoteIndex === 1 ? 'zero' : 'one'
  const [side, setSide] = useState<'zero' | 'one'>(opening)
  const [window, setWindow] = useState<keyof typeof WINDOWS>('day')
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [inspected, setInspected] = useState<{ key: string; index: number } | null>(null)
  // V4 motion (v4-pool.css): the first window drawn wipes in; a later one (another window, or the other token priced)
  // swaps in, and in the dialog a side switch ticks the figure. Fixed per key, so a mounted plot never flips.
  const [firstDrawn, setFirstDrawn] = useState<string | null>(null)
  const [flips, setFlips] = useState(0)
  // The chart's card, for the ember on its line (below); state set by a callback ref, read only in an effect.
  const [card, setCard] = useState<HTMLElement | null>(null)
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
      {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the dash no longer carries the failed read's words. */}
      <div className="dm-pool-plot-empty">{loading ? <Skeleton className="dm-pool-plot-baseline" /> : <span className="text-fg-subtle">—</span>}</div>
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
  if (plot && point && firstDrawn === null) setFirstDrawn(key)
  const swapped = firstDrawn !== null && firstDrawn !== key
  // The ember on the line (page size, a fine pointer): the lit copy's light follows the pointer while it is near the
  // plot, and rests on the line's last stretch while the pointer has not moved in the window, or has left it. Decoration
  // only: one passive listener, one frame at a time, custom properties through the CSSOM; a plot drawn again (another
  // window or token) is placed again without a pointer move.
  useEffect(() => {
    // `window` is this chart's time window here: the page's own is globalThis's.
    const view = globalThis.window
    if (compact || !card || typeof view?.matchMedia !== 'function' || typeof requestAnimationFrame !== 'function') return
    if (!view.matchMedia('(hover: hover) and (pointer: fine)').matches) return
    let on = false
    let x = 0
    let y = 0
    let frame = 0
    const draw = () => {
      frame = 0
      const lit = card.querySelector<SVGSVGElement>('.dm-pool-lit')
      if (!lit) return
      const area = lit.getBoundingClientRect()
      const scale = rootScale()
      let lx = x - area.left
      let ly = y - area.top
      let shown = x > area.left - LIT_ZONE.side * scale && x < area.right + LIT_ZONE.side * scale && y > area.top - LIT_ZONE.above * scale && y < area.bottom + LIT_ZONE.below * scale
      if (!on) {
        const end = card.querySelector('.dm-pool-end')?.getBoundingClientRect()
        if (!end) return
        lx = end.left + end.width / 2 - area.left + LIT_REST.x * scale
        ly = end.top + end.height / 2 - area.top + LIT_REST.y * scale
        shown = true
      }
      lit.style.setProperty('--elx', cssPx(lx))
      lit.style.setProperty('--ely', cssPx(ly))
      lit.style.setProperty('--lit-on', shown ? '1' : '0')
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw)
    }
    const move = (event: globalThis.PointerEvent) => {
      if (event.pointerType === 'touch') return
      on = true
      x = event.clientX
      y = event.clientY
      schedule()
    }
    const out = (event: globalThis.PointerEvent) => {
      if (event.relatedTarget !== null) return
      on = false
      schedule()
    }
    const redrawn = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule)
    redrawn?.observe(card, { childList: true, subtree: true })
    view.addEventListener('pointermove', move, { passive: true })
    document.addEventListener('pointerout', out, { passive: true })
    view.addEventListener('scroll', schedule, { passive: true })
    view.addEventListener('resize', schedule, { passive: true })
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      redrawn?.disconnect()
      view.removeEventListener('pointermove', move)
      document.removeEventListener('pointerout', out)
      view.removeEventListener('scroll', schedule)
      view.removeEventListener('resize', schedule)
    }
  }, [compact, card])
  if (disabled) return <div data-history-mode="provider">{provider()}</div>
  // Said only when something is missing, and in plain words; a whole window says nothing.
  // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): only the shading is explained ("Some hours are
  // missing: they are shaded.", a legend for what the plot draws). Gone: "Price history for this pool is still being
  // collected.", "Price history isn’t available for this pool yet." and the producer's cause after them (the words of a
  // `reason` other than history_refresh_pending, history_acquisition_pending and history_partial), which stays as data in
  // `data-history-reason`.
  const coverage = data?.gaps.length ? 'Some hours are missing: they are shaded.' : ''

  // The change beside the header price: from the first close the line draws (its left end, the price a reader sees
  // the line start from) to the close shown (the latest, or the inspected hour), only when that first hour opens the
  // window, so a partial window never claims a whole one.
  const first = data?.candles[0]
  const opensWindow = !!data && !!first && first.startTimestamp - data.requestedWindow.startTimestamp <= data.resolutionSeconds
  // QA round 2, N9: at rest (no hour read) the header's price is the pool's own price, the one the Markets table and the
  // figures sheet write for its row (marketPoolPrice), so one pool never reads two prices on one screen; the last close
  // where the row has none, or writes it the other way round (the chart flipped). An hour read shows its own close.
  const pool = market && point && !inspecting ? marketPoolPrice(market, now) : null
  const live = pool?.state === 'usable' && pool.base.address.toLowerCase() === currency.address.toLowerCase() && pool.quote.address.toLowerCase() === quote.address.toLowerCase() ? pool : null
  // Changed on purpose 2026-10-30 (QA round 2, final review read-4): measured to that price unrounded (`exact`), never to
  // its written digits (four significant ones below 1), so a pool that did not move reads 0.00%, not a red 0.03%.
  const change = point && first && opensWindow && data && data.candles.length > 1 ? percentChange(first.close, live ? live.exact : point.candle.close) : null

  // The latest point, and the open hour joined to the closed one before it (lighter), so the line never ends in a detached dot.
  const last = plot ? plot.points[plot.points.length - 1] : null
  const before = plot && plot.points.length > 1 ? plot.points[plot.points.length - 2] : null
  const openJoin = data && last && before && !last.candle.complete && before.candle.complete && last.candle.startTimestamp - before.candle.startTimestamp === data.resolutionSeconds &&
    !data.gaps.some(gap => gap.startTimestamp < last.candle.startTimestamp && gap.endTimestamp > before.candle.startTimestamp)
    ? `M${before.x.toFixed(2)} ${before.y.toFixed(2)} L${last.x.toFixed(2)} ${last.y.toFixed(2)}` : null
  const lone = plot ? plot.points.filter(p => plot.paths.includes(`M${p.x.toFixed(2)} ${p.y.toFixed(2)}`) && !(openJoin && p === last)) : []
  // Each run of two points or more, as a line: monotone from 20 points, straight below (the open-hour join stays straight).
  const lines = plot ? runsOf(plot.paths, plot.points).filter(run => run.length > 1).map(run => linePath(run, curveFor(run.length))) : []
  // Reading an hour on the page dims the line past it (V4 pool.html); the dialog keeps the whole line (MarketsMore D).
  const past = inspecting && !compact && !!point

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
  // Changed on purpose 2026-10-30 (QA round 2, N16): no title on the header's price any more. It read the raw close (about
  // 120 digits), "Prices from swaps on Robinhood Chain." and " Verified through block N.": a source caption and a block
  // number, off the screen's words by the owner's rules.
  // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the price's title no longer adds " Showing the
  // last stored prices." / " Stored prices, not the latest.", and its date no longer has the title "Last available history;
  // this is not a current price.". `data-ratio-stale` keeps the state, as data.

  return <div data-history-mode="chain" data-history-reason={data?.reason ?? undefined}>
    <section ref={setCard} className={`dm-card dm-pool-chart${compact ? ' dm-pool-chart--compact' : ''}`} aria-labelledby={titleId} data-pool-ratio-chart="" data-ratio-status={data?.status ?? current?.state ?? 'reading'} data-ratio-stale={stale ? '' : undefined}>
      <div className="dm-pool-chart-head">
        <h2 id={titleId} className="dm-title">Price history</h2>
        <Segmented size="sm" label="History window" value={window} onChange={setWindow}
          items={[{ key: 'day', label: '24h' }, { key: 'week', label: '7d' }, { key: 'month', label: '30d' }]} />
      </div>
      {point && <div className="dm-pool-chart-figure" aria-live="off" data-tick={flips ? '' : undefined}>
        <div className="dm-pool-chart-price">
          {/* QA round 2 review (N9): an hour read is written as the pool's price is (plainClose, the table's form, as the
              Markets cards do), so the figure keeps its form under the pointer. */}
          <p className="dm-fig-xl dm-pool-chart-close" data-chart-price={live ? 'pool' : 'close'}>{live ? live.text : plainClose(point.candle.close)}</p>
          <span className="dm-pool-chart-unit"><PoolTokenLabel token={quote} /> for 1 <PoolTokenLabel token={currency} /></span>
          {change && (
            <span className="dm-delta dm-delta--md" data-sign={change.sign} data-variant="text">
              <span className="dm-delta-arrow" aria-hidden="true" />
              {change.sign !== 0 && <span className="sr-only">{change.sign > 0 ? '+' : '−'}</span>}
              {change.text}
            </span>
          )}
        </div>
        {/* QA round 2 review (N9): the pool's price now has no hour of its own, so the line under it is the hour only for a
            close (the one read, or the last where the row has no price); a no-break space keeps its height. */}
        <p className="dm-pool-chart-date">{inspecting ? `${at(point.candle.startTimestamp)} · ${point.candle.swapCount} swaps` : live ? '\u00a0' : at(point.candle.startTimestamp)}</p>
      </div>}
      {!point && reading && <div aria-hidden="true" className="dm-pool-skel-figure"><Skeleton className="dm-pool-skel-price" /><Skeleton className="dm-pool-skel-date" /></div>}
      <div className="dm-pool-chart-body" data-ratio-unit="quote_per_base">
        <div role="status" aria-live="polite" className="sr-only">
          {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): no "Price history is temporarily
              unavailable." here or on the plot (the plot shows the dash every empty value shows), and an empty window
              states the fact alone. */}
          {reading ? 'Reading the pool’s price history…' :
            !data ? '' :
            !plot || !point ? (data.status === 'available' ? 'No swaps in this window.' : 'No prices to draw for this window.') : ''}
        </div>
        {reading ? <>
            <div className="dm-pool-plot dm-pool-plot-empty"><Skeleton className="dm-pool-plot-baseline" /></div>
            <div aria-hidden="true" className="dm-pool-skel-axis"><Skeleton className="dm-pool-skel-tick" /><Skeleton className="dm-pool-skel-tick" /></div>
          </> :
          !data ? <div className="dm-pool-plot dm-pool-plot-empty"><span className="text-fg-subtle">—</span></div> :
          !plot || !point || !last ? <div className="dm-pool-plot dm-pool-plot-empty"><p className="text-body text-fg-muted">{data.status === 'available' ? 'No swaps in this window.' : coverage || 'No prices to draw for this window.'}</p></div> : <>
            <div className="dm-pool-canvas" data-swap={swapped ? '' : undefined}>
              <svg width="100%" height="15rem" viewBox={`0 0 ${plot.width} ${plot.height}`} preserveAspectRatio="none" role="slider"
                aria-label="Inspect the pool’s price by hour" aria-valuemin={1} aria-valuemax={plot.points.length} aria-valuenow={index + 1}
                aria-valuetext={hourText(point.candle, quote.symbol)} tabIndex={0} className="dm-pool-chart-svg"
                onPointerMove={inspectAt} onPointerDown={event => { event.currentTarget.focus({ preventScroll: true }); inspectAt(event) }}
                onPointerLeave={event => { if (event.pointerType !== 'touch') setInspected(null) }} onPointerCancel={() => setInspected(null)}
                onKeyDown={inspectByKey} onBlur={() => setInspected(null)}>
                <defs>
                  <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" className="dm-stop-top" />
                    <stop offset="0.4" className="dm-stop-mid" />
                    <stop offset="1" className="dm-stop-bottom" />
                  </linearGradient>
                  {/* V4 (pool.html pclip): while an hour is read on the page, the line and its area stop at it. */}
                  {past && <clipPath id={`${fillId}-past`}><rect x={-10} y={-20} width={point.x + 10} height={plot.height + 40} /></clipPath>}
                </defs>
                {plot.gaps.map((gap, index) => <rect key={index} x={gap.x} width={gap.width} y={0} height={plot.height} className="dm-pool-gap" />)}
                {GRID.map((y) => <line key={`grid${y}`} x1={0} x2={plot.width} y1={y} y2={y} className="dm-pool-grid" />)}
                {/* Past the hour read, a dim copy of the line (pool.html .p-dim). */}
                {past && lines.map((path, index) => <path key={`d${index}`} d={path} className="dm-pool-dim" />)}
                {past && openJoin && <path d={openJoin} className="dm-pool-dim" />}
                <g clipPath={past ? `url(#${fillId}-past)` : undefined}>
                  {lines.map((path, index) => <path key={`a${index}`} d={areaUnder(path, plot.height)} fill={`url(#${fillId})`} />)}
                  {openJoin && <path d={areaUnder(openJoin, plot.height)} fill={`url(#${fillId})`} opacity="0.55" />}
                  {lines.map((path, index) => <path key={`g${index}`} d={path} className="dm-series-glow" />)}
                  {lines.map((path, index) => <path key={`l${index}`} d={path} className="dm-series-line" />)}
                  {openJoin && <path d={openJoin} className="dm-series-line" data-open="" />}
                </g>
                <line x1={last.x} x2={plot.width} y1={last.y} y2={last.y} className="dm-last-line" />
                {inspecting && <line x1={point.x} x2={point.x} y1={0} y2={plot.height} className="dm-crosshair" />}
                {inspecting && <line x1={0} x2={plot.width} y1={point.y} y2={point.y} className="dm-crosshair" data-axis="y" />}
              </svg>
              {/* V4 (pool.html .lit): the ember lights a copy of the line where it passes, page size only; decoration. */}
              {!compact && <svg aria-hidden="true" focusable="false" className="dm-pool-lit" viewBox={`0 0 ${plot.width} ${plot.height}`} preserveAspectRatio="none">
                <g clipPath={past ? `url(#${fillId}-past)` : undefined}>
                  {lines.map((path, index) => <path key={`lg${index}`} d={path} className="dm-pool-lit-glow" />)}
                  {openJoin && <path d={openJoin} className="dm-pool-lit-glow" />}
                  {lines.map((path, index) => <path key={`ll${index}`} d={path} className="dm-pool-lit-line" />)}
                  {openJoin && <path d={openJoin} className="dm-pool-lit-line" />}
                </g>
              </svg>}
              <div className="dm-pool-overlay" aria-hidden="true">
                {lone.map(p => <span key={p.candle.startTimestamp} className="dm-pool-lone" style={place(p.x, p.y)} />)}
                <span className="dm-pool-end" style={place(last.x, last.y)} data-ember-rest={compact ? undefined : `${LIT_REST.x},${LIT_REST.y}`} />
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
        {(reading || (plot && point) || side !== opening) && <Segmented size="sm" label="Price of" value={side} onChange={(next: 'zero' | 'one') => { if (next !== side) setFlips((count) => count + 1); setSide(next) }}
          items={[{ key: 'zero', label: <PoolTokenLabel token={option.currencies[0]} /> }, { key: 'one', label: <PoolTokenLabel token={option.currencies[1]} /> }]} />}
        {data && plot && point && coverage && <p className="dm-pool-coverage">{coverage}</p>}
      </div>
    </section>
  </div>
}
