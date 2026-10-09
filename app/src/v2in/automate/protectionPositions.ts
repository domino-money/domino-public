import type { PortfolioResponse } from 'api-contracts/read-v6/types'
import type { WalletPosition } from '../../lib/walletPositions'
import { v2Chain } from '../../v2/chains'
import type { PoolRef } from '../../v2/types'
import { exitOnPosition } from '../autoexit/card'
import { fullRange } from '../autoexit/form'
import { positionExitPrice } from '../autoexit/priceContext'
import { walletPositionOf } from '../position/card'
import { findPosition, isLive, tokensOf } from '../position/model'
import { tokenBook } from '../position/tokens'
import { parseV2PositionParam, type V2PositionRef } from '../route'
import { tokenMetaOf, vaultsOfPosition } from './portfolio'
import { setupEligibility } from './setupPositions'
import { poolTokens, type TokenView } from './tokens'

export interface ProtectionPosition {
  key: string
  position: WalletPosition
  target: V2PositionRef & {
    pool: PoolRef
    tokens: readonly [TokenView, TokenView]
    range: { tickLower: number; tickUpper: number }
    price: ReturnType<typeof positionExitPrice>
    vault: null
  }
}

export const protectionKey = (ref: V2PositionRef): string => `${ref.chainId}:${ref.dex}:${ref.tokenId}`

/** Old numeric links mean Robinhood v4 only; explicit links never collapse two NFT namespaces. */
export function protectionSelection(route: string): string | null {
  const param = route.replace(/^#/, '').split('/')[3]?.split(/[?#]/)[0]
  const ref = parseV2PositionParam(param)
  if (ref) return protectionKey(ref)
  return param && /^[1-9]\d{0,28}$/.test(param) && BigInt(param) < 1n << 96n ? `4663:4:${param}` : null
}

/** A fresh, owned, plain NFT only. Existing setups are managed in the position, never duplicated here. */
export function protectionPositions(body: PortfolioResponse, owner: string): { positions: readonly ProtectionPosition[]; incomplete: boolean } {
  const positions: ProtectionPosition[] = []
  let incomplete = body.wallet.toLowerCase() !== owner.toLowerCase() || body.truncated.positions
    || body.chains.some((chain) => chain.status !== 'current')
  if (body.truncated.vaults || body.truncated.mandates) return { positions, incomplete: true }
  const seen = new Set<string>()
  for (const item of body.positions) {
    const eligibility = setupEligibility(body, owner, item)
    if (eligibility === 'unavailable') incomplete = true
    if (eligibility !== 'eligible') continue
    const ref = { chainId: item.chainId, dex: item.dex, tokenId: BigInt(item.tokenId) }
    const key = protectionKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    // Vault history can precede its position's custody update. No new setup on an existing root or active successor.
    if (vaultsOfPosition(body, item.chainId, item.tokenId, item.dex).length || exitOnPosition(body, item.chainId, item.tokenId, item.dex)) continue
    const view = findPosition({ positions: [item] }, item.chainId, item.dex, ref.tokenId)
    if (!view || !isLive(view) || fullRange(view, view.pool.tickSpacing)) continue
    const position = walletPositionOf(view, tokenBook(item.chainId, tokensOf(body, item.chainId)))
    positions.push({ key, position, target: {
      ...ref, pool: view.pool, tokens: poolTokens(v2Chain(item.chainId), view.pool, tokenMetaOf(body.tokens, item.chainId)),
      range: { tickLower: view.tickLower, tickUpper: view.tickUpper },
      price: positionExitPrice(position, { block: view.snapshotBlock, saved: false }), vault: null,
    } })
  }
  return { positions, incomplete }
}
