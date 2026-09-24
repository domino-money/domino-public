import { useState, type CSSProperties } from 'react'
import type { Candle } from 'api-contracts/read-v1/types'
import type { RatioCandle } from 'api-contracts/read-v3/types'
import type { PoolCatalogueEntry, PoolListing } from '../../config/selectedPoolCatalogue'
import { agedMarket, feeLabel, presentMetric, retrievedAgeSeconds, retrievedText, type Instant, type Market } from '../../lib/markets'
import { CARD_LINE_PAD, type CardSeries } from '../../lib/read/cardSeries'
import { formatUsdCompact } from '../../lib/read/decimal'
import { unreadToken } from '../../lib/read/project'
import { ratioText } from '../../lib/read/ratioSeries'
import { PriceLineSvg } from '../charts/PriceLine'
import { VolumeBarsSvg } from '../charts/VolumeBars'
import { MetricCell } from '../explore/MetricCell'
import { poolHref } from '../explore/routes'
import { PoolTokenLabel } from '../PoolCatalogueIdentity'
import { TokenIcon, TokenMark, TokenMarkPair } from '../TokenIcon'
import { FigureDash } from '../ui'

const hour = (timestamp: number) => new Date(timestamp * 1000).toISOString().slice(11, 16)

/** Bundled artwork by address where the catalogue has it; a read-token mark for other bound addresses; a plain disc otherwise. */
function CatalogueMarks({ entry }: { entry: PoolCatalogueEntry }) {
  return (
    <span className="inline-flex shrink-0 items-center" aria-hidden="true">
      {entry.artwork.map((artwork, index) => {
        const style = { marginLeft: index ? -6 : 0 }
        if (artwork) return <TokenIcon key={index} symbol={artwork} size={20} ring="var(--surface-3)" style={style} />
        if (entry.addresses) return <TokenMark key={index} token={unreadToken(entry.addresses[index])} size={20} ring="var(--surface-3)" style={style} />
        return <span key={index} className="dm-mkt-disc" style={style} />
      })}
    </span>
  )
}

function Pair({ market, catalogue }: { market: Market | null; catalogue?: PoolCatalogueEntry }) {
  if (market) {
    const fee = feeLabel(market)
    return (
      <span className="dm-chip dm-chip--plate dm-mkt-pair">
        <TokenMarkPair base={market.tokens.base} quote={market.tokens.quote} size={20} ring="var(--surface-3)" />
        <span className="dm-mkt-pair-name">
          <PoolTokenLabel token={market.tokens.base} />/<PoolTokenLabel token={market.tokens.quote} />
        </span>
        <span className="dm-mkt-pair-fee">
          · <span className="dm-mkt-pair-venue">{market.feePips === null ? 'Uniswap · ' : 'Uniswap '}</span>
          {fee}
        </span>
      </span>
    )
  }
  if (!catalogue) return null
  return (
    <span className="dm-chip dm-chip--plate dm-mkt-pair">
      <CatalogueMarks entry={catalogue} />
      <span className="dm-mkt-pair-name">
        <bdi>{catalogue.labels[0]}</bdi>/<bdi>{catalogue.labels[1]}</bdi>
      </span>
      <span className="dm-mkt-pair-fee">
        · <span className="dm-mkt-pair-venue">Uniswap </span>
        {catalogue.fee}
      </span>
    </span>
  )
}

/**
 * One selected pool as a wide card on the Markets rail: the pair, its TVL in
 * the table's own presented figure (the same state, title and data hooks),
 * and a plot of its last 24 hours. The rail decides what the plot shows
 * (lib/read/cardSeries.ts); the card only draws it: the pool's price as a
 * line, hourly volume as bars, or, when there is no series, the row's 24h
 * volume as a large figure. Before its first answer the plot is a baseline
 * with no words. Pointing along a line or bars names one hour in the caption;
 * colour is never the only cue. Why a chart is missing, and where a series
 * comes from, are titles and data only: the card never prints a sentence
 * about either. The whole card opens the pool page.
 */
export function MarketCard({ listing, index, now, series }: { listing: PoolListing; index: number; now: Instant; series: CardSeries }) {
  const [bar, setBar] = useState<Candle | null>(null)
  const [point, setPoint] = useState<RatioCandle | null>(null)
  const { poolId, market: read, catalogue } = listing
  const market = read ? agedMarket(read, now) : null
  const retrieved = market?.provenance ? retrievedText(retrievedAgeSeconds(market.provenance.market, now)) : undefined
  const bars = series.kind === 'bars' ? series : null
  const line = series.kind === 'line' ? series : null
  const shownBar = bars && bar && bars.candles.some((candle) => candle.startTimestamp === bar.startTimestamp) ? bar : null
  const shownPoint = line && point && line.history.candles.some((candle) => candle.startTimestamp === point.startTimestamp) ? point : null
  // The plot's ground is set in markets.css, so hovering can change it with the plate.
  const style = { '--delay': `${Math.min(index, 3) * 60}ms` } as CSSProperties

  let caption = null
  if (line && shownPoint) {
    caption = (
      <span className="tnum">
        {hour(shownPoint.startTimestamp)} UTC · {ratioText(shownPoint.close)} <PoolTokenLabel token={line.quote} /> per <PoolTokenLabel token={line.base} /> · {shownPoint.swapCount}{' '}
        {shownPoint.swapCount === 1 ? 'swap' : 'swaps'}
        {!shownPoint.complete && ' · open hour'}
      </span>
    )
  } else if (line) {
    caption = <span>Price · 24h</span>
  } else if (bars && shownBar) {
    caption = (
      <span className="tnum">
        {hour(shownBar.startTimestamp)} UTC · {formatUsdCompact(shownBar.volumeUsd) ?? 'Unavailable'}
        {!shownBar.closed && ' · open hour'}
      </span>
    )
  } else if (bars) {
    caption = (
      <span className="tnum">
        Volume by hour · {bars.returned} {bars.returned === 1 ? 'candle' : 'candles'}
      </span>
    )
  } else if (series.kind === 'figure') {
    caption = <span>24h volume</span>
  }

  let plot = <span aria-hidden="true" className="dm-mkt-baseline" />
  if (line) {
    plot = <PriceLineSvg history={line.history} label="Pool price, last 24 hours" height={96} pad={CARD_LINE_PAD} title={line.title} onInspect={setPoint} />
  } else if (bars) {
    plot = <VolumeBarsSvg candles={bars.candles} intervalSeconds={bars.intervalSeconds} label="Hourly volume" height={96} title={bars.title} onInspect={setBar} />
  } else if (series.kind === 'figure') {
    // The row's own figure, aged on this card's clock like its TVL; a dash when there is no row or no value.
    const volume = market ? market.volume24hUsd : series.metric
    plot = (
      <span className="dm-mkt-plot-figure" data-chart-unavailable={series.code} title={series.title}>
        {volume && presentMetric(volume).kind === 'value' ? <MetricCell metric={volume} retrieved={retrieved} /> : <FigureDash reason="24h volume unavailable" />}
      </span>
    )
  }

  return (
    <a href={poolHref(poolId)} data-market-card={poolId} data-card-series={series.kind} className="dm-plate dm-dots-chart dm-mkt-card animate-rise" style={style}>
      <div className="dm-mkt-card-head">
        <Pair market={market} catalogue={catalogue} />
        <span className="dm-mkt-card-tvl">
          <span className="dm-mkt-card-label">TVL</span>
          <span className="dm-mkt-card-figure">
            {market ? (
              <MetricCell metric={market.tvlUsd} retrieved={retrieved} />
            ) : (
              <FigureDash reason="TVL unavailable" />
            )}
          </span>
        </span>
      </div>
      <div className="dm-mkt-plot" data-series-stale={(line ?? bars)?.stale ? '' : undefined}>
        {plot}
      </div>
      <p className="dm-mkt-card-caption">{caption}</p>
    </a>
  )
}
