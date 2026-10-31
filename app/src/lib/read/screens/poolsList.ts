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
import { compare, formatUsdCompact, parseDecimal } from '../decimal'
import { reasonText } from '../describe'
import { tokenDisplay, unreadToken } from '../project'
import type { TokenDisplay } from '../types'
import { COPY } from './copy'
import { DYNAMIC_FEE_PIPS, feeLabel } from './fee'
import type { PoolCatalogueEntry } from '../../../config/selectedPoolCatalogue'
import { featuredPoolIds } from './featuredPools'
import { addressKey, NATIVE_CURRENCY, poolIdKey, type AddressKey, type PoolIdKey } from './identity'
import { figureFromProviderMetrics, retrievalNote, type AttributedFigure } from './figures'
import type { Instant, Market, Metric } from '../../markets'
import { aprDigits } from '../../format/apr'
import { poolAprPresentation } from '../poolAprPresentation'
import { rowApr } from './rowApr'

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
  /**
   * Added 2026-10-06 (the owner: Base's v3 rows showed no APR): a v3 pool's slot0.feeProtocol when its protocol fee is on,
   * as read-v6 chain-pools reports it; the APR estimate takes the LPs' share from it (rowApr.ts v3LpShare).
   */
  v3FeeProtocol?: number
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
   * Changed on purpose 2026-10-06 (the owner: "USD estimate unavailable" on Robinhood Chain pairs without USDG): New
   * position's chosen Robinhood Chain pool without USDG carries them too, read by the same service for its pair
   * (components/create/usePricedPool.ts), in pool order.
   */
  usdPrices?: readonly [string | null, string | null]
  /** The block the pool was verified at. */
  block: number
  catalogue: { source: 'initialize_event' | 'verified_observation'; block: number } | null
  requestedById: boolean
  liquidity: AttributedFigure
  volume: AttributedFigure
  /**
   * Added 2026-10-30 (QA round 2, N8): the APR the Markets table shows for this pool, where the page already holds its
   * Markets row (withMarketFigures). New position's row and its preview write that figure (optionAprText), so one pool
   * reads one APR on every screen. Absent everywhere else, and on a pool Markets shows no APR for.
   */
  marketApr?: MarketApr
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

/**
 * A Markets row's provider figure as a pool option's (QA round 2, N10), with its own provider: the same figure the
 * Markets table shows for the pool. Null for anything that is not a provider's current or kept figure (Domino's own
 * history has no provider to name here). Changed 2026-10-30 (QA round 2, N8): a figure standing in for a refused one
 * (figureFallback.ts) is taken too, under the provider it names, as the Markets table shows it.
 */
export function marketFigure(metric: Metric | undefined): AttributedFigure | null {
  if (!metric || metric.value === null || metric.source === undefined) return null
  if (metric.state !== 'provider' && metric.state !== 'stale') return null
  const parsed = parseDecimal(metric.value)
  const value = formatUsdCompact(metric.value)
  if (!parsed || !value) return null
  const figure = { value, raw: metric.value, zero: parsed.coefficient === 0n, provider: metric.source === 'DexScreener' ? 'dexscreener' as const : 'geckoterminal' as const, retrievedAt: metric.asOf ?? 0, cacheAgeSeconds: null }
  return metric.state === 'stale' ? { state: 'attributed_stale', ...figure, refreshReason: null } : { state: 'attributed', ...figure }
}

/** The APR the Markets table shows for a pool (QA round 2, N8): its digits by the one APR rule, and whether it is an estimate. */
export interface MarketApr {
  /** "38.8", "1,590", "<0.1" (lib/format/apr.ts); the caller adds "%" and, for an estimate, "est.". */
  digits: string
  estimate: boolean
}

/**
 * The APR a Markets row shows, chosen as its cell chooses (poolAprPresentation.ts): Domino's own history where it
 * qualifies, else the read service's estimate while it is current, else the stand-in estimate (figureFallback.ts). Null
 * where the row shows none (a dash, or a figure still coming). `row` as the table draws it: stand-ins applied, aged.
 */
export function marketApr(row: Market, now: Instant): MarketApr | null {
  const apr = poolAprPresentation(row, now)
  const digits = apr.qualified
    ? (row.feeAprPercent.value === null ? null : aprDigits(row.feeAprPercent.value))
    : (apr.estimate.text ?? (apr.fallback ? aprDigits(apr.fallback.percent) : null))
  return digits === null ? null : { digits, estimate: !apr.qualified }
}

/** One pool's figures as the Markets table shows them, for New position's row (QA round 2, N8); null where it shows none. */
export interface MarketFigures {
  liquidity: AttributedFigure | null
  volume: AttributedFigure | null
  apr: MarketApr | null
}

/**
 * New position's list with the figures the Markets table already shows for the same pools, so one pool reads one TVL,
 * one 24h volume and one APR on Markets, on its own page and in New position (QA round 2, N8; N10 before it filled only
 * the figures the pools route had not reported). Each figure Markets shows replaces the route's; the route's stays where
 * Markets shows none (and where Markets' is Domino's own history, which marketFigure does not take). Then the list is put
 * in TVL order again. `figures` are worked out from rows already read (knownMarkets.ts); nothing is read for this. The
 * same options when there are none.
 */
export function withMarketFigures<T extends PoolOption>(options: readonly T[], figures: ReadonlyMap<string, MarketFigures> | null): readonly T[] {
  if (!figures || figures.size === 0 || options.length === 0) return options
  let changed = false
  const out = options.map((option) => {
    const shown = figures.get(option.key)
    if (!shown) return option
    const liquidity = shown.liquidity ?? option.liquidity
    const volume = shown.volume ?? option.volume
    if (liquidity === option.liquidity && volume === option.volume && shown.apr === null && option.marketApr === undefined) return option
    changed = true
    const next: T = { ...option, liquidity, volume }
    // An APR Markets no longer shows is not kept from an earlier merge (a chosen pool merged again, knownMarkets.ts).
    if (shown.apr) next.marketApr = shown.apr
    else delete next.marketApr
    return next
  })
  return changed ? byTvl(out) : options
}

/**
 * A pool row's APR as New position writes it, in its list and on its preview card (QA round 2, N8): the figure Markets
 * shows where the page holds the pool's row ("38.8% est.", or "41.2%" from Domino's own history), else the row's own
 * estimate from the figures it carries (rowApr.ts, "12.2% est."). Null where there is neither. One APR rule
 * (lib/format/apr.ts).
 */
export function optionAprText(option: PoolOption): string | null {
  if (option.marketApr) return `${option.marketApr.digits}%${option.marketApr.estimate ? ' est.' : ''}`
  const apr = rowApr({
    integration: option.integration,
    currentLpFeePips: option.feePips,
    protocolFeeRaw: option.protocolFeeRaw,
    ...(option.v3FeeProtocol !== undefined ? { v3FeeProtocol: option.v3FeeProtocol } : {}),
    liquidity: option.liquidity,
    volume: option.volume,
  })
  return apr.kind === 'estimate' ? `${aprDigits(apr.text) ?? apr.text}% est.` : null
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
