/** Public token metadata already validated by the read source, reused across
 * screens for five minutes at most. This cache contains no wallet, balance,
 * session or transaction data and never refreshes an observation's timestamp.
 * The shared scheduler remains responsible for in-flight deduplication.
 *
 * Added 2026-09-28 (speed wave, item 6): a pool's page opened from Home or
 * Markets asked again what they had just read. A single pool's overview is now
 * cut from the table's overview of at most OVERVIEW_SLICE_MS ago, once per
 * pool and table answer, with its tokens and the answer's acquisitionAccepted
 * (then the page's own reads go to the service as before); and a 24h history
 * a Markets card read is the pool chart's own identical question, answered for
 * HISTORY_REUSE_MS. Both keep the answer's own provenance, so every figure is
 * dated as it was read, and the chart asks again on that answer's rhythm
 * (historyRead.ts), so nothing turns stale sooner on screen. Measured with the
 * study's latencies, a pool opened from Markets: activity 3.2 s to 0.8 s.
 */
import { realClock, type Clock } from './pipeline'
import { storedTokenRead } from './publicOverview'
import type { ReadOptions, ReadOutcome, ReadRequests, ReadRoute, ReadSource } from './types'

export const TOKEN_METADATA_CACHE_MS = 300_000
/** How long the table's overview answers a question about one of its pools. */
export const OVERVIEW_SLICE_MS = 30_000
/** How long a 24h history answers the identical question. Short of the chart's 120 s rule for a stale snapshot. */
export const HISTORY_REUSE_MS = 30_000
const MAX_TOKENS = 256
type TokenRead = Extract<ReadOutcome<'token'>, { state: 'ok' }>
type OverviewRead = Extract<ReadOutcome<'overview'>, { state: 'ok' }>
type HistoryRead = Extract<ReadOutcome<'history'>, { state: 'ok' }>

/** The one pool a request `{ poolIds: [id] }` asks about, lowercase; null for any other request. */
function onePool(request: unknown): string | null {
  if (request === null || typeof request !== 'object' || Object.keys(request).join() !== 'poolIds') return null
  const ids = (request as { poolIds: unknown }).poolIds
  return Array.isArray(ids) && ids.length === 1 && typeof ids[0] === 'string' ? ids[0].toLowerCase() : null
}

/** A table's overview cut to one of its pools, with that pool's tokens; null when it does not name the pool. */
function sliceOf(outcome: OverviewRead, poolId: string): OverviewRead | null {
  const entry = outcome.data.pools.find((pool) => pool.poolId.toLowerCase() === poolId)
  if (!entry) return null
  const currencies = new Set((entry.value?.market.pool.currencies ?? []).map((currency) => currency.toLowerCase()))
  return { ...outcome, data: { ...outcome.data, requestedPoolIds: [entry.poolId], pools: [entry], tokens: outcome.data.tokens.filter((token) => currencies.has(token.address.toLowerCase())), hasMore: false, nextAfterPoolId: null } }
}

export function createPublicMetadataCache(source: ReadSource, clock: Clock = realClock): ReadSource {
  const tokens = new Map<string, { outcome: TokenRead; expires: number }>()
  // A pool page following an overview joins its just-read bundle; this
  // two-second reuse never replaces the ten-second visible revalidation.
  const overviews = new Map<string, { outcome: OverviewRead; expires: number }>()
  /** The last overview of several pools (the table's), and the pools already cut from it. */
  let wide: { outcome: OverviewRead; expires: number; cut: Set<string> } | null = null
  const histories = new Map<string, { outcome: HistoryRead; expires: number }>()
  return {
    transport: source.transport,
    ...(source.supportsStoredReads ? { supportsStoredReads: true as const } : {}),
    ...(source.routeEnabled ? { routeEnabled: source.routeEnabled.bind(source) } : {}),
    async read<R extends ReadRoute>(route: R, request: ReadRequests[R], options: ReadOptions = {}): Promise<ReadOutcome<R>> {
      // Canonicalize only the complete, exact public-token request. Invalid
      // envelopes still reach the normal validator; private routes never cache.
      const token = route === 'token' && request !== null && typeof request === 'object' && Object.keys(request).length === 1 && 'token' in request &&
        typeof request.token === 'string' && /^0x[0-9a-fA-F]{40}$/.test(request.token) ? request.token.toLowerCase() : null
      const now = clock.monotonic()
      const stopped = options.signal?.aborted || (options.deadlineAt !== undefined && now >= options.deadlineAt)
      const overviewKey = route === 'overview' ? JSON.stringify(request) : null
      const historyKey = route === 'history' ? JSON.stringify(request) : null
      const cached = token ? tokens.get(token) : overviewKey ? overviews.get(overviewKey) : historyKey ? histories.get(historyKey) : undefined
      const again = <T extends ReadOutcome>(outcome: T) => ({ ...outcome, provenance: { ...outcome.provenance, deadlineAt: options.deadlineAt, attempts: 0 } }) as unknown as ReadOutcome<R>
      if (!stopped && cached && now < cached.expires) {
        if (token) { tokens.delete(token); tokens.set(token, cached as { outcome: TokenRead; expires: number }) }
        return again(cached.outcome)
      }
      // One pool of the table's overview, once for each pool and answer: the page's own later reads go to the service.
      const one = overviewKey ? onePool(request) : null
      if (!stopped && one && wide && now < wide.expires && !wide.cut.has(one)) {
        const slice = sliceOf(wide.outcome, one)
        if (slice) {
          wide.cut.add(one)
          overviews.set(overviewKey!, { outcome: slice, expires: now + 2000 })
          return again(slice)
        }
      }
      if (token) tokens.delete(token)
      const outcome = await source.read(route, token ? { token } as ReadRequests[R] : request, options)
      if (['gate_required', 'gate_unavailable', 'access_required', 'not_connected', 'disabled', 'incompatible'].includes(outcome.state)) {
        tokens.clear(); overviews.clear(); histories.clear(); wide = null
      }
      if (token && outcome.state === 'ok' && !options.signal?.aborted) {
        const read = outcome as TokenRead
        if (read.data.asset.readStatus === 'available') {
          const observed = read.provenance.receivedMonotonic
          // A wrapped source returning an old observation cannot renew it.
          const age = observed === undefined ? Math.max(0, clock.now() - read.provenance.receivedAt) : Math.max(0, clock.monotonic() - observed)
          if (age < TOKEN_METADATA_CACHE_MS) tokens.set(token, { outcome: read, expires: clock.monotonic() + TOKEN_METADATA_CACHE_MS - age })
          while (tokens.size > MAX_TOKENS) tokens.delete(tokens.keys().next().value!)
        }
      }
      if (route === 'overview' && outcome.state === 'ok' && !options.signal?.aborted) {
        const overview = outcome as Extract<ReadOutcome<'overview'>, { state: 'ok' }>
        overviews.delete(overviewKey!)
        overviews.set(overviewKey!, { outcome: overview, expires: clock.monotonic() + 2000 })
        while (overviews.size > 32) overviews.delete(overviews.keys().next().value!)
        if (overview.data.pools.length > 1) wide = { outcome: overview, expires: clock.monotonic() + OVERVIEW_SLICE_MS, cut: new Set() }
        for (const entry of overview.data.tokens) {
          const read = storedTokenRead(entry, overview.data.generatedAt, overview.provenance)
          if (!read || read.data.asset.readStatus !== 'available') continue
          const age = Math.max(0, overview.data.generatedAt - entry.observedAt!) * 1000
          if (age < TOKEN_METADATA_CACHE_MS) tokens.set(entry.address, { outcome: read, expires: clock.monotonic() + TOKEN_METADATA_CACHE_MS - age })
        }
        while (tokens.size > MAX_TOKENS) tokens.delete(tokens.keys().next().value!)
      }
      if (route === 'history' && outcome.state === 'ok' && !options.signal?.aborted) {
        histories.delete(historyKey!)
        histories.set(historyKey!, { outcome: outcome as HistoryRead, expires: clock.monotonic() + HISTORY_REUSE_MS })
        while (histories.size > 32) histories.delete(histories.keys().next().value!)
      }
      return outcome
    },
  }
}
