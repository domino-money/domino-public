import { estimateTitle, presentAprEstimate, type AprEstimateObservation } from '../../../lib/read/aprEstimate'
import { formatUsdCompact } from '../../../lib/read/decimal'
import type { Instant } from '../../../lib/markets'
import { fixedFeePercent } from '../../../lib/read/screens/fee'
import { protocolFee, utcTime } from '../../../lib/read/screens/figures'
import { cx } from '../../ui'

/** The protocol fee an estimate was worked out with: none, one rate both ways, or the rate selling the first token / the second. */
function protocolFeeWords(raw: number): string {
  const fee = protocolFee(raw)
  if (fee.state === 'none') return 'None'
  if (fee.state === 'invalid') return '—'
  return fee.zeroForOnePips === fee.oneForZeroPips ? fee.zeroForOne : `${fee.zeroForOne} / ${fee.oneForZero}`
}

/**
 * The read service's pool fee APR estimate, labelled as one: `compact` in a
 * table cell or a stat ("12.34% est.", or without a figure the same dash a
 * catalogue row shows, so a row that lands without an estimate changes no
 * word), plain in the ticker ("Est. APR unavailable"), `detailed` where its
 * inputs are listed, beside `label` when one is given. What the estimate is
 * not, why it is unavailable and whether it is stale are its title, from the
 * estimate's own limitations and reasons, and its state is data either way;
 * the figure is in the site's own ink. It is never a figure the app worked
 * out.
 */
export function PoolAprEstimate({ observation, now, detailed = false, compact = false, label }: { observation?: AprEstimateObservation; now: Instant; detailed?: boolean; compact?: boolean; label?: string }) {
  const shown = presentAprEstimate(observation, now)
  const data = observation?.data
  const title = estimateTitle(observation, now)
  const tone = shown.text === null ? 'text-fg-subtle' : 'text-fg'
  if (detailed) {
    const inputs = data?.inputs
    const usd = (value: string | null | undefined) => (value === null || value === undefined ? '—' : (formatUsdCompact(value) ?? '—'))
    const figure = (
      <span className={cx('tnum whitespace-nowrap font-medium', label ? undefined : 'text-body', tone)} title={title} data-apr-figure="">
        {shown.text === null ? '—' : `${shown.text}% est. APR`}
      </span>
    )
    return (
      <div data-apr-estimate={shown.state} data-apr-reasons={shown.reasons.join(' ') || undefined} className={cx('grid text-[13px] leading-[18px]', label ? 'gap-1.5' : 'gap-3')}>
        {label ? (
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="text-fg-muted">{label}</span>
            {figure}
          </div>
        ) : (
          figure
        )}
        {data && inputs && (
          <dl className="grid gap-1.5 text-caption text-fg-subtle" data-apr-inputs="">
            <div className="flex flex-wrap justify-between gap-x-3"><dt>LP fee</dt><dd className="tnum text-fg-muted">{fixedFeePercent(inputs.currentLpFeePips)}</dd></div>
            <div className="flex flex-wrap justify-between gap-x-3"><dt>Protocol fee</dt><dd className="tnum text-fg-muted" title={`Selling the pool’s first token / its second. Packed value ${inputs.protocolFeeRaw}.`}>{protocolFeeWords(inputs.protocolFeeRaw)}</dd></div>
            <div className="flex flex-wrap justify-between gap-x-3"><dt>24h volume, GeckoTerminal</dt><dd className="tnum text-fg-muted" title={inputs.volume24hUsd ?? undefined}>{usd(inputs.volume24hUsd)}</dd></div>
            <div className="flex flex-wrap justify-between gap-x-3"><dt>TVL, GeckoTerminal</dt><dd className="tnum text-fg-muted" title={inputs.reportedLiquidityUsd ?? undefined}>{usd(inputs.reportedLiquidityUsd)}</dd></div>
            <div className="flex flex-wrap justify-between gap-x-3"><dt>Method</dt><dd className="text-fg-muted">365 × LP fee × (1 − protocol fee) × 24h volume ÷ TVL</dd></div>
            {data.provenance.retrievedAt !== null && (
              <div className="flex flex-wrap justify-between gap-x-3"><dt>Inputs retrieved</dt><dd className="tnum text-fg-muted">{utcTime(data.provenance.retrievedAt)}</dd></div>
            )}
            <div className="flex flex-wrap justify-between gap-x-3"><dt>Pool verified</dt><dd className="tnum text-fg-muted">block {data.provenance.snapshot.number}</dd></div>
            {shown.text !== null && data.feeAprEstimate24hPercent !== null && (
              <div className="flex flex-wrap justify-between gap-x-3"><dt>Exact estimate</dt><dd className="tnum break-all text-fg-muted">{data.feeAprEstimate24hPercent}%</dd></div>
            )}
          </dl>
        )}
      </div>
    )
  }
  if (compact && shown.text === null) {
    // The catalogue row's dash (MarketsTable's Dash), with this estimate's state as data and its reasons as the title.
    return (
      <span data-apr-estimate={shown.state}>
        <span className="text-fg-subtle" title={title}>
          —
        </span>
      </span>
    )
  }
  return (
    <span data-apr-estimate={shown.state}>
      <span className={cx('tnum whitespace-nowrap', compact ? 'font-medium' : undefined, tone)} title={title}>
        {shown.text === null ? 'Est. APR unavailable' : `${shown.text}% ${compact ? 'est.' : 'est. APR'}`}
      </span>
      {!compact && shown.text !== null && <span className="ml-1 text-fg-subtle">from GeckoTerminal inputs</span>}
    </span>
  )
}
