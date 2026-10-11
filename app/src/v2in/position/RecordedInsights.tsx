import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { PortfolioResponse } from 'api-contracts/read-v6/types'
import { ChartFrame, type Plot } from '../../components/charts/ChartFrame'
import { XAxis, YAxis } from '../../components/charts/Axis'
import { ChartTooltip, ChartTooltipRow } from '../../components/charts/ChartTooltip'
import { Crosshair } from '../../components/charts/series'
import { PositionInsights } from '../../components/positions/PositionInsights'
import { PositionRange, type CardPrice } from '../../components/positions/PositionRange'
import { positionPlotHeight, usePositionChartOptions } from '../../components/positions/PositionChartOptions'
import { PendingPlot } from '../../components/positions/visual/PendingPlot'
import { nearestIndex } from '../../lib/chart/inspect'
import { rangeFacts } from '../../lib/chart/priceFacts'
import { priceFigure } from '../../lib/chart/priceRange'
import { shortDate, shortTime } from '../../lib/format/time'
import { priceInverted } from '../../lib/read/orientation'
import { confirmedOperationState, subscribeConfirmedOperations } from '../../lib/confirmedOperations'
import { useMediaQuery } from '../../lib/useMediaQuery'
import type { LiveCard } from '../../lib/walletCards'
import { formatUnitsText } from '../../v2/plan/present'
import type { LiveV6Position } from './model'
import { decimalsOf, labelOf, type TokenBook } from './tokens'
import { createPositionReadings, recordedPriceHistory, type PositionReading } from './recordedReadings'

let storage: Storage | null = null
try { storage = typeof sessionStorage === 'undefined' ? null : sessionStorage } catch { /* Private browsing. */ }
const readings = createPositionReadings(storage)
const COVERAGE = 'Only snapshots recorded in this browser session. Earlier history isn’t available.'

/** Base/Arbitrum observations use the existing portfolio read. They never masquerade as a lifetime fee ledger. */
export default function RecordedInsights({ answer, position, card, price, book, fresh }: {
  answer: PortfolioResponse; position: LiveV6Position; card: LiveCard; price: CardPrice; book: TokenBook; fresh: boolean
}) {
  const key = `${answer.wallet.toLowerCase()}:${position.chainId}:${position.manager}:${position.tokenId}:${card.poolId}`
  const subscribe = useCallback((listener: () => void) => readings.subscribe(key, listener), [key])
  const snapshot = useCallback(() => readings.get(key), [key])
  const rows = useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(() => {
    const rollback = (operation: ReturnType<typeof confirmedOperationState>[number]) => {
      if (operation.phase === 'reorged' && operation.chainId === position.chainId) readings.rollback(key, operation.blockHash, operation.block)
    }
    for (const operation of confirmedOperationState()) rollback(operation)
    return subscribeConfirmedOperations(rollback)
  }, [key, position.chainId])
  useEffect(() => {
    const found = answer.positions.find(item => item.chainId === position.chainId && item.positionManager.toLowerCase() === position.manager && item.tokenId === position.tokenId.toString())
    readings.observe(key, found?.state.status === 'live' ? found.state : null, fresh)
  }, [answer, position.chainId, position.manager, position.tokenId, key, fresh])
  const facts = useMemo(() => rangeFacts(card, price.state.phase === 'ready' ? price.state.price : null), [card, price])
  const recorded = useMemo(() => facts ? recordedPriceHistory(rows, [decimalsOf(book, position.pool.currency0), decimalsOf(book, position.pool.currency1)], priceInverted(position.pool.currency0, position.pool.currency1), facts) : null,
    [rows, book, position.pool.currency0, position.pool.currency1, facts])
  return <PositionInsights
    fees={<RecordedFees rows={rows} position={position} book={book} stale={!fresh} />}
    range={<section className="dm-position-range-panel" aria-label="Price range"><PositionRange card={card} price={price} variant="page" recorded={recorded} /></section>}
  />
}

function RecordedFees({ rows, position, book, stale }: { rows: readonly PositionReading[]; position: LiveV6Position; book: TokenBook; stale: boolean }) {
  const [token, setToken] = useState<0 | 1>(0)
  const phone = useMediaQuery('(max-width: 767px)')
  const { expanded, showPoints } = usePositionChartOptions()
  const address = token === 0 ? position.pool.currency0 : position.pool.currency1
  const label = labelOf(book, address), decimals = decimalsOf(book, address)
  const usable = decimals !== null && decimals >= 0 && decimals <= 77
  const points = useMemo(() => usable ? rows.map(row => ({ t: row.snapshot.timestamp, raw: row.fees[token], value: Number(row.fees[token]) / 10 ** decimals! })).filter(point => Number.isFinite(point.value)) : [], [rows, token, decimals, usable])
  const start = points[0]?.t ?? 0, end = points.at(-1)?.t ?? start
  const max = Math.max(...points.map(point => point.value), 0)
  const upper = max > 0 ? max * 1.2 : 1
  const xs = points.map(point => point.t)
  const x = (t: number, plot: Plot) => start === end ? (plot.left + plot.right) / 2 : plot.left + 8 + (t - start) / (end - start) * Math.max(0, plot.right - plot.left - 16)
  const y = (value: number, plot: Plot) => plot.bottom - value / upper * (plot.bottom - plot.top)
  const exact = (raw: string) => formatUnitsText(BigInt(raw), usable ? decimals : null, 77)
  const time = (t: number) => `${shortDate(t)} ${shortTime(t)}`
  const current = position.feesOwed?.[token]
  return <section className="dm-position-range-panel dm-recorded-fees" data-recorded-fees="" data-reading-count={points.length} data-stale={stale ? '' : undefined}>
    <div className="dm-recorded-fees-head">
      <h2 className="dm-title">Fees ready to collect</h2>
      <div className="dm-seg" role="group" aria-label="Fees token">
        {([position.pool.currency0, position.pool.currency1] as const).map((item, index) => <button key={item} className="dm-seg-item" type="button" aria-pressed={token === index} onClick={() => setToken(index as 0 | 1)}>{labelOf(book, item)}</button>)}
      </div>
    </div>
    <p className="dm-recorded-fees-value"><span className="dm-fig-lg" title={current === undefined ? undefined : exact(current.toString())}>{current === undefined ? '—' : formatUnitsText(current, usable ? decimals : null)}</span>{' '}<span>{usable ? label : `raw units of ${label}`}</span></p>
    {points.length > 0 ? <ChartFrame
      className="dm-recorded-fees-chart" height={positionPlotHeight(phone ? 160 : 176, phone, expanded)}
      padding={{ top: 12, right: phone ? 10 : 76, bottom: 26, left: 8 }} label={`Recorded fees ready to collect in ${label}. ${COVERAGE}`}
      points={points.length} indexAt={(px, plot) => nearestIndex(xs, start + Math.max(0, Math.min(1, (px - plot.left) / Math.max(1, plot.right - plot.left))) * (end - start))}
      valueText={index => `${time(points[index].t)}, ${exact(points[index].raw)} ${label} ready to collect`}
      axes={plot => <><XAxis ticks={points.length === 1 ? [{ x: x(start, plot), label: shortTime(start) }] : [{ x: x(start, plot), label: shortTime(start) }, { x: x(end, plot), label: shortTime(end) }]} anchor={plot.bottom + 22} left={plot.left} right={plot.right} />
        {!phone && <YAxis ticks={max > 0 ? [{ y: y(max, plot), label: priceFigure(max) }, { y: plot.bottom, label: '0' }] : [{ y: plot.bottom, label: '0' }]} anchor={plot.right + 10} />}</>}
      series={plot => <g data-recorded-fee-points="">{points.map(point => <circle key={point.t} cx={x(point.t, plot)} cy={y(point.value, plot)} r={showPoints ? 4 : 3} className="dm-position-measured-point" data-tone="in" />)}</g>}
      inspect={(plot, index) => index === null ? null : <Crosshair x={x(points[index].t, plot)} top={plot.top} bottom={plot.bottom} left={plot.left} right={plot.right} />}
      overlay={(plot, index) => index === null ? null : <ChartTooltip x={x(points[index].t, plot)} plot={plot} head={time(points[index].t)}><ChartTooltipRow label="Ready to collect">{exact(points[index].raw)} {label}</ChartTooltipRow></ChartTooltip>}
    /> : <PendingPlot label="Recorded fees" busy={false} note={stale ? 'Waiting for a current reading.' : 'Waiting for a timestamped reading.'} />}
    <p className="dm-pvr-note" title={`${COVERAGE} These are collectable balances, not total fees earned.${position.dex === 3 ? ' They can include tokens withdrawn from liquidity outside Domino.' : ''}`}>{stale ? 'Last recorded readings' : 'Recorded this session'} · {rows.length ? time(rows.at(-1)!.snapshot.timestamp) : 'Waiting'}</p>
  </section>
}
