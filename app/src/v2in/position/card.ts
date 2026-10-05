/**
 * A read-v6 position (spec F7 rev2 §6.2, `state.status: live`) as the card V1's position page draws
 * (lib/walletCards.ts walletCard: the pair, the range's ends, in range or not, the principal and the fees as token
 * amounts), so the same components draw it (components/positions/PositionRange.tsx, PositionFigures.tsx). The pool's
 * identity is its own: v4's pool id (keccak256 of its PoolKey), v3's pool address (the factory's CREATE2 address, as a
 * 32-byte word). Token marks of a chain other than Robinhood's are plain discs (./marks.ts markOf). No USD: the card's
 * valuation stays "no qualified price source".
 *
 * Pure apart from viem's hashing.
 */
import { encodeAbiParameters, keccak256 } from 'viem'
import { v3PoolAddress } from '../../finance/v2/direct'
import { addressKey } from '../../lib/read/screens/identity'
import { walletCard, type LiveCard } from '../../lib/walletCards'
import type { WalletPosition } from '../../lib/walletPositions'
import { v2Chain } from '../../v2/chains'
import type { Address, Hex, PoolRef, V2ChainId } from '../../v2/types'
import type { LiveV6Position } from './model'
import { markOf } from './marks'
import { decimalsOf, type TokenBook } from './tokens'

const POOL_KEY = [{ type: 'tuple', components: [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] }] as const

/** The pool's own identity: v4's pool id, or v3's pool address. */
export function poolIdentity(chainId: V2ChainId, pool: PoolRef): { kind: 'v4'; id: Hex } | { kind: 'v3'; address: Address } {
  if (pool.dex === 4) return { kind: 'v4', id: keccak256(encodeAbiParameters(POOL_KEY, [{ currency0: pool.currency0, currency1: pool.currency1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks }])) }
  return { kind: 'v3', address: v3PoolAddress(v2Chain(chainId), pool.currency0, pool.currency1, pool.fee) }
}

/** The same identity as a 32-byte word (v3's address left-padded), the card's pool id. */
const poolWord = (chainId: V2ChainId, pool: PoolRef): Hex => {
  const identity = poolIdentity(chainId, pool)
  return identity.kind === 'v4' ? identity.id : (`0x${identity.address.slice(2).padStart(64, '0')}` as Hex)
}

/** The position as V1's page reads one (lib/walletPositions.ts WalletPosition), from read-v6's live state. */
export function walletPositionOf(position: LiveV6Position, book: TokenBook): WalletPosition {
  const token = (address: Address) => ({ address, symbol: book.get(address)?.symbol ?? null, decimals: decimalsOf(book, address) })
  return {
    tokenId: position.tokenId.toString(10),
    status: position.liquidity > 0n ? 'open' : 'closed',
    poolId: poolWord(position.chainId, position.pool),
    currencies: [token(position.pool.currency0), token(position.pool.currency1)],
    fee: position.pool.fee,
    tickSpacing: position.pool.tickSpacing,
    hooks: position.pool.hooks,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    liquidity: position.liquidity.toString(10),
    sqrtPriceX96: position.sqrtPriceX96.toString(10),
    tick: position.tick,
    unclaimedFees: position.feesOwed ? [position.feesOwed[0].toString(10), position.feesOwed[1].toString(10)] : null,
    principal: position.principal ? [position.principal[0].toString(10), position.principal[1].toString(10)] : null,
  }
}

/** The card V1's components draw, with this chain's marks and position manager. */
export function cardOf(position: LiveV6Position, book: TokenBook): LiveCard {
  const card = walletCard(walletPositionOf(position, book), position.owner)
  const [c0, c1] = [position.pool.currency0, position.pool.currency1]
  const mark = (address: Address) => markOf(position.chainId, { address, symbol: book.get(address)?.symbol ?? null, decimals: decimalsOf(book, address) })
  return { ...card, currencies: [mark(c0), mark(c1)], positionManager: addressKey(position.manager) }
}
