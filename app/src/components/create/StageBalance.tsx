import { CREATE } from '../../lib/create/copy'
import { previewRequest, type JourneyState } from '../../lib/create/journey'

const ROWS = [
  ['needed', CREATE.balance.rows.needed],
  ['wallet', CREATE.balance.rows.wallet],
  ['swap', CREATE.balance.rows.swap],
  ['leftovers', CREATE.balance.rows.leftovers],
] as const

/**
 * The deposit composition, inside Review (the `balance` stage has no step of
 * its own). Its shape is shown, its figures are not: they are calculated in
 * Setup from exact pool state when the deposit is prepared, and nothing is
 * estimated in their place.
 */
export function StageBalance() {
  return (
    <section aria-labelledby="create-amounts-heading" className="dm-flow-section" data-stage="balance">
      <h3 id="create-amounts-heading" className="dm-flow-subtitle">
        {CREATE.review.amounts}
      </h3>
      <dl className="dm-flow-facts">
        {ROWS.map(([key, label]) => (
          <div key={key} data-balance-row={key}>
            <dt>{label}</dt>
            <dd className="text-fg-subtle">{CREATE.balance.rows.unavailable}</dd>
          </div>
        ))}
      </dl>
      <p className="dm-hint">
        {CREATE.balance.notEnabled} {CREATE.balance.notEnabledDetail}
      </p>
      <p className="dm-hint">{CREATE.balance.swapNote}</p>
    </section>
  )
}

/** The request the deposit would be prepared from, exactly as formed; never sent from this page. */
export function RequestDetails({ state }: { state: JourneyState }) {
  const request = previewRequest(state)
  return (
    <details className="dm-details dm-flow-disclosure">
      <summary>{CREATE.balance.requestHeading}</summary>
      <div className="grid gap-2">
        <p className="text-caption text-fg-muted">{CREATE.balance.requestNote}</p>
        {request.ok ? (
          <pre className="dm-pre" data-preview-request="">
            {JSON.stringify(request.request, null, 2)}
          </pre>
        ) : (
          <p role="status" className="text-caption text-money-wait" data-preview-request-missing="">
            {CREATE.balance.cannotForm} {request.reason}
          </p>
        )}
      </div>
    </details>
  )
}
