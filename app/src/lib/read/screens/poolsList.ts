/**
 * Issue #3: existing pools for a chosen token, as options a person can pick
 * for reference.
 *
 * Neutral order (fee tier, then pool id): never ranked by provider volume or
 * APR, and nothing is "recommended". Candidates the producer rejected are
 * listed with their reason and cannot be chosen. Coverage is said plainly:
 * an empty or partial list is never proof that no pool exists. DexScreener
 * figures here are attributed to DexScreener and never mixed with
 * GeckoTerminal's.
 *
 * New position's first step is the exception, and asks for it (`only:
 * 'domino'`): it lists only the pools Domino's setup contract can open a
 * position in, largest reported TVL first (`byTvl`), because there the list
 * is a choice of where to deposit rather than a reference.
 */
import type { CatalogueDiscoveryPool, DiscoveryPool, PoolsRequest, PoolsResponse } from 'api-contracts/read-v1/types'
import { compare } from '../decimal'
import { reasonText } from '../describe'
import { tokenDisplay, unreadToken } from '../project'
import type { TokenDisplay } from '../types'
import { COPY } from './copy'
import { DYNAMIC_FEE_PIPS, feeLabel } from './fee'
import type { PoolCatalogueEntry } from '../../../config/selectedPoolCatalogue'
import { featuredPoolIds } from './featuredPools'
import { addressKey, NATIVE_CURRENCY, poolIdKey, type AddressKey, type PoolIdKey } from './identity'
import { figureFromProviderMetrics, retrievalNote, type AttributedFigure } from './figures'

export interface PoolOption {
  key: PoolIdKey
  kind: 'discovery' | 'catalogue' | 'stored'
  currencies: [TokenDisplay, TokenDisplay]
  fee: string
  /** For ordering only; the dynamic sentinel sorts last. */
  feePips: number
  tickSpacing: number
  /** The pool's tick and square-root price at `block`, as read. Only poolRange.ts turns them into a price. */
  tick: number
  sqrtPriceX96: string
  /** When the reply arrived, on the page's clock (provenance.receivedAt); null when unknown. Never shown as a data time. */
  readAt: number | null
  hooks: AddressKey
  /** The pool's packed directional protocol fee at `block`, as read (figures.ts `protocolFee`). */
  protocolFeeRaw?: number
  integration: 'hookless_fixed_fee' | 'requires_separate_adapter'
  /**
   * Added 2026-10-05 (New position on Base and Arbitrum One, lib/create/otherChains.ts): the Uniswap version of a pool read
   * on another network through the wallet. Absent on every pool of the read service (Robinhood Chain), which are v4. A v3
   * pool's `key` is its address as a 32-byte word (twelve zero bytes, then the address), the way the ABI writes one.
   */
  dex?: 3 | 4
  /**
   * Added 2026-10-06 (rugged97's delta of 5 Oct, item 4: read-v6 1.1.0-rc.1's qualified USD): a pool on Base or Arbitrum
   * One read by Domino's service carries each currency's USD price as that read gave it (18 decimals; the stable at 1, ETH
   * and WETH at Chainlink's ETH/USD, any other token at its deepest qualified pool), in pool order, null for a currency
   * without one. Absent everywhere else: Robinhood Chain's pools are valued through USDG (components/create/valuation.ts).
   */
  usdPrices?: readonly [string | null, string | null]
  /** The block the pool was verified at. */
  block: number
  catalogue: { source: 'initialize_event' | 'verified_observation'; block: number } | null
  requestedById: boolean
  liquidity: AttributedFigure
  volume: AttributedFigure
  /** Source and retrieval time of the two DexScreener figures; null when there are none to date (none retrieved, or rejected). */
  providerNote: string | null
  aprReason: string
  tokenMetadata: 'available' | 'partial'
  providerConflict: boolean
}

export interface RejectedPool {
  key: PoolIdKey
  reason: string
}

export interface PoolsView {
  options: PoolOption[]
  rejected: RejectedPool[]
  coverage: string[]
  block: number
  /** False whenever a source was missing: the list may be incomplete. */
  complete: boolean
  /** Verified pools left out by `only: 'domino'` (hooks or a dynamic fee), for data attributes only; 0 otherwise. */
  hidden: number
}

/**
 * Whether Domino's setup contract can open a position in this pool: no hooks
 * and a fixed fee. DominoSetup.open reverts on any other pool (hooks ≠ 0, or
 * the dynamic-fee flag), so New position never lists one. Every field has to
 * agree: one that says otherwise is enough to leave the pool out.
 */
export function usableForDomino(pool: DiscoveryPool | CatalogueDiscoveryPool): boolean {
  return pool.integrationClass === 'hookless_fixed_fee'
    && pool.poolKey.feeMode === 'fixed'
    && pool.poolKey.fee_pips !== DYNAMIC_FEE_PIPS
    && addressKey(pool.poolKey.hooks) === NATIVE_CURRENCY
}

/** The same test on a pool already projected, for a pool that arrives by a link or on its own page. */
export function optionUsableForDomino(option: Pick<PoolOption, 'integration' | 'hooks' | 'feePips'>): boolean {
  return option.integration === 'hookless_fixed_fee' && option.hooks === NATIVE_CURRENCY && option.feePips !== DYNAMIC_FEE_PIPS
}

export function poolOption(pool: DiscoveryPool | CatalogueDiscoveryPool, tokens: ReadonlyMap<string, TokenDisplay>, readAt: number | null = null): PoolOption {
  const token = (address: string) => tokens.get(address.toLowerCase()) ?? unreadToken(address)
  const conflict = 'providerCurrencyConflict' in pool && pool.providerCurrencyConflict === true
  return {
    key: poolIdKey(pool.poolId),
    kind: pool.poolKind,
    currencies: [token(pool.poolKey.currency0), token(pool.poolKey.currency1)],
    fee: feeLabel(pool.poolKey),
    feePips: pool.poolKey.feeMode === 'dynamic' ? DYNAMIC_FEE_PIPS : pool.poolKey.fee_pips,
    tickSpacing: pool.poolKey.tick_spacing,
    tick: pool.tick,
    sqrtPriceX96: pool.sqrtPriceX96,
    readAt,
    hooks: addressKey(pool.poolKey.hooks),
    protocolFeeRaw: pool.protocolFeeRaw,
    integration: pool.integrationClass,
    block: pool.snapshot.number,
    catalogue: pool.poolKind === 'catalogue' ? { source: pool.catalogueSource, block: pool.catalogueObservation.number } : null,
    requestedById: pool.requestedById === true,
    liquidity: figureFromProviderMetrics(pool.providerMetrics, 'liquidity', conflict),
    volume: figureFromProviderMetrics(pool.providerMetrics, 'volume', conflict),
    providerNote: pool.providerMetrics && !conflict ? retrievalNote(pool.providerMetrics.retrievedAt) : null,
    aprReason: pool.aprReason,
    tokenMetadata: pool.tokenMetadataStatus,
    providerConflict: conflict,
  }
}

const neutral = (a: Pick<PoolOption, 'feePips' | 'key'>, b: Pick<PoolOption, 'feePips' | 'key'>) => a.feePips - b.feePips || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

/** Fee tier, then pool id. The order says nothing about which pool is better. */
export function neutralOrder<T extends Pick<PoolOption, 'feePips' | 'key'>>(options: readonly T[]): T[] {
  return [...options].sort(neutral)
}

/** A figure's provider decimal when one was reported (current or retained), else null. */
const reported = (figure: AttributedFigure): string | null => (figure.state === 'attributed' || figure.state === 'attributed_stale' ? figure.raw : null)

/** Larger first, compared exactly as decimals; a missing figure after every reported one. */
function descending(a: string | null, b: string | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1
  return -(compare(a, b) ?? 0)
}

/**
 * New position's order: reported TVL, highest first, and every pool without a
 * reported TVL after all that have one. Ties go to 24h volume the same way,
 * then to the neutral order (fee tier, then pool id), so one reply always
 * lists in one order.
 */
export function byTvl<T extends Pick<PoolOption, 'liquidity' | 'volume' | 'feePips' | 'key'>>(options: readonly T[]): T[] {
  return [...options].sort((a, b) => descending(reported(a.liquidity), reported(b.liquidity)) || descending(reported(a.volume), reported(b.volume)) || neutral(a, b))
}

export function coverageLines(d: PoolsResponse): { lines: string[]; complete: boolean } {
  const lines: string[] = []
  let complete = true
  if (d.discovery.status === 'received') {
    const n = d.discovery.returned
    lines.push(`The discovery provider returned ${n} candidate${n === 1 ? '' : 's'} (${d.discovery.v4Candidates} on Uniswap). That covers the provider’s candidates only.`)
  } else {
    complete = false
    lines.push(`Provider discovery was unavailable (${reasonText(d.discovery.reason)}), so this list may be incomplete.`)
  }
  if (d.catalogue.status === 'available') {
    lines.push(`Catalogue revision ${d.catalogue.revision} covers blocks ${d.catalogue.startBlock}–${d.catalogue.indexedThrough ?? 'not yet indexed'} only, not complete history.`)
  } else if (d.catalogue.status === 'not_configured') {
    complete = false
    lines.push('No pool catalogue is configured on this server, so this list may be incomplete.')
  } else {
    complete = false
    lines.push(`The pool catalogue was unavailable (${reasonText(d.catalogue.reason)}), so this list may be incomplete.`)
  }
  if (d.selectedTokenReadStatus !== 'available') lines.push(`The selected token’s metadata is ${reasonText(d.selectedTokenReadStatus)}.`)
  if (d.pools.length === 0) lines.push(COPY.picker.noOptions)
  return { lines, complete }
}

/**
 * The reply as options. With `only: 'domino'` a pool Domino cannot open a
 * position in is dropped here, before it is an option, a row or a count
 * anyone sees (`hidden` keeps the number, for data only), and the rest are
 * ordered by reported TVL.
 */
export function projectPoolsView(d: PoolsResponse, readAt: number | null = null, opts: { only?: 'domino' } = {}): PoolsView {
  const tokens = new Map(d.tokens.map((t) => [t.address.toLowerCase(), tokenDisplay(t)]))
  const { lines, complete } = coverageLines(d)
  const domino = opts.only === 'domino'
  const kept = domino ? d.pools.filter(usableForDomino) : d.pools
  const options = kept.map((pool) => poolOption(pool, tokens, readAt))
  return {
    options: domino ? byTvl(options) : neutralOrder(options),
    rejected: d.unverifiedCandidates.map((candidate) => ({ key: poolIdKey(candidate.poolId), reason: candidate.reason })),
    coverage: lines,
    block: d.snapshot.number,
    complete,
    hidden: d.pools.length - kept.length,
  }
}

/** Fixed key order: the scheduler coalesces by the request's JSON. */
export function poolsRequest(token: AddressKey, paired: AddressKey | null) {
  return paired ? { token, pairedToken: paired } : { token }
}

/** At most this many pool ids are named in one pools read (the read contract's own limit on `poolIds`). */
export const MAX_POOL_HINTS = 10

/**
 * New position's pools read. It names the site's featured pools that hold the
 * token (featuredPools.ts), then the hints (pool ids a market data provider
 * lists for the token, most liquid first; poolHints.ts), each once, ten at
 * most, and asks for exactly that many. The read service verifies those
 * pools on chain and attaches its own figures, instead of the first twelve
 * its catalogue holds by id. The featured pools come first because the
 * provider's list is a 30-pair sample that can leave them out, and they are
 * named even when the hints are slow or missing. With neither it is the
 * plain read above. Nothing the hints say is shown: a named pool the chain
 * does not confirm is not an option. Fixed key order, as above.
 */
export function usablePoolsRequest(token: AddressKey, paired: AddressKey | null, hints: readonly PoolIdKey[], featured?: readonly PoolCatalogueEntry[]): PoolsRequest {
  const poolIds = [...new Set([...featuredPoolIds(token, paired, featured), ...hints])].slice(0, MAX_POOL_HINTS)
  if (poolIds.length === 0) return poolsRequest(token, paired)
  return paired ? { token, pairedToken: paired, maxPools: poolIds.length, poolIds } : { token, maxPools: poolIds.length, poolIds }
}
