import { aprLabel, feeLabel, type FallbackApr as Fallback, type Instant, type Market, type Metric } from '../lib/markets'
import { feeWords } from '../lib/format/fee'
import { presentAprEstimate, type AprEstimateObservation } from '../lib/read/aprEstimate'
import { shownResult, useMarkets } from '../lib/read/useMarkets'
import { TokenMarkPair } from './TokenIcon'
import { FallbackApr } from './read/screens/FallbackApr'
import { PoolAprEstimate } from './read/screens/PoolAprEstimate'
import { useNow } from '../lib/read/useNow'
import { useFeatured } from '../lib/read/featuredSource'
import { pricePair } from '../lib/read/orientation'
import { useFallbackRows } from '../lib/read/useFallback'
import { poolListings } from '../config/selectedPoolCatalogue'
import { poolHref } from './explore/routes'
import { PoolCatalogueIdentity, PoolTokenLabel } from './PoolCatalogueIdentity'

/** The strip's words for an APR it has no figure for: the same for a pool not read yet and a read pool without an estimate. */
const NO_APR = 'Est. APR —'

/**
 * The backend estimate in the strip: its figure when there is one; otherwise
 * the one label a pool without a figure has, why in the title, and the
 * estimate's state as data. A row waiting for figures the store is collecting
 * (`figuresPending`, marketsProvider.ts) is loading, as the table's cell says,
 * not unavailable (added 2026-09-25, r4/metrics).
 */
function EstimateApr({ observation, now, pending = false, fallback }: { observation?: AprEstimateObservation; now: Instant; pending?: boolean; fallback?: Fallback }) {
  const shown = presentAprEstimate(observation, now)
  if (shown.text !== null) return <PoolAprEstimate observation={observation} now={now} />
  // An estimate standing in for the read service's when its provider did not answer (audit V1, lib/read/figureFallback.ts).
  if (fallback) return <FallbackApr apr={fallback} />
  // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): "Est. APR —" with no title; it used to be
  // titled "Est. APR loading" or with why there is no estimate (estimateTitle's reasons).
  return (
    <span data-apr-estimate={pending ? 'pending' : shown.state}>
      <span className="tnum whitespace-nowrap text-fg-subtle">
        {NO_APR}
      </span>
    </span>
  )
}

/**
 * Whether a row's APR is Domino's own qualified history, current or retained:
 * the same test the table's APR cell makes, so the strip and the table show
 * the same APR for a pool, and the backend estimate only where there is none.
 */
const historicalApr = (metric: Metric) => metric.value !== null && (metric.state === 'qualified' || metric.state === 'stale')

/**
 * The APR in the strip, under the same state rule as the table: never a retained value as current, never an invented one.
 * Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): an APR with no figure reads "APR —" (it used to
 * read "APR unavailable", "APR not reported" or "APR not current"), and a kept one no longer has the title "Last observed
 * value, not current". The state stays in `data-metric`.
 */
function Apr({ metric }: { metric: Metric }) {
  const shown = aprLabel(metric)
  if (shown.kind !== 'value') {
    return (
      <span className="tnum text-fg-subtle" data-metric={shown.kind === 'unavailable' ? (shown.rejected ? 'rejected' : 'unavailable') : shown.kind === 'absent' ? 'absent' : 'not-current'}>
        APR —
      </span>
    )
  }
  return (
    <span
      className="tnum"
      style={{ color: shown.stale ? 'var(--fg)' : 'var(--money-in)' }}
      data-metric={shown.stale ? 'stale' : shown.source ? 'provider' : 'qualified'}
    >
      {shown.text}
    </span>
  )
}

/** A row's pair as its price is written, "TOKEN/USDG" (audit E21, lib/read/orientation.ts). */
function TickerPair({ m }: { m: Market }) {
  const pair = pricePair(m.tokens.base, m.tokens.quote)
  return (
    <>
      <TokenMarkPair base={pair.base} quote={pair.quote} size={16} ring="var(--bg)" />
      <span className="dm-ticker-pair">
        <PoolTokenLabel token={pair.base} />/<PoolTokenLabel token={pair.quote} />
      </span>
    </>
  )
}

const NO_MARKETS: readonly Market[] = []

/**
 * Scrolling strip of pools across the top of Home: pair, fee tier and pool
 * APR. It reads nothing of its own: it shows the result set of the Selected
 * pools table, from the same provider. Pair names come from the token reads.
 * Domino's qualified historical APR, where pool-metrics provides one, stands
 * where the table's APR cell has it; otherwise the backend estimate, with its
 * source, caveat and age. A pool with no APR figure reads "Est. APR —"
 * whether its row has not landed or landed without an estimate, so nothing
 * changes words as the rows arrive; why is in the title. With no rows it
 * says it is loading them, or that none are selected. The strip pauses while
 * it is hovered or holds focus; with reduced motion it stands still and
 * scrolls by hand.
 */
export function Ticker() {
  const { state, provider } = useMarkets()
  const result = shownResult(state)
  const read = result?.markets ?? NO_MARKETS
  const now = useNow(read.length > 0)
  // The list on screen (lib/read/featuredSource.ts): the featured list, or the embedded one.
  const featured = useFeatured()
  const listed = __DOMINO_POOL_SET__ === 'selected' && provider.kind === 'bridge'
  // Refused figures stood in for, as the table does (audit V1); nothing named until the list's first answer (B4).
  const markets = useFallbackRows(read, listed ? featured.entries : null, now)
  const listings = listed && !featured.settled ? [] : poolListings(markets, listed ? featured.entries : null)

  // Each item opens its pool page, by PoolId and the token to verify it with
  // (`#/pool/<id>/<token>`), so a link still opens once the pool has left the
  // list. The divider between items is a pseudo-element, so the strip's
  // children stay exactly the items. The seamless second copy takes its links
  // out of the tab order.
  const render = (copy: boolean) => listings.map(({ poolId, market: m, catalogue, token }) => m ? (
    <a href={poolHref(m.poolId, token)} key={m.key} tabIndex={copy ? -1 : undefined} className="dm-ticker-item">
      <TickerPair m={m} />
      <span className="tnum">{feeWords(feeLabel(m))}</span>
      {historicalApr(m.feeAprPercent) ? <Apr metric={m.feeAprPercent} /> : <EstimateApr observation={m.feeAprEstimate} now={now} pending={m.figuresPending === true} fallback={m.aprFallback} />}
    </a>
  ) : catalogue ? <a href={poolHref(poolId, token)} key={poolId} tabIndex={copy ? -1 : undefined} className="dm-ticker-item" data-pool-catalogue={poolId}>
    <PoolCatalogueIdentity entry={catalogue} compact />
    {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): no title "Pool figures are unavailable, so there is no estimated APR." */}
    <span className="tnum whitespace-nowrap text-fg-subtle">{NO_APR}</span>
  </a> : null)
  const items = render(false)

  // Until the list's first answer is in there is nothing to name yet (audit B4): loading, whatever the rows' own state.
  // Changed on purpose 2026-10-30 (QA round 2, rule 3: no line saying data is unavailable): a failed read reads as one
  // still loading, as it is (a failed overview is asked again silently, with backoff); it used to show the failure's title
  // ("Temporarily unavailable", "Live data unavailable", "Read service busy").
  const quiet = state.phase === 'ready' && !(listed && !featured.settled) ? 'No pools selected yet' : 'Loading pools…'

  return (
    <div className="dm-ticker" data-ticker="">
      {__DOMINO_READ_MODE__ === 'fixture' && provider.kind === 'fixture' && (
        <span className="dm-ticker-tag" title="Contract fixtures, not observations">
          Fixture
        </span>
      )}
      <div className="dm-ticker-scroller">
        {items.length === 0 ? (
          // The strip only says there is nothing to scroll yet: loading, or no pools selected.
          <span className="dm-ticker-status" data-ticker-status="">
            {quiet}
          </span>
        ) : (
          <div className="dm-marquee" style={{ '--dur': `${items.length * 7}s` } as React.CSSProperties}>
            {items}
            {/* The seamless second copy: neither announced nor reachable by Tab. */}
            <span aria-hidden="true" inert className="contents">
              {render(true).map((it, i) => (
                <span key={`d${i}`} className="contents">
                  {it}
                </span>
              ))}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
