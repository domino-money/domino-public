import { compactUsd, percentText, presentMetric, turnover, type FigureFallback, type Market, type Metric, type Presented } from '../../lib/markets'
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
 * A presented figure in a cell, a card or a stat: a provider's, Domino's
 * calculation from a provider's figures, Domino's own, or a dash where there
 * is no number. One rule for the Markets table, the Markets cards, Home and
 * the pool page, so no screen reads a figure differently from another. Titles
 * carry our own words for where a figure comes from, never provider text.
 *
 * Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): a
 * figure with no number is the dash "—" every empty value already shows, with
 * no title and no words; it used to read "Unavailable" (title "Unavailable:
 * <reason>"), "Not reported by the provider" / "Not reported" (title
 * "Unavailable: the market data provider reported no value") or "Not current"
 * (title "Reference analytics only, not a current figure" / "Calculated over
 * an incomplete window, not a current figure"). Its state stays in
 * `data-metric`. A kept (stale) value is still shown as the value, and its
 * title names its source only: when it was retrieved, and that it is stale,
 * are no longer said.
 *
 * Size comes from where the figure sits (a 14px table cell, a 16px card
 * figure, a 24px stat); this sets weight, tone and figures only.
 */
export function PresentedFigure({
  shown,
  strong = true,
  tone = 'fg',
  className,
}: {
  shown: Presented
  strong?: boolean
  /** `in`: a yield figure (an APR), in the gains ink (DESIGN-V2 §2.4); stale or current alike. */
  tone?: 'fg' | 'in'
  className?: string
}) {
  if (shown.kind !== 'value') {
    const state = shown.kind === 'unavailable' ? (shown.rejected ? 'rejected' : 'unavailable') : shown.kind === 'absent' ? 'absent' : 'not-current'
    return (
      <span className={cx('text-fg-subtle', className)} data-metric={state}>
        —
      </span>
    )
  }
  // Every figure in the site's own ink, kept or not: where it comes from is one
  // hover away, in its title, never a colour or a word beside the number.
  return (
    <span
      className={cx('tnum whitespace-nowrap', tone === 'in' ? 'text-money-in' : 'text-fg', strong && 'font-medium', className)}
      data-metric={shown.stale ? 'stale' : shown.source ? 'provider' : shown.calculatedFrom ? 'calculated' : 'qualified'}
      data-figure-source={shown.fallback}
      title={valueTitle(shown)}
    >
      {shown.text}
    </span>
  )
}

/**
 * A stand-in figure's title (audit V1, 2026-10-01): where it comes from. DEX Screener is named: it is a second source,
 * beside the read service's own provider, and a reader should be able to tell the two apart.
 *
 * Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the basis only. Dropped: when it was observed
 * ("at HH:MM:SS UTC, YYYY-MM-DD (N s ago)", "at an unknown time"), "Not current.", "Shown because the usual market data
 * provider did not answer this time." and "Domino doesn’t collect this pool’s figures yet." `asOf` is no longer said.
 */
export function fallbackTitle(fallback: FigureFallback, kind: 'figure' | 'estimate' = 'figure'): string {
  if (kind === 'estimate') {
    switch (fallback) {
      case 'kept':
        return 'An estimate from figures a market data provider reported.'
      case 'dexscreener':
      case 'discovered':
        return 'Worked out the read service’s way (fixed LP fee × 24h volume ÷ TVL × 365) from DEX Screener’s figures.'
      case 'selection':
        return 'The estimate today’s selection of Top pools was made with.'
      default:
        return fallback satisfies never
    }
  }
  switch (fallback) {
    case 'kept':
      return 'Reported by a market data provider. Not reconciled by Domino.'
    case 'dexscreener':
      return 'Reported by DEX Screener, a second market data provider. Not reconciled by Domino.'
    case 'selection':
      return 'From today’s selection of Top pools, as a market data provider reported it.'
    case 'discovered':
      return 'Reported by DEX Screener, a market data provider. Not reconciled by Domino.'
    default:
      return fallback satisfies never
  }
}

/**
 * Who a shown figure comes from, in our own words. A provider is the part it plays, never its name.
 *
 * Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the basis only. Dropped: the retrieval time
 * (", retrieved N s ago", ", retrieval time unknown"), " Stale, not current.", and a kept value of Domino's own history
 * no longer says "Last observed <time>" / "Last observed value, not current": it has no title, as a current one has none.
 */
export function valueTitle(shown: Extract<Presented, { kind: 'value' }>): string | undefined {
  if (shown.fallback) return fallbackTitle(shown.fallback)
  if (shown.source) return 'Reported by a market data provider. Not reconciled by Domino.'
  // Only 24h vol/TVL is calculated from a provider's figures.
  if (shown.calculatedFrom) return 'Calculated by Domino from a market data provider’s reported 24h volume and TVL. Those figures are not reconciled by Domino.'
  return undefined
}

/**
 * A market metric, as money or as a percentage. `tone="in"` draws a yield (an APR) in the gains ink.
 * Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): no `retrieved` any more (its words left every
 * title), and a percent that cannot be written is the dash, never "Unavailable%".
 */
export function MetricCell({ metric, percent, tone, className }: { metric: Metric; percent?: boolean; tone?: 'fg' | 'in'; className?: string }) {
  const shown = presentMetric(metric, (m) => (percent ? (percentText(m) === null ? '—' : `${percentText(m)}%`) : compactUsd(m)))
  return <PresentedFigure shown={shown} tone={tone} className={className} />
}

/** Daily volume over TVL, Domino's own ratio of two figures on one basis; a dash otherwise. */
export function TurnoverCell({ market, className }: { market: Pick<Market, 'volume24hUsd' | 'tvlUsd'>; className?: string }) {
  return <PresentedFigure shown={turnover(market)} className={className} />
}
