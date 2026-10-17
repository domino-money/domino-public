import type { CSSProperties, ReactNode } from 'react'
import { poolListings } from '../../config/selectedPoolCatalogue'
import { agedMarket, feeLabel, percentText, presentMetric, type Instant, type Market } from '../../lib/markets'
import { feeWords } from '../../lib/format/fee'
import { useFeatured } from '../../lib/read/featuredSource'
import { pricePair } from '../../lib/read/orientation'
import { poolAprPresentation } from '../../lib/read/poolAprPresentation'
import { useFallbackRows } from '../../lib/read/useFallback'
import { shownResult, useMarkets } from '../../lib/read/useMarkets'
import { useNow } from '../../lib/read/useNow'
import { poolHref } from '../explore/routes'
import { PoolTokenLabel } from '../PoolCatalogueIdentity'
import { fallbackPercent } from '../read/screens/FallbackApr'
import { cx } from '../ui'
import { useInView } from './Vignettes'

const NO_MARKETS: readonly Market[] = []

/**
 * A row's APR exactly as the Top pools table writes it (MarketsTable's Row: Domino's qualified history, else the
 * stand-in estimate, else the read service's estimate, each "est."), or null where the table has no figure: a pool
 * without one is left out of the strip, never shown with a dash or an invented value.
 */
function aprWords(m: Market, now: Instant): string | null {
  const apr = poolAprPresentation(m, now)
  if (apr.qualified) {
    const shown = presentMetric(m.feeAprPercent, (metric) => (percentText(metric) === null ? '—' : `${percentText(metric)}%`))
    return shown.kind === 'value' && shown.text !== '—' ? shown.text : null
  }
  if (apr.pending) return null
  if (apr.fallback) {
    const text = fallbackPercent(apr.fallback)
    return text === null ? null : `${text}% est.`
  }
  return apr.estimate.text === null ? null : `${apr.estimate.text}% est.`
}

/** The site's decorative separator (V4 §5.5): a mini domino in outline. */
const SEPARATOR = (
  <svg className="dm-mq-sep" viewBox="0 0 9 16" fill="none" aria-hidden="true" focusable="false">
    <rect x="0.6" y="0.6" width="7.8" height="14.8" rx="2.2" stroke="currentColor" strokeWidth="1.2" />
    <path d="M2.4 8h4.2" stroke="currentColor" strokeWidth="1.1" />
  </svg>
)

/** Fewer pools than this fill each half of the loop by repeating, so the strip never runs out mid-screen. */
const FILL = 8

/**
 * Home's pool strip (V4 §5.5, the owner's D-H1): the pools of the Top pools table below that have an APR figure,
 * scrolling. It reads nothing of its own: the same provider, list and stand-ins as the table, so a pool's APR here
 * is the table's. With no figure to show (nothing read yet, live data not connected, a list with no figures) it shows
 * nothing at all. It pauses while hovered, focused or off screen; with reduced motion it stands still and scrolls by hand.
 */
export function HomeMarquee() {
  const { state, provider } = useMarkets()
  const result = shownResult(state)
  const read = result?.markets ?? NO_MARKETS
  const now = useNow(read.length > 0)
  const featured = useFeatured()
  const listed = __DOMINO_POOL_SET__ === 'selected' && provider.kind === 'bridge'
  const markets = useFallbackRows(read, listed ? featured.entries : null, now)
  const listings = listed && !featured.settled ? [] : poolListings(markets, listed ? featured.entries : null)
  const [ref, inView] = useInView<HTMLDivElement>(0)

  const pools = listings.flatMap(({ market, token }) => {
    if (!market) return []
    const m = agedMarket(market, now)
    const apr = aprWords(m, now)
    if (apr === null) return []
    const pair = pricePair(m.tokens.base, m.tokens.quote)
    return [{ key: m.key, href: poolHref(m.poolId, token), apr, fee: feeWords(feeLabel(m)), pair }]
  })

  const item = (pool: (typeof pools)[number], copy: string | null): ReactNode => (
    <a key={copy === null ? pool.key : `${copy}-${pool.key}`} href={pool.href} className={cx('dm-mq-item', copy !== null && 'dm-mq-copy')} tabIndex={copy === null ? undefined : -1} aria-hidden={copy === null ? undefined : true}>
      <span className="dm-mq-pair"><PoolTokenLabel token={pool.pair.base} />/<PoolTokenLabel token={pool.pair.quote} /></span>
      <span className="dm-mq-apr tnum">{pool.apr}</span>
      <span className="dm-mq-fee tnum">{pool.fee}</span>
      {SEPARATOR}
    </a>
  )
  const repeats = pools.length === 0 ? 0 : Math.ceil(FILL / pools.length) - 1
  const fill = (half: string) => Array.from({ length: repeats }, (_, round) => pools.map((pool) => item(pool, `${half}${round}`)))

  return (
    <div ref={ref} className={cx('dm-home-marquee dm-k-mq', inView && 'is-running')} data-home-marquee="">
      {pools.length > 0 && (
        <div className="dm-mq-track" style={{ '--mq-dur': `${(pools.length + repeats * pools.length) * 11}s` } as CSSProperties}>
          <div className="dm-mq-set">
            {pools.map((pool) => item(pool, null))}
            {fill('a')}
          </div>
          {/* The seamless second half: neither announced nor reachable by Tab. */}
          <div className="dm-mq-set" aria-hidden="true" inert>
            {pools.map((pool) => item(pool, 'b'))}
            {fill('c')}
          </div>
        </div>
      )}
    </div>
  )
}
