import type { DepositPlan } from '../../../lib/create/depositPlan'
import type { JourneyState as V1JourneyState } from '../../../lib/create/journey'
import { slippageBpsFrom } from '../../../lib/create/slippage'
import type { S1PlanConsent, S1PlanRequest } from '../../../v2/plan/types'
import type { Address } from '../../../v2/types'
import { poolFromList } from './pools'
import { rangeCheckOn, type JourneyState } from './state'

/**
 * The owner's New position (2026-10-05: his journey's screens, components/create/Journey.tsx, with Domino V2 connected
 * behind them): what his journey chose, read for the zap path's plan and review. Pure.
 *
 *   - zapStateFromV1: the pool (V1's verified PoolOption, poolFromList's v4 hookless fixed-fee JourneyPool), the range and
 *     the slippage exactly as chosen; Robinhood Chain; no starting price (V1 lists only pools with one);
 *   - inputsFromV1: what the wallet puts in, from V1's own funding of the deposit (lib/create/reviewPlan.ts, the same
 *     reading its Review draws from): both of the pool's tokens at the amounts the amount step showed, or the one token the
 *     wallet holds, all of it, for the planner to swap in; short says which token lacks and by how much; wait while the
 *     wallet's balances are not read;
 *   - requestFromV1: the create request (position-plan-v1) for one consent.
 */
export function zapStateFromV1(state: Pick<V1JourneyState, 'pool' | 'range' | 'slippageBps'>): JourneyState | null {
  const option = state.pool
  if (!option || !state.range) return null
  const pool = poolFromList({ ...option, currencies: option.currencies, readAt: option.readAt })
  if (!pool) return null
  return { chainId: 4663, pool, start: null, range: state.range, amounts: { mode: 'pool', other: null, text: {} }, slippage: state.slippageBps, step: 'review', furthest: 'review' }
}

export type V1Funding =
  | { kind: 'wait' }
  | { kind: 'short'; token: Address; have: bigint; need: bigint }
  | { kind: 'inputs'; inputs: readonly { token: Address; amount: bigint }[] }

export function inputsFromV1(zap: JourneyState | null, planned: { need: readonly [bigint, bigint]; plan: DepositPlan | null } | null): V1Funding {
  const plan = planned?.plan ?? null
  if (!zap?.pool || !planned || !plan) return { kind: 'wait' }
  const currencies: readonly [Address, Address] = [zap.pool.pool.currency0, zap.pool.pool.currency1]
  if (plan.kind === 'short') return { kind: 'short', token: currencies[plan.token], have: plan.have, need: plan.need }
  const pairs: readonly (readonly [Address, bigint])[] =
    plan.kind === 'both' ? [[currencies[0], planned.need[0]], [currencies[1], planned.need[1]]] : [[currencies[plan.from], plan.deposit]]
  const inputs = pairs.filter(([, amount]) => amount > 0n).map(([token, amount]) => ({ token, amount }))
  return inputs.length > 0 ? { kind: 'inputs', inputs } : { kind: 'wait' }
}

export function requestFromV1(zap: JourneyState | null, funding: V1Funding, consent: S1PlanConsent): S1PlanRequest | null {
  if (!zap?.pool || !zap.range || funding.kind !== 'inputs' || !rangeCheckOn(zap.range, zap.pool.pool.tickSpacing).ok) return null
  const slippageBps = slippageBpsFrom(zap.slippage)
  if (slippageBps === null) return null
  return { chainId: zap.chainId, action: 'create', consent, pool: zap.pool.pool, tickLower: zap.range.lower, tickUpper: zap.range.upper, inputs: funding.inputs, slippageBps }
}
