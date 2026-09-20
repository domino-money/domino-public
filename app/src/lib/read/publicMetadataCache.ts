/** Public token metadata already validated by the read source, reused across
 * screens for five minutes at most. This cache contains no wallet, balance,
 * session or transaction data and never refreshes an observation's timestamp.
 * The shared scheduler remains responsible for in-flight deduplication.
 */
import { realClock, type Clock } from './pipeline'
import { storedTokenRead } from './publicOverview'
import type { ReadOptions, ReadOutcome, ReadRequests, ReadRoute, ReadSource } from './types'

export const TOKEN_METADATA_CACHE_MS = 300_000
const MAX_TOKENS = 256
type TokenRead = Extract<ReadOutcome<'token'>, { state: 'ok' }>
type OverviewRead = Extract<ReadOutcome<'overview'>, { state: 'ok' }>

export function createPublicMetadataCache(source: ReadSource, clock: Clock = realClock): ReadSource {
  const tokens = new Map<string, { outcome: TokenRead; expires: number }>()
  // A pool page following an overview joins its just-read bundle; this
  // two-second reuse never replaces the ten-second visible revalidation.
  const overviews = new Map<string, { outcome: OverviewRead; expires: number }>()
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
      const cached = token ? tokens.get(token) : overviewKey ? overviews.get(overviewKey) : undefined
      if (!stopped && cached && now < cached.expires) {
        if (token) { tokens.delete(token); tokens.set(token, cached as { outcome: TokenRead; expires: number }) }
        return { ...cached.outcome, provenance: { ...cached.outcome.provenance, deadlineAt: options.deadlineAt, attempts: 0 } } as ReadOutcome<R>
      }
      if (token) tokens.delete(token)
      const outcome = await source.read(route, token ? { token } as ReadRequests[R] : request, options)
      if (['gate_required', 'gate_unavailable', 'access_required', 'not_connected', 'disabled', 'incompatible'].includes(outcome.state)) { tokens.clear(); overviews.clear() }
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
        for (const entry of overview.data.tokens) {
          const read = storedTokenRead(entry, overview.data.generatedAt, overview.provenance)
          if (!read || read.data.asset.readStatus !== 'available') continue
          const age = Math.max(0, overview.data.generatedAt - entry.observedAt!) * 1000
          if (age < TOKEN_METADATA_CACHE_MS) tokens.set(entry.address, { outcome: read, expires: clock.monotonic() + TOKEN_METADATA_CACHE_MS - age })
        }
        while (tokens.size > MAX_TOKENS) tokens.delete(tokens.keys().next().value!)
      }
      return outcome
    },
  }
}
