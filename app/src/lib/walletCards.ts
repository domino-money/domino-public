/**
 * The positions screens' cards from chain data (2026-09-24): a WalletPosition
 * of the wallet's own list (POST /api/owned/v2/positions), or one position's
 * /api/fees/v1/state answer (its page), as the card the rows and the page
 * draw, and as the PositionState the USD figures are valued at. Both come from
 * one chain read at one block, so a card's amounts and its price always agree.
 *
 * Pure: no read, no storage. BigInt lives here, never in a component.
 */
import { principalAt } from '../components/positions/visual/value'
import { POSITION_MANAGER } from './fees/constants'
import type { PositionState, StatePositionOk } from './fees/types'
import { unreadToken } from './read/project'
import { feeFromPips } from './read/screens/fee'
import { addressKey, poolIdKey } from './read/screens/identity'
import { amountView, rangeEnd, type ChainPositionCard } from './read/screens/positions'
import type { TokenDisplay } from './read/types'
import type { WalletPosition, WalletToken } from './walletPositions'

export type LiveCard = Extract<ChainPositionCard, { kind: 'live' }>

/** A currency as the positions components and the owner's actions name it. */
export interface CurrencyView {
  address: string
  symbol: string | null
  decimals: number | null
}

/** A token read from chain as the screens' token: its artwork from the curated table, its symbol as read (untrusted text). */
export function chainToken(token: WalletToken): TokenDisplay {
  return { ...unreadToken(token.address), symbol: token.symbol, decimals: token.decimals, readStatus: token.decimals === null ? 'partial' : 'available' }
}

/** A position of the wallet's list (or of a position's page) as the card the screens draw, `owner` its NFT's owner at the read's block. */
export function walletCard(position: WalletPosition, owner: string): LiveCard {
  const base = chainToken(position.currencies[0])
  const quote = chainToken(position.currencies[1])
  const spacing = position.tickSpacing
  // Each end on its own: a full-range end is 0 or ∞ whatever the decimals, and an unwritable price is not blamed on them.
  const ends = { lower: rangeEnd(position.tickLower, 'lower', spacing, base.decimals, quote.decimals), upper: rangeEnd(position.tickUpper, 'upper', spacing, base.decimals, quote.decimals) }
  const prices = ends.lower.kind !== 'tick' && ends.upper.kind !== 'tick' ? { lower: ends.lower.text, upper: ends.upper.text } : null
  const principal = position.principal
  const fees = position.unclaimedFees
  return {
    origin: 'chain',
    kind: 'live',
    key: `4663:nft:${position.tokenId}`,
    tokenId: position.tokenId,
    poolId: poolIdKey(position.poolId),
    positionManager: addressKey(POSITION_MANAGER),
    currencies: [base, quote],
    fee: feeFromPips(position.fee),
    feePips: position.fee,
    tickSpacing: spacing,
    hooks: addressKey(position.hooks),
    range: { tickLower: position.tickLower, tickUpper: position.tickUpper, fullRange: ends.lower.kind === 'limit' && ends.upper.kind === 'limit', ends, prices },
    inRange: position.tick !== null && position.tick >= position.tickLower && position.tick < position.tickUpper,
    hasLiquidity: position.status === 'open',
    liquidityRaw: position.liquidity,
    principal: [amountView(principal ? principal[0] : null, base), amountView(principal ? principal[1] : null, quote)],
    unsettledFees: [amountView(fees ? fees[0] : null, base), amountView(fees ? fees[1] : null, quote)],
    owner: { address: addressKey(owner), basis: 'ownerOf_at_pinned_block' },
    valuation: { state: 'unavailable', reason: 'no_qualified_price_source' },
  }
}

/**
 * The PositionState a position's USD is valued at (components/positions/visual/value.ts): the pool's price of the
 * same read, at `block`. Null when the read gave no price: no USD is shown rather than one from another moment.
 */
export function walletState(position: WalletPosition, block: number, owner: string): PositionState | null {
  if (position.sqrtPriceX96 === null || position.tick === null) return null
  const fees = position.unclaimedFees
  return {
    block,
    timestamp: 0,
    unclaimed: fees ? [BigInt(fees[0]), BigInt(fees[1])] : [0n, 0n],
    sqrtPriceX96: BigInt(position.sqrtPriceX96),
    tick: position.tick,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    liquidity: BigInt(position.liquidity),
    poolId: position.poolId,
    owner: owner.toLowerCase(),
    currencies: [{ ...position.currencies[0] }, { ...position.currencies[1] }],
  }
}

/**
 * One position NFT's /api/fees/v1/state answer as a WalletPosition: the same
 * fields the wallet's list carries, its principal computed at the answer's own
 * pool price with v4's rounding (visual/value.ts principalAt).
 */
export function positionOfState(state: StatePositionOk): WalletPosition {
  const liquidity = BigInt(state.liquidity)
  const sqrt = BigInt(state.sqrtPriceX96)
  const principal = sqrt > 0n ? principalAt(liquidity, sqrt, state.tick, state.tickLower, state.tickUpper) : null
  const token = (currency: StatePositionOk['currencies'][number]): WalletToken => ({ address: currency.address, symbol: currency.symbol, decimals: currency.decimals })
  return {
    tokenId: state.tokenId,
    status: liquidity > 0n ? 'open' : 'closed',
    poolId: state.poolId,
    currencies: [token(state.currencies[0]), token(state.currencies[1])],
    fee: state.poolKey.fee,
    tickSpacing: state.poolKey.tickSpacing,
    hooks: state.poolKey.hooks,
    tickLower: state.tickLower,
    tickUpper: state.tickUpper,
    liquidity: state.liquidity,
    sqrtPriceX96: sqrt > 0n ? state.sqrtPriceX96 : null,
    tick: sqrt > 0n ? state.tick : null,
    unclaimedFees: [state.unclaimed0, state.unclaimed1],
    principal: principal ? [principal[0].toString(), principal[1].toString()] : null,
  }
}
