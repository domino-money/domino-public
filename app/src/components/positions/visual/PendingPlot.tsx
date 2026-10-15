import { rem } from '../../../lib/rootScale'
import { useMediaQuery } from '../../../lib/useMediaQuery'
import { usePositionChartOptions } from '../PositionChartOptions'
import { feesChartBox } from './feesChartLayout'

/**
 * A reserved chart frame, without invented points or a zero claim while data is unknown. Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): it
 * says nothing over the frame unless a caller gives a `note`; every caller's line was about the data's freshness or
 * availability ("Updating price…", "Price is temporarily unavailable. Retrying automatically.", "Updating fee history…").
 */
export function PendingPlot({ label, note, busy = false }: { label: string; note?: string; busy?: boolean }) {
  const phone = useMediaQuery('(max-width: 767px)')
  const { expanded } = usePositionChartOptions()
  return (
    <div className="dm-pending-plot" data-pending-plot="" aria-busy={busy || undefined} style={expanded ? { height: rem(feesChartBox(phone, true)) } : undefined}>
      <svg viewBox="0 0 640 180" preserveAspectRatio="none" role="img" aria-label={label}>
        <path d="M0 24H640M0 84H640M0 144H640" className="dm-position-chart-guide" />
        <path d="M0 164H640" className="dm-chart-baseline" />
      </svg>
      {note && <p className="dm-fees-quiet-note" role="status">{note}</p>}
    </div>
  )
}
