import { TokenMark } from '../TokenIcon'
import { ELYSIUM_LIVE, ELYSIUM_V2_ID } from '../../lib/elysiumIdentity'
import { unreadToken } from '../../lib/read/project'
import type { TokenChainId } from '../../lib/read/types'

/**
 * Automation uses the same bounded artwork lookup as the rest of the app.
 * Legacy pickers are Robinhood-only; a multichain picker passes its network.
 * Robinhood's address catalogue never supplies another network's artwork.
 */
export function AddressMark({ address, chainId = 4663, size = 24 }: { address: string; chainId?: TokenChainId; size?: number }) {
  const token = unreadToken(address)
  // Changed on purpose 2026-11-07 (review finding P2): the zero address is Ether only on an Ether network; on Elysium, where
  // the build serves it, it is HYPE, which takes the plain mark as everywhere else there (src/v2/chains.ts nativeArtwork).
  const native = /^0x0{40}$/i.test(address) && !(ELYSIUM_LIVE && chainId === ELYSIUM_V2_ID)
  return <TokenMark token={{ ...token, chainId, artwork: chainId === 4663 || native ? token.artwork : null }} size={size} />
}
