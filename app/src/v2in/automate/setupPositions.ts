import type { PortfolioResponse, Position } from 'api-contracts/read-v6/types'
import type { WalletPosition } from '../../lib/walletPositions'
import { v2Chain } from '../../v2/chains'
import { ZERO_ADDRESS } from '../../v2/types'
import { walletPositionOf } from '../position/card'
import { findPosition, isLive, tokensOf } from '../position/model'
import { tokenBook } from '../position/tokens'

export type SetupEligibility = 'eligible' | 'unavailable' | 'unsupported' | 'not-owned' | 'closed' | 'automated' | 'subscribed'

/** A validated read-v6 NFT, never its numeric id alone, admits an automation offer. The money client rechecks on chain. */
export function setupEligibility(body: PortfolioResponse, owner: string, item: Position): SetupEligibility {
  if (body.wallet.toLowerCase() !== owner.toLowerCase()) return 'unavailable'
  const chain = v2Chain(item.chainId)
  const manager = item.dex === 4 ? chain.uniswap.v4.positionManager : chain.uniswap.v3.positionManager
  if (item.positionManager.toLowerCase() !== manager || BigInt(item.tokenId) <= 0n || BigInt(item.tokenId) >= 1n << 96n) return 'unsupported'
  const state = item.state
  if (body.chains.find((one) => one.chainId === item.chainId)?.status !== 'current' || state.status !== 'live' || state.freshness.status !== 'fresh') return 'unavailable'
  if (state.pool.dex !== item.dex || state.pool.hooks.toLowerCase() !== ZERO_ADDRESS) return 'unsupported'
  if (state.owner.toLowerCase() !== owner.toLowerCase()) return 'not-owned'
  if (BigInt(state.liquidity) === 0n) return 'closed'
  if (item.vault !== null) return 'automated'
  // read-v6 maps the on-chain zero subscriber to null. A live reply read both custody fields successfully.
  if (state.custody.subscriber !== null && state.custody.subscriber.toLowerCase() !== ZERO_ADDRESS) return 'subscribed'
  return 'eligible'
}

/** Sequence currently creates Robinhood v4 vaults. Other chains/managers never collapse into that NFT-id namespace. */
export function setupPositions(body: PortfolioResponse, owner: string): { positions: readonly WalletPosition[]; incomplete: boolean } {
  const positions: WalletPosition[] = []
  let incomplete = body.wallet.toLowerCase() !== owner.toLowerCase()
    || body.chains.find((one) => one.chainId === 4663)?.status !== 'current' || body.truncated.positions
  const book = tokenBook(4663, tokensOf(body, 4663))
  for (const item of body.positions) {
    if (item.chainId !== 4663 || item.dex !== 4) continue
    const eligibility = setupEligibility(body, owner, item)
    if (eligibility === 'unavailable') incomplete = true
    if (eligibility !== 'eligible') continue
    const position = findPosition({ positions: [item] }, 4663, 4, BigInt(item.tokenId))
    if (position && isLive(position)) positions.push(walletPositionOf(position, book))
  }
  return { positions, incomplete }
}

/** Only a successful read with a pending requested NFT is polled. Transport failures keep their own retry policy. */
export function setupRetryDelay(body: PortfolioResponse, owner: string, tokenId: string | null, attempt: number): number | null {
  if (tokenId === null || attempt >= 3) return null
  const item = body.positions.find((one) => one.chainId === 4663 && one.dex === 4 && one.tokenId === tokenId)
  return !item || setupEligibility(body, owner, item) === 'unavailable' ? 1500 * 2 ** attempt : null
}
