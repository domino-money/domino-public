/**
 * Fees earned and Your APR on a chain whose history is read-v6's (`position-fees`, docs/v2/V2_FEES.md, the owner's
 * 2026-11-04: every chain the same as Robinhood Chain): the view the shared card and tile draw, or null while this read
 * has nothing to say, and then the page keeps what it showed before the route existed. The route's capabilities decide:
 * while the read Worker does not name it, nothing is asked and nothing on the page changes. What the page draws from the
 * answer besides (2026-11-06) is ./storedFees.ts, pure.
 */
import { useMemo } from 'react'
import type { PositionFees } from 'api-contracts/read-v6/types'
import { positionFeesView } from '../../lib/fees/positionFees'
import type { FeeHistoryView } from '../../lib/fees/types'
import { useKeyed } from '../lists/hooks'
import { POSITION_FEES, positionFeesKey, routeOpensPositionFees } from '../lists/source'
import { chainHasDex } from '../../v2/chains'
import type { V2ChainId } from '../../v2/types'
import { feeTokenOf } from './storedFees'
import type { TokenBook } from './tokens'

export { burnedAt, compoundingKind, feeTokenOf, qualifiedUsdOf, storedAutomaticAdds, storedBasis, storedFeesEvents, storedHistoryWords, storedRecord, type CompoundingKind } from './storedFees'

const WAITING: FeeHistoryView = { phase: 'loading', state: null }

export type StoredRef = { chainId: V2ChainId; dex: 3 | 4; tokenId: string }

/**
 * The position's own entry in its `position-fees` answer, read while the page shows it: null where this chain or this
 * route has none. `waiting`: the route serves it and its first answer is on the way.
 */
export function useStoredPosition(ref: StoredRef | null): { position: PositionFees | null; waiting: boolean } {
  // Robinhood Chain's history is the site's own ledger (lib/fees/store.ts); read-v6 has no follower there. A position of a
  // version its chain lacks (v3 on a chain with v4 alone) is never asked about: the page shows what it shows without
  // the route (added 2026-11-06, Elysium readiness).
  const key = ref === null || ref.chainId === 4663 || !chainHasDex(ref.chainId, ref.dex) ? null : positionFeesKey(ref.chainId, [ref])
  const reply = useKeyed(POSITION_FEES, key)
  return useMemo(() => {
    if (key === null || ref === null) return { position: null, waiting: false }
    if (reply === null) return { position: null, waiting: routeOpensPositionFees() }
    if (reply.kind !== 'ok') return { position: null, waiting: false }
    return { position: reply.body.positions.find((one) => one.dex === ref.dex && one.tokenId === ref.tokenId) ?? null, waiting: false }
  }, [key, reply, ref])
}

/** The position's fees view, read while the page shows it; null where this chain or this route has none. */
export function usePositionFees(ref: StoredRef, book: TokenBook): FeeHistoryView | null {
  const stored = useStoredPosition(ref)
  return useMemo(() => {
    if (stored.position === null) return stored.waiting ? WAITING : null
    const view = positionFeesView(stored.position, feeTokenOf(book))
    return view.phase === 'unavailable' ? null : view
  }, [stored, book])
}
