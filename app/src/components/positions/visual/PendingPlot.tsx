/** A reserved chart frame, without invented points or a zero claim while data is unknown. */
export function PendingPlot({ label, note, busy = false }: { label: string; note: string; busy?: boolean }) {
  return (
    <div className="dm-pending-plot" data-pending-plot="" aria-busy={busy || undefined}>
      <svg viewBox="0 0 640 180" preserveAspectRatio="none" role="img" aria-label={label}>
        <path d="M0 24H640M0 84H640M0 144H640" className="dm-position-chart-guide" />
        <path d="M0 164H640" className="dm-chart-baseline" />
      </svg>
      <p className="dm-fees-quiet-note" role="status">{note}</p>
    </div>
  )
}
