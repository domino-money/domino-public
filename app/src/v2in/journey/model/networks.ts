import { PROTOCOL_FEE_UNDESCRIBED, type NetworkPoolFacts, type NetworkToken, type OtherChainId } from '../../../lib/create/otherChains'
import { fixedFeePercent } from '../../../lib/read/screens/fee'
import type { AttributedFigure } from '../../../lib/read/screens/figures'
import { NATIVE_CURRENCY, poolIdKey, type PoolIdKey } from '../../../lib/read/screens/identity'
import type { PoolOption } from '../../../lib/read/screens/poolsList'
import type { TokenDisplay } from '../../../lib/read/types'
import type { PoolOnChain } from '../../../finance/v2/zap'
import { v2Chain } from '../../../v2/chains'
import { ZERO_ADDRESS, type Address, type Dex, type PoolRef } from '../../../v2/types'
import type { JourneyGates } from '../source'
import { profileTokens, type JourneyToken } from '../tokens'
import { offeredPool, poolOf, tiersOf } from './pools'

/**
 * Base and Arbitrum One in today's journey (2026-10-05, ../otherChains.ts): what is pure of it. Which networks are offered,
 * the hits a search text names, the pools to read for a token, and how a pool read through the wallet becomes one of
 * today's pool rows (lib/read/screens/poolsList.ts PoolOption) and back. No wallet, no React.
 */

/** A row's TVL and 24h volume until DEX Screener's are put on as the rows are drawn (lib/create/otherChains.ts networkRows). */
const UNREPORTED: AttributedFigure = { state: 'unavailable', provider: 'dexscreener', reason: 'no_provider_figures' }

/** The networks offered: Base and Arbitrum One, each only while its S1 gate is live. */
export function offeredNetworks(gates: JourneyGates | null): OtherChainId[] {
  if (!gates) return []
  return ([8453, 42161] as const).filter((chainId) => gates[chainId]?.mode === 'live')
}

/**
 * The S1 gates read again, merged into the ones the page holds (pure; 2026-10-06, the owner's point 3: one failed read
 * of the plan route's word used to leave Base and Arbitrum One out for the whole visit): a network once live stays live,
 * and a network whose gate says the same keeps the very gate it had, so nothing downstream starts over. The held gates
 * themselves come back when nothing changed.
 */
export function mergeGates(held: JourneyGates | null, next: JourneyGates): JourneyGates {
  if (!held) return next
  let changed = false
  const out = { ...held }
  for (const chainId of [4663, 8453, 42161] as const) {
    if (held[chainId].mode === 'live' || held[chainId].mode === next[chainId].mode) continue
    out[chainId] = next[chainId]
    changed = true
  }
  return changed ? Object.freeze(out) : held
}

/** A token of another network as a screen shows it: the profile's artwork for ETH and the network's WETH, else a disc. */
export function displayOf(chainId: OtherChainId, token: JourneyToken): TokenDisplay {
  const address = token.address.toLowerCase()
  const weth = v2Chain(chainId).wrappedNative.address
  return {
    origin: 'read',
    chainId,
    address,
    symbol: token.symbol,
    decimals: token.decimals,
    readStatus: token.decimals === null ? 'partial' : 'available',
    artwork: address === ZERO_ADDRESS ? 'ETH' : address === weth ? 'WETH' : null,
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** How well a symbol matches the text typed: 0 exact, 1 a prefix, 2 inside it; null not at all. */
function matchOf(symbol: string | null, needle: string): number | null {
  if (symbol === null) return null
  const label = symbol.toLowerCase()
  if (label === needle) return 0
  if (label.startsWith(needle)) return 1
  return label.includes(needle) ? 2 : null
}

/**
 * The other networks' hits for the text typed (pure): two characters at least, as today's search. A name matches the
 * profile tokens' symbols, the closest first, Base before Arbitrum One for the same match; an address is that token on
 * each network (a profile token as it is named there, any other to read once chosen). Changed on purpose 2026-10-06 (the
 * review of the next update): a profile token's row says it is the network's own currency (`own`), so it never rivals
 * Robinhood Chain's own ETH or WETH for Enter (lib/create/otherChains.ts preselectOf).
 */
export function networkTokens(query: string, chains: readonly OtherChainId[]): NetworkToken[] {
  const text = query.trim()
  if (text.length < 2) return []
  if (/^0x/i.test(text)) {
    if (!ADDRESS.test(text)) return []
    const address = text.toLowerCase() as Address
    return chains.map((chainId): NetworkToken => {
      const known = profileTokens(chainId).find((token) => token.address === address)
      const network = v2Chain(chainId).name
      if (known) return { chainId, network, token: displayOf(chainId, known), unread: false, own: true }
      return { chainId, network, token: { origin: 'read', chainId, address, symbol: null, decimals: null, readStatus: 'partial', artwork: null }, unread: true }
    })
  }
  const needle = text.toLowerCase()
  const hits: { row: NetworkToken; rank: number; order: number }[] = []
  chains.forEach((chainId, order) => {
    for (const token of profileTokens(chainId)) {
      const rank = matchOf(token.symbol, needle)
      if (rank !== null) hits.push({ row: { chainId, network: v2Chain(chainId).name, token: displayOf(chainId, token), unread: false, own: true }, rank, order })
    }
  })
  return hits.sort((a, b) => a.rank - b.rank || a.order - b.order).map((hit) => hit.row)
}

/**
 * The pools to read for a token (pure): the token with each profile token, every tier of v4 and v3, hookless, each pool
 * once. Native ETH is v4's alone, so a chosen ETH asks no v3 pool; a partner ETH is WETH in v3. ETH never pairs with WETH.
 */
export function poolsToRead(chainId: OtherChainId, token: Address): PoolRef[] {
  const self = token.toLowerCase() as Address
  const weth = v2Chain(chainId).wrappedNative.address
  const ether = (address: Address) => address === ZERO_ADDRESS || address === weth
  const refs: PoolRef[] = []
  const seen = new Set<string>()
  for (const dex of [4, 3] as const satisfies readonly Dex[]) {
    if (dex === 3 && self === ZERO_ADDRESS) continue
    for (const partner of profileTokens(chainId)) {
      const other = dex === 3 && partner.address === ZERO_ADDRESS ? weth : partner.address
      if (other === self || (ether(other) && ether(self))) continue
      for (const tier of tiersOf(chainId, dex)) {
        const pool = poolOf(dex, self, other, tier.fee, tier.tickSpacing)
        if (!pool || !offeredPool(pool)) continue
        const key = `${pool.dex}:${pool.currency0}:${pool.currency1}:${pool.fee}:${pool.tickSpacing}`
        if (seen.has(key)) continue
        seen.add(key)
        refs.push(pool)
      }
    }
  }
  return refs
}

/** A pool's key on screen: the v4 pool id, or a v3 pool's address as a 32-byte word (lib/read/screens/poolsList.ts `dex`). */
export const optionKey = (found: Pick<PoolOnChain, 'pool' | 'id'>) => poolIdKey(found.pool.dex === 4 ? found.id : `0x${'0'.repeat(24)}${found.id.slice(2)}`)

/**
 * A pool read through the wallet, as today's pool rows and steps take one (pure). Its protocol fee is not read that way,
 * so no APR estimate is worked out for it (2026-10-06: PROTOCOL_FEE_UNDESCRIBED), whatever figures it is drawn with.
 */
export function optionOf(found: PoolOnChain, currencies: readonly [TokenDisplay, TokenDisplay], readAt: number): PoolOption {
  return poolRow({ pool: found.pool, key: optionKey(found), tick: found.tick, sqrtPriceX96: found.sqrtPriceX96.toString(), block: Number(found.block), protocolFeeRaw: PROTOCOL_FEE_UNDESCRIBED }, currencies, readAt)
}

/** What a wallet read says of each listed pool beyond its row, by row key (2026-10-06): its active liquidity, no depth. */
export function factsOfFound(found: readonly Pick<PoolOnChain, 'pool' | 'id' | 'liquidity'>[]): Record<string, NetworkPoolFacts> {
  return Object.fromEntries(found.map((entry) => [optionKey(entry), { depthUsd: null, liquidity: entry.liquidity.toString() }]))
}

/**
 * A pool as today's pool rows and steps take one (pure), from whatever read it: the wallet (`optionOf`) or Domino's service
 * (./chainReads.ts, 2026-10-06). `key`: the v4 pool id, or a v3 pool's address as a 32-byte word. `protocolFeeRaw`
 * (2026-10-06): the pool's protocol fee as the APR estimate takes it (lib/create/otherChains.ts PROTOCOL_FEE_UNDESCRIBED
 * where it cannot).
 */
export function poolRow(read: { pool: PoolRef; key: PoolIdKey; tick: number; sqrtPriceX96: string; block: number; usdPrices?: readonly [string | null, string | null]; protocolFeeRaw?: number; v3FeeProtocol?: number }, currencies: readonly [TokenDisplay, TokenDisplay], readAt: number): PoolOption {
  return {
    ...(read.usdPrices ? { usdPrices: read.usdPrices } : {}),
    ...(read.protocolFeeRaw !== undefined ? { protocolFeeRaw: read.protocolFeeRaw } : {}),
    ...(read.v3FeeProtocol !== undefined ? { v3FeeProtocol: read.v3FeeProtocol } : {}),
    key: read.key,
    kind: 'discovery',
    currencies: [currencies[0], currencies[1]],
    fee: fixedFeePercent(read.pool.fee),
    feePips: read.pool.fee,
    tickSpacing: read.pool.tickSpacing,
    tick: read.tick,
    sqrtPriceX96: read.sqrtPriceX96,
    readAt,
    hooks: NATIVE_CURRENCY,
    integration: 'hookless_fixed_fee',
    dex: read.pool.dex,
    block: read.block,
    catalogue: null,
    requestedById: false,
    liquidity: UNREPORTED,
    volume: UNREPORTED,
    providerNote: null,
    aprReason: 'missing_reported_tvl',
    tokenMetadata: 'available',
    providerConflict: false,
  }
}

/**
 * The pools a position can open in now, in the order to show (pure): hookless, a fee tier the factory confirms, a price
 * and liquidity in range. Grouped by what the token is paired with, ETH and WETH as one (the same 18 decimals, so their
 * liquidity compares), the profile's order (ether, then the dollar); the most liquidity in range first within a group.
 */
export function listedPools(chainId: OtherChainId, token: TokenDisplay, found: readonly (PoolOnChain & { spacingOk: boolean })[], readAt: number): PoolOption[] {
  const self = token.address.toLowerCase()
  const weth = v2Chain(chainId).wrappedNative.address
  const profile = profileTokens(chainId)
  const partnerOf = (pool: PoolRef) => (pool.currency0 === self ? pool.currency1 : pool.currency0)
  const group = (pool: PoolRef) => {
    const partner = partnerOf(pool)
    const index = profile.findIndex((entry) => entry.address === (partner === weth ? ZERO_ADDRESS : partner))
    return index < 0 ? profile.length : index
  }
  const displayAt = (address: Address): TokenDisplay | null => {
    if (address === self) return token
    const known = profile.find((entry) => entry.address === address)
    return known ? displayOf(chainId, known) : null
  }
  return found
    .filter((entry) => entry.exists && entry.initialized && entry.liquidity > 0n && entry.spacingOk && offeredPool(entry.pool))
    .sort((a, b) => group(a.pool) - group(b.pool) || (a.liquidity === b.liquidity ? 0 : a.liquidity > b.liquidity ? -1 : 1))
    .flatMap((entry) => {
      const first = displayAt(entry.pool.currency0)
      const second = displayAt(entry.pool.currency1)
      return first && second ? [optionOf(entry, [first, second], readAt)] : []
    })
}

/** The PoolRef of a pool on screen (its currencies, fee, spacing and version). */
export const refOf = (option: PoolOption): PoolRef => ({
  dex: option.dex ?? 4,
  currency0: option.currencies[0].address as Address,
  currency1: option.currencies[1].address as Address,
  fee: option.feePips,
  tickSpacing: option.tickSpacing,
  hooks: ZERO_ADDRESS,
})
