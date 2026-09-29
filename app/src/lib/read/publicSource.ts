/** Additive stored reads use their own capability and exact contract while
 * sharing the app's one paced scheduler with V1/V2. A failed data POST never
 * silently becomes a second provider request in another namespace. */
import type * as V3 from 'api-contracts/read-v3/runtime.mjs'
import type { ReadV3Route } from 'api-contracts/read-v3/types'
import { createBridgeSource, type BridgeOptions } from './bridgeSource'
import { isTransient } from './screens/transient'
import type { ReadSource, ReadRoute, ReadValidators } from './types'

const stored = (route: ReadRoute): route is ReadV3Route => route === 'overview' || route === 'history' || route === 'search'

/** The only failures a fallback must not paper over: the person has to sign in. */
const GATE = new Set(['gate_required', 'gate_unavailable', 'access_required'])

/**
 * How many times a read-v3 capabilities check that failed in passing is asked again at once (speed wave, item 3,
 * 2026-09-28). The Worker answers it itself, in about a tenth of a second.
 */
export const CHECK_AGAIN = 2

export function createPublicSource(legacy: ReadSource, options: BridgeOptions, runtime: typeof V3): ReadSource {
  const source = createBridgeSource({ ...options, namespace: 'v3', validators: runtime as unknown as ReadValidators })
  return {
    transport: legacy.transport,
    supportsStoredReads: true,
    read: (route, request, opts) => stored(route) ? source.read(route, request, opts) : legacy.read(route, request, opts),
    routeEnabled: async (route, opts) => {
      if (!stored(route)) return legacy.routeEnabled?.(route, opts) ?? { state: 'not_enabled' }
      let check = await source.routeEnabled(route, opts)
      // A failure that can pass by itself (an edge error page, a dropped connection, a hop that refused the answer) is
      // asked again at once, twice at most: a failed answer is never kept (bridgeSource.ts), so each is a new GET.
      for (let again = 0; again < CHECK_AGAIN && check.state === 'failed' && isTransient(check.outcome); again += 1) {
        check = await source.routeEnabled(route, opts)
      }
      // This check asks one question: can THIS deployment serve read-v3? An
      // answer that says no sends the page to V1/V2, a complete read path that
      // can carry it, instead of the page dying whole.
      //
      // Narrowing this to disabled/not_connected was not enough. A reader that
      // simply has no /internal/read/v3 route answers 404 with an empty body;
      // the bridge calls that invalid, `invalid` is a blocking outcome, and the
      // markets table stops with no rows and no retry while every V1 and V2 read
      // beside it answers 200. Seen 2026-09-20 against the development reader.
      // Such an answer still sends the page to V1/V2, as does any other final one.
      //
      // Gate states are the exception and stay failures: the way out of those is
      // signing in, not reading the same data somewhere else. Changed on purpose
      // 2026-09-28 (speed wave, item 3): so is a failure that can still pass by
      // itself after the checks above. One edge page sent Home's table down the
      // older path, one provider read per pool (4.9 s each), 10 to 38 s instead
      // of about 1 s, through the same edge. The screens ask such a failure
      // again on their own (marketsProvider.ts FAILED_RETRY_MS, PoolDetail.tsx,
      // historyRead.ts, cardReads.ts).
      if (check.state === 'failed' && !GATE.has(check.outcome.state) && check.outcome.state !== 'aborted' && !isTransient(check.outcome)) return { state: 'not_enabled' }
      return check
    },
  }
}
