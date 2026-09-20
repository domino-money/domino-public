/** Additive stored reads use their own capability and exact contract while
 * sharing the app's one paced scheduler with V1/V2. A failed data POST never
 * silently becomes a second provider request in another namespace. */
import type * as V3 from 'api-contracts/read-v3/runtime.mjs'
import type { ReadV3Route } from 'api-contracts/read-v3/types'
import { createBridgeSource, type BridgeOptions } from './bridgeSource'
import type { ReadSource, ReadRoute, ReadValidators } from './types'

const stored = (route: ReadRoute): route is ReadV3Route => route === 'overview' || route === 'history' || route === 'search'

/** The only failures a fallback must not paper over: the person has to sign in. */
const GATE = new Set(['gate_required', 'gate_unavailable', 'access_required'])

export function createPublicSource(legacy: ReadSource, options: BridgeOptions, runtime: typeof V3): ReadSource {
  const source = createBridgeSource({ ...options, namespace: 'v3', validators: runtime as unknown as ReadValidators })
  return {
    transport: legacy.transport,
    supportsStoredReads: true,
    read: (route, request, opts) => stored(route) ? source.read(route, request, opts) : legacy.read(route, request, opts),
    routeEnabled: async (route, opts) => {
      if (!stored(route)) return legacy.routeEnabled?.(route, opts) ?? { state: 'not_enabled' }
      const check = await source.routeEnabled(route, opts)
      // This check asks one question: can THIS deployment serve read-v3? Any
      // answer but a gate one means no, and V1/V2 is a complete read path that
      // can carry the page — so it does, instead of the page dying whole.
      //
      // Narrowing this to disabled/not_connected was not enough. A reader that
      // simply has no /internal/read/v3 route answers 404 with an empty body;
      // the bridge calls that invalid, `invalid` is a blocking outcome, and the
      // markets table stops with no rows and no retry while every V1 and V2 read
      // beside it answers 200. Seen 2026-09-20 against the development reader.
      //
      // Gate states are the exception and stay failures: the way out of those is
      // signing in, not reading the same data somewhere else.
      if (check.state === 'failed' && !GATE.has(check.outcome.state)) return { state: 'not_enabled' }
      return check
    },
  }
}
