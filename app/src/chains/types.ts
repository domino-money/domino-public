/**
 * The boundary every chain's screens read through (2026-10-01, the chain2 workstream, audit items G5 and G7).
 *
 * A pool and a position are named with their chain (G5): a Robinhood v4 pool is a 32-byte id, an Elysium v3 pool a
 * 20-byte address, and position #5 is a different NFT on each chain and under each position manager. So a reference
 * carries the chain id, and a position its position manager too; every store, cache and route key is built from these
 * (`poolKey`, `positionKey`), never from a bare id.
 *
 * A ChainAdapter is what a chain's screens ask (G7): its capabilities, its pools and their state, a wallet's positions,
 * one position with its fees, and its history. The Elysium v3 adapter (chains/elysium/adapter.ts) is the first; the
 * Robinhood v4 adapter (chains/robinhood/adapter.ts, part B) wraps the reads Robinhood's own screens make, and says
 * which it does not wrap. Every figure an
 * adapter returns carries where it was read and when (`Provenance`), so a screen can always say so.
 *
 * Types and pure helpers only.
 */
import type { ChainConfig, Protocol } from '../config/chainKit'

export interface PoolRef {
  readonly chainId: number
  readonly protocol: Protocol
  /** v4: the pool id (0x + 64 hex); v3: the pool's address (0x + 40 hex). Lowercase. */
  readonly id: string
}

export interface PositionRef {
  readonly chainId: number
  /** The position manager whose NFT this is, lowercase. */
  readonly positionManager: string
  /** The NFT's id, a decimal string. */
  readonly tokenId: string
}

const V3_POOL = /^0x[0-9a-f]{40}$/
const V4_POOL = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const TOKEN_ID = /^[1-9][0-9]{0,77}$/

/** A pool reference, or null when `id` is not a pool of that protocol (a route segment is untrusted text). */
export function poolRef(chain: ChainConfig, id: string): PoolRef | null {
  const value = id.toLowerCase()
  const protocol = chain.deployment.protocol
  if (!(protocol === 'uniswap-v3' ? V3_POOL : V4_POOL).test(value)) return null
  return Object.freeze({ chainId: chain.id, protocol, id: value })
}

/** A position reference, or null when the manager or the token id is not one. */
export function positionRef(chain: ChainConfig, positionManager: string, tokenId: string): PositionRef | null {
  const manager = positionManager.toLowerCase()
  if (!ADDRESS.test(manager) || /^0x0{40}$/.test(manager) || !TOKEN_ID.test(tokenId)) return null
  return Object.freeze({ chainId: chain.id, positionManager: manager, tokenId })
}

/** The one key a pool is stored and cached under: `<chainId>:<protocol>:<id>`. */
export const poolKey = (ref: PoolRef): string => `${ref.chainId}:${ref.protocol}:${ref.id}`

/** The one key a position is stored and cached under: `<chainId>:<positionManager>:<tokenId>`. */
export const positionKey = (ref: PositionRef): string => `${ref.chainId}:${ref.positionManager}:${ref.tokenId}`

/** Where a figure was read, and when: the chain itself at a block, or a service's answer anchored at one. */
export interface Provenance {
  readonly source: 'chain' | 'service'
  readonly block: number
  /** Seconds since the epoch: the block's own time. */
  readonly timestamp: number
}

export interface TokenInfo {
  readonly address: string
  /** As the token's contract answers it; untrusted text, never an identity. */
  readonly symbol: string | null
  readonly decimals: number | null
}

export interface PoolSummary {
  readonly ref: PoolRef
  readonly token0: TokenInfo
  readonly token1: TokenInfo
  /** The fee tier, in millionths (3000 is 0.3%). */
  readonly fee: number
  readonly tickSpacing: number
  readonly sqrtPriceX96: bigint
  readonly tick: number
  readonly liquidity: bigint
  /** What the pool holds of each token (null where unread). */
  readonly balances: readonly [bigint | null, bigint | null]
  readonly feeProtocol: number
  readonly at: Provenance
}

export interface PoolActivitySummary {
  readonly ref: PoolRef
  readonly swaps: number
  /** What swappers paid in, per token. */
  readonly paidIn: readonly [bigint, bigint]
  /** What the providers earned from it, an estimate (v3math.ts providerFees). */
  readonly providerFees: readonly [bigint, bigint]
  readonly fromBlock: number
  readonly toBlock: number
  readonly hours: number
  readonly at: Provenance
}

/** Who holds a position's NFT: the wallet itself, or a Domino vault the wallet owns. */
export type Holder = { readonly kind: 'wallet'; readonly owner: string } | { readonly kind: 'vault'; readonly vault: string; readonly owner: string }

export interface PositionSummary {
  readonly ref: PositionRef
  readonly pool: PoolRef
  readonly holder: Holder
  readonly token0: TokenInfo
  readonly token1: TokenInfo
  readonly fee: number
  readonly tickSpacing: number
  readonly tickLower: number
  readonly tickUpper: number
  readonly liquidity: bigint
  /** Whether the vault still manages it (a released or closed one is inactive). Wallet-held positions: liquidity > 0. */
  readonly active: boolean
}

export interface PositionState extends PositionSummary {
  readonly tick: number
  readonly sqrtPriceX96: bigint
  readonly inRange: boolean
  /** What the position holds now, per token. */
  readonly amounts: readonly [bigint, bigint]
  /** Fees earned and not yet collected, per token (v3math.ts uncollectedFees). */
  readonly fees: readonly [bigint, bigint]
  readonly at: Provenance
}

export interface HistoryItem {
  readonly kind: string
  readonly source: Provenance['source']
  readonly block: number
  /** The block's time, where the source gave it (his service does; the chain's logs do not, and no time is invented). */
  readonly timestamp: number | null
  readonly transactionHash: string
  readonly tokenId: string | null
  /** Token amounts the event names, raw, per token of the position's pool; null where it names none. */
  readonly amounts: readonly [bigint | null, bigint | null]
}

export interface HistoryPage {
  readonly items: readonly HistoryItem[]
  /** Whether the list covers the position's whole life (false: a window, or the service said its coverage is partial). */
  readonly complete: boolean
  readonly at: Provenance
}

/** What a chain's screens may show, and why something is hidden: the screens are driven by this, never by the chain. */
export interface ChainCapabilities {
  readonly chain: ChainConfig
  /**
   * Whether a pool list is known: from the chain (a factory's pools, read in the browser), from the chain's read service
   * (Robinhood's: its screens read it through the read pipeline, not through an adapter; part B, G7), or not at all.
   */
  readonly pools: 'chain' | 'service' | 'none'
  /** Whether USD values may be shown: only where the chain has a dollar rule or a price provider. */
  readonly usd: boolean
  /** Whether a yearly rate may be shown: needs USD and a fee history; not on a chain with neither. */
  readonly apr: boolean
  /** Where a wallet's positions are found. */
  readonly positions: 'vaults-and-wallet' | 'wallet' | 'none'
  /** Whether a position's history comes from the service, from the chain's logs, or nowhere. */
  readonly history: 'service' | 'chain' | 'none'
  /** Whether a position can be created or changed from this app now, and if not, why. */
  readonly actions: { readonly available: boolean; readonly reason: ActionsUnavailable | null }
  /** The read service answered (its capabilities route), and with which qualification. */
  readonly service: { readonly read: ServiceState; readonly actions: ServiceState }
}

/** `none` (part B, G7): no such service stands behind the adapter (Robinhood's reads the chain directly). */
export type ServiceState = 'connected' | 'not-enabled' | 'unreachable' | 'none'

/** Why actions are not offered, in the order they are checked. */
export type ActionsUnavailable =
  /** The section's own flag: off in this environment. */
  | 'section-off'
  /** The chain's deployment is unqualified and the service offers no testnet actions. */
  | 'deployment-unqualified'
  /** The actions service is not reachable through this site. */
  | 'service-off'
  /** The service is reachable, but its contract version offers this site no wallet lane (rc.2 offers none). */
  | 'service-says-no'
  /** No wallet signer is wired into this build. */
  | 'no-signer'

export interface ChainAdapter {
  readonly chain: ChainConfig
  capabilities(signal?: AbortSignal): Promise<ChainCapabilities>
  listPools(signal?: AbortSignal): Promise<PoolSummary[]>
  poolState(ref: PoolRef, signal?: AbortSignal): Promise<PoolSummary>
  poolActivity(ref: PoolRef, hours: number, signal?: AbortSignal): Promise<PoolActivitySummary>
  listPositions(owner: string, signal?: AbortSignal): Promise<PositionSummary[]>
  position(ref: PositionRef, signal?: AbortSignal): Promise<PositionState>
  history(ref: PositionRef, signal?: AbortSignal): Promise<HistoryPage | null>
}
