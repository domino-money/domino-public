import { compactUsd, percentText, presentMetric, turnover, type Market, type Metric, type Presented } from '../../lib/markets'
import { reasonText } from '../../lib/read/describe'
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
export function PresentedFigure({ shown, retrieved, strong = true, className }: { shown: Presented; retrieved?: string; strong?: boolean; className?: string }) {
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
      className={cx('tnum whitespace-nowrap text-fg', strong && 'font-medium', className)}
      data-metric={shown.stale ? 'stale' : shown.source ? 'provider' : shown.calculatedFrom ? 'calculated' : 'qualified'}
      title={valueTitle(shown, retrieved)}
    >
      {shown.text}
    </span>
  )
}

/** Who a shown figure comes from, and how old it is, in our own words. A provider is the part it plays, never its name. */
export function valueTitle(shown: Extract<Presented, { kind: 'value' }>, retrieved = 'retrieval time unknown'): string | undefined {
  const stale = shown.stale ? ' Stale, not current.' : ''
  if (shown.source) return `Reported by a market data provider, ${retrieved}. Not reconciled by Domino.${stale}`
  // Only 24h vol/TVL is calculated from a provider's figures.
  if (shown.calculatedFrom) return `Calculated by Domino from a market data provider's reported 24h volume and TVL, ${retrieved}. Those figures are not reconciled by Domino.${stale}`
  if (!shown.stale) return undefined
  return shown.asOf ? `Last observed ${new Date(shown.asOf * 1000).toLocaleString('en-US')}` : 'Last observed value, not current'
}

/** A market metric, as money or as a percentage. */
export function MetricCell({ metric, percent, retrieved, className }: { metric: Metric; percent?: boolean; retrieved?: string; className?: string }) {
  const shown = presentMetric(metric, (m) => (percent ? `${percentText(m) ?? 'Unavailable'}%` : compactUsd(m)))
  return <PresentedFigure shown={shown} retrieved={retrieved} className={className} />
}

/** Daily volume over TVL, Domino's own ratio of two figures on one basis; unavailable otherwise. */
export function TurnoverCell({ market, retrieved, className }: { market: Pick<Market, 'volume24hUsd' | 'tvlUsd'>; retrieved?: string; className?: string }) {
  return <PresentedFigure shown={turnover(market)} retrieved={retrieved} className={className} />
}
