import { APR_CAVEAT, aprReason, presentAprEstimate, type AprEstimateObservation } from '../../../lib/read/aprEstimate'
import type { Instant } from '../../../lib/markets'
import { utcTime } from '../../../lib/read/screens/figures'

export function PoolAprEstimate({ observation, now, detailed = false }: { observation?: AprEstimateObservation; now: Instant; detailed?: boolean }) {
  const shown = presentAprEstimate(observation, now)
  const data = observation?.data
  const Tag = detailed ? 'div' : 'span'
  const title = `${APR_CAVEAT}${shown.reasons.length ? ` ${shown.reasons.map(aprReason).join(' ')}` : ''}`
  return (
    <Tag data-apr-estimate={shown.state} className={detailed ? 'grid gap-2 text-[13px]' : 'text-[12px]'}>
      <span className={`tnum font-mono ${shown.state === 'stale' ? 'text-money-wait' : shown.text === null ? 'text-fg-subtle' : 'text-fg'}`} title={title}>
        {shown.text === null ? 'Est. APR unavailable' : `${shown.text}% est. APR${shown.state === 'stale' ? ' · stale' : ''}`}
      </span>
      {!detailed && shown.text !== null && <span className="block text-[10px] text-fg-subtle">from GeckoTerminal inputs</span>}
      {detailed && <>
        <p className="text-fg-muted">{APR_CAVEAT}</p>
        {shown.reasons.length > 0 && <ul className="list-inside list-disc text-fg-muted">{shown.reasons.map((r) => <li key={r}>{aprReason(r)}</li>)}</ul>}
        {data && <dl className="grid gap-1 text-[12px] text-fg-muted">
          <div><dt className="inline">Method: </dt><dd className="inline">365 × 100 × (fixed LP fee × reported 24h volume) / current reported TVL.</dd></div>
          <div><dt className="inline">Provider: </dt><dd className="inline">GeckoTerminal; update time unknown.</dd></div>
          {data.provenance.retrievedAt !== null && <div><dt className="inline">Retrieved: </dt><dd className="inline">{utcTime(data.provenance.retrievedAt)}{shown.ageSeconds === null ? '' : ` · input age ${shown.ageSeconds} s`}</dd></div>}
          <div><dt className="inline">Pool verified: </dt><dd className="inline">block {data.provenance.snapshot.number}; {utcTime(data.provenance.snapshot.timestamp)}</dd></div>
          {shown.text !== null && <div><dt className="inline">Exact backend estimate: </dt><dd className="inline break-all font-mono">{data.feeAprEstimate24hPercent}%</dd></div>}
        </dl>}
      </>}
    </Tag>
  )
}
