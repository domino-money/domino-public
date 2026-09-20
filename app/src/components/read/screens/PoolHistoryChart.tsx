import { useEffect, useId, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { HistoryResponse } from 'api-contracts/read-v3/types'
import type { Market } from '../../../lib/markets'
import { reasonText } from '../../../lib/read/describe'
import { watchPublicHistory, type HistoryEvent } from '../../../lib/read/historyRead'
import { ratioCandleText, ratioGeometry, ratioText } from '../../../lib/read/ratioSeries'
import type { PoolOption } from '../../../lib/read/screens/poolsList'
import type { ReadSource } from '../../../lib/read/types'
import { useNow } from '../../../lib/read/useNow'
import { Segmented, Skeleton } from '../../ui'
import { PoolTokenLabel } from '../../PoolCatalogueIdentity'
import { CANDLES_TITLE, PoolPriceChart } from './PoolPriceChart'
import { Address } from './Address'

const WINDOWS = { day: 86400, week: 604800, month: 2592000 } as const
const at = (timestamp: number) => new Date(timestamp * 1000).toISOString().slice(5, 16).replace('T', ' ') + ' UTC'
type Answer = { key: string; state: HistoryEvent['state']; data: HistoryResponse | null; failed: boolean }

/** Stored Swap ratios have their own denomination and coverage; USD stays a separate, opt-in provider chart. */
export function PoolHistoryChart({ source, option, market, loading, failed }: {
  source: ReadSource; option: PoolOption; market: Market | null; loading: boolean; failed?: string
}) {
  const [mode, setMode] = useState<'chain' | 'provider'>('chain')
  const [side, setSide] = useState<'zero' | 'one'>('zero')
  const [window, setWindow] = useState<keyof typeof WINDOWS>('day')
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [inspected, setInspected] = useState<{ key: string; index: number } | null>(null)
  const titleId = `pool-history-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const currency = option.currencies[side === 'zero' ? 0 : 1]
  const quote = option.currencies[side === 'zero' ? 1 : 0]
  const key = `${option.key}:${currency.address}:${window}`
  const current = answer?.key === key ? answer : null
  const data = current?.data ?? null
  const disabled = current?.state === 'not_enabled'
  const now = useNow(mode === 'chain' && !disabled)

  useEffect(() => {
    if (mode !== 'chain') return
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
  }, [source, option.key, currency.address, quote.address, key, window, mode])

  const provider = market ? <PoolPriceChart market={market} /> : <div className="dm-card p-5">
    <h2 className="dm-display dm-display-card">USD price and volume</h2>
    <div className="dm-pool-plot dm-dots-chart mt-4" title={CANDLES_TITLE} data-chart-provider="GeckoTerminal">
      <div className="dm-pool-plot-empty">{loading ? <Skeleton className="dm-pool-plot-baseline" /> : <span className="text-fg-subtle" title={failed}>—</span>}</div>
    </div>
  </div>
  if (disabled) return provider

  const plot = data ? ratioGeometry(data) : null
  const index = plot ? Math.min(inspected?.key === key ? inspected.index : plot.points.length - 1, plot.points.length - 1) : -1
  const point = plot?.points[index]
  const recentFailure = current?.failed === true
  const aged = data?.snapshot && now.wall / 1000 - data.snapshot.timestamp > 120
  const stale = data?.status === 'stale' || aged || recentFailure
  // The producer's `reason` defaults to a restatement of the status
  // (backend/public_history.py: history_refresh_pending for stale,
  // history_acquisition_pending for not_built and partial). Appending those
  // says the same thing twice. Anything else is a real cause — a recorded
  // last_error, or the DataError code behind an unavailable window — and is
  // the only thing on this card that could tell a person why.
  const RESTATED = ['history_refresh_pending', 'history_acquisition_pending']
  const said = (code: string) => { const words = reasonText(code); return ` ${words.charAt(0).toUpperCase()}${words.slice(1)}.` }
  const cause = data?.reason && !RESTATED.includes(data.reason) ? said(data.reason) : ''
  const coverage = (data?.status === 'not_built' ? 'History is being acquired.' : data?.status === 'unavailable' ? 'History is unavailable for this pool.' :
    data?.gaps.length ? 'Partial coverage · shaded intervals have not been acquired.' : 'Requested window covered.') + cause

  const inspectAt = (event: PointerEvent<SVGSVGElement>) => {
    if (!plot) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - bounds.left) * plot.width / Math.max(1, bounds.width)
    let nearest = 0
    plot.points.forEach((p, at) => { if (Math.abs(p.x - x) < Math.abs(plot.points[nearest].x - x)) nearest = at })
    setInspected({ key, index: nearest })
  }
  const inspectByKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!plot || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    setInspected({ key, index: event.key === 'Home' ? 0 : event.key === 'End' ? plot.points.length - 1 : Math.max(0, Math.min(plot.points.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1))) })
  }

  return <div data-history-mode={mode} data-history-reason={data?.reason ?? undefined}>
    <div className="mb-3 flex flex-wrap justify-end gap-2">
      <Segmented label="Price history source" value={mode} onChange={setMode}
        items={[{ key: 'chain', label: 'Pool ratio' }, { key: 'provider', label: 'USD · provider' }]} />
    </div>
    {mode === 'provider' ? provider : <section className="dm-card dm-pool-chart p-5" aria-labelledby={titleId} data-pool-ratio-chart="" data-ratio-status={data?.status ?? current?.state ?? 'reading'}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id={titleId} className="dm-display dm-display-card">Pool price history</h2>
          <p className="mt-1 text-caption text-fg-muted"><PoolTokenLabel token={quote} /> per <PoolTokenLabel token={currency} /> · Robinhood Chain swaps</p>
        </div>
        <Segmented label="History window" value={window} onChange={setWindow}
          items={[{ key: 'day', label: '24h' }, { key: 'week', label: '7d' }, { key: 'month', label: '30d' }]} />
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Base currency" value={side} onChange={setSide}
          items={[{ key: 'zero', label: <PoolTokenLabel token={option.currencies[0]} /> }, { key: 'one', label: <PoolTokenLabel token={option.currencies[1]} /> }]} />
        {stale && <span className="text-caption text-fg-muted">{recentFailure ? 'Refresh unavailable · showing stored history' : 'Stored history is stale'}</span>}
      </div>
      {point && <div className="mt-5" aria-live="off">
        <p className="tnum break-all text-[24px] leading-[28px] font-medium" title={point.candle.close}>{ratioText(point.candle.close)}</p>
        <p className="mt-1 text-caption text-fg-muted">{at(point.candle.startTimestamp)} · close · {point.candle.swapCount} swaps{!point.candle.complete && ' · partial interval'}</p>
      </div>}
      <div className="mt-4" data-ratio-unit="quote_per_base">
        {!current || (current.state === 'reading' && !data) ? <div className="dm-pool-plot dm-pool-plot-empty"><Skeleton className="dm-pool-plot-baseline" /><span role="status" className="sr-only">Reading stored pool history…</span></div> :
          !data ? <p className="py-16 text-center text-body text-fg-muted" role="status">Pool history is temporarily unavailable.</p> :
          !plot || !point ? <p className="py-16 text-center text-body text-fg-muted" role="status">{data.status === 'available' ? 'No swaps in the covered window.' : coverage}</p> : <>
            <svg width="100%" height="240" viewBox={`0 0 ${plot.width} ${plot.height}`} preserveAspectRatio="none" role="slider"
              aria-label="Inspect pool ratio closes" aria-valuemin={1} aria-valuemax={plot.points.length} aria-valuenow={index + 1}
              aria-valuetext={ratioCandleText(point.candle)} tabIndex={0} className="dm-pool-chart-svg"
              onPointerMove={inspectAt} onPointerDown={inspectAt} onPointerLeave={() => setInspected(null)}
              onKeyDown={inspectByKey} onBlur={() => setInspected(null)}>
              {plot.gaps.map((gap, index) => <rect key={index} x={gap.x} width={gap.width} y={plot.top} height={plot.bottom - plot.top} fill="var(--fg-subtle)" opacity="0.12" />)}
              {plot.labels.map(label => <line key={label.y} x1={plot.left} x2={plot.right} y1={label.y} y2={label.y} className="dm-pool-grid" />)}
              {plot.paths.map((path, index) => <path key={index} d={path} className="dm-pool-line" fill="none" vectorEffect="non-scaling-stroke" />)}
              {plot.points.map(p => <circle key={p.candle.startTimestamp} cx={p.x} cy={p.y} r={p === point ? 4 : 2} className="dm-pool-last" opacity={p.candle.complete ? 1 : 0.5} />)}
              <line x1={point.x} x2={point.x} y1={plot.top} y2={plot.bottom} className="dm-pool-crosshair" />
            </svg>
            <div className="flex justify-between gap-3 text-caption text-fg-muted"><span>{at(data.requestedWindow.startTimestamp)}</span><span>{at(data.requestedWindow.endTimestamp)}</span></div>
          </>}
      </div>
      {data && <p className="mt-3 text-caption text-fg-muted" role="status">{coverage}{!data.acquisitionAccepted && ' New acquisition is at capacity; showing stored data.'}</p>}
      {data && <details className="dm-details -mx-3 mt-3">
        <summary>Source, coverage and exact values</summary>
        <div className="grid gap-3 text-caption text-fg-muted">
          <p>Pool ratios from verified Robinhood Chain Swap events. Prices are denominated in the quote token, not USD. Missing intervals stay empty; prices are never filled forward.</p>
          <p>Base <Address value={data.currency} /> · quote {data.quoteCurrency ? <Address value={data.quoteCurrency} /> : 'unavailable'}</p>
          <p>{data.snapshot ? `Verified through block ${data.snapshot.number} · ${at(data.snapshot.timestamp)}` : 'No verified history snapshot yet.'}</p>
          <p>{data.resolutionSeconds === 86400 ? 'Daily' : 'Hourly'} intervals · {data.covered.length} covered segment{data.covered.length === 1 ? '' : 's'} · {data.gaps.length} acquisition gap{data.gaps.length === 1 ? '' : 's'}.</p>
          <ul className="tnum grid max-h-[240px] gap-2 overflow-y-auto break-words">{data.candles.map(candle => <li key={candle.startTimestamp}>{ratioCandleText(candle)}</li>)}</ul>
        </div>
      </details>}
    </section>}
  </div>
}
