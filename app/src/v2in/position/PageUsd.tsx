import { useEffect, useMemo } from 'react'
import { useWalletIdentity } from '../../lib/walletIdentity'
import type { WalletPosition } from '../../lib/walletPositions'
import type { Address } from '../../v2/types'
import { usePortfolio } from '../automate/read6'
import { anyIn, useKeyed, useListsGate, useUsdAged } from '../lists/hooks'
import { portfolioSeenAt } from '../lists/positionSync'
import { OWN_PORTFOLIO } from '../lists/source'
import { pagePrices, pageReadingSeen, robinhoodPageUsd, type PageUsd } from './pageValuation'

/**
 * Added 2026-10-14 (the incident of 2026-10-13, package V1; decision D3): the dollars of Robinhood Chain's own position
 * page (screens/PositionDetail.tsx), from the one valuation its list row uses (./pageValuation.ts). It draws nothing: it
 * hands the page what its two money tiles show (`onUsd`), and null when it has nothing to say, for which the page keeps
 * its own rule (a pair with USDG at the pool's price). Opened lazily by the page, in a build with V2 only, in the chunk
 * of the page's automation (../automate/PositionAutomation.tsx re-exports it), as every V2 part of that page is.
 *
 * No request is added: the connected wallet's portfolio is the read this page's automation already keeps (the same
 * reader and key).
 *
 * Changed on purpose 2026-10-14 (package V1, review):
 *   - "nothing newer for two minutes" is counted from when this page took the answer and the reading
 *     (../lists/hooks.ts useUsdAged over ../lists/positionSync.ts), not from this part's mount: opened from a list that
 *     already dated its figures, the page showed the same figures with no time for two more minutes;
 *   - the position OWNER's portfolio answer is where the prices come from when the connected wallet's says nothing of
 *     the pair (./pageValuation.ts pagePrices): a visitor (no wallet, or one that holds neither token) saw the page's
 *     own USDG rule where the owner's row showed read-v6's qualified prices, and token amounts for ETH / token. No
 *     request is added by it either: this page's Activity already reads the owner's portfolio (../lists/
 *     PositionHistory.tsx: the same reader, the same key, under the same gate), and a keyed read is one read however
 *     many parts show it (../lists/read.ts).
 */
export interface PageUsdProps {
  tokenId: string
  position: WalletPosition
  block: number
  /** The NFT's owner, as the page read it. */
  owner: string
  /** The row of the wallet's list read a moment ago, shown for the instant before the page's own read answers. */
  brief: boolean
  /** A copy this browser kept, or the read gateway's row: not the page's own chain read. */
  saved: boolean
  onUsd: (usd: PageUsd | null) => void
}

export default function PageUsdBridge({ tokenId, position, block, owner, brief, saved, onUsd }: PageUsdProps) {
  const identity = useWalletIdentity()
  const connected = identity.kind === 'connected' ? (identity.address.toLowerCase() as Address) : null
  const read = usePortfolio(connected, null)
  const mine = read?.reply.kind === 'ok' ? read.reply.body : null
  // The owner's, exactly as the page's Activity reads it (../lists/PositionHistory.tsx): the lists' gate, the owner's key.
  const gate = useListsGate()
  const held = useKeyed(OWN_PORTFOLIO, anyIn(gate, 'live') ? owner.toLowerCase() : null)
  const answer = pagePrices(position, mine, held?.kind === 'ok' ? held.body : null)
  // Nothing newer for as long as a figure is current (decision D4): no newer prices, or no newer reading of the NFT.
  const [late, still] = useUsdAged([answer ? portfolioSeenAt(answer.servedAt) : null, pageReadingSeen({ tokenId, block, saved })])
  const usd = useMemo(() => {
    // The list's row, for an instant: the page's own rule draws it, as it always has, with no time flashing under it.
    if (brief) return null
    const worked = robinhoodPageUsd({ tokenId, position, block, saved }, answer, { late, still })
    // Without read-v6's word the figures are the page's own rule's, to the last digit: the page draws those itself, with
    // its own titles, exactly as before; this speaks then only when there is a time to say.
    if (!worked.quoted && worked.asOf === null && !worked.now?.asOf) return null
    return worked.principal === null && worked.fees === null && worked.why === null ? null : worked
  }, [tokenId, position, block, brief, saved, answer, late, still])
  useEffect(() => {
    onUsd(usd)
    return () => onUsd(null)
  }, [usd, onUsd])
  return null
}
