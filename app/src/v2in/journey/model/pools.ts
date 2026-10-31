import { v2Chain } from '../../../v2/chains'
import { feeTierText } from '../../../v2/plan/present'
import { ZERO_ADDRESS, type Address, type Dex, type Hex, type PoolRef, type V2ChainId } from '../../../v2/types'
import { JOURNEY_HOOKED_POOLS_SHOWN, V4_NEW_POOL_TIERS } from '../constants'
import type { JourneyToken } from '../tokens'

/**
 * A pool New position can open a position in through Domino's new contracts (spec F7 rev2 §1.4, §2.6.1, §2.6.5), on
 * one network: its PoolRef, as read at one block (through the wallet's own provider on that network, or from V1's list
 * on Robinhood Chain), with its tokens' own metadata. Every V2 object carries its chain (§1.3): a pool is chain +
 * PoolRef. Pure: no viem, no wallet.
 */
export interface JourneyPool {
  chainId: V2ChainId
  pool: PoolRef
  /** The v3 pool's address, or the v4 pool id. */
  id: Hex
  /** v3's factory answer; a v4 pool "exists" once it has a price. */
  exists: boolean
  initialized: boolean
  sqrtPriceX96: bigint
  tick: number
  tokens: readonly [JourneyToken, JourneyToken]
  block: bigint
  /** When it was read, on the page's clock (ms); null when V1's list did not say. */
  readAt: number | null
  /** Where it came from: read through the wallet, or V1's list (Robinhood Chain). */
  source: 'wallet' | 'list'
}

const lower = (value: string): Address => value.toLowerCase() as Address

/**
 * The pool's currencies for two tokens: sorted by address, native ETH (address(0)) always first, as the PoolKey sorts
 * them (rev2 §2.6.5). v3 holds no native ETH (its pools use WETH): null. Null for the same token twice.
 */
export function poolOf(dex: Dex, a: Address, b: Address, fee: number, tickSpacing: number): PoolRef | null {
  const x = lower(a)
  const y = lower(b)
  if (x === y) return null
  if (dex === 3 && (x === ZERO_ADDRESS || y === ZERO_ADDRESS)) return null
  const [currency0, currency1] = BigInt(x) < BigInt(y) ? [x, y] : [y, x]
  return { dex, currency0, currency1, fee, tickSpacing, hooks: ZERO_ADDRESS }
}

/**
 * The fee tiers a DEX offers on a network (§1.4, §2.6.5): v3 the profile's table, Base's extra 0.02%, 0.03% and 0.04%
 * included (fee 200/300/400 → tick spacing 4/6/8; src/v2/chains.ts BASE_EXTRA_V3_TIERS; the factory's
 * feeAmountTickSpacing confirms a tier when the pool is read); v4 the four v3 pairs (decision #26). Lowest fee first.
 */
export function tiersOf(chainId: V2ChainId, dex: Dex): { fee: number; tickSpacing: number }[] {
  if (dex === 4) return [...V4_NEW_POOL_TIERS]
  const table = v2Chain(chainId).uniswap.v3.tickSpacingByFee
  return Object.entries(table).map(([fee, tickSpacing]) => ({ fee: Number(fee), tickSpacing })).sort((x, y) => x.fee - y.fee)
}

/** Whether a pool may be offered at all: no hook (decision #6, v4 pools with a hook stay refused for positions). */
export const offeredPool = (pool: Pick<PoolRef, 'hooks'>): boolean => JOURNEY_HOOKED_POOLS_SHOWN || lower(pool.hooks) === ZERO_ADDRESS

/** The same pool, field by field (addresses in any case). */
export function samePool(a: PoolRef, b: PoolRef): boolean {
  return a.dex === b.dex && lower(a.currency0) === lower(b.currency0) && lower(a.currency1) === lower(b.currency1) && a.fee === b.fee && a.tickSpacing === b.tickSpacing && lower(a.hooks) === lower(b.hooks)
}

/** A key for a pool on a network: chain, DEX, currencies, fee, spacing. */
export const poolKey = (chainId: V2ChainId, pool: PoolRef): string => `${chainId}:${pool.dex}:${lower(pool.currency0)}:${lower(pool.currency1)}:${pool.fee}:${pool.tickSpacing}`

/** "Uniswap v3" / "Uniswap v4": for a `title`, a data attribute, and the pool finder's own control alone (never a word on screen otherwise). */
export const dexName = (dex: Dex): string => `Uniswap v${dex}`

/**
 * A pool's fee in pips as a percent: 3000 → "0.30%", 200 → "0.02%". Changed on purpose 2026-10-30 (QA round 2, N2): the
 * one fee format of every screen (v2/plan/present.ts feeTierText); it was "0.3%" and "1%" here alone.
 */
export const feePercent = (pips: number): string => feeTierText(pips)

/**
 * A pool of V1's list on Robinhood Chain (lib/read/screens/poolsList.ts PoolOption: Uniswap v4, read through rugged97's
 * read service), as the zap path takes it. Structural, so this module imports nothing of V1's read layer: the option's
 * currencies (lowercase, native ETH as address(0)), fee in pips, spacing, hooks, its price and tick as read, the block.
 * Null for one the zap path never takes (a hook, a dynamic fee, a price that is not an integer).
 * Changed on purpose 2026-10-05 (New position on Base and Arbitrum One, ../otherChains.ts): a pool today's journey read on
 * another network through the wallet carries its network on its currencies and its version (`dex`; a v3 pool's key is its
 * address as a 32-byte word). Without them, Robinhood Chain and v4, as before.
 */
export function poolFromList(option: {
  key: string
  dex?: Dex
  currencies: readonly [{ address: string; symbol: string | null; decimals: number | null; chainId?: number }, { address: string; symbol: string | null; decimals: number | null; chainId?: number }]
  feePips: number
  tickSpacing: number
  hooks: string
  tick: number
  sqrtPriceX96: string
  block: number
  readAt: number | null
}): JourneyPool | null {
  if (lower(option.hooks) !== ZERO_ADDRESS) return null
  if (!Number.isSafeInteger(option.feePips) || option.feePips < 0 || option.feePips > 1_000_000) return null
  let sqrt: bigint
  try {
    sqrt = BigInt(option.sqrtPriceX96)
  } catch {
    return null
  }
  const [a, b] = option.currencies
  const dex: Dex = option.dex ?? 4
  const chainId = (a.chainId ?? 4663) as V2ChainId
  if (![4663, 8453, 42161].includes(chainId) || (b.chainId ?? 4663) !== chainId) return null
  const pool = poolOf(dex, a.address as Address, b.address as Address, option.feePips, option.tickSpacing)
  if (!pool || pool.currency0 !== lower(a.address)) return null
  if (!/^0x[0-9a-fA-F]{64}$/.test(option.key)) return null
  // A v3 pool's id is its address, the key's last 20 bytes (its first 12 are zero).
  if (dex === 3 && !/^0x0{24}[0-9a-fA-F]{40}$/.test(option.key)) return null
  return {
    chainId,
    pool,
    id: (dex === 3 ? `0x${option.key.slice(26).toLowerCase()}` : lower(option.key)) as Hex,
    exists: sqrt !== 0n,
    initialized: sqrt !== 0n,
    sqrtPriceX96: sqrt,
    tick: option.tick,
    tokens: [
      { address: lower(a.address), symbol: a.symbol, decimals: a.decimals },
      { address: lower(b.address), symbol: b.symbol, decimals: b.decimals },
    ],
    block: BigInt(option.block),
    readAt: option.readAt,
    source: 'list',
  }
}
