import { aprLabel, feeLabel, type Metric } from '../lib/markets'
import { describeFailure } from '../lib/read/describe'
import { shownResult, useMarkets } from '../lib/read/useMarkets'
import { TokenLabel } from './read/TokenLabel'
import { TokenMarkPair } from './TokenIcon'

/** The APR in the strip, under the same state rule as the table: never a retained value as current, never an invented one. */
function Apr({ metric }: { metric: Metric }) {
  const shown = aprLabel(metric)
  if (shown.kind === 'unavailable') {
    return (
      <span className="tnum font-mono text-fg-subtle" data-metric={shown.rejected ? 'rejected' : 'unavailable'}>
        APR unavailable
      </span>
    )
  }
  if (shown.kind === 'absent') {
    return (
      <span className="tnum font-mono text-fg-subtle" data-metric="absent">
        APR not reported
      </span>
    )
  }
  if (shown.kind === 'not_current') {
    return (
      <span className="tnum font-mono text-fg-subtle" data-metric="not-current">
        APR not current
      </span>
    )
  }
  return (
    <span
      className="tnum font-mono"
      style={{ color: shown.stale ? 'var(--money-wait)' : 'var(--money-in)' }}
      data-metric={shown.stale ? 'stale' : shown.source ? 'provider' : 'qualified'}
      title={shown.stale ? 'Last observed value, not current' : undefined}
    >
      {shown.text}
      {shown.stale && ' · stale'}
    </span>
  )
}

/**
 * Scrolling strip of pools across the top of the page: pair, fee tier and
 * pool APR. It reads nothing of its own: it shows the result set of the
 * Selected pools table, from the same provider. Pair names come from the
 * token reads, and the APR reads "APR unavailable" until the read service
 * provides one. With nothing to scroll it says why, in the table's words.
 */
export function Ticker() {
  const { state, provider } = useMarkets()
  const result = shownResult(state)
  const markets = result?.markets ?? []

  const items = markets.map((m) => (
    <span key={m.key} className="flex items-center gap-2.5 whitespace-nowrap px-6 py-2.5 text-[12px]">
      <TokenMarkPair base={m.tokens.base} quote={m.tokens.quote} size={18} ring="var(--surface-1)" />
      <span className="font-medium">
        <TokenLabel token={m.tokens.base} />/<TokenLabel token={m.tokens.quote} />
      </span>
      <span className="font-mono text-fg-subtle">{feeLabel(m)}</span>
      <Apr metric={m.feeAprPercent} />
    </span>
  ))

  const quiet = state.phase === 'failed' ? describeFailure(state.failure).title : state.phase === 'ready' ? 'No pools selected yet' : 'Loading pools…'

  return (
    <div className="flex items-center overflow-hidden border-b bg-surface-1" data-ticker="">
      {__DOMINO_READ_MODE__ === 'fixture' && provider.kind === 'fixture' && (
        <span className="z-10 shrink-0 border-r bg-surface-1 px-3 py-2.5 font-mono text-[10px] uppercase tracking-[0.6px] text-fg-subtle" title="Contract fixtures, not observations">
          Fixture
        </span>
      )}
      <div className="flex-1 overflow-hidden">
        {items.length === 0 ? (
          // The table below carries the status line; the strip only says there is nothing to scroll, and why.
          <span className="block px-6 py-2.5 text-[12px] text-fg-subtle" data-ticker-status="">
            {quiet}
          </span>
        ) : (
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
        )}
      </div>
    </div>
  )
}
