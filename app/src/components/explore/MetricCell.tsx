import { compactUsd, percentText, presentMetric, turnover, type FigureFallback, type Market, type Metric, type Presented } from '../../lib/markets'
import { reasonText } from '../../lib/read/describe'
import { utcTime } from '../../lib/read/screens/figures'
import { Skeleton, cx } from '../ui'

/**
 * A figure whose reads have not settled yet: a quiet placeholder in the
 * figure's place, named only for assistive technology. It is not
 * "Unavailable": nothing has failed. `data` carries the caller's data-*
 * hooks, so tests and styling can tell it from a settled figure.
 */
export function PendingFigure({ label, className, data }: { label: string; className?: string; data?: Record<`data-${string}`, string> }) {
  return (
    <span className={cx('inline-flex w-full justify-end', className)} {...data}>
      <Skeleton className="h-4 w-20" />
      <span className="sr-only">{label} loading</span>
    </span>
  )
}

/**
 * A presented figure in a cell, a card or a stat: unavailable, not reported,
 * not current, stale, a provider's, Domino's calculation from a
 * provider's figures, or current. One rule for the Markets table, the Markets
 * cards, Home and the pool page, so no screen reads a figure differently from
 * another. A provider figure is dated only by when it was retrieved: the
 * provider's own update time is not known. Titles carry our own words for a
 * state, never provider text.
 *
 * Size comes from where the figure sits (a 14px table cell, a 16px card
 * figure, a 24px stat); this sets weight, tone and figures only.
 */
export function PresentedFigure({
  shown,
  retrieved,
  strong = true,
  tone = 'fg',
  className,
}: {
  shown: Presented
  retrieved?: string
  strong?: boolean
  /** `in`: a yield figure (an APR), in the gains ink (DESIGN-V2 §2.4); stale or current alike. */
  tone?: 'fg' | 'in'
  className?: string
}) {
  if (shown.kind === 'unavailable') {
    return (
      <span className={cx('text-fg-subtle', className)} data-metric={shown.rejected ? 'rejected' : 'unavailable'} title={shown.reason ? `Unavailable: ${reasonText(shown.reason)}` : undefined}>
        Unavailable
      </span>
    )
  }
  if (shown.kind === 'absent') {
    return (
      <span className={cx('text-fg-subtle', className)} data-metric="absent" title={`Unavailable: ${shown.source ? 'the market data provider' : 'the source'} reported no value`}>
        {shown.source ? 'Not reported by the provider' : 'Not reported'}
      </span>
    )
  }
  if (shown.kind === 'not_current') {
    return (
      <span
        className={cx('text-fg-subtle', className)}
        data-metric="not-current"
        title={shown.basis === 'reference' ? 'Reference analytics only, not a current figure' : 'Calculated over an incomplete window, not a current figure'}
      >
        Not current
      </span>
    )
  }
  // Every figure in the site's own ink, stale or not: its age and whether it is
  // still current are one hover away, in its title, never a colour or a word
  // beside the number.
  return (
    <span
      className={cx('tnum whitespace-nowrap', tone === 'in' ? 'text-money-in' : 'text-fg', strong && 'font-medium', className)}
      data-metric={shown.stale ? 'stale' : shown.source ? 'provider' : shown.calculatedFrom ? 'calculated' : 'qualified'}
      data-figure-source={shown.fallback}
      title={valueTitle(shown, retrieved)}
    >
      {shown.text}
    </span>
  )
}

/** How long ago a unix time was, in whole minutes or hours, for a figure's title. */
export function agoText(seconds: number, nowMs: number = Date.now()): string {
  const ago = Math.max(0, Math.floor(nowMs / 1000) - seconds)
  if (ago < 120) return `${ago} s ago`
  if (ago < 7_200) return `${Math.floor(ago / 60)} min ago`
  return `${Math.floor(ago / 3_600)} h ago`
}

/**
 * A stand-in figure's title (audit V1, 2026-10-01): where it comes from and when it was observed, and that the read
 * service's own provider did not answer this time. DEX Screener is named: it is a second source, beside the read
 * service's own provider, and a reader should be able to tell the two apart.
 */
export function fallbackTitle(fallback: FigureFallback, asOf: number | undefined, kind: 'figure' | 'estimate' = 'figure'): string {
  const when = asOf === undefined ? 'at an unknown time' : `at ${utcTime(asOf)} (${agoText(asOf)})`
  const why = 'Shown because the usual market data provider did not answer this time.'
  if (kind === 'estimate') {
    switch (fallback) {
      case 'kept':
        return `The last estimate this page saw, from figures a market data provider reported ${when}. Not current. ${why}`
      case 'dexscreener':
        return `Worked out the read service’s way (fixed LP fee × 24h volume ÷ TVL × 365) from DEX Screener’s figures, retrieved ${when}. ${why}`
      case 'selection':
        return `The estimate today’s selection of Top pools was made with, from figures reported ${when}. Not current. ${why}`
      case 'discovered':
        return `Worked out the read service’s way (fixed LP fee × 24h volume ÷ TVL × 365) from DEX Screener’s figures, retrieved ${when}. Domino doesn’t collect this pool’s figures yet.`
      default:
        return fallback satisfies never
    }
  }
  switch (fallback) {
    case 'kept':
      return `Last reported by a market data provider ${when}. Not current. ${why}`
    case 'dexscreener':
      return `Reported by DEX Screener, a second market data provider, retrieved ${when}. Not reconciled by Domino. ${why}`
    case 'selection':
      return `From today’s selection of Top pools, as a market data provider reported it ${when}. Not current. ${why}`
    case 'discovered':
      return `Reported by DEX Screener, a market data provider, retrieved ${when}. Domino doesn’t collect this pool’s figures yet. Not reconciled by Domino.`
    default:
      return fallback satisfies never
  }
}

/** Who a shown figure comes from, and how old it is, in our own words. A provider is the part it plays, never its name. */
export function valueTitle(shown: Extract<Presented, { kind: 'value' }>, retrieved = 'retrieval time unknown'): string | undefined {
  if (shown.fallback) return fallbackTitle(shown.fallback, shown.asOf)
  const stale = shown.stale ? ' Stale, not current.' : ''
  if (shown.source) return `Reported by a market data provider, ${retrieved}. Not reconciled by Domino.${stale}`
  // Only 24h vol/TVL is calculated from a provider's figures.
  if (shown.calculatedFrom) return `Calculated by Domino from a market data provider’s reported 24h volume and TVL, ${retrieved}. Those figures are not reconciled by Domino.${stale}`
  if (!shown.stale) return undefined
  return shown.asOf ? `Last observed ${new Date(shown.asOf * 1000).toLocaleString('en-US')}` : 'Last observed value, not current'
}

/** A market metric, as money or as a percentage. `tone="in"` draws a yield (an APR) in the gains ink. */
export function MetricCell({ metric, percent, retrieved, tone, className }: { metric: Metric; percent?: boolean; retrieved?: string; tone?: 'fg' | 'in'; className?: string }) {
  const shown = presentMetric(metric, (m) => (percent ? `${percentText(m) ?? 'Unavailable'}%` : compactUsd(m)))
  return <PresentedFigure shown={shown} retrieved={retrieved} tone={tone} className={className} />
}

/** Daily volume over TVL, Domino's own ratio of two figures on one basis; unavailable otherwise. */
export function TurnoverCell({ market, retrieved, className }: { market: Pick<Market, 'volume24hUsd' | 'tvlUsd'>; retrieved?: string; className?: string }) {
  return <PresentedFigure shown={turnover(market)} retrieved={retrieved} className={className} />
}
