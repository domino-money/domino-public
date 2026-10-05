/**
 * What an S1 plan's swaps must deliver, tied to what the person asked for (the plan request), checked twice: on the plan
 * answer (./parse.ts, after the package's validator) and again by the closed money client (finance/v2/plan.ts checkPlan)
 * before any consent. Added on purpose (data) 2026-10-02 (Domino V2 rev2 review, finding F1): the package's request
 * match covers the pool, the ticks, the inputs, the liquidity and the burn, but not `receive`, and no check tied a leg's
 * OUTPUT to the request, so a converted exit could route the withdrawn token into a token nobody asked for.
 *
 * The rules (spec F7 rev2 §2.3, §2.6, §2.7, §2.8 "input / output / hop"):
 *   - a leg spends only what the zap holds at that point: the request's inputs (create, increase), the pool's currencies
 *     (what a removal pays, and the position's own tokens), or what an EARLIER leg delivered;
 *   - every leg's output is either a hop (a LATER leg spends it) or the final token the request names:
 *       exit converted         the token asked for (`receive.token`);
 *       exit to both tokens    no leg at all (§2.6.4: `legs = []`);
 *       create, increase,      one of the pool's two currencies; on a v3 pool with WETH, native ETH folds into WETH
 *       change range           (§2.7: the zap wraps it before the mint, wrapping is never a leg).
 *
 * Pure: no viem, no wallet.
 */
import { ZERO_ADDRESS, type Address, type PoolRef } from '../types'
import type { S1PlanRequest } from './types'

/** What the person asked a plan for: the action and, per action, what it puts in or what it takes out as. */
export type PlanTarget =
  | { readonly action: 'create' | 'increase'; readonly inputs: readonly { readonly token: Address; readonly amount: bigint }[] }
  | { readonly action: 'changeRange' }
  | { readonly action: 'exit'; readonly receive: 'both' | { readonly convertTo: Address } }

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The target of a plan request (null when the request names no valid target for its action). */
export function planTargetOf(request: S1PlanRequest): PlanTarget | null {
  switch (request.action) {
    case 'create':
    case 'increase':
      return request.inputs ? { action: request.action, inputs: request.inputs.map((input) => ({ token: input.token.toLowerCase() as Address, amount: input.amount })) } : null
    case 'changeRange':
      return { action: 'changeRange' }
    case 'exit': {
      const receive = request.receive
      if (receive === 'both') return { action: 'exit', receive: 'both' }
      return receive && typeof receive === 'object' ? { action: 'exit', receive: { convertTo: receive.convertTo.toLowerCase() as Address } } : null
    }
    default:
      return null
  }
}

/**
 * The route's problems against the target (closed codes, the screen words them):
 *   - `plan_route_source`: a leg spends a token the zap does not hold at that point;
 *   - `plan_route_target`: a leg delivers a token that is neither spent by a later leg nor what the request names, or an
 *     exit to both tokens carries a leg.
 * `wrappedNative` is the chain profile's WETH (for §2.7's folding on v3 pools).
 */
export function routeProblems(
  legs: readonly { readonly tokenIn: string; readonly tokenOut: string }[],
  target: PlanTarget,
  pool: { readonly dex: PoolRef['dex']; readonly currency0: string; readonly currency1: string },
  wrappedNative: Address,
): string[] {
  const problems = new Set<string>()
  if (target.action === 'exit' && target.receive === 'both') {
    if (legs.length > 0) problems.add('plan_route_target')
    return [...problems]
  }
  const poolCurrency = (token: string) => same(token, pool.currency0) || same(token, pool.currency1)
  // §2.7: on a v3 pool with WETH, ETH that reaches the mint is wrapped first, so it counts as WETH there.
  const wraps = pool.dex === 3 && (same(pool.currency0, wrappedNative) || same(pool.currency1, wrappedNative))
  const mints = target.action === 'create' || target.action === 'increase' || target.action === 'changeRange'
  const finalOk = (token: string) => (mints ? poolCurrency(token) || (wraps && same(token, ZERO_ADDRESS)) : target.action === 'exit' && target.receive !== 'both' && same(token, target.receive.convertTo))
  const requested = target.action === 'create' || target.action === 'increase' ? target.inputs.map((input) => input.token) : []
  legs.forEach((leg, i) => {
    const earlier = legs.slice(0, i).some((other) => same(other.tokenOut, leg.tokenIn))
    if (!requested.some((token) => same(token, leg.tokenIn)) && !poolCurrency(leg.tokenIn) && !earlier) problems.add('plan_route_source')
    const later = legs.slice(i + 1).some((other) => same(other.tokenIn, leg.tokenOut))
    if (!later && !finalOk(leg.tokenOut)) problems.add('plan_route_target')
  })
  return [...problems]
}
