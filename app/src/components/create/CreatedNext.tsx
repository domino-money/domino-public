import { useState } from 'react'
import { askAutoExitOnArrival } from '../../lib/automate/autoExitAsk'
import { AUTO_EXIT_FEATURE, FEATURES, FEATURE_ORDER, type FeatureKey } from '../../lib/automate/features'
import { priceOf, type JourneyState } from '../../lib/create/journey'
import { rangePosition, usableTicks } from '../../lib/read/screens/poolRange'
import { ModeArt, PlainArt } from '../automate/ModeArt'
import { positionHref, sequenceHref } from '../explore/routes'
import { ExitThumb } from '../home/Vignettes'
import { IconChevronRight } from '../icons'
import { Pill } from '../ui'

/** Where each choice leads: the position's own page, or the automation page with this position and that mode chosen. */
const hrefOf = (key: FeatureKey, tokenId: string) => (key === 'plain' ? positionHref(tokenId) : sequenceHref(tokenId, key))

/**
 * Whether the range just opened sits beside today's price (a buy or a sell: it starts in one token and converts as the
 * price crosses it), from the journey's own price read; false when either is unknown. Added 2026-10-06 (the owner's
 * point 5): where Auto-exit is recommended.
 */
export function createdBeside(state: Pick<JourneyState, 'pool' | 'range'> | null | undefined, now: number): boolean {
  if (!state?.range) return false
  const price = priceOf(state.pool, now)
  return price !== null && price.state === 'usable' && rangePosition(state.range, price.tick) !== 'inside'
}

/**
 * Whether the range just opened covers every price the pool allows (both ends at the usable ticks of its spacing):
 * Auto-exit has nothing to close it at, so it is not offered. Added 2026-10-06 (the review of point 5).
 */
export function createdFullRange(state: Pick<JourneyState, 'pool' | 'range'> | null | undefined): boolean {
  if (!state?.range || !state.pool) return false
  const { min, max } = usableTicks(state.pool.tickSpacing)
  return state.range.lower <= min && state.range.upper >= max
}

/**
 * New position's success (2026-09-24, the owner's three features "totally
 * integrated"): the position is in the wallet, and the natural next step is
 * offered where Create position was pressed, instead of the page leaving on
 * its own. Quiet rows, each a link: keep it as a plain position and open it,
 * or automate it with Auto-compound or Domino-compound, whose setup opens with
 * this position already chosen (#/sequence/<mode>/<id>). Nothing is signed or
 * read here.
 *
 * Changed on purpose 2026-10-06 (the owner's point 5; rugged97: "someone makes an LP to buy or sell; when the price hits
 * the edge of the range we close the position automatically"): in a build that carries Domino V2, Auto-exit is offered
 * beside them, and recommended when the range sits beside today's price (`state`, the journey that made it). The
 * question no longer speaks of fees only. Changed on purpose 2026-10-06 (the review of point 5): it opens the position's
 * own page with Auto-exit's dialog asked for (lib/automate/autoExitAsk.ts), which its automation panel opens once it can
 * offer it there; not Set up automation, which depends on V1's automation release. Where Auto-exit is not offered, the
 * page is simply the position's.
 */
export function CreatedNext({ tokenId, state }: { tokenId: string; state?: Pick<JourneyState, 'pool' | 'range'> | null }) {
  const [now] = useState(() => Date.now())
  const beside = createdBeside(state, now)
  const exit = __DOMINO_V2__ && !createdFullRange(state)
  return (
    <section className="dm-created" aria-labelledby="created-title" data-created-position={tokenId}>
      <p id="created-title" className="dm-created-line" role="status">
        Position NFT <span translate="no">{tokenId}</span> is in your wallet. What should Domino do with it?
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
        {exit && (
          // The panel's key for a Robinhood Chain Uniswap v4 position is its bare id (src/v2in/autoexit/entry.ts exitOrderKey).
          <a href={positionHref(tokenId)} onClick={() => askAutoExitOnArrival(tokenId)} className="dm-created-choice" data-created-next="autoexit" data-created-recommended={beside ? '' : undefined}>
            <span className="dm-created-art" aria-hidden="true">
              <ExitThumb />
            </span>
            <span className="dm-created-text">
              <span className="dm-created-name">
                {AUTO_EXIT_FEATURE.name}
                <span className="dm-created-fee"> · {AUTO_EXIT_FEATURE.fee}</span>
                {beside && (
                  <>
                    {' '}
                    <Pill tone="accent" className="dm-created-pill">Recommended</Pill>
                  </>
                )}
              </span>
              <span className="dm-created-note">{AUTO_EXIT_FEATURE.line}</span>
            </span>
            <span className="dm-created-go">
              <span className="dm-created-go-text">Turn on</span>
              <IconChevronRight size={16} />
            </span>
          </a>
        )}
      </nav>
    </section>
  )
}
