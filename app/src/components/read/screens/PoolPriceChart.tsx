import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { Candle } from 'api-contracts/read-v1/types'
import type { Market } from '../../../lib/markets'
import { candleDescription, chartMatches } from '../../../lib/read/chart'
import { compare, formatUsdPrice, toFixed } from '../../../lib/read/decimal'
import { reasonText } from '../../../lib/read/describe'
import { areaGeometry, changeOverWindow, midpoint, volumeGeometry, windowCandles, type AreaGeometry, type BarGeometry } from '../../../lib/read/priceSeries'
import { unreadToken } from '../../../lib/read/project'
import { useNow } from '../../../lib/read/useNow'
import { useLoadMilestone } from '../../../lib/useLoadMilestone'
import { failureText } from '../../../lib/read/screens/copy'
import { utcTime } from '../../../lib/read/screens/figures'
import { useReadSource } from '../../../lib/read/screens/readContext'
import { askAgainLater, readWithin, type ScreenOutcome } from '../../../lib/read/screens/screenRead'
import { VolumeBarsGroup } from '../../charts/VolumeBars'
import { Button, Pill, Segmented, Skeleton } from '../../ui'
import { TokenLabel } from '../TokenLabel'
import { Address } from './Address'

/**
 * Who reports the candles: the plot's data and title, never a caption under
 * the heading. The name stays in the data alone; the title says only that a
 * market data provider reported them.
 */
const PROVIDER = 'GeckoTerminal'
export const CANDLES_TITLE = 'Hourly candles reported by a market data provider.'
const CHANGE_TITLE = 'Domino’s calculation from a market data provider’s hourly candles: first open to last close of the shown window. Not a return.'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const INSPECT_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']
/** Room left of the first hour, so its bar never touches the plot's edge. */
const EDGE = 8
/** The line keeps clear of its band's top and bottom by these. */
const LINE_PAD_TOP = 16
const LINE_PAD_BOTTOM = 12

const two = (value: number) => String(value).padStart(2, '0')
/** "13 Sep 14:00 UTC": the candle's start, in UTC, the same in every browser. */
function hourText(seconds: number) {
  const date = new Date(seconds * 1000)
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())} UTC`
}
const clock = (seconds: number) => new Date(seconds * 1000).toISOString().slice(11, 16)

const placesOf = (text: string) => (text.includes('.') ? text.length - text.indexOf('.') - 1 : 0)
/**
 * The scale's labels, written to one precision: formatUsdPrice gives a value
 * below one more places than a value above it, so a scale that crosses $1
 * (a stablecoin) would read "$1.00" over "$0.999302". Each label is then
 * written to the finest of them, from the provider's exact string.
 */
function scaleTexts(values: ReadonlyArray<string>): string[] {
  const texts = values.map((value) => formatUsdPrice(value) ?? value)
  const finest = Math.max(...texts.map(placesOf))
  return values.map((value, index) => {
    if (placesOf(texts[index]) >= finest) return texts[index]
    const fixed = toFixed(value, finest)
    if (fixed === null) return texts[index]
    const [whole, fraction] = fixed.split('.')
    return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`
  })
}

/** About how wide a price label is at 12px in the tabular sans: digits and "$" are wide, separators narrow. */
const labelWidth = (text: string) => [...text].reduce((width, char) => width + (/[\d$]/.test(char) ? 7.3 : 3.7), 0)

interface Plot {
  width: number
  height: number
  compact: boolean
  lineHeight: number
  barsTop: number
  barsHeight: number
  /** The price label column at the right. */
  gutter: number
  line: AreaGeometry
  bars: BarGeometry[]
  labels: Array<{ y: number; text: string }>
  hours: Array<{ x: number; anchor: 'start' | 'middle' | 'end'; text: string }>
  /** One column per candle, for the hooks and the hit area. */
  columns: Array<{ start: number; x: number; width: number }>
}

/**
 * Where everything sits for `width` pixels. The price line and the volume bars
 * share one time scale: both are drawn with the same width and the same left
 * and right pad, and the pad holds half a bar, so each bar sits under its
 * close point. Only coordinates are numbers; every price stays the provider's
 * decimal string until it is written as text.
 */
function plotFor(candles: ReadonlyArray<Candle>, intervalSeconds: number, width: number): Plot | null {
  if (candles.length === 0 || width <= 0) return null
  const compact = width < 560
  const lineHeight = compact ? 200 : 236
  const gap = compact ? 8 : 12
  const barsHeight = compact ? 48 : 64
  const labelRow = compact ? 24 : 28

  // Label texts first: the gutter is as wide as the widest of them.
  const first = candles[0].startTimestamp
  const span = candles[candles.length - 1].startTimestamp - first
  const steps = span > 0 && intervalSeconds > 0 ? span / intervalSeconds : 23
  const probe = areaGeometry(candles, width, lineHeight, { top: LINE_PAD_TOP, right: 0, bottom: LINE_PAD_BOTTOM, left: 0 })
  if (!probe) return null
  const high = probe.high
  const low = probe.low
  const middle = midpoint(high, low)
  const [highText, lowText, middleText = null] = scaleTexts(middle === null ? [high, low] : [high, low, middle])
  const flat = compare(high, low) === 0 || highText === lowText
  const texts = flat ? [highText] : [highText, lowText, ...(middleText ? [middleText] : [])]
  const gutter = Math.max(52, Math.ceil(Math.max(...texts.map(labelWidth), labelWidth('UTC')) + 18))

  // One hour's pitch fills the plot left of the gutter; half of it pads each end.
  const pitch = (width - EDGE - gutter) / (steps + 1)
  if (pitch <= 0) return null
  const pad = { left: EDGE + pitch / 2, right: gutter + pitch / 2 }
  const line = areaGeometry(candles, width, lineHeight, { top: LINE_PAD_TOP, right: pad.right, bottom: LINE_PAD_BOTTOM, left: pad.left })
  const volume = volumeGeometry(candles, intervalSeconds, width, barsHeight, { top: 0, right: pad.right, bottom: 0, left: pad.left }, Math.max(2, pitch * 0.38))
  if (!line) return null

  const top = LINE_PAD_TOP
  const bottom = lineHeight - LINE_PAD_BOTTOM
  const labels = flat
    ? [{ y: (top + bottom) / 2, text: highText }]
    : [
        { y: top, text: highText },
        ...(!compact && middleText && middleText !== highText && middleText !== lowText ? [{ y: (top + bottom) / 2, text: middleText }] : []),
        { y: bottom, text: lowText },
      ]

  const points = line.points
  const barsTop = lineHeight + gap
  const plotRight = width - gutter
  const half = 18
  const hourAt = (index: number) => {
    const x = points[index].x
    const anchor: 'start' | 'middle' | 'end' = x - half < 0 ? 'start' : x + half > plotRight ? 'end' : 'middle'
    return { x: anchor === 'start' ? 0 : anchor === 'end' ? plotRight : x, anchor, text: clock(points[index].candle.startTimestamp) }
  }
  const indexes = [...new Set([0, ...(points.length >= 3 ? [Math.floor((points.length - 1) / 2)] : []), points.length - 1])]
  const hours = indexes.map(hourAt)

  const columns = points.map((point, index) => {
    const left = index === 0 ? 0 : (points[index - 1].x + point.x) / 2
    const right = index === points.length - 1 ? plotRight : (point.x + points[index + 1].x) / 2
    return { start: point.candle.startTimestamp, x: left, width: Math.max(1, right - left) }
  })

  return { width, height: barsTop + barsHeight + labelRow, compact, lineHeight, barsTop, barsHeight, gutter, line, bars: volume?.bars ?? [], labels, hours, columns }
}

/**
 * One token's reported hourly USD prices and volume, from one pool-market
 * read made when a person asks for it: the close as a line with the area
 * under it, the volume as bars on the same time scale beneath, and a readout
 * that follows the pointer or the arrow keys. Every figure on it is a candle
 * the provider returned, or Domino's arithmetic on two of them, said so. The
 * contract returns up to 24 hourly candles and nothing longer, so there is no
 * period to choose, and nothing here calls the window a day. Where the
 * candles came from and how old they are is the plot's title. A read the
 * service was busy for is asked again on its own; candles that have expired
 * on screen offer the same ask again, never a separate retry.
 */
export function PoolPriceChart({ market, autoLoad = false, control }: { market: Market; autoLoad?: boolean; /** A control for the header row, beside the title (the pool page's history source). */ control?: ReactNode }) {
  const source = useReadSource()
  const [selected, setSelected] = useState<'base' | 'quote'>(() => (market.chartTokens?.quote === market.tokens.base.address ? 'quote' : 'base'))
  const [attempt, setAttempt] = useState(0)
  const [read, setRead] = useState<{ key: string; outcome: ScreenOutcome<'pool-market'> } | null>(null)
  const [inspected, setInspected] = useState<number | null>(null)
  const [width, setWidth] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const fillId = `pool-chart-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const chartTokens = market.chartTokens
  const currency = chartTokens?.[selected]
  // Quiet re-asks belong to one question: this pool, this token, this ask. Another starts from none.
  const question = `${market.poolId}:${currency}:${attempt}`
  const [asked, setAsked] = useState<{ question: string; quiet: number }>({ question, quiet: 0 })
  const quiet = asked.question === question ? asked.quiet : 0
  const key = `${question}:${quiet}`
  const outcome = read?.key === key ? read.outcome : null
  // While the same token is read again, the last candles stay on screen, dimmed, with their own age; another token's never do.
  const retained = !outcome && read && read.outcome.state === 'ok' && read.key.startsWith(`${market.poolId}:${currency}:`) ? read : null
  const answer = outcome ?? retained?.outcome ?? null
  const shownKey = outcome ? key : (retained?.key ?? key)
  const active = (autoLoad || attempt > 0) && !!currency
  const now = useNow(active)

  useEffect(() => {
    if (!active || !source || !currency) return
    const controller = new AbortController()
    const { signal } = controller
    void readWithin(source, 'pool-market', { poolId: market.poolId, includePriceHistory: true, priceToken: selected }, { signal }).then(async (result) => {
      if (signal.aborted || result.state === 'aborted') return
      setRead({ key, outcome: result })
      if (result.state !== 'ok' && (await askAgainLater(result, quiet, signal))) setAsked({ question, quiet: quiet + 1 })
    })
    return () => controller.abort()
  }, [source, active, currency, market.poolId, selected, key, question, quiet])

  const measured = !!chartTokens
  useLayoutEffect(() => {
    const node = box.current
    if (!node) return
    const measure = () => setWidth(Math.floor(node.getBoundingClientRect().width))
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(node)
    return () => observer?.disconnect()
  }, [measured])

  const reading = active && !outcome
  const history = answer?.state === 'ok' ? answer.data.priceHistory : null
  const matches = answer?.state === 'ok' && currency ? chartMatches(answer.data, currency, selected) : false
  const age =
    history?.cache?.ageSeconds === null || history?.cache?.ageSeconds === undefined || answer?.state !== 'ok'
      ? null
      : history.cache.ageSeconds +
        Math.max(0, Math.floor((answer.provenance.receivedMonotonic !== undefined && now.monotonic !== undefined ? now.monotonic - answer.provenance.receivedMonotonic : now.wall - answer.provenance.receivedAt) / 1000))
  const expired = !!history?.cache && age !== null && age > history.cache.maxStaleSeconds
  const data = matches && !expired ? (history?.data ?? null) : null
  const stale = history?.status === 'stale' || (!!history?.cache && age !== null && age >= history.cache.freshForSeconds)
  const failure = answer && answer.state !== 'ok' ? failureText(answer, 'pools') : null
  const reason = failure
    ? [failure.title, failure.detail].filter(Boolean).join('. ')
    : expired
      ? 'These hourly prices were retrieved more than five minutes ago.'
      : history?.data && !matches
        ? 'The chart currency changed during this read.'
        : history
          ? `Hourly prices ${history.status}: ${reasonText(history.reason)}`
          : ''
  // Where the shown candles came from and how old they are: the plot's title and data, never a line under it.
  const provenanceTitle = data
    ? `Reported by a market data provider, retrieved ${utcTime(data.retrievedAt)}${age === null ? '' : `, ${age} s ago`}${stale ? ', stale' : ''}. ${data.coverage.returnedCandles} candles; ${data.coverage.closedCandles} closed; ${data.coverage.gapsDetected ? 'gaps detected' : 'no gaps reported'}. Reported USD prices for one token, not the pool’s pair price or liquidity distribution. Complete 24h coverage is not established.`
    : undefined
  const tokenFor = (address: string) => [market.tokens.base, market.tokens.quote].find((token) => token.origin === 'read' && token.address.toLowerCase() === address.toLowerCase()) ?? unreadToken(address)

  const candles = data ? windowCandles(data, null) : []
  const plot = data ? plotFor(candles, data.intervalSeconds, width) : null
  const points = plot?.line.points ?? []
  const change = candles.length ? changeOverWindow(candles) : null
  const inspecting = inspected !== null && points.some((point) => point.candle.startTimestamp === inspected)
  const current = (inspecting ? points.find((point) => point.candle.startTimestamp === inspected) : undefined) ?? points.at(-1)
  const index = current ? points.indexOf(current) : -1
  const last = points.at(-1)
  useLoadMilestone('pool', 'chart', active && !reading && !expired && answer?.state === 'ok' && data && plot && current && last ? stale ? 'cached' : 'current' : null)

  const ask = () => {
    setInspected(null)
    setAttempt((n) => n + 1)
  }
  const inspectAt = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (points.length === 0) return
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left
    const nearest = points.reduce((best, point) => (Math.abs(point.x - x) < Math.abs(best.x - x) ? point : best))
    if (nearest.candle.startTimestamp !== inspected) setInspected(nearest.candle.startTimestamp)
  }
  const inspectByKey = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (!INSPECT_KEYS.includes(event.key) || points.length === 0) return
    event.preventDefault()
    const from = index === -1 ? points.length - 1 : index
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : Math.max(0, Math.min(points.length - 1, from + (event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 1)))
    setInspected(points[next].candle.startTimestamp)
  }

  const magnitude = change ? change.percentText.replace(/^[+−]/, '') : ''

  return (
    <section className="dm-card dm-pool-chart" aria-labelledby="pool-chart-title" data-pool-chart="">
      <div className="dm-pool-chart-head">
        <h2 id="pool-chart-title" className="dm-title">
          USD price and volume
        </h2>
        {control}
      </div>
      {!chartTokens && <p className="mt-4 text-body text-fg-muted">A verified provider currency pair is needed before requesting a chart.</p>}

      {data && current && (
        <div className="dm-pool-chart-figure animate-fade" data-candle-inspection="">
          <div className="dm-pool-chart-price">
            <p className="dm-fig-xl dm-pool-chart-close">{formatUsdPrice(current.candle.closeUsd) ?? '—'}</p>
            {change && (
              <span className="inline-flex" title={CHANGE_TITLE} data-chart-change={change.sign}>
                <Pill tone={change.sign > 0 ? 'in' : change.sign < 0 ? 'out' : 'neutral'} className="tnum">
                  {change.sign !== 0 && <span aria-hidden="true">{change.sign > 0 ? '▲' : '▼'}</span>}
                  <span className="sr-only">{change.sign > 0 ? 'Up ' : change.sign < 0 ? 'Down ' : ''}</span>
                  {magnitude}
                </Pill>
              </span>
            )}
          </div>
          <p className="dm-pool-chart-date">
            {hourText(current.candle.startTimestamp)} · {inspecting ? 'close' : 'latest close'}
            {current.candle.closed ? '' : ' · open hour'}
          </p>
        </div>
      )}

      {chartTokens && (
        <div className="dm-pool-chart-controls">
          <Segmented
            size="sm"
            label="Chart currency"
            value={selected}
            onChange={(side) => {
              setInspected(null)
              setSelected(side)
            }}
            items={(['base', 'quote'] as const).map((side) => ({ key: side, label: <TokenLabel token={tokenFor(chartTokens[side])} /> }))}
          />
        </div>
      )}

      {chartTokens && (
        <div
          ref={box}
          className="dm-pool-plot dm-dots-chart mt-4"
          title={provenanceTitle ?? (reason ? `${CANDLES_TITLE} ${reason}` : CANDLES_TITLE)}
          data-chart-provider={PROVIDER}
          data-chart-provenance={provenanceTitle}
          data-chart-state={!active ? 'idle' : !answer || (reading && !data) ? 'reading' : answer.state !== 'ok' ? 'failed' : expired ? 'expired' : !data ? 'unavailable' : stale ? 'stale' : 'shown'}
        >
          {!active ? (
            <div className="dm-pool-plot-empty">
              <Button variant="outline" size="sm" onClick={ask}>
                Show hourly candles
              </Button>
            </div>
          ) : !answer || (reading && !data) ? (
            <div className="dm-pool-plot-empty">
              <p role="status" className="sr-only">
                Reading hourly prices…
              </p>
              <Skeleton className="dm-pool-plot-baseline" />
            </div>
          ) : expired ? (
            // Candles past the provider's limit are gone from the plot; the same ask reads fresh ones.
            <div className="dm-pool-plot-empty" data-chart-unavailable="expired">
              <Button variant="outline" size="sm" onClick={ask}>
                Show hourly candles
              </Button>
            </div>
          ) : answer.state !== 'ok' || !data ? (
            <div className="dm-pool-plot-empty" data-chart-unavailable={answer.state !== 'ok' ? answer.state : (history?.reason ?? 'unavailable')}>
              <p role="status" className="sr-only">
                {reason}
              </p>
              <span className="text-[13px] leading-[18px] text-fg-subtle" title={reason}>
                —
              </span>
            </div>
          ) : candles.length === 0 ? (
            <div className="dm-pool-plot-empty">
              <p className="text-[13px] leading-[18px] text-fg-muted">No candles reported.</p>
            </div>
          ) : plot && current && last ? (
            <svg
              key={shownKey}
              width={plot.width}
              height={plot.height}
              viewBox={`0 0 ${plot.width} ${plot.height}`}
              role="slider"
              aria-label={`Inspect reported hourly USD candles${stale ? ', stale retrieval' : ''}`}
              aria-valuemin={1}
              aria-valuemax={points.length}
              aria-valuenow={Math.max(1, index + 1)}
              aria-valuetext={candleDescription(current.candle)}
              tabIndex={0}
              className="dm-pool-chart-svg"
              aria-busy={reading || undefined}
              data-candle-chart=""
              onPointerMove={inspectAt}
              onPointerDown={inspectAt}
              onPointerLeave={() => setInspected(null)}
              onKeyDown={inspectByKey}
              onBlur={() => setInspected(null)}
            >
              <defs>
                <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" className="dm-stop-top" />
                  <stop offset="0.4" className="dm-stop-mid" />
                  <stop offset="1" className="dm-stop-bottom" />
                </linearGradient>
              </defs>
              <g className="dm-pool-reveal">
                <path d={plot.line.areaPath} fill={`url(#${fillId})`} />
                <path d={plot.line.linePath} className="dm-series-glow" />
                <path d={plot.line.linePath} className="dm-series-line" />
                {!inspecting && <circle cx={last.x} cy={last.y} r="3.5" className="dm-end-dot" data-open={last.candle.closed ? undefined : ''} />}
              </g>
              {inspecting && (
                <g>
                  <line x1={current.x} x2={current.x} y1={0} y2={plot.barsTop + plot.barsHeight} className="dm-crosshair" />
                  <line x1={0} x2={plot.width - plot.gutter} y1={current.y} y2={current.y} className="dm-crosshair" data-axis="y" />
                  <circle cx={current.x} cy={current.y} r="8" className="dm-hover-halo" />
                  <circle cx={current.x} cy={current.y} r="5" className="dm-hover-dot" />
                </g>
              )}
              <g transform={`translate(0 ${plot.barsTop})`}>
                <VolumeBarsGroup bars={plot.bars} inspected={inspecting ? inspected : null} />
              </g>
              {plot.columns.map((column) => (
                <g key={column.start} data-candle-timestamp={column.start}>
                  <rect x={column.x} y={0} width={column.width} height={plot.barsTop + plot.barsHeight} fill="transparent" />
                </g>
              ))}
              {plot.labels.map((label) => (
                <text key={`label-${label.y}`} x={plot.width - 8} y={label.y + 4} textAnchor="end" className="dm-pool-axis">
                  {label.text}
                </text>
              ))}
              {plot.hours.map((hour, at) => (
                <text key={`hour-${at}`} x={hour.x} y={plot.height - 8} textAnchor={hour.anchor} className="dm-pool-axis">
                  {hour.text}
                </text>
              ))}
              <text x={plot.width - 8} y={plot.height - 8} textAnchor="end" className="dm-pool-axis">
                UTC
              </text>
            </svg>
          ) : (
            <div className="dm-pool-plot-empty">{width > 0 && <p className="text-[13px] leading-[18px] text-fg-muted">These hourly prices couldn’t be drawn.</p>}</div>
          )}
        </div>
      )}

      {data && (
        <>
          <details className="dm-details dm-pool-quiet">
            <summary>Source and exact candle values</summary>
            <div>
              <p className="text-caption text-fg-muted" data-chart-currency="">
                Token <Address value={currency ?? ''} />
              </p>
              <ul className="tnum mt-2 grid max-h-[240px] gap-1.5 overflow-y-auto text-caption break-words text-fg-muted">
                {data.candles.map((candle) => (
                  <li key={candle.startTimestamp}>{candleDescription(candle)}</li>
                ))}
              </ul>
            </div>
          </details>
        </>
      )}
    </section>
  )
}
