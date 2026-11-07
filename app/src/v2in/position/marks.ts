/**
 * A token as the page's token marks and labels take it (lib/read/types.ts TokenDisplay). Robinhood Chain's tokens as
 * the existing pages draw them (the curated artwork table, then the artwork client); a token of another chain uses
 * its own chain/address in that same client, never Robinhood's identity. Changed on purpose
 * 2026-10-03 (the owner, point 9: the dialogs redrawn with token pictures): native ETH (the zero address) is ETH on every
 * chain Domino V2 serves, so it takes ETH's own bundled picture there too; nothing is looked up for it. Changed on purpose
 * 2026-11-06 (Elysium readiness): only where the chain's native currency is Ether (v2/chains.ts nativeArtwork); HYPE and
 * WHYPE have no bundled picture, and take the mark any token without one takes.
 *
 * Pure: no React, no wallet.
 */
import { unreadToken } from '../../lib/read/project'
import type { TokenDisplay } from '../../lib/read/types'
import { nativeArtwork, v2Chain, wrappedArtwork } from '../../v2/chains'
import { ZERO_ADDRESS, type V2ChainId } from '../../v2/types'
import type { PositionToken } from './tokens'

export function markOf(chainId: V2ChainId, token: PositionToken): TokenDisplay {
  const base = unreadToken(token.address)
  const address = token.address.toLowerCase()
  const chain = v2Chain(chainId)
  const artwork = address === ZERO_ADDRESS ? nativeArtwork(chain) : address === chain.wrappedNative.address.toLowerCase() ? wrappedArtwork(chain) : chainId === 4663 ? base.artwork : null
  // The list and detail use the same chain/address identity and bounded resolver. Metadata missing on another
  // chain does not mean its contract is absent, and never permits Robinhood's curated artwork for that address.
  return { ...base, chainId, symbol: token.symbol, decimals: token.decimals, readStatus: token.decimals === null ? 'partial' : 'available', artwork }
}
