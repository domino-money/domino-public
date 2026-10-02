import { FEATURES, FEATURE_ORDER } from '../../lib/automate/features'
import { docsHref } from '../explore/routes'
import { IconCheck } from '../icons'

/** Where each feature is explained. */
const DOCS: Record<string, string | null> = { plain: 'earned-fees', compound: 'auto-compound', domino: 'domino-compound' }

/**
 * What Domino can do in this pool, the product's three features side by side (lib/automate/features.ts): a plain
 * position, and the two ways to put its fees to work. They work in a pool with no hooks and a fixed fee, the pools New
 * position opens positions in and a sequence accepts; any other pool says so in one line. `why` is that line's reason.
 */
export function PoolAutomation({ usable, why }: { usable: boolean; why: string }) {
  return (
    <section className="dm-card dm-pool-card dm-pool-auto" aria-labelledby="pool-auto-title" data-pool-automation={usable ? 'available' : 'unavailable'}>
      <h2 id="pool-auto-title" className="dm-title">
        What you can do here
      </h2>
      {usable ? (
        <>
          <p className="dm-pool-lead">Create a position, then choose in Automate what happens to its fees.</p>
          <ul className="dm-pool-auto-list">
            {FEATURE_ORDER.map((key) => {
              const feature = FEATURES[key]
              const slug = DOCS[key]
              return (
                <li key={key} data-feature={key}>
                  <span className="dm-pool-auto-mark" aria-hidden="true">
                    <IconCheck size={14} />
                  </span>
                  <span className="dm-pool-auto-body">
                    <span className="dm-pool-auto-name">
                      {slug ? <a href={docsHref(slug)}>{feature.name}</a> : feature.name}
                      <span className="dm-pool-auto-fee">{feature.fee ? `${feature.fee} of fees` : 'No service fee'}</span>
                    </span>
                    <span className="dm-pool-auto-line">{feature.line}</span>
                  </span>
                </li>
              )
            })}
          </ul>
        </>
      ) : (
        <p className="dm-pool-lead" data-pool-automation-why="">
          Domino can’t open positions in this pool: {why}. You can still follow its price and figures here.
        </p>
      )}
    </section>
  )
}
