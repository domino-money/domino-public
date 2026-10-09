import { lazy, Suspense, type ComponentProps } from 'react'
import { isMissingChunk, recoverWhenSafe } from '../../../lib/staleRelease'
import { Skeleton } from '../../ui'
import type { PoolHistoryChart as SharedPoolHistoryChart } from './PoolHistoryChart'

export type { PoolHistoryOption } from './PoolHistoryChart'
type Props = ComponentProps<typeof SharedPoolHistoryChart>

/** A pool's chart loads when its page or figures dialog opens, without delaying wallet or position reads. */
const History = lazy(() => import('./PoolHistoryChart')
  .then(module => ({ default: module.PoolHistoryChart }))
  .catch((error: unknown) => {
    if (isMissingChunk(error)) recoverWhenSafe()
    return { default: (props: Props) => <HistoryPlaceholder compact={props.compact} unavailable /> }
  }))

function HistoryPlaceholder({ compact, unavailable = false }: { compact?: boolean; unavailable?: boolean }) {
  const Bubble = unavailable ? 'span' : Skeleton
  return <div data-history-mode="chain"><section className={`dm-card dm-pool-chart${compact ? ' dm-pool-chart--compact' : ''}`} aria-label="Price history" data-pool-history-placeholder="" data-pool-history-loading={unavailable ? undefined : ''}>
    <div className="dm-pool-chart-head">
      <h2 className="dm-title">Price history</h2>
      <Bubble className="dm-pool-skel-seg" aria-hidden="true" />
    </div>
    <div className="dm-pool-skel-figure" aria-hidden="true"><Bubble className="dm-pool-skel-price" /><Bubble className="dm-pool-skel-date" /></div>
    <div className="dm-pool-chart-body">
      <div className="dm-pool-plot dm-pool-plot-empty">
        {unavailable ? <p className="text-body text-fg-muted">Price history is temporarily unavailable.</p>
          : <><Skeleton className="dm-pool-plot-baseline" /><span role="status" className="sr-only">Loading price history…</span></>}
      </div>
      <div className="dm-pool-skel-axis" aria-hidden="true"><Bubble className="dm-pool-skel-tick" /><Bubble className="dm-pool-skel-tick" /></div>
    </div>
    <div className="dm-pool-chart-foot" aria-hidden="true"><Bubble className="dm-pool-skel-switch" /></div>
  </section></div>
}

export function PoolHistoryChart(props: Props) {
  return <Suspense fallback={<HistoryPlaceholder compact={props.compact} />}><History {...props} /></Suspense>
}
