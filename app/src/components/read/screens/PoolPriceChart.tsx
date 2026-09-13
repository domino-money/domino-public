import { useEffect, useState } from 'react'
import type { Market } from '../../../lib/markets'
import { candleDescription, candleGeometry, chartMatches } from '../../../lib/read/chart'
import { reasonText } from '../../../lib/read/describe'
import { useNow } from '../../../lib/read/useNow'
import { failureText } from '../../../lib/read/screens/copy'
import { utcTime } from '../../../lib/read/screens/figures'
import { useReadSource } from '../../../lib/read/screens/readContext'
import { readWithin, type ScreenOutcome } from '../../../lib/read/screens/screenRead'
import { Button } from '../../ui'
import { Address } from './Address'
import { ScreenStatus } from './ScreenStatus'

export function PoolPriceChart({ market }: { market: Market }) {
  const source = useReadSource()
  const [selected, setSelected] = useState<'base' | 'quote'>('base')
  const [attempt, setAttempt] = useState(0)
  const [read, setRead] = useState<{ key: string; outcome: ScreenOutcome<'pool-market'> } | null>(null)
  const currency = market.chartTokens?.[selected]
  const key = `${market.poolId}:${currency}:${attempt}`
  const outcome = read?.key === key ? read.outcome : null
  const active = attempt > 0 && !!currency
  const now = useNow(active)

  useEffect(() => {
    if (!active || !source || !currency) return
    const controller = new AbortController()
    void readWithin(source, 'pool-market', { poolId: market.poolId, includePriceHistory: true, priceToken: selected }, { signal: controller.signal }).then((outcome) => {
      if (!controller.signal.aborted && outcome.state !== 'aborted') setRead({ key, outcome })
    })
    return () => controller.abort()
  }, [source, active, currency, market.poolId, selected, key])

  const history = outcome?.state === 'ok' ? outcome.data.priceHistory : null
  const matches = outcome?.state === 'ok' && currency ? chartMatches(outcome.data, currency, selected) : false
  const age = history?.cache?.ageSeconds === null || history?.cache?.ageSeconds === undefined || outcome?.state !== 'ok' ? null : history.cache.ageSeconds + Math.max(0, Math.floor((outcome.provenance.receivedMonotonic !== undefined && now.monotonic !== undefined ? now.monotonic - outcome.provenance.receivedMonotonic : now.wall - outcome.provenance.receivedAt) / 1000))
  const expired = history?.cache && age !== null && age > history.cache.maxStaleSeconds
  const data = matches && !expired ? history?.data : null
  const stale = history?.status === 'stale' || (!!history?.cache && age !== null && age >= history.cache.freshForSeconds)
  const candles = data ? candleGeometry(data) : []
  const reason = expired ? 'Chart retrieval has expired. Load again for a fresh provider observation.' : history?.data && !matches ? 'The chart currency changed during this read. Refresh the pool before trying again.' : history ? `Hourly prices ${history.status}: ${reasonText(history.reason)}` : ''

  return <section className="grid gap-3 rounded-[var(--radius)] border bg-surface-1 p-4" aria-labelledby="pool-chart-title" data-pool-chart="">
    <h3 id="pool-chart-title" className="text-[14px] font-medium">Hourly token prices · USD</h3>
    <p className="text-[12px] text-fg-subtle">GeckoTerminal candles, reported for the selected token address. Gaps and open intervals remain visible; complete 24h coverage is not established.</p>
    {market.chartTokens ? <>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Chart currency">
        {(['base', 'quote'] as const).map((side) => <button key={side} type="button" aria-pressed={selected === side} className="rounded border px-2 py-1 text-[12px]" onClick={() => setSelected(side)}>
          <Address value={market.chartTokens![side]} />
        </button>)}
      </div>
      <p className="break-all font-mono text-[11px]" data-chart-currency="">Token {currency}</p>
      <Button variant="ghost" disabled={active && !outcome} onClick={() => setAttempt((n) => n + 1)}>{active && !outcome ? 'Loading prices…' : attempt ? 'Reload hourly prices' : 'Load hourly prices'}</Button>
    </> : <p className="text-[13px] text-fg-muted">A verified provider currency pair is needed before requesting a chart.</p>}
    {active && !outcome && <ScreenStatus line={{ code: 'loading', title: 'Loading hourly prices…', detail: '' }} />}
    {outcome && outcome.state !== 'ok' && <ScreenStatus line={failureText(outcome, 'pools')} />}
    {outcome?.state === 'ok' && !data && <p role="status" className="text-[13px] text-fg-muted" data-chart-unavailable="">{reason}</p>}
    {data && <>
      <p className="text-[12px] text-fg-subtle" data-chart-provenance="">Retrieved {utcTime(data.retrievedAt)}{age === null ? '' : ` · ${age} s ago`}{stale ? ' · stale' : ''}. {data.coverage.returnedCandles} candles; {data.coverage.closedCandles} closed; {data.coverage.gapsDetected ? 'gaps detected' : 'no gaps reported'}.</p>
      {candles.length ? <svg viewBox="0 0 440 200" role="img" aria-label={`Reported hourly USD candles for ${currency}${stale ? ', stale retrieval' : ''}`} className="w-full" data-candle-chart="">
        {candles.map((g) => <g key={g.candle.startTimestamp} data-candle-timestamp={g.candle.startTimestamp} opacity={g.candle.closed ? 1 : 0.5}>
          <title>{candleDescription(g.candle)}</title>
          <line x1={g.x} x2={g.x} y1={g.high} y2={g.low} stroke="currentColor" />
          <rect x={g.x - g.width / 2} y={Math.min(g.open, g.close)} width={g.width} height={Math.max(1, Math.abs(g.close - g.open))} fill={g.close <= g.open ? 'var(--money-in)' : 'var(--money-out)'} />
        </g>)}
      </svg> : <p>No candles reported.</p>}
      <details><summary className="cursor-pointer text-[12px]">Exact candle values and timestamps</summary>
        <ul className="mt-2 grid gap-2 break-words font-mono text-[10px]">{data.candles.map((c) => <li key={c.startTimestamp}>{candleDescription(c)}</li>)}</ul>
      </details>
    </>}
  </section>
}
