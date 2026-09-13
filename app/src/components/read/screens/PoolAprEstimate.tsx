import { APR_CAVEAT, aprReason, presentAprEstimate, type AprEstimateObservation } from '../../../lib/read/aprEstimate'
import type { Instant } from '../../../lib/markets'
import { utcTime } from '../../../lib/read/screens/figures'
import { cx } from '../../ui'

/**
 * The read service's pool fee APR estimate, labelled as one: `compact` in a
 * table cell or a stat ("Unavailable", "12.34% est."), plain in the ticker
 * ("Est. APR unavailable"), `detailed` where its method and inputs are
 * explained. The caveat, and why it is unavailable or stale, is always the
 * figure's own title; it is never a figure the app worked out itself.
 */
export function PoolAprEstimate({ observation, now, detailed = false, compact = false }: { observation?: AprEstimateObservation; now: Instant; detailed?: boolean; compact?: boolean }) {
  const shown = presentAprEstimate(observation, now)
  const data = observation?.data
  const Tag = detailed ? 'div' : 'span'
  const title = `${APR_CAVEAT}${shown.reasons.length ? ` ${shown.reasons.map(aprReason).join(' ')}` : ''}`
  // The figure in the site's own ink; whether it is stale is in its title, and in words only where the estimate is explained in detail.
  const tone = shown.text === null ? 'text-fg-subtle' : 'text-fg'
  return (
    <Tag data-apr-estimate={shown.state} className={detailed ? 'grid gap-3 text-[13px] leading-[18px]' : undefined}>
      <span className={cx('tnum whitespace-nowrap', compact || detailed ? 'font-medium' : undefined, detailed && 'text-body', tone)} title={`${title}${shown.state === 'stale' ? ' Stale, not current.' : ''}`}>
        {shown.text === null ? (compact ? 'Unavailable' : 'Est. APR unavailable') : `${shown.text}% ${compact ? 'est.' : 'est. APR'}${detailed && shown.state === 'stale' ? ' · stale' : ''}`}
      </span>
      {!detailed && !compact && shown.text !== null && <span className="ml-1 text-fg-subtle">from GeckoTerminal inputs</span>}
      {detailed && (
        <>
          <p className="text-fg-muted">{APR_CAVEAT}</p>
          {shown.reasons.length > 0 && (
            <ul className="grid gap-1 text-fg-muted">
              {shown.reasons.map((r) => (
                <li key={r} className="flex gap-2">
                  <span aria-hidden="true" className="mt-[7px] size-1 shrink-0 rounded-full bg-fg-faint" />
                  <span>{aprReason(r)}</span>
                </li>
              ))}
            </ul>
          )}
          {data && (
            <dl className="grid gap-1.5 text-caption text-fg-subtle">
              <div className="flex flex-wrap gap-x-2"><dt>Method</dt><dd className="text-fg-muted">365 × 100 × (fixed LP fee × reported 24h volume) / current reported TVL.</dd></div>
              <div className="flex flex-wrap gap-x-2"><dt>Provider</dt><dd className="text-fg-muted">GeckoTerminal; update time unknown.</dd></div>
              {data.provenance.retrievedAt !== null && (
                <div className="flex flex-wrap gap-x-2"><dt>Retrieved</dt><dd className="tnum text-fg-muted">{utcTime(data.provenance.retrievedAt)}{shown.ageSeconds === null ? '' : ` · input age ${shown.ageSeconds} s`}</dd></div>
              )}
              <div className="flex flex-wrap gap-x-2"><dt>Pool verified</dt><dd className="tnum text-fg-muted">block {data.provenance.snapshot.number}; {utcTime(data.provenance.snapshot.timestamp)}</dd></div>
              {shown.text !== null && (
                <div className="flex flex-wrap gap-x-2"><dt>Exact backend estimate</dt><dd className="tnum break-all text-fg-muted">{data.feeAprEstimate24hPercent}%</dd></div>
              )}
            </dl>
          )}
        </>
      )}
    </Tag>
  )
}
