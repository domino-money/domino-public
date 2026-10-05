/**
 * A token as the page's token marks and labels take it (lib/read/types.ts TokenDisplay). Robinhood Chain's tokens as
 * V1's pages draw them (the curated artwork table, then the artwork client); a token of another chain as a plain disc
 * with its own symbol, never looked up as if it were Robinhood's: an address alone names no chain. Changed on purpose
 * 2026-10-03 (the owner, point 9: the dialogs redrawn with token pictures): native ETH (the zero address) is ETH on every
 * chain Domino V2 serves, so it takes ETH's own bundled picture there too; nothing is looked up for it.
 *
 * Pure: no React, no wallet.
 */
import { unreadToken } from '../../lib/read/project'
import type { TokenDisplay } from '../../lib/read/types'
import { ZERO_ADDRESS, type V2ChainId } from '../../v2/types'
import type { PositionToken } from './tokens'

export function markOf(chainId: V2ChainId, token: PositionToken): TokenDisplay {
  const base = unreadToken(token.address)
  if (chainId === 4663) return { ...base, symbol: token.symbol, decimals: token.decimals, readStatus: token.decimals === null ? 'partial' : 'available' }
  return { ...base, symbol: token.symbol, decimals: token.decimals, readStatus: 'no_contract', artwork: token.address.toLowerCase() === ZERO_ADDRESS ? 'ETH' : null }
}
