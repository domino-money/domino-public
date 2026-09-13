/** Optional read-v2 inside the existing scheduler. It replaces a lean market
 * read; it never appends an APR fetch to one. Charts remain explicit v1 reads.
 * Only a capabilities refusal permits fallback, before any v2 data POST. */
import type * as V2 from 'api-contracts/read-v2/runtime.mjs'
import type { PoolMarketEstimateResponse } from 'api-contracts/read-v2/types'
import { createBridgeSource, type BridgeOptions } from './bridgeSource'
import { BRIDGE_RETRY, realClock } from './pipeline'
import type { ReadOptions, ReadOutcome, ReadRequests, ReadResponses, ReadRoute, ReadSource, ReadValidators } from './types'

export function estimateValidators(runtime: typeof V2): ReadValidators {
  return {
    CONTRACT_VERSION: runtime.CONTRACT_VERSION,
    ERROR_STATUS_BY_CODE: runtime.ERROR_STATUS_BY_CODE,
    validateError: runtime.validateError,
    validateRequest: <R extends ReadRoute>(route: R, body: unknown): body is ReadRequests[R] =>
      route === 'pool-market' && runtime.validateRequest('pool-market', body),
    assertResponse: <R extends keyof ReadResponses>(route: R, body: unknown): ReadResponses[R] => {
      if (route === 'capabilities') return runtime.assertResponse('capabilities', body) as ReadResponses[R]
      if (route === 'pool-market') return runtime.assertResponse('pool-market', body).market as ReadResponses[R]
      throw new TypeError('unsupported_estimate_route')
    },
    poolAprEstimate: (body) => (body as PoolMarketEstimateResponse).estimate,
  }
}

export function createEstimateSource(options: BridgeOptions, runtime: typeof V2): ReadSource {
  const v1 = createBridgeSource(options)
  const v2 = createBridgeSource({ ...options, namespace: 'v2', validators: estimateValidators(runtime) })
  const clock = options.clock ?? realClock
  let fallback: 'estimate_not_enabled' | 'estimate_transport_unavailable' | null = null
  return {
    transport: 'bridge',
    async read<R extends ReadRoute>(route: R, request: ReadRequests[R], opts: ReadOptions = {}): Promise<ReadOutcome<R>> {
      if (!options.validators.validateRequest(route, request)) return v1.read(route, request, opts)
      if (route !== 'pool-market' || (request as ReadRequests['pool-market']).includePriceHistory) return v1.read(route, request, opts)
      const budget = { ...opts, deadlineAt: opts.deadlineAt ?? clock.monotonic() + (options.policy ?? BRIDGE_RETRY).totalMs }
      if (!fallback) {
        let dispatched = false
        const result = await v2.read('pool-market', { poolId: (request as ReadRequests['pool-market']).poolId.toLowerCase() }, {
          ...budget, onAttempt: () => { dispatched = true; opts.onAttempt?.() },
        })
        if (dispatched || !['disabled', 'not_connected', 'unavailable'].includes(result.state) ||
          (result.state === 'disabled' && result.reason === 'live_data_disabled') ||
          (result.state === 'unavailable' && result.cause.kind === 'read_deadline')) return result as ReadOutcome<R>
        fallback = result.state === 'disabled' ? 'estimate_not_enabled' : 'estimate_transport_unavailable'
      }
      // One optional namespace probe per page when absent. Reload can discover
      // a newly enabled deployment; transient data failures never trigger v1.
      const result = await v1.read(route, request, budget)
      return result.state === 'ok' ? { ...result, estimateReason: fallback } : result
    },
  }
}
