import { FEATURES, FEATURE_ORDER, type FeatureKey } from '../../lib/automate/features'
import { ModeArt, PlainArt } from '../automate/ModeArt'
import { positionHref, sequenceHref } from '../explore/routes'
import { IconChevronRight } from '../icons'

/** Where each choice leads: the position's own page, or the automation page with this position and that mode chosen. */
const hrefOf = (key: FeatureKey, tokenId: string) => (key === 'plain' ? positionHref(tokenId) : sequenceHref(tokenId, key))

/**
 * New position's success (2026-09-24, the owner's three features "totally
 * integrated"): the position is in the wallet, and the natural next step is
 * offered where Create position was pressed, instead of the page leaving on
 * its own. Three quiet rows, each a link: keep it as a plain position and
 * open it, or automate it with Auto-compound or Domino-compound, whose setup
 * opens with this position already chosen (#/sequence/<mode>/<id>). Nothing is
 * signed or read here.
 */
export function CreatedNext({ tokenId }: { tokenId: string }) {
  return (
    <section className="dm-created" aria-labelledby="created-title" data-created-position={tokenId}>
      <p id="created-title" className="dm-created-line" role="status">
        Position NFT <span translate="no">{tokenId}</span> is in your wallet. What should its earned fees do?
      </p>
      <nav className="dm-created-choices" aria-labelledby="created-title">
        {FEATURE_ORDER.map((key) => {
          const feature = FEATURES[key]
          return (
            <a key={key} href={hrefOf(key, tokenId)} className="dm-created-choice" data-created-next={key}>
              <span className="dm-created-art" aria-hidden="true">
                {key === 'plain' ? <PlainArt /> : <ModeArt mode={key} size="thumb" />}
              </span>
              <span className="dm-created-text">
                <span className="dm-created-name">
                  {feature.name}
                  {feature.fee && <span className="dm-created-fee"> · {feature.fee}</span>}
                </span>
                <span className="dm-created-note">{feature.line}</span>
              </span>
              <span className="dm-created-go">
                <span className="dm-created-go-text">{key === 'plain' ? 'View position' : 'Set up'}</span>
                <IconChevronRight size={16} />
              </span>
            </a>
          )
        })}
      </nav>
    </section>
  )
}
