/** Optional read-v2 inside the existing scheduler. It replaces a lean market
 * read; it never appends an APR fetch to one. Charts remain explicit v1 reads.
 * Only a capabilities refusal permits fallback, before any v2 data POST.
 *
 * A reply whose estimate this build's runtime refuses keeps its market figures
 * only when they stand on their own. The envelope must be read-v2's in every
 * other respect (schemaVersion 1, executionAvailable false, an estimate
 * object, and no key but schemaVersion, chainId, poolId, market, estimate and
 * executionAvailable), and the market must pass the read-v1 contract for the
 * same pool and chain; then the row keeps them, without an estimate and with
 * `estimate_contract_mismatch`. This is what a read service one release behind
 * or ahead of this build sends. Anything else about the reply that fails
 * (identity, envelope, market) stays invalid, and no second read is sent.
 *
 * A stored market read (`fromSnapshot: true`) is a read-v1 question about the
 * read service's own snapshot, which keeps no estimate: it goes to v1 exactly
 * as asked, never widened into a full v2 read, and its answer is the answer.
 * When the store holds nothing for the pool (503 `snapshot_not_built`, for any
 * pool the store lacks, not only an empty store), that failure goes back to
 * the caller, whose own lean read follows through the paced queue. A normal
 * read sent from inside this job would leave with no gap after the stored one,
 * and the gateway refuses a provider start within 1 s of the last. */
import type * as V2 from 'api-contracts/read-v2/runtime.mjs'
import type { PoolMarketEstimateResponse } from 'api-contracts/read-v2/types'
import { CAPABILITIES_REUSE_MS, createBridgeSource, type BridgeOptions, type BridgeSource } from './bridgeSource'
import { BRIDGE_RETRY, realClock } from './pipeline'
import type { ReadOptions, ReadOutcome, ReadRequests, ReadResponses, ReadRoute, ReadValidators } from './types'

const sameId = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

/** Every key of a read-v2 pool-market reply, and nothing else. */
const ESTIMATE_REPLY_KEYS = ['chainId', 'estimate', 'executionAvailable', 'market', 'poolId', 'schemaVersion'] as const

/**
 * Whether a refused reply is read-v2's envelope in every respect but its
 * estimate's contents: the version and execution flag the contract fixes, an
 * estimate object, and exactly the contract's keys. Only such a reply may
 * give its market figures without its estimate.
 */
function estimateEnvelope(reply: unknown): reply is Record<(typeof ESTIMATE_REPLY_KEYS)[number], unknown> {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return false
  const keys = Object.keys(reply).sort()
  if (keys.length !== ESTIMATE_REPLY_KEYS.length || keys.some((key, index) => key !== ESTIMATE_REPLY_KEYS[index])) return false
  const envelope = reply as Record<string, unknown>
  const estimate = envelope.estimate
  return envelope.schemaVersion === 1 && envelope.executionAvailable === false && typeof estimate === 'object' && estimate !== null && !Array.isArray(estimate)
}

/**
 * The v2 validators. `market` is read-v1's validators: with them, a reply
 * whose estimate the v2 runtime refuses can still give its market figures
 * (see the header). Such a reply carries no estimate.
 */
export function estimateValidators(runtime: typeof V2, market?: ReadValidators): ReadValidators {
  const estimateRefused = new WeakSet<object>()
  return {
    CONTRACT_VERSION: runtime.CONTRACT_VERSION,
    ERROR_STATUS_BY_CODE: runtime.ERROR_STATUS_BY_CODE,
    validateError: runtime.validateError,
    validateRequest: <R extends ReadRoute>(route: R, body: unknown): body is ReadRequests[R] =>
      route === 'pool-market' && runtime.validateRequest('pool-market', body),
    assertResponse: <R extends keyof ReadResponses>(route: R, body: unknown): ReadResponses[R] => {
      if (route === 'capabilities') return runtime.assertResponse('capabilities', body) as ReadResponses[R]
      if (route !== 'pool-market') throw new TypeError('unsupported_estimate_route')
      try {
        return runtime.assertResponse('pool-market', body).market as ReadResponses[R]
      } catch (refused) {
        if (!market || !estimateEnvelope(body)) throw refused
        // Throws in turn when the market part is not a read-v1 pool-market on its own.
        const figures = market.assertResponse('pool-market', body.market)
        if (!sameId(body.poolId, figures.poolId) || body.chainId !== figures.chainId) throw refused
        estimateRefused.add(body)
        return figures as ReadResponses[R]
      }
    },
    poolAprEstimate: (body) => (estimateRefused.has(body as object) ? undefined : (body as PoolMarketEstimateResponse).estimate),
  }
}

export function createEstimateSource(options: BridgeOptions, runtime: typeof V2): BridgeSource {
  const v1 = createBridgeSource(options)
  const v2 = createBridgeSource({ ...options, namespace: 'v2', validators: estimateValidators(runtime, options.validators) })
  const clock = options.clock ?? realClock
  let fallback: 'estimate_not_enabled' | 'estimate_transport_unavailable' | null = null
  let fallbackUntil = 0

  async function read<R extends ReadRoute>(route: R, request: ReadRequests[R], opts: ReadOptions = {}): Promise<ReadOutcome<R>> {
    if (!options.validators.validateRequest(route, request)) return v1.read(route, request, opts)
    if (route !== 'pool-market' || (request as ReadRequests['pool-market']).includePriceHistory) return v1.read(route, request, opts)
    const market = request as ReadRequests['pool-market']
    const budget = { ...opts, deadlineAt: opts.deadlineAt ?? clock.monotonic() + (options.policy ?? BRIDGE_RETRY).totalMs }
    if (market.fromSnapshot) {
      // One read, and its answer, snapshot_not_built included: the caller's own paced read follows (see the header).
      const stored = await v1.read('pool-market', market, budget)
      return (stored.state === 'ok' ? { ...stored, estimateReason: 'estimate_not_in_snapshot' } : stored) as ReadOutcome<R>
    }
    if (fallback && clock.monotonic() >= fallbackUntil) fallback = null
    if (!fallback) {
      let dispatched = false
      const result = await v2.read('pool-market', { poolId: market.poolId.toLowerCase() }, {
        ...budget, onAttempt: () => { dispatched = true; opts.onAttempt?.() },
      })
      // A v2 reply always carries its estimate: an ok read without one is a refused estimate (see the header).
      if (result.state === 'ok' && result.estimate === undefined) return { ...result, estimateReason: 'estimate_contract_mismatch' } as ReadOutcome<R>
      if (dispatched || !['disabled', 'not_connected', 'unavailable'].includes(result.state) ||
        (result.state === 'disabled' && result.reason === 'live_data_disabled') ||
        (result.state === 'unavailable' && result.cause.kind === 'read_deadline')) return result as ReadOutcome<R>
      fallback = result.state === 'disabled' ? 'estimate_not_enabled' : 'estimate_transport_unavailable'
      fallbackUntil = clock.monotonic() + CAPABILITIES_REUSE_MS
    }
    // At most one optional namespace probe a minute when absent. A later read
    // discovers an enabled deployment without reload; data failures never trigger v1.
    const result = await v1.read(route, request, budget)
    return result.state === 'ok' ? { ...result, estimateReason: fallback } : result
  }

  return {
    transport: 'bridge',
    read,
    // Which reads a page may send is read-v1's answer; the estimate namespace only ever replaces a lean market read.
    routeEnabled: (route, opts) => v1.routeEnabled(route, opts),
  }
}
