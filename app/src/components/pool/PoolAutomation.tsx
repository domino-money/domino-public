import { AUTO_EXIT_FEATURE, FEATURES, FEATURE_ORDER } from '../../lib/automate/features'
import { docsHref } from '../explore/routes'
import { IconCheck } from '../icons'

/** Where each feature is explained. */
const DOCS: Record<string, string> = { plain: 'new-position', protection: 'auto-exit', compound: 'auto-compound', domino: 'domino-compound' }

/**
 * The same choices as Automate: create a position, protect its range, or put its fees to work.
 * They work in a pool with no hooks and a fixed fee, the pools New
 * position opens positions in and a sequence accepts; any other pool says so in one line. `why` is that line's reason.
 */
export function PoolAutomation({ usable, why }: { usable: boolean; why: string }) {
  const choices = __DOMINO_V2__ ? ['plain', 'protection', 'compound', 'domino'] as const : FEATURE_ORDER
  return (
    <section className="dm-card dm-pool-card dm-pool-auto" aria-labelledby="pool-auto-title" data-pool-automation={usable ? 'available' : 'unavailable'}>
      <h2 id="pool-auto-title" className="dm-title">
        What you can do here
      </h2>
      {usable ? (
        <>
          <p className="dm-pool-lead">Create a position, then choose how Domino manages it.</p>
          <ul className="dm-pool-auto-list">
            {choices.map((key) => {
              const feature = key === 'protection' ? AUTO_EXIT_FEATURE : FEATURES[key]
              const slug = DOCS[key]
              return (
                <li key={key} data-feature={key}>
                  <span className="dm-pool-auto-mark" aria-hidden="true">
                    <IconCheck size={14} />
                  </span>
                  <span className="dm-pool-auto-body">
                    <span className="dm-pool-auto-name">
                      <a href={docsHref(slug)}>{key === 'plain' ? 'New position' : feature.name}</a>
                      <span className="dm-pool-auto-fee">{key === 'protection' ? feature.fee : feature.fee ? `${feature.fee} of fees` : 'No automation fee'}</span>
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
