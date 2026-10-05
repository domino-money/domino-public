import { livePlanTransport as sitePlanTransport } from '../../finance/v2/http'
import { v2Chain } from '../../v2/chains'
import { v2Gate, type V2Gate } from '../../v2/gate'
import { v2PageProbe } from '../transports'
import { POSITION_PLAN_RUNTIME } from '../../v2/plan/contract'
import type { S1PlanContext, S1PlanTransport, S1PlanValidators } from '../../v2/plan/types'
import type { Address, V2ChainId, V2Contracts } from '../../v2/types'

/**
 * Where New position's zap path gets its gate and its plans: this area's ONE adapter, so swapping in a shared helper is a
 * change here only.
 *
 *   - gates: src/v2/gate.ts `v2Gate('s1', chain)` for the three networks (`off` / `preview` / `live`; in TEST builds the
 *     gate itself reads `window.__dominoV2Test.{originOpen, contracts, backendOn}`).
 *   - plans: under `preview`, none at all (real data only: the owner, 2026-10-02 night; ./run.ts shows what was chosen and
 *     the gate's sentence); under `live`, the plan service over http, the site's own route with the signed-in session's
 *     CSRF (src/finance/v2/http.ts livePlanTransport, as the position's actions get it through ../transports; Changed on
 *     purpose 2026-10-04: it was never wired here, so a live New position could never get a plan), and in a TEST build
 *     the browser suite's planner standing in for it (`window.__dominoV2Test.s1.plan`).
 *   - the package's validators (src/v2/plan/contract.ts): every answer passes `validateResponse`, then the app's checks.
 */
export type JourneyGates = Readonly<Record<V2ChainId, V2Gate>>

const CHAINS: readonly V2ChainId[] = [4663, 8453, 42161]

/** The S1 gate of every network at the page's origin. */
export async function journeyGates(): Promise<JourneyGates> {
  const gates = await Promise.all(CHAINS.map((chainId) => v2Gate('s1', chainId, undefined, v2PageProbe)))
  return Object.freeze({ 4663: gates[0], 8453: gates[1], 42161: gates[2] })
}

export const planRuntime: S1PlanValidators = POSITION_PLAN_RUNTIME

// The browser suites' planner, in TEST builds only (the define folds every other build's branch away).
declare const __DOMINO_TEST_HOOKS__: boolean | undefined
const TEST_HOOKS: boolean = typeof __DOMINO_TEST_HOOKS__ === 'boolean' && __DOMINO_TEST_HOOKS__
type Planner = (request: Record<string, unknown>) => unknown
function testPlanner(): Planner | null {
  if (!TEST_HOOKS || typeof window === 'undefined') return null
  const hooks = (window as unknown as { __dominoV2Test?: { s1?: { plan?: unknown } } }).__dominoV2Test
  const plan = hooks?.s1?.plan
  return typeof plan === 'function' ? (plan as Planner) : null
}

/** `{ status, body }` as scripted, or a bare body as a 200. */
const isExchange = (value: unknown): value is { status: number; body: unknown } =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 2 && typeof (value as { status?: unknown }).status === 'number' && 'body' in value

/** A transport over a responder: undefined from it is "not answered", which the plan client says as unavailable. */
function responderTransport(answer: (request: Record<string, unknown>) => unknown | Promise<unknown>): S1PlanTransport {
  return {
    kind: 'http',
    async plan(request) {
      const reply = await answer(structuredClone(request))
      if (reply === undefined) throw new Error('plan_not_answered')
      return structuredClone(isExchange(reply) ? reply : { status: 200, body: reply })
    },
  }
}

/** The `live` gate's plan transport: in a test build the suite's planner, else the plan service over the site's route. */
export function livePlanTransport(): S1PlanTransport | null {
  const planner = testPlanner()
  if (planner) return responderTransport(planner)
  return sitePlanTransport()
}

/** What a `live` answer is held to: the connected wallet, the gate's pinned zaps, the profile's Permit2 and Uniswap managers. */
export function liveContext(chainId: V2ChainId, owner: Address, contracts: V2Contracts): Omit<S1PlanContext, 'now'> {
  const chain = v2Chain(chainId)
  return {
    owner,
    zaps: { 3: contracts.addresses.zapV3.toLowerCase() as Address, 4: contracts.addresses.zapV4.toLowerCase() as Address },
    permit2: chain.permit2,
    managers: { 3: chain.uniswap.v3.positionManager, 4: chain.uniswap.v4.positionManager },
  }
}
