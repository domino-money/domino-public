import { TokenMark } from '../TokenIcon'
import { unreadToken } from '../../lib/read/project'
import type { TokenChainId } from '../../lib/read/types'

/**
 * Automation uses the same bounded artwork lookup as the rest of the app.
 * Legacy pickers are Robinhood-only; a multichain picker passes its network.
 * Robinhood's address catalogue never supplies another network's artwork.
 */
export function AddressMark({ address, chainId = 4663, size = 24 }: { address: string; chainId?: TokenChainId; size?: number }) {
  const token = unreadToken(address)
  const native = /^0x0{40}$/i.test(address)
  return <TokenMark token={{ ...token, chainId, artwork: chainId === 4663 || native ? token.artwork : null }} size={size} />
}
