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
 */
export function ProviderFigure({ label, figure, full = false, dash = false }: { label: string; figure: AttributedFigure; full?: boolean; dash?: boolean }) {
  const provenance = provenanceText(figure)
  const valued = figure.state === 'attributed' || figure.state === 'attributed_stale'
  return (
    <div className="grid min-w-0 gap-0.5" data-provider-figure={figure.state} data-provider={figure.provider} title={provenance.long}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-[0.8125rem] leading-[1.125rem] text-fg-muted">{label}</span>
        <span className={cx('tnum text-[0.8125rem] leading-[1.125rem]', valued ? 'font-medium text-fg' : 'text-fg-subtle')}>
          {valued || !dash ? VALUE_TEXT(figure) : '—'}
        </span>
      </div>
      {full && <p className="sr-only">{provenance.long}</p>}
    </div>
  )
}
