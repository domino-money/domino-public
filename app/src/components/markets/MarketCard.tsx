import { useState, type CSSProperties } from 'react'
import type { Candle } from 'api-contracts/read-v1/types'
import type { PoolCatalogueEntry, PoolListing } from '../../config/selectedPoolCatalogue'
import { agedMarket, feeLabel, retrievedAgeSeconds, retrievedText, type Instant, type Market } from '../../lib/markets'
import { formatUsdCompact } from '../../lib/read/decimal'
import { unreadToken } from '../../lib/read/project'
import { VolumeBarsSvg } from '../charts/VolumeBars'
import { MetricCell } from '../explore/MetricCell'
import { poolHref } from '../explore/routes'
import { PoolTokenLabel } from '../PoolCatalogueIdentity'
import { TokenIcon, TokenMark, TokenMarkPair } from '../TokenIcon'

/**
 * What a card's plot shows, decided by the carousel from real outcomes only.
 * Every state ends: nothing here waits or pulses for ever.
 */
export type CardVolume =
  /** The markets read has no row for this pool yet. */
  | { kind: 'loading' }
  /** The markets read finished and this pool stayed a catalogue row. */
  | { kind: 'no-figures' }
  /** A live row whose hourly read is queued, running, or about to be asked for as the card comes into view. */
  | { kind: 'reading' }
  | { kind: 'bars'; candles: readonly Candle[]; intervalSeconds: number; returned: number; stale: boolean; title: string }
  /** An answer without usable candles, and why. */
  | { kind: 'unavailable'; reason: string }
  /** The read itself failed, in failureText's words. */
  | { kind: 'failed'; title: string; detail: string }
  /** The candles are older than the read service's own limit, so they are no longer drawn. */
  | { kind: 'expired' }

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
 * and up to 24 bars of its reported hourly volume. The whole card opens the
 * pool page. Pointing along the plot names one hour and its volume in the
 * caption; colour is never the only cue. The rail decides what the plot
 * shows; the card only draws it.
 */
export function MarketCard({ listing, index, now, volume }: { listing: PoolListing; index: number; now: Instant; volume: CardVolume }) {
  const [inspected, setInspected] = useState<Candle | null>(null)
  const { poolId, market: read, catalogue } = listing
  const market = read ? agedMarket(read, now) : null
  const retrieved = market?.provenance ? retrievedText(retrievedAgeSeconds(market.provenance.market, now)) : undefined
  const bars = volume.kind === 'bars' ? volume : null
  const shown = bars && inspected && bars.candles.some((candle) => candle.startTimestamp === inspected.startTimestamp) ? inspected : null
  // The plot's ground is set in markets.css, so hovering can change it with the plate.
  const style = { '--delay': `${Math.min(index, 3) * 60}ms` } as CSSProperties

  let caption = null
  if (volume.kind === 'loading') caption = <span>Reading pool figures…</span>
  else if (volume.kind === 'reading') caption = <span>Reading hourly volume…</span>
  else if (volume.kind === 'expired') caption = <span data-chart-unavailable="">Hourly volume expired</span>
  else if (volume.kind === 'no-figures') caption = <span data-chart-unavailable="">Hourly volume unavailable: this pool’s figures didn’t load.</span>
  else if (bars && shown) {
    caption = (
      <span className="tnum">
        {hour(shown.startTimestamp)} UTC · {formatUsdCompact(shown.volumeUsd) ?? 'Unavailable'}
        {!shown.closed && ' · open hour'}
      </span>
    )
  } else if (bars) {
    caption = (
      <span className="tnum">
        Volume by hour · {bars.returned} {bars.returned === 1 ? 'candle' : 'candles'}
      </span>
    )
  }

  return (
    <a href={poolHref(poolId)} data-market-card={poolId} className="dm-plate dm-dots-chart dm-mkt-card animate-rise" style={style}>
      <div className="dm-mkt-card-head">
        <Pair market={market} catalogue={catalogue} />
        <span className="dm-mkt-card-tvl">
          <span className="dm-mkt-card-label">TVL</span>
          <span className="dm-mkt-card-figure">
            {market ? (
              <MetricCell metric={market.tvlUsd} retrieved={retrieved} />
            ) : (
              <span className="text-fg-subtle" aria-label="TVL unavailable">
                —
              </span>
            )}
          </span>
        </span>
      </div>
      <div className="dm-mkt-plot">
        {bars && (
          <VolumeBarsSvg candles={bars.candles} intervalSeconds={bars.intervalSeconds} label="Hourly volume" height={96} title={bars.title} onInspect={setInspected} />
        )}
        {(volume.kind === 'loading' || volume.kind === 'reading') && <span aria-hidden="true" className="dm-mkt-baseline" />}
        {volume.kind === 'unavailable' && (
          <p className="dm-mkt-plot-note" data-chart-unavailable="">
            Hourly volume unavailable: {volume.reason}
          </p>
        )}
        {volume.kind === 'failed' && (
          <p className="dm-mkt-plot-note" data-chart-unavailable="">
            {volume.title} · {volume.detail}
          </p>
        )}
      </div>
      <p className="dm-mkt-card-caption">{caption}</p>
    </a>
  )
}
