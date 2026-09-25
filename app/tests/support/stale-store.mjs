/**
 * A read-v3 overview entry as the store serves a pool without its provider
 * figures (backend/public_observations.py aged_market: market `unavailable`,
 * no data, and the estimate built from that). Added 2026-09-25 (r4/metrics)
 * for the owner's Home, where ETH/USDG and PONS/USDG said "Unavailable" for a
 * minute; options added the same day after review, for the stores whose
 * figures are not coming. Every answer built with it still passes read-v3's
 * own runtime, which the tests check.
 *
 * By default the figures aged past the store's five-minute limit (the cache
 * age past maxStaleSeconds) and the collector is about to try again: the
 * demand the overview itself registers brings the collection within five
 * seconds (backend/migrations/026_public_demand.sql), so `acquisition` is
 * ready, with no error, next attempt in `inSeconds`.
 *
 * - `reason`: the store's last collection failed (backend/manage_public_data.py
 *   fail(): last_error set, a backoff of up to 300 s that a request does not
 *   bring forward); give `inSeconds` that backoff.
 * - `neverCovered`: the provider never gave figures for this pool (cache age
 *   null): a collection brings none back.
 * - `observedAt`: when the store's observation was published, for a
 *   collection that came and went without figures. Defaults to the entry's.
 */
export function agedPoolEntry(entry, generatedAt, { inSeconds = 5, refreshing = false, reason = null, neverCovered = false, observedAt = entry.observedAt } = {}) {
  const value = entry.value
  const age = neverCovered ? null : value.market.market.cache.maxStaleSeconds + 14
  const cache = { ...value.market.market.cache, ageSeconds: age, ...(neverCovered ? { status: 'miss' } : {}) }
  const market = { status: 'unavailable', reason: 'provider_unavailable', data: null, cache }
  const estimate = {
    ...value.estimate,
    feeAprEstimate24hPercent: null,
    status: 'unavailable',
    reasons: neverCovered
      ? ['market_age_unknown', 'market_unavailable', 'missing_reported_tvl', 'missing_volume24h']
      : ['market_data_expired', 'market_unavailable', 'missing_reported_tvl', 'missing_volume24h'],
    inputs: { ...value.estimate.inputs, reportedLiquidityUsd: null, volume24hUsd: null },
    provenance: { ...value.estimate.provenance, marketStatus: 'unavailable', marketReason: 'provider_unavailable', retrievedAt: null, sourceUrl: null, cacheStatus: cache.status, cacheAgeSeconds: age, effectiveMarketAgeSeconds: age },
  }
  return {
    ...entry,
    observedAt,
    acquisition: { status: 'ready', refreshing, reason, nextAttemptAt: generatedAt + inSeconds },
    value: { ...value, market: { ...value.market, market }, estimate },
  }
}

/** `body` with the pools named in `stale` served as agedPoolEntry serves them. */
export function withStalePools(body, stale, options) {
  const ids = new Set([...stale].map((id) => id.toLowerCase()))
  return { ...body, pools: body.pools.map((entry) => (ids.has(entry.poolId.toLowerCase()) && entry.value ? agedPoolEntry(entry, body.generatedAt, options) : entry)) }
}
