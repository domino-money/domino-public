import { Button } from '../../components/ui'
import { NEW_POOL_TITLE } from './constants'
import { useJourneyNetwork } from './context'
import { JOURNEY } from './copy'

/**
 * "Create a new pool (advanced)" at the foot of New position's pool step (spec F7 §2.6.5, decision #7: an advanced path,
 * labeled apart; the owner, 2026-10-02 night: no network choice anywhere, the pool step stays exactly today's). A closed
 * disclosure in the step's own advanced look; opening it and pressing the button turns the journey to the zap path's
 * pool finder on Robinhood Chain (./NewPositionV2.tsx `findOther`), where a pool Domino does not list is read through
 * the wallet and one with no price yet can be created. Nothing where the wrapper offers no finder (V2 off).
 *
 * Default export: the lazily mounted part (components/create/Journey.tsx).
 */
export default function PoolAdvanced() {
  const network = useJourneyNetwork()
  if (!network?.findOther) return null
  return (
    <details className="dm-details dm-flow-advanced" data-pool-advanced="">
      <summary>
        <span>{NEW_POOL_TITLE}</span>
      </summary>
      <div className="grid gap-3">
        <p className="text-caption text-fg-muted">{JOURNEY.pool.advancedLead}</p>
        <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={network.findOther} data-network-find-other="">
          {JOURNEY.pool.findOther}
        </Button>
      </div>
    </details>
  )
}
