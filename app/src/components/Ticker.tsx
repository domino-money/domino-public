import { aprLabel, feeTierLabel, listMarkets, type Metric } from '../lib/markets'
import { TokenPair } from './TokenIcon'

/**
 * Scrolling strip of pools across the top of the page: pair, fee tier and pool
 * APR, from the same adapter as the markets table. While the adapter serves
 * sample figures the strip carries the same small label the table does; it
 * disappears on its own once the numbers are qualified.
 */
/** The APR in the strip, under the same state rule as the table: never a retained value as current. */
function Apr({ metric }: { metric: Metric }) {
  const shown = aprLabel(metric)
  if (shown.kind === 'unavailable') {
    return (
      <span className="tnum font-mono text-fg-subtle" data-metric="unavailable">
        APR unavailable
      </span>
    )
  }
  return (
    <span
      className="tnum font-mono"
      style={{ color: shown.stale ? 'var(--money-wait)' : 'var(--money-in)' }}
      data-metric={shown.stale ? 'stale' : shown.sample ? 'placeholder' : 'qualified'}
      title={shown.sample ? 'Sample figure, not an observation' : shown.stale ? 'Last observed value, not current' : undefined}
    >
      {shown.text}
      {shown.stale && ' · stale'}
    </span>
  )
}

export function Ticker() {
  const { markets, source } = listMarkets()

  const items = markets.map((m) => (
    <span key={m.poolId} className="flex items-center gap-2.5 whitespace-nowrap px-6 py-2.5 text-[12px]">
      <TokenPair base={m.base} quote={m.quote} size={18} ring="var(--surface-1)" />
      <span className="font-medium">
        {m.base}/{m.quote}
      </span>
      <span className="font-mono text-fg-subtle">{feeTierLabel(m.feePips)}</span>
      <Apr metric={m.feeAprPercent} />
    </span>
  ))

  return (
    <div className="flex items-center overflow-hidden border-b bg-surface-1">
      {source === 'placeholder' && (
        <span className="z-10 shrink-0 border-r bg-surface-1 px-3 py-2.5 font-mono text-[10px] uppercase tracking-[0.6px] text-fg-subtle" title="Sample figures until live data is qualified">
          Sample
        </span>
      )}
      <div className="flex-1 overflow-hidden">
        <div className="dm-marquee flex w-max items-center" style={{ '--dur': `${items.length * 7}s` } as React.CSSProperties}>
          {items}
          <span aria-hidden="true" className="contents">
            {items.map((it, i) => (
              <span key={`d${i}`} className="contents">
                {it}
              </span>
            ))}
          </span>
        </div>
      </div>
    </div>
  )
}
