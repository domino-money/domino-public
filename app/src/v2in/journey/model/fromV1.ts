import type { DepositPlan } from '../../../lib/create/depositPlan'
import { validateBudget, type PayWith, type JourneyState as V1JourneyState } from '../../../lib/create/journey'
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
 *     the slippage exactly as chosen; the pool's network (Robinhood Chain, or since 2026-10-05 Base or Arbitrum One, whose
 *     pools today's journey reads through the wallet, v3 or v4); no starting price (V1 lists only pools with one);
 *   - inputsFromV1: what the wallet puts in, from V1's own funding of the deposit (lib/create/reviewPlan.ts, the same
 *     reading its Review draws from): both of the pool's tokens at the amounts the amount step showed, or the one token the
 *     wallet holds, all of it, for the planner to swap in; short says which token lacks and by how much; wait while the
 *     wallet's balances are not read;
 *   - balancesUnread (2026-10-06): that wait is for good, the read having finished with nothing usable;
 *   - requestFromV1: the create request (position-plan-v1) for one consent.
 */
export function zapStateFromV1(state: Pick<V1JourneyState, 'pool' | 'range' | 'slippageBps'>): JourneyState | null {
  const option = state.pool
  if (!option || !state.range) return null
  const pool = poolFromList({ ...option, currencies: option.currencies, readAt: option.readAt })
  if (!pool) return null
  return { chainId: pool.chainId, pool, start: null, range: state.range, amounts: { mode: 'pool', other: null, text: {} }, slippage: state.slippageBps, step: 'review', furthest: 'review' }
}

export type V1Funding =
  | { kind: 'wait' }
  | { kind: 'short'; token: Address; have: bigint; need: bigint }
  | { kind: 'inputs'; inputs: readonly { token: Address; amount: bigint }[] }

/**
 * Changed on purpose 2026-10-06 (the owner: AI/PONS short on Robinhood Chain and nothing offered): a deposit paid with one
 * other token (`payWith`, lib/create/journey.ts PayWith) is that token alone, at the amount typed (position-plan-v1: "the
 * pool's tokens, or exactly one other token"), as the zap path's "Another token" asks it: the plan swaps it for the pool's
 * two, and its review and the wallet's own checks say whether the wallet holds it.
 */
export function inputsFromV1(zap: JourneyState | null, planned: { need: readonly [bigint, bigint]; plan: DepositPlan | null } | null, payWith: PayWith | null = null): V1Funding {
  if (payWith) {
    const paid = validateBudget(payWith.text, payWith.token.decimals)
    return zap?.pool && paid.ok ? { kind: 'inputs', inputs: [{ token: payWith.token.address as Address, amount: BigInt(paid.raw) }] } : { kind: 'wait' }
  }
  const plan = planned?.plan ?? null
  if (!zap?.pool || !planned || !plan) return { kind: 'wait' }
  const currencies: readonly [Address, Address] = [zap.pool.pool.currency0, zap.pool.pool.currency1]
  if (plan.kind === 'short') return { kind: 'short', token: currencies[plan.token], have: plan.have, need: plan.need }
  const pairs: readonly (readonly [Address, bigint])[] =
    plan.kind === 'both' ? [[currencies[0], planned.need[0]], [currencies[1], planned.need[1]]] : [[currencies[plan.from], plan.deposit]]
  const inputs = pairs.filter(([, amount]) => amount > 0n).map(([token, amount]) => ({ token, amount }))
  return inputs.length > 0 ? { kind: 'inputs', inputs } : { kind: 'wait' }
}

/** The wallet's read of the pool's two balances, as Review gets it (components/create/usePairBalances.ts PairBalancesState). */
export interface PairRead {
  status: 'disconnected' | 'waiting' | 'loading' | 'ready'
  balances: readonly [{ raw: string | null }, { raw: string | null }] | null
}

/**
 * Added 2026-10-06 (the final check's F5): the read of the wallet's two balances finished with nothing the plan can use (a
 * read that failed settles as `ready` with no figure, or a side with none, and is never asked again by itself:
 * components/create/usePairBalances.ts), so inputsFromV1 waits for good until they are read again. False while the read is
 * under way, with no wallet, and once both sides are known (a zero is known).
 */
export const balancesUnread = (read: PairRead): boolean =>
  read.status === 'ready' && (read.balances === null || read.balances[0].raw === null || read.balances[1].raw === null)

export function requestFromV1(zap: JourneyState | null, funding: V1Funding, consent: S1PlanConsent): S1PlanRequest | null {
  if (!zap?.pool || !zap.range || funding.kind !== 'inputs' || !rangeCheckOn(zap.range, zap.pool.pool.tickSpacing).ok) return null
  const slippageBps = slippageBpsFrom(zap.slippage)
  if (slippageBps === null) return null
  return { chainId: zap.chainId, action: 'create', consent, pool: zap.pool.pool, tickLower: zap.range.lower, tickUpper: zap.range.upper, inputs: funding.inputs, slippageBps }
}
