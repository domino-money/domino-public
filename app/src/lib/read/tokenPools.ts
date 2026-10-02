/**
 * A token's pools on Markets, from both of the read service's sources (audit V2 and B6, 2026-10-01).
 *
 * A token's page used to list only the stored overview (read-v3), which holds the pools the read service already
 * knows and has verified, with figures from its market data provider. New position lists the pools route (read-v1),
 * which verifies on chain the pools DEX Screener lists for the token, most liquid first (screens/poolHints.ts). The two
 * never met: on production, UFG's page listed 17 pools, none with figures, many with fees of 79-99%, and not its real
 * USDG/UFG 4% pool (0x031fe000…), the owner's own, which New position listed with its figures.
 *
 * Now the page reads both and shows one list:
 *   - every pool once, by pool id: the stored row where there is one (its figures stood in for, where its provider
 *     refused, by DEX Screener's: figureFallback.ts), else the pools route's row with DEX Screener's figures, which it
 *     verified on chain at a block before it is listed (a pool it does not confirm is not listed at all);
 *   - today's Top pools that hold the token first, in the list's order, then by liquidity, largest first;
 *   - pools with a fee above a tenth of every swap, and pools Domino can't open positions in, flagged in words, and
 *     left out until "Show all" asks for them (splitFlagged).
 * Nothing here reads anything; the page does.
 */
import type { CatalogueDiscoveryPool, DiscoveryPool, PoolsResponse } from 'api-contracts/read-v1/types'
import { compare, parseDecimal } from './decimal'
import type { Market, Metric } from '../markets'
import { identityKey, tokenDisplay, tokenText, unreadToken } from './project'
import { rowApr } from './screens/rowApr'
import { figureFromProviderMetrics } from './screens/figures'
import type { Provenance, TokenDisplay } from './types'

/** Above this, in pips, a pool's fee is flagged: more than a tenth of every swap. */
export const HIGH_FEE_PIPS = 100_000
const ZERO = /^0x0{40}$/

const lower = (value: string) => value.toLowerCase()

/** A DEX Screener figure the pools route carried, as a row's metric: attributed, dated, never one of ours. */
function discovered(raw: string | null, retrievedAt: number | null, reason: string): Metric {
  if (raw === null || retrievedAt === null || !parseDecimal(raw)) return { value: null, state: 'unavailable', reason }
  return { value: raw, state: 'provider', asOf: retrievedAt, source: 'DexScreener', fallback: 'discovered' }
}

/**
 * The pools route's verified pools as Markets rows: names and decimals from the same answer, the pool's own state for
 * its price, DEX Screener's figures attributed and dated, and the read service's estimate method worked out on them,
 * labelled an estimate. No row is made for a pool the answer does not carry.
 */
export function discoveryRows(d: PoolsResponse, provenance: Provenance): Market[] {
  const tokens = new Map<string, TokenDisplay>(d.tokens.map((token) => [lower(token.address), tokenDisplay(token)]))
  const token = (address: string) => tokens.get(lower(address)) ?? unreadToken(address)
  return d.pools.map((pool: DiscoveryPool | CatalogueDiscoveryPool): Market => {
    const metrics = 'providerMetrics' in pool ? pool.providerMetrics : null
    const conflict = 'providerCurrencyConflict' in pool && pool.providerCurrencyConflict === true
    const at = metrics && !conflict ? metrics.retrievedAt : null
    const [currency0, currency1] = pool.currencies
    const base = token(currency0)
    const quote = token(currency1)
    const feePips = pool.poolKey.feeMode === 'fixed' ? pool.poolKey.fee_pips : null
    const estimate = feePips === null ? null : rowApr({
      integration: pool.integrationClass, currentLpFeePips: feePips, protocolFeeRaw: pool.protocolFeeRaw,
      liquidity: figureFromProviderMetrics(metrics, 'liquidity', conflict), volume: figureFromProviderMetrics(metrics, 'volume', conflict),
    })
    return {
      key: identityKey(pool.poolId),
      poolId: lower(pool.poolId),
      base: tokenText(base),
      quote: tokenText(quote),
      tokens: { base, quote },
      feePips,
      protocol: 'v4',
      integration: pool.integrationClass,
      hooks: lower(pool.poolKey.hooks),
      protocolFeeRaw: pool.protocolFeeRaw,
      tvlUsd: discovered(metrics && !conflict ? metrics.reportedLiquidityUsd : null, at, conflict ? 'provider_currency_mismatch' : 'no_provider_figures'),
      volume24hUsd: discovered(metrics && !conflict ? metrics.volume24hUsd : null, at, conflict ? 'provider_currency_mismatch' : 'no_provider_figures'),
      feeAprPercent: { value: null, state: 'unavailable', reason: 'fee_apr_not_provided' },
      ...(estimate?.kind === 'estimate' && at !== null ? { aprFallback: { percent: estimate.text, asOf: at, basis: 'discovered' as const } } : {}),
      poolState: {
        sqrtPriceX96: pool.sqrtPriceX96,
        tick: pool.tick,
        tickSpacing: pool.poolKey.tick_spacing,
        block: pool.snapshot.number,
        currency0: lower(pool.poolKey.currency0),
        currency1: lower(pool.poolKey.currency1),
      },
      provenance: {
        block: pool.snapshot.number,
        market: { status: 'unavailable', reason: 'not_collected', cacheAgeSeconds: null, freshForSeconds: 60, receivedAt: provenance.receivedAt, ...(provenance.receivedMonotonic === undefined ? {} : { receivedMonotonic: provenance.receivedMonotonic }) },
        metrics: 'not_requested',
        fixtures: [],
        origin: 'pool-market',
      },
    }
  })
}

/** Whether Domino can open a position in a row's pool: no hooks, a fixed fee, the standard integration. Unknown counts as yes. */
export const openable = (m: Pick<Market, 'integration' | 'hooks' | 'feePips'>) =>
  m.feePips !== null && m.integration !== 'requires_separate_adapter' && (m.hooks === undefined || ZERO.test(m.hooks))

/** Whether a row is flagged: a fee above HIGH_FEE_PIPS, or a pool Domino can't open positions in. */
export const flagged = (m: Pick<Market, 'integration' | 'hooks' | 'feePips'>) => !openable(m) || (m.feePips !== null && m.feePips > HIGH_FEE_PIPS)

/** A row's liquidity for ordering: its own TVL where it has a number, else `fallback` (DEX Screener's), else none (-1). */
export function liquidityOf(row: Market, fallback: (poolId: string) => string | null = () => null): string | null {
  const own = row.tvlUsd.state !== 'unavailable' && row.tvlUsd.state !== 'rejected' && row.tvlUsd.state !== 'absent' && row.tvlUsd.value !== null ? row.tvlUsd.value : null
  return own ?? fallback(row.poolId)
}

/**
 * One list from both sources (see the header): the stored rows first claim their pool, the pools route's rows add the
 * pools the store does not hold; then today's listed pools that hold the token, in the list's order, then the rest by
 * liquidity, largest first, a pool with none last, ties by pool id.
 */
export function mergeTokenPools(stored: readonly Market[], found: readonly Market[], options: { listed?: readonly string[]; liquidity?: (poolId: string) => string | null } = {}): Market[] {
  const byId = new Map<string, Market>()
  for (const row of stored) byId.set(row.poolId, row)
  for (const row of found) if (!byId.has(row.poolId)) byId.set(row.poolId, row)
  const listed = (options.listed ?? []).map(lower)
  const rank = (row: Market) => {
    const at = listed.indexOf(row.poolId)
    return at === -1 ? listed.length : at
  }
  return [...byId.values()].sort((a, b) => {
    const listedFirst = rank(a) - rank(b)
    if (listedFirst !== 0) return listedFirst
    const x = liquidityOf(a, options.liquidity)
    const y = liquidityOf(b, options.liquidity)
    if (x !== null && y !== null) {
      const larger = compare(y, x) ?? 0
      if (larger !== 0) return larger
    } else if (x !== y) return x === null ? 1 : -1
    return a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0
  })
}

/** The rows shown by default, and the flagged ones "Show all" adds. */
export function splitFlagged(rows: readonly Market[]): { shown: Market[]; hidden: Market[] } {
  return { shown: rows.filter((row) => !flagged(row)), hidden: rows.filter(flagged) }
}
