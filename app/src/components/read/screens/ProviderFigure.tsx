import { provenanceText, type AttributedFigure } from '../../../lib/read/screens/figures'
import { cx } from '../../ui'

const VALUE_TEXT = (figure: AttributedFigure) => {
  switch (figure.state) {
    case 'attributed':
    case 'attributed_stale':
      return figure.value
    case 'not_reported':
      return 'Not reported'
    case 'unavailable':
      return 'Unavailable'
    case 'rejected':
      return 'Rejected, not shown'
    default:
      return figure satisfies never
  }
}

/**
 * One provider figure with who reported it, as a word beside it: the
 * provider's name, and for a current figure its cache age. A stale figure
 * reads as the figure, in the same ink; when it was retrieved, that it is
 * stale and why a figure is missing are its title and data, never a caption
 * or a colour. `full` also gives that sentence to assistive technology.
 * With `dash` a missing figure is a dash, with why only in its title and
 * data, as in the markets tables; without it the missing figure says so in
 * words.
 *
 * Changed on purpose 2026-10-06 (rugged97's delta of 6 Oct §4): `note`, what
 * the figure says of itself in place of provenanceText's words, where the
 * provider is named (Base's and Arbitrum One's rows in New position: DEX
 * Screener and when it was read, or why there is no figure,
 * lib/create/otherChains.ts networkFigureNote). Its dash then carries the note
 * as its accessible name too (as FigureDash does), and its closed reason as
 * `data-provider-reason`. Without `note` nothing changes.
 */
export function ProviderFigure({ label, figure, full = false, dash = false, note }: { label: string; figure: AttributedFigure; full?: boolean; dash?: boolean; note?: string }) {
  const provenance = provenanceText(figure)
  const valued = figure.state === 'attributed' || figure.state === 'attributed_stale'
  const said = note ?? provenance.long
  const reason = note !== undefined && (figure.state === 'unavailable' || figure.state === 'rejected') ? figure.reason : undefined
  return (
    <div className="grid min-w-0 gap-0.5" data-provider-figure={figure.state} data-provider={figure.provider} data-provider-reason={reason} title={said}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-[0.8125rem] leading-[1.125rem] text-fg-muted">{label}</span>
        <span className={cx('tnum text-[0.8125rem] leading-[1.125rem]', valued ? 'font-medium text-fg' : 'text-fg-subtle')} aria-label={note !== undefined && dash && !valued ? note : undefined}>
          {valued || !dash ? VALUE_TEXT(figure) : '—'}
        </span>
      </div>
      {full && <p className="sr-only">{said}</p>}
    </div>
  )
}
