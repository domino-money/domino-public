/** Project stored observations through the existing V1/V2 presentation. The
 * envelope arrival is not a fresh observation: server-reported storage age is
 * carried onto the page's clocks, preserving both provider and snapshot age. */
import type { VerifiedPool } from 'api-contracts/read-v1/types'
import type { StoredPool, StoredToken } from 'api-contracts/read-v3/types'
import { observe } from './interpret'
import { projectMarketRow, tokenDisplay, unreadToken } from './project'
import { addressKey, poolIdKey } from './screens/identity'
import { DYNAMIC_FEE_PIPS, feeLabel } from './screens/fee'
import { figureFromMarket, retrievalNote } from './screens/figures'
import type { PoolOption } from './screens/poolsList'
import type { PaintMemory } from './marketsPaint'
import type { Provenance, ReadOutcome } from './types'

export function storedProvenance(provenance: Provenance, generatedAt: number, observedAt: number): Provenance {
  const ageMs = Math.max(0, generatedAt - observedAt) * 1000
  return {
    ...provenance,
    receivedAt: provenance.receivedAt - ageMs,
    ...(provenance.receivedMonotonic === undefined ? {} : { receivedMonotonic: provenance.receivedMonotonic - ageMs }),
  }
}

export function storedTokenRead(entry: StoredToken, generatedAt: number, provenance: Provenance): Extract<ReadOutcome<'token'>, { state: 'ok' }> | null {
  if (!entry.value || entry.observedAt === null) return null
  return { state: 'ok', route: 'token', data: entry.value, observation: observe('token', entry.value), provenance: storedProvenance(provenance, generatedAt, entry.observedAt) }
}

export function storedPoolRead(entry: StoredPool, generatedAt: number, provenance: Provenance): Extract<ReadOutcome<'pool-market'>, { state: 'ok' }> | null {
  if (!entry.value || entry.observedAt === null) return null
  return { state: 'ok', route: 'pool-market', data: entry.value.market, estimate: entry.value.estimate,
    observation: observe('pool-market', entry.value.market), provenance: storedProvenance(provenance, generatedAt, entry.observedAt) }
}

/** The overview's rows; with `keep`, only the pools it keeps (a list's binding, marketsProvider.ts). */
export function overviewRows(outcome: Pick<Extract<ReadOutcome<'overview'>, { state: 'ok' }>, 'data' | 'provenance'>, keep?: (poolId: string, pool: VerifiedPool) => boolean) {
  const tokens = new Map<string, ReadOutcome<'token'>>()
  for (const entry of outcome.data.tokens) {
    const read = storedTokenRead(entry, outcome.data.generatedAt, outcome.provenance)
    if (read) tokens.set(entry.address, read)
  }
  return outcome.data.pools.flatMap((entry) => {
    const market = storedPoolRead(entry, outcome.data.generatedAt, outcome.provenance)
    if (!market || (keep && !keep(entry.poolId, market.data.pool))) return []
    const row = projectMarketRow({ market, tokens, metrics: null })
    const pending = market.data.pool.currencies.some((address) => outcome.data.tokens.some((entry) => entry.address === address && entry.value === null && entry.acquisition.status === 'pending'))
    return [{ ...row, ...(pending ? { tokensPending: true as const } : {}) }]
  })
}

export function overviewPoolOption(outcome: Extract<ReadOutcome<'overview'>, { state: 'ok' }>, poolId: string): PoolOption | null {
  const entry = outcome.data.pools.find((row) => row.poolId === poolId)
  const read = entry && storedPoolRead(entry, outcome.data.generatedAt, outcome.provenance)
  if (!read) return null
  const pool = read.data.pool
  const currencies = pool.currencies.map((address) => {
    const stored = outcome.data.tokens.find((token) => token.address === address)
    return stored?.value ? tokenDisplay(stored.value.asset) : unreadToken(address)
  }) as PoolOption['currencies']
  return {
    key: poolIdKey(poolId), kind: 'stored', currencies, fee: feeLabel(pool.poolKey),
    feePips: pool.poolKey.feeMode === 'dynamic' ? DYNAMIC_FEE_PIPS : pool.poolKey.fee_pips,
    tickSpacing: pool.poolKey.tick_spacing, tick: pool.tick, sqrtPriceX96: pool.sqrtPriceX96,
    readAt: read.provenance.receivedAt, hooks: addressKey(pool.poolKey.hooks), protocolFeeRaw: pool.protocolFeeRaw,
    integration: pool.integrationClass, block: pool.snapshot.number, catalogue: null, requestedById: true,
    liquidity: figureFromMarket(read.data.market, 'liquidity'), volume: figureFromMarket(read.data.market, 'volume'),
    providerNote: read.data.market.data ? retrievalNote(read.data.market.data.retrievedAt) : null,
    aprReason: pool.aprReason, tokenMetadata: currencies.every((token) => token.readStatus === 'available') ? 'available' : 'partial', providerConflict: false,
  }
}

/**
 * A pool as this browser's copy of the last overview (marketsPaint.ts) names it, for its page to paint while its own
 * verification is on its way (speed wave, item 44, 2026-09-28): the copy as an answer, dated as it was read, and the
 * pool's option, only where the copy names the pool with the token the page verifies it against. Null otherwise.
 */
export function paintedPool(memory: Pick<PaintMemory, 'load'> | null, poolId: string, token: string): { overview: Extract<ReadOutcome<'overview'>, { state: 'ok' }>; option: PoolOption } | null {
  const copy = memory?.load()
  if (!copy) return null
  const overview = { route: 'overview' as const, state: 'ok' as const, data: copy.data, observation: { block: null, providers: [] }, provenance: copy.provenance }
  const option = overviewPoolOption(overview, poolId)
  return option && option.currencies.some((currency) => currency.address === token) ? { overview, option } : null
}
