import { provenanceText, type AttributedFigure } from '../../../lib/read/screens/figures'
import { cx } from '../../ui'

const VALUE_TEXT = (figure: AttributedFigure) => {
  switch (figure.state) {
    case 'attributed':
      return figure.value
    case 'attributed_stale':
      return `${figure.value} · stale`
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
 * One provider figure with who reported it and when it was retrieved, in
 * words: the provider's name and the state are visible text, never colour or
 * a tooltip alone.
 */
export function ProviderFigure({ label, figure, full = false }: { label: string; figure: AttributedFigure; full?: boolean }) {
  const provenance = provenanceText(figure)
  const valued = figure.state === 'attributed' || figure.state === 'attributed_stale'
  return (
    <div className="grid gap-0.5" data-provider-figure={figure.state} data-provider={figure.provider}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-[12px] text-fg-muted">{label}</span>
        <span className={cx('tnum font-mono text-[13px]', valued ? (figure.state === 'attributed_stale' ? 'text-money-wait' : 'text-fg') : 'text-fg-subtle')}>
          {VALUE_TEXT(figure)} <span className="text-[11px] text-fg-subtle">· {provenance.short}</span>
        </span>
      </div>
      {full && <p className="text-[11px] leading-relaxed text-fg-subtle">{provenance.long}</p>}
    </div>
  )
}
