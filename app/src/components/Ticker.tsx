import { aprLabel, feeLabel, type Instant, type Metric } from '../lib/markets'
import { estimateTitle, presentAprEstimate, type AprEstimateObservation } from '../lib/read/aprEstimate'
import { describeFailure } from '../lib/read/describe'
import { shownResult, useMarkets } from '../lib/read/useMarkets'
import { TokenMarkPair } from './TokenIcon'
import { PoolAprEstimate } from './read/screens/PoolAprEstimate'
import { useNow } from '../lib/read/useNow'
import { poolListings } from '../config/selectedPoolCatalogue'
import { PoolCatalogueIdentity, PoolTokenLabel } from './PoolCatalogueIdentity'

/** The strip's words for an APR it has no figure for: the same for a pool not read yet and a read pool without an estimate. */
const NO_APR = 'Est. APR —'

/**
 * The backend estimate in the strip: its figure when there is one; otherwise
 * the one label a pool without a figure has, why in the title, and the
 * estimate's state as data.
 */
function EstimateApr({ observation, now }: { observation?: AprEstimateObservation; now: Instant }) {
  const shown = presentAprEstimate(observation, now)
  if (shown.text !== null) return <PoolAprEstimate observation={observation} now={now} />
  return (
    <span data-apr-estimate={shown.state}>
      <span className="tnum whitespace-nowrap text-fg-subtle" title={estimateTitle(observation, now)}>
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

/** The APR in the strip, under the same state rule as the table: never a retained value as current, never an invented one. */
function Apr({ metric }: { metric: Metric }) {
  const shown = aprLabel(metric)
  if (shown.kind === 'unavailable') {
    return (
      <span className="tnum text-fg-subtle" data-metric={shown.rejected ? 'rejected' : 'unavailable'}>
        APR unavailable
      </span>
    )
  }
  if (shown.kind === 'absent') {
    return (
      <span className="tnum text-fg-subtle" data-metric="absent">
        APR not reported
      </span>
    )
  }
  if (shown.kind === 'not_current') {
    return (
      <span className="tnum text-fg-subtle" data-metric="not-current">
        APR not current
      </span>
    )
  }
  return (
    <span
      className="tnum"
      style={{ color: shown.stale ? 'var(--fg)' : 'var(--money-in)' }}
      data-metric={shown.stale ? 'stale' : shown.source ? 'provider' : 'qualified'}
      title={shown.stale ? 'Last observed value, not current' : undefined}
    >
      {shown.text}
    </span>
  )
}

/**
 * Scrolling strip of pools across the top of Home: pair, fee tier and pool
 * APR. It reads nothing of its own: it shows the result set of the Selected
 * pools table, from the same provider. Pair names come from the token reads.
 * Domino's qualified historical APR, where pool-metrics provides one, stands
 * where the table's APR cell has it; otherwise the backend estimate, with its
 * source, caveat and age. A pool with no APR figure reads "Est. APR —"
 * whether its row has not landed or landed without an estimate, so nothing
 * changes words as the rows arrive; why is in the title. With no rows it
 * says why. The strip pauses while it is hovered or holds focus; with
 * reduced motion it stands still and scrolls by hand.
 */
export function Ticker() {
  const { state, provider } = useMarkets()
  const result = shownResult(state)
  const markets = result?.markets ?? []
  const now = useNow(markets.length > 0)
  const listings = poolListings(markets, __DOMINO_POOL_SET__ === 'selected' && provider.kind === 'bridge')

  // Each item opens its pool page, by PoolId. The divider between items is a
  // pseudo-element, so the strip's children stay exactly the items. The
  // seamless second copy takes its links out of the tab order.
  const render = (copy: boolean) => listings.map(({ poolId, market: m, catalogue }) => m ? (
    <a href={`#/pool/${m.poolId}`} key={m.key} tabIndex={copy ? -1 : undefined} className="dm-ticker-item">
      <TokenMarkPair base={m.tokens.base} quote={m.tokens.quote} size={16} ring="var(--bg)" />
      <span className="dm-ticker-pair">
        <PoolTokenLabel token={m.tokens.base} />/<PoolTokenLabel token={m.tokens.quote} />
      </span>
      <span className="tnum">{feeLabel(m)}</span>
      {historicalApr(m.feeAprPercent) ? <Apr metric={m.feeAprPercent} /> : <EstimateApr observation={m.feeAprEstimate} now={now} />}
    </a>
  ) : catalogue ? <a href={`#/pool/${poolId}`} key={poolId} tabIndex={copy ? -1 : undefined} className="dm-ticker-item" data-pool-catalogue={poolId}>
    <PoolCatalogueIdentity entry={catalogue} compact />
    <span className="tnum whitespace-nowrap text-fg-subtle" title="Pool figures are unavailable, so there is no estimated APR.">{NO_APR}</span>
  </a> : null)
  const items = render(false)

  const quiet = state.phase === 'failed' ? describeFailure(state.failure).title : state.phase === 'ready' ? 'No pools selected yet' : 'Loading pools…'

  return (
    <div className="dm-ticker" data-ticker="">
      {__DOMINO_READ_MODE__ === 'fixture' && provider.kind === 'fixture' && (
        <span className="dm-ticker-tag" title="Contract fixtures, not observations">
          Fixture
        </span>
      )}
      <div className="dm-ticker-scroller">
        {items.length === 0 ? (
          // The table below carries the status line; the strip only says there is nothing to scroll, and why.
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
