import { useState, type CSSProperties } from 'react'
import type { Candle } from 'api-contracts/read-v1/types'
import type { RatioCandle } from 'api-contracts/read-v3/types'
import type { PoolCatalogueEntry, PoolListing } from '../../config/selectedPoolCatalogue'
import { agedMarket, feeLabel, presentMetric, type Instant, type Market } from '../../lib/markets'
import type { CardSeries } from '../../lib/read/cardSeries'
import { formatUsdCompact } from '../../lib/read/decimal'
import { pricePair } from '../../lib/read/orientation'
import { unreadToken } from '../../lib/read/project'
import { marketPoolPrice, plainClose } from '../../lib/read/marketPrice'
import { percentChange } from '../../lib/format/change'
import { feeWords } from '../../lib/format/fee'
import { networkName } from '../../lib/networkName'
import { shortTime } from '../../lib/format/time'
import { PriceLineSvg } from '../charts/PriceLine'
import { VolumeBarsSvg } from '../charts/VolumeBars'
import { MetricCell } from '../explore/MetricCell'
import { FEE_MEANING } from '../explore/feeMeaning'
import { poolHref } from '../explore/routes'
import { CatalogueLabel, PoolTokenLabel } from '../PoolCatalogueIdentity'
import { TokenIcon, TokenMark, TokenMarkPair } from '../TokenIcon'
import { FigureDash } from '../ui'
import { rem } from '../../lib/rootScale'

/**
 * Plot dimensions in the shared 16px design scale. V3 puts its metadata outside the plot,
 * leaving the whole chart area to the data instead of reserving a caption band inside it.
 * V4 (markets.html .p-plot): 104px, the line edge to edge between 8px insets.
 */
const LINE_HEIGHT = 104
/** Bars carry no price, so they take the price row's room as well. */
const BARS_HEIGHT = 164
/**
 * Small vertical insets keep peaks clear of the price and footer. The line runs to the plate's right content edge and
 * its end dot overhangs into the padding (the svg draws overflow), as the prototype's does.
 * This changes the plot's frame only; every candle and the window's direction are preserved.
 */
const LINE_PAD = { left: 0, right: 0, top: 8, bottom: 8 }

/** One token, by address, whatever its case. */
const sameToken = (a: { address: string }, b: { address: string }) => a.address.toLowerCase() === b.address.toLowerCase()

/** Bundled artwork by address where the catalogue has it; a read-token mark for other bound addresses; a plain disc otherwise. */
function CatalogueMarks({ entry }: { entry: PoolCatalogueEntry }) {
  return (
    <span className="inline-flex shrink-0 items-center" aria-hidden="true">
      {entry.artwork.map((artwork, index) => {
        const style = { marginLeft: index ? rem(-9) : 0 }
        if (artwork) return <TokenIcon key={index} symbol={artwork} size={32} ring="var(--card)" style={style} />
        if (entry.addresses) return <TokenMark key={index} token={unreadToken(entry.addresses[index])} size={32} ring="var(--card)" style={style} />
        return <span key={index} className="dm-mkt-disc" style={style} />
      })}
    </span>
  )
}

/** QA round 2, Q23 and Q28: under the pair, the pool's network, then its fee with what the fee is in its title. */
function NetworkAndFee({ chainId, fee }: { chainId: number; fee: string }) {
  return (
    <span className="dm-mkt-pair-fee">
      <span data-chain-chip={chainId}>{networkName(chainId)}</span> · <span title={FEE_MEANING}>{feeWords(fee)}</span>
    </span>
  )
}

function Pair({ market, catalogue }: { market: Market | null; catalogue?: PoolCatalogueEntry }) {
  if (market) {
    const fee = feeLabel(market)
    // Named as its price is written, "TOKEN/USDG" (audit E21, lib/read/orientation.ts).
    const pair = pricePair(market.tokens.base, market.tokens.quote)
    return (
      <span className="dm-mkt-pair">
        <TokenMarkPair base={pair.base} quote={pair.quote} size={32} ring="var(--card)" />
        <span className="dm-mkt-pair-identity">
          <span className="dm-mkt-pair-name"><PoolTokenLabel token={pair.base} /> / <PoolTokenLabel token={pair.quote} /></span>
          <NetworkAndFee chainId={pair.base.chainId} fee={fee} />
        </span>
      </span>
    )
  }
  if (!catalogue) return null
  return (
    <span className="dm-mkt-pair">
      <CatalogueMarks entry={catalogue} />
      <span className="dm-mkt-pair-identity">
        <span className="dm-mkt-pair-name"><CatalogueLabel text={catalogue.labels[0]} /> / <CatalogueLabel text={catalogue.labels[1]} /></span>
        <NetworkAndFee chainId={4663} fee={catalogue.fee} />
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
  const { poolId, market: read, catalogue, token } = listing
  const market = read ? agedMarket(read, now) : null
  const bars = series.kind === 'bars' ? series : null
  const line = series.kind === 'line' ? series : null
  const shownBar = bars && bar && bars.candles.some((candle) => candle.startTimestamp === bar.startTimestamp) ? bar : null
  const shownPoint = line && point && line.history.candles.some((candle) => candle.startTimestamp === point.startTimestamp) ? point : null
  // The plot's ground is set in markets.css, so hovering can change it with the plate.
  // Five plates step in 40ms apart (.v4c.fast .plate:nth-child(1..5)).
  const style = { '--delay': `${Math.min(index, 4) * 40}ms` } as CSSProperties

  let caption = null
  if (line && shownPoint) {
    caption = (
      <span className="tnum">
        {shortTime(shownPoint.startTimestamp)} · 1 <PoolTokenLabel token={line.base} /> = {plainClose(shownPoint.close)} <PoolTokenLabel token={line.quote} /> · {shownPoint.swapCount}{' '}
        {shownPoint.swapCount === 1 ? 'swap' : 'swaps'}
        {!shownPoint.complete && ' · open hour'}
      </span>
    )
  } else if (line) {
    caption = <span>Price · 24h</span>
  } else if (bars && shownBar) {
    caption = (
      <span className="tnum">
        {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): an hour's volume it cannot write is "—", never "Unavailable". */}
        {shortTime(shownBar.startTimestamp)} · {formatUsdCompact(shownBar.volumeUsd) ?? '—'}
        {!shownBar.closed && ' · open hour'}
      </span>
    )
  } else if (bars) {
    caption = (
      <span className="tnum">
        Volume by hour
      </span>
    )
  } else if (series.kind === 'figure') {
    caption = <span>24h volume</span>
  }

  // The price row (DESIGN-V2 §8.1): the latest close, or the inspected one while a pointer is on the line, in the
  // pool's quote token; beside it, its change from the first close the line draws (the change a reader can see on
  // the plot, for the hour at rest and the hour inspected alike), but only when that first hour opens the window (a
  // partial window's change would claim more than it covers). Waiting cards rest bubbles in its place.
  const candles = line ? line.history.candles : []
  const first = candles[0]
  const last = candles[candles.length - 1]
  // QA round 2, N9: at rest the price is the pool's own price the table writes for this row (marketPoolPrice), so a
  // card and its row never read two prices for one pool; the last close only where the row has none to give, or writes
  // it the other way round. A pointer on the line still reads that hour's close.
  const pool = line && market ? marketPoolPrice(market, now) : null
  const live = pool?.state === 'usable' && line && sameToken(pool.base, line.base) && sameToken(pool.quote, line.quote) ? pool : null
  const restText = live ? live.text : last ? plainClose(last.close) : ''
  // Changed on purpose 2026-10-30 (QA round 2, final review read-4): the change and the line's colour measure to the
  // pool price unrounded (`exact`), never to the four digits written below 1, so a pool that did not move reads 0.00%.
  const restValue = live ? live.exact : last?.close ?? ''
  const shownText = shownPoint ? plainClose(shownPoint.close) : restText
  const whole = !!line && !!first && first.startTimestamp - line.history.requestedWindow.startTimestamp <= line.history.resolutionSeconds
  const change = whole && candles.length > 1 ? percentChange(first.close, shownPoint ? shownPoint.close : restValue) : null
  // The line's colour is the window's own direction, first close to the price at rest (the badge at rest); Tangerine
  // without one.
  const direction = whole && candles.length > 1 ? percentChange(first.close, restValue) : null
  const tone = direction ? (direction.sign > 0 ? 'up' : direction.sign < 0 ? 'down' : 'flat') : undefined

  let plot = <span aria-hidden="true" className="dm-mkt-baseline" />
  if (line) {
    // A smooth line and its soft area, a live end dot (PriceLineSvg's area variant); the dashed level of the first close
    // only beside the change it measures.
    plot = <PriceLineSvg history={line.history} label="Pool price, last 24 hours" height={LINE_HEIGHT} pad={LINE_PAD} title={line.title} onInspect={setPoint} variant="area" tone={tone} level={direction !== null} live />
  } else if (bars) {
    plot = <VolumeBarsSvg candles={bars.candles} intervalSeconds={bars.intervalSeconds} label="Hourly volume" height={BARS_HEIGHT} title={bars.title} onInspect={setBar} />
  } else if (series.kind === 'figure') {
    // The row's own figure, aged on this card's clock like its TVL; a dash when there is no row or no value.
    const volume = market ? market.volume24hUsd : series.metric
    // A figure the store is about to collect rests as a bubble, as the TVL does, never a dash while it is coming.
    const coming = market?.figuresPending === true && (!volume || presentMetric(volume).kind === 'unavailable')
    // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): why there is no chart ("Price chart
    // unavailable: <why>.", lib/read/cardSeries.ts) is no longer this figure's title, and its dash no longer says "24h
    // volume unavailable". The reason stays as data (`data-chart-unavailable`).
    plot = (
      <span className="dm-mkt-plot-figure" data-chart-unavailable={series.code}>
        {volume && presentMetric(volume).kind === 'value' ? <MetricCell metric={volume} /> : coming ? <span aria-hidden="true" className="dm-skel dm-mkt-skel-tvl" /> : <FigureDash />}
      </span>
    )
  }

  let price = null
  if (line) {
    price = (
      <div className="dm-mkt-card-price">
        <span data-card-price={shownPoint ? 'hour' : live ? 'pool' : 'close'} className="dm-mkt-card-close dm-fig-lg">{shownText}</span>
        {change && (
          <span className="dm-delta dm-mkt-card-delta" data-sign={change.sign} data-variant="pill">
            <span className="dm-delta-arrow" aria-hidden="true" />
            {change.sign !== 0 && <span className="sr-only">{change.sign > 0 ? '+' : '−'}</span>}
            {change.text}
          </span>
        )}
        <span className="dm-mkt-card-unit">
          <PoolTokenLabel token={line.quote} /> for 1 <PoolTokenLabel token={line.base} />
        </span>
      </div>
    )
  } else if (series.kind === 'waiting') {
    price = (
      <div className="dm-mkt-card-price" aria-hidden="true">
        <span className="dm-skel dm-mkt-skel-close" />
        <span className="dm-skel dm-mkt-skel-delta" />
        <span className="dm-skel dm-mkt-skel-unit" />
      </div>
    )
  }

  return (
    <a href={poolHref(poolId, token)} data-market-card={poolId} data-card-series={series.kind} data-card-direction={tone} className="dm-plate dm-dots-chart dm-mkt-card animate-rise" style={style}>
      <div className="dm-mkt-card-head">
        <Pair market={market} catalogue={catalogue} />
        <span className="dm-mkt-card-open" aria-hidden="true">↗</span>
      </div>
      {price}
      <div className="dm-mkt-plot" data-series-stale={(line ?? bars)?.stale ? '' : undefined}>
        {plot}
      </div>
      <div className="dm-mkt-card-foot">
        {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): no sr-only " · Last available history" after a kept chart. */}
        <p className="dm-mkt-card-caption">{caption}</p>
        <span className="dm-mkt-card-tvl">
          <span className="dm-mkt-card-label" title="Total value held in the pool">TVL</span>
          <span className="dm-mkt-card-figure">
            {market && !(market.figuresPending && presentMetric(market.tvlUsd).kind === 'unavailable') ? (
              <MetricCell metric={market.tvlUsd} />
            ) : market || series.kind === 'waiting' ? (
              // Waiting for the card's read, or for figures the store is about to collect (marketsProvider.ts, catch-up).
              <span aria-hidden="true" className="dm-skel dm-mkt-skel-tvl" />
            ) : (
              // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the dash no longer says "TVL unavailable".
              <FigureDash />
            )}
          </span>
        </span>
      </div>
    </a>
  )
}
