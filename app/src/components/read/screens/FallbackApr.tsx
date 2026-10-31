import type { FallbackApr as Fallback } from '../../../lib/markets'
import { aprDigits } from '../../../lib/format/apr'
import { ESTIMATE_SCOPE } from '../../../lib/read/aprEstimate'
import { cx } from '../../ui'

/**
 * The percent as a row writes an estimate: the one APR rule of every screen (lib/format/apr.ts, audit E21,
 * 2026-10-01), one decimal under 100%, whole from there, "<0.1" for a positive one too small for it.
 */
export function fallbackPercent(apr: Fallback): string | null {
  return aprDigits(apr.percent)
}

/**
 * An APR estimate standing in for the read service's when its provider did not answer this time (audit V1,
 * 2026-10-01; lib/read/figureFallback.ts): written as an estimate is ("12.34% est."), in the same ink, with where it
 * comes from and when it was observed in its title, and its basis as data. `compact` in a table cell or a stat; plain
 * in the ticker ("12.34% est. APR").
 */
export function FallbackApr({ apr, compact = false }: { apr: Fallback; compact?: boolean }) {
  const text = fallbackPercent(apr)
  if (text === null) return null
  return (
    <span data-apr-estimate="fallback" data-figure-source={apr.basis}>
      {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): no longer when it was observed nor "Not
          current. Shown because the usual market data provider did not answer this time." (MetricCell fallbackTitle).
          Changed on purpose 2026-10-30 (QA round 2, N105/Q29): the one plain sentence every "est." figure has
          (ESTIMATE_SCOPE); it began with its basis, e.g. "Worked out the read service’s way (fixed LP fee × 24h volume ÷
          TVL × 365) from DEX Screener’s figures.". The basis stays as data (data-figure-source). */}
      <span className={cx('tnum whitespace-nowrap', compact ? 'font-medium text-money-in' : 'text-fg')} title={ESTIMATE_SCOPE}>
        {/* V4: a compact figure's "est." is quieter and smaller than the figure (.apr i, .stat-q); the words stay the same. */}
        {compact ? <>{`${text}% `}<span className="dm-apr-est">est.</span></> : `${text}% est. APR`}
      </span>
    </span>
  )
}
