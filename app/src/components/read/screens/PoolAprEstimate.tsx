import { estimateTitle, presentAprEstimate, type AprEstimateObservation } from '../../../lib/read/aprEstimate'
import { formatUsdCompact, toFixed } from '../../../lib/read/decimal'
import type { Instant } from '../../../lib/markets'
import { fixedFeePercent } from '../../../lib/read/screens/fee'
import { protocolFee } from '../../../lib/read/screens/figures'
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
 * word), plain in the ticker ("Est. APR —"), `detailed` where its
 * inputs are listed, beside `label` when one is given. A figure's title is
 * one plain sentence, the same for every estimate (estimateTitle,
 * ESTIMATE_SCOPE; 2026-10-30, N105), and its state and reasons are data;
 * the figure is in the site's own ink. It is never a figure the app worked
 * out. Changed on purpose 2026-09-27 (r6/marketsdata, the owner's plain-words
 * rule): the ticker's figure no longer runs "from provider-reported inputs"
 * after it; where the inputs come from stays in its title.
 */
/** The exact estimate to four decimals, trailing zeros dropped ("25.4409", "10.95"); the full figure stays in its title. */
export const preciseEstimate = (exact: string) => (toFixed(exact, 4) ?? exact).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')

export function PoolAprEstimate({ observation, now, detailed = false, compact = false, label }: { observation?: AprEstimateObservation; now: Instant; detailed?: boolean; compact?: boolean; label?: string }) {
  const shown = presentAprEstimate(observation, now)
  const data = observation?.data
  // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the title is the estimate's basis
  // (estimateTitle), and only on a figure: a dash has none (it used to carry why there is no estimate). Changed on purpose
  // 2026-10-30 (QA round 2, N105/Q29): one sentence for the compact and the detailed figure alike, as for a stand-in's.
  const title = shown.text === null ? undefined : estimateTitle(observation)
  const tone = shown.text === null ? 'text-fg-subtle' : 'text-fg'
  if (detailed) {
    const inputs = data?.inputs
    const usd = (value: string | null | undefined) => (value === null || value === undefined ? '—' : (formatUsdCompact(value) ?? '—'))
    const figure = (
      <span className={cx('tnum whitespace-nowrap font-medium', label ? undefined : 'text-body', tone)} title={title} data-apr-figure="">
        {/* QA round 2, Q34: beside its label ("Estimated APR") the figure is the percent alone, never "46.5% est. APR". */}
        {shown.text === null ? '—' : label ? `${shown.text}%` : `${shown.text}% est. APR`}
      </span>
    )
    return (
      <div data-apr-estimate={shown.state} data-apr-reasons={shown.reasons.join(' ') || undefined} className={cx('grid text-[0.8125rem] leading-[1.125rem]', label ? 'gap-1.5' : 'gap-3')}>
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
            <div className="flex flex-wrap justify-between gap-x-3"><dt>24h volume, provider-reported</dt><dd className="tnum text-fg-muted" title={inputs.volume24hUsd ?? undefined}>{usd(inputs.volume24hUsd)}</dd></div>
            <div className="flex flex-wrap justify-between gap-x-3"><dt>TVL, provider-reported</dt><dd className="tnum text-fg-muted" title={inputs.reportedLiquidityUsd ?? undefined}>{usd(inputs.reportedLiquidityUsd)}</dd></div>
            <div className="flex flex-wrap justify-between gap-x-3"><dt>Method</dt><dd className="text-fg-muted">365 × LP fee × (1 − protocol fee) × 24h volume ÷ TVL</dd></div>
            {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): no "Inputs retrieved <HH:MM:SS UTC, date>" row. */}
            <div className="flex flex-wrap justify-between gap-x-3"><dt>Pool verified</dt><dd className="tnum text-fg-muted">block {data.provenance.snapshot.number.toLocaleString('en-US')}</dd></div>
            {shown.text !== null && data.feeAprEstimate24hPercent !== null && (
              // Changed on purpose 2026-10-30 (QA round 2, Q34): four decimals, the read service's whole figure in its title
              // (it printed 18 decimals of figures that are rounded at the provider).
              <div className="flex flex-wrap justify-between gap-x-3"><dt>Precise estimate</dt><dd className="tnum text-fg-muted" title={`${data.feeAprEstimate24hPercent}%`}>{preciseEstimate(data.feeAprEstimate24hPercent)}%</dd></div>
            )}
          </dl>
        )}
      </div>
    )
  }
  if (compact && shown.text === null) {
    // The catalogue row's dash (MarketsTable's Dash), with this estimate's state as data and no title (pack 7).
    return (
      <span data-apr-estimate={shown.state}>
        <span className="text-fg-subtle" title={title}>
          —
        </span>
      </span>
    )
  }
  // An APR figure in a table cell or a stat is a yield, in the gains ink (DESIGN-V2 §2.4); the ticker's plain form keeps the ink.
  const ink = compact && shown.text !== null ? 'text-money-in' : tone
  return (
    <span data-apr-estimate={shown.state}>
      <span className={cx('tnum whitespace-nowrap', compact ? 'font-medium' : undefined, ink)} title={title}>
        {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): "Est. APR —", never "Est. APR unavailable". */}
        {/* V4: a compact figure's "est." is quieter and smaller than the figure (.apr i, .stat-q); the words stay the same. */}
        {shown.text === null ? 'Est. APR —' : compact ? <>{`${shown.text}% `}<span className="dm-apr-est">est.</span></> : `${shown.text}% est. APR`}
      </span>
    </span>
  )
}
