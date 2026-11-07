import { Button } from '../../components/ui'
import { ELYSIUM_V2_ID } from '../../lib/elysiumIdentity'
import type { V2ChainId } from '../../v2/types'
import { NEW_POOL_TITLE } from './constants'
import { useJourneyNetwork } from './context'
import { JOURNEY, ONE_VERSION } from './copy'

/**
 * "Create a new pool (advanced)" at the foot of New position's pool step (spec F7 §2.6.5, decision #7: an advanced path,
 * labeled apart; the owner, 2026-10-02 night: no network choice anywhere, the pool step stays exactly today's). A closed
 * disclosure in the step's own advanced look; opening it and pressing the button turns the journey to the zap path's
 * pool finder on Robinhood Chain (./NewPositionV2.tsx `findOther`), where a pool Domino does not list is read through
 * the wallet and one with no price yet can be created. Nothing where the wrapper offers no finder (V2 off).
 *
 * Changed on purpose 2026-11-06 (the replica rule, O-15): the finder of the network of the token chosen in step 1
 * (`chainId`, from today's journey; Robinhood Chain before one is chosen), so a Base or Arbitrum One token opens that
 * network's finder, where a pool with no price yet is created as on Robinhood Chain; it opened Robinhood Chain's whatever
 * the token. Nothing where that network's finder is not offered.
 *
 * Default export: the lazily mounted part (components/create/Journey.tsx).
 */
export default function PoolAdvanced({ chainId = 4663 }: { chainId?: V2ChainId }) {
  const network = useJourneyNetwork()
  const open = network?.findOther(chainId) ?? null
  if (!open) return null
  return (
    <details className="dm-details dm-flow-advanced" data-pool-advanced="">
      <summary>
        <span>{NEW_POOL_TITLE}</span>
      </summary>
      <div className="grid gap-3">
        {/* Changed on purpose 2026-11-07 (review finding P5): no version to pick on Elysium, the one network with Uniswap v4
            alone (its profile names uniswap.v3 null: tests/elysium-switch.test.mjs; the finder itself asks chainHasDex).
            By id, so this lazy part loads no chain table of its own (a chunk more in every build). */}
        <p className="text-caption text-fg-muted">{ONE_VERSION === null || chainId !== ELYSIUM_V2_ID ? JOURNEY.pool.advancedLead : ONE_VERSION.advancedLead}</p>
        <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={open} data-network-find-other={chainId}>
          {JOURNEY.pool.findOther}
        </Button>
      </div>
    </details>
  )
}
