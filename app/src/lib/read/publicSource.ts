/** Additive stored reads use their own capability and exact contract while
 * sharing the app's one paced scheduler with V1/V2. A failed data POST never
 * silently becomes a second provider request in another namespace. */
import type * as V3 from 'api-contracts/read-v3/runtime.mjs'
import type { ReadV3Route } from 'api-contracts/read-v3/types'
import { createBridgeSource, type BridgeOptions } from './bridgeSource'
import type { ReadSource, ReadRoute, ReadValidators } from './types'

const stored = (route: ReadRoute): route is ReadV3Route => route === 'overview' || route === 'history' || route === 'search'

export function createPublicSource(legacy: ReadSource, options: BridgeOptions, runtime: typeof V3): ReadSource {
  const source = createBridgeSource({ ...options, namespace: 'v3', validators: runtime as unknown as ReadValidators })
  return {
    transport: legacy.transport,
    supportsStoredReads: true,
    read: (route, request, opts) => stored(route) ? source.read(route, request, opts) : legacy.read(route, request, opts),
    routeEnabled: async (route, opts) => {
      if (!stored(route)) return legacy.routeEnabled?.(route, opts) ?? { state: 'not_enabled' }
      const check = await source.routeEnabled(route, opts)
      // Older deployments omit the namespace. Only an absent/disabled
      // capability allows the existing V1/V2 path; gate errors stay failures.
      if (check.state === 'failed' && (check.outcome.state === 'disabled' || check.outcome.state === 'not_connected')) return { state: 'not_enabled' }
      return check
    },
  }
}
