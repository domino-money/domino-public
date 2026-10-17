import { useEffect, useRef } from 'react'
import { agedMarket, feeLabel, presentMetric, type Market, type Metric } from '../../../lib/markets'
import { useFeatured } from '../../../lib/read/featuredSource'
import { pricePair } from '../../../lib/read/orientation'
import { poolAprPresentation } from '../../../lib/read/poolAprPresentation'
import { addressKey, poolIdKey } from '../../../lib/read/screens/identity'
import { useReadSource } from '../../../lib/read/screens/readContext'
import { useFallbackRows } from '../../../lib/read/useFallback'
import { shownResult, useMarkets } from '../../../lib/read/useMarkets'
import { useNow } from '../../../lib/read/useNow'
import { useDialog } from '../../../lib/useDialog'
import { MetricCell } from '../../explore/MetricCell'
import { IconClose } from '../../icons'
import { TokenMarkPair } from '../../TokenIcon'
import { FigureDash, IconButton, Skeleton } from '../../ui'
import { TokenLabel } from '../TokenLabel'
import { FallbackApr } from './FallbackApr'
import { PoolAprEstimate } from './PoolAprEstimate'
import { PoolHistoryChart, type PoolHistoryOption } from './LazyPoolHistoryChart'

/** The pool page's preferred direction, from the verified pool and token addresses. */
export function figuresHistoryOption(market: Market): PoolHistoryOption | null {
  const { base, quote } = pricePair(market.tokens.base, market.tokens.quote)
  if (base.address.toLowerCase() === quote.address.toLowerCase()) return null
  try {
    return { key: poolIdKey(market.poolId), currencies: [{ ...base, address: addressKey(base.address) }, { ...quote, address: addressKey(quote.address) }] }
  } catch {
    return null
  }
}

const sourceName = (metric: Metric): string | null => {
  if (metric.source === 'GeckoTerminal') return 'GeckoTerminal'
  if (metric.source === 'DexScreener') return 'DEX Screener'
  return metric.state === 'qualified' ? 'Domino history' : null
}

/** The selected pool stays live and shares the pool page's cached, automatically refreshed price history. */
export function PoolFiguresDialog({ market: opened, onClose }: { market: Market; onClose: () => void }) {
  const source = useReadSource()
  const { state } = useMarkets()
  const featured = useFeatured()
  const now = useNow(true)
  const current = shownResult(state)?.markets.find(row => row.key === opened.key) ?? opened
  const [market] = useFallbackRows([agedMarket(current, now)], featured.entries, now)
  const dialog = useDialog(true, onClose)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])

  const pair = pricePair(market.tokens.base, market.tokens.quote)
  const option = figuresHistoryOption(market)
  const apr = poolAprPresentation(market, now)
  const coming = market.figuresPending === true
  const sources = [...new Set([sourceName(market.tvlUsd), sourceName(market.volume24hUsd)].filter(Boolean))].join(', ')
  const loading = (label: string, data: Record<`data-${string}`, string>) => <span className="inline-flex" {...data}>
    <Skeleton className="h-4 w-16" /><span className="sr-only">{label} loading</span>
  </span>

  return <div role="presentation" className="dm-dialog-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="pool-figures-title" className="dm-dialog dm-pool-figures" data-pool-figures-dialog="" data-ember="">
      <header className="dm-pool-figures-head">
        <TokenMarkPair base={pair.base} quote={pair.quote} size={36} ring="var(--surface-2)" />
        <div className="min-w-0">
          <h2 id="pool-figures-title" ref={heading} tabIndex={-1} className="dm-dialog-title outline-none"><TokenLabel token={pair.base} /> / <TokenLabel token={pair.quote} /></h2>
          <p className="dm-pool-figures-venue">Uniswap · {feeLabel(market)}</p>
        </div>
      </header>
      <IconButton label="Close" icon={<IconClose />} variant="ghost" size="sm" className="dm-dialog-close" onClick={onClose} />

      <dl className="dm-pool-figures-metrics" data-figures-summary="">
        <div><dt>APR</dt><dd>{apr.qualified ? <MetricCell metric={market.feeAprPercent} percent tone="in" />
          : apr.pending ? loading('Estimated APR', { 'data-apr-summary': 'pending' })
            : apr.fallback ? <FallbackApr apr={apr.fallback} compact /> : <PoolAprEstimate observation={market.feeAprEstimate} now={now} compact />}</dd></div>
        <div><dt>TVL</dt><dd>{coming && presentMetric(market.tvlUsd).kind === 'unavailable' ? loading('TVL', { 'data-figure-summary': 'pending' }) : <MetricCell metric={market.tvlUsd} />}</dd></div>
        <div><dt>24h volume</dt><dd>{coming && presentMetric(market.volume24hUsd).kind === 'unavailable' ? loading('24h volume', { 'data-figure-summary': 'pending' }) : <MetricCell metric={market.volume24hUsd} />}</dd></div>
      </dl>

      {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the figures carry no retrieval time in their
          titles any more, and a pool with no chart is a dash that no longer says "Price history is unavailable for this pool." */}
      {source && option ? <PoolHistoryChart source={source} option={option} market={market} loading={coming} compact />
        : <section className="dm-card dm-pool-chart dm-pool-chart--compact" aria-label="Price history" data-pool-chart-awaiting-source="">
          <h3 className="dm-pool-heading">Price history</h3>
          <div className="dm-pool-plot-empty" role="status">{option ? <><Skeleton className="h-4 w-24" /><span className="sr-only">Price history loading</span></> : <FigureDash />}</div>
        </section>}

      <details className="dm-details dm-pool-figures-details" data-figures-sources="">
        <summary tabIndex={0}>Details</summary>
        <dl className="dm-pool-figures-facts">
          <div><dt>Network</dt><dd>Robinhood Chain</dd></div>
          <div><dt>Pool fee</dt><dd>{feeLabel(market)}</dd></div>
          {(apr.qualified || apr.fallback || apr.estimate.text !== null) && <div><dt>APR basis</dt><dd>{apr.qualified ? 'Verified fees over 24h' : 'Recent pool activity'}</dd></div>}
          {sources && <div><dt>Data sources</dt><dd>{sources}</dd></div>}
        </dl>
      </details>
    </div>
  </div>
}
