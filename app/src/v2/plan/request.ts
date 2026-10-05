/**
 * The S1 plan request, `position-plan-v1` `1.0.0-rc.2` (spec F7 rev2 §2.4 "Pedido"), built and checked by the app
 * before anything is asked, and written in its wire form: raw integers as decimal strings, addresses lowercase, exactly
 * the fields the action takes (a field outside its action is the service's `invalid_request`):
 *
 *   { chainId, action, consent,
 *     pool (create) | position: { dex, tokenId } (increase, changeRange, exit),
 *     tickLower, tickUpper (create, changeRange), inputs: [{ token, amountRaw }] (create, increase),
 *     liquidityToRemove: "all" | raw (changeRange, exit), burn (changeRange, exit),
 *     receive: { mode: "both" } | { mode: "converted", token } (exit),
 *     initialPrice: { price, baseToken, decimals0, decimals1 } (create of a pool with no price),
 *     slippageBps }
 *
 * No owner and no recipient: the service plans for the session's wallet only. No nonce: the service picks it
 * (`readiness.nonce`; a direct plan's is 0).
 *
 * Pure: no viem, no wallet.
 */
import { isV2ChainId, v2Chain } from '../chains'
import { ZERO_ADDRESS, type Address, type PoolRef } from '../types'
import type { S1PlanRequest } from './types'

/** Decision #2: the S1 slippage is editable from 0.1% to 5% (10 to 500 bps), 0.5% by default. */
export const S1_SLIPPAGE_MIN_BPS = 10
export const S1_SLIPPAGE_MAX_BPS = 500

const MIN_TICK = -887272
const MAX_TICK = 887272
const MAX_UINT128 = (1n << 128n) - 1n
const MAX_UINT256 = (1n << 256n) - 1n
const ADDRESS = /^0x[0-9a-f]{40}$/
const PRICE = /^(0|[1-9][0-9]{0,39})(\.[0-9]{1,36})?$/

const fail = (code: string): never => {
  throw new Error(code)
}
const lowerAddress = (value: unknown): Address => (typeof value === 'string' && ADDRESS.test(value.toLowerCase()) ? (value.toLowerCase() as Address) : fail('plan_request_address'))
const big = (value: unknown, max: bigint, code: string): bigint => (typeof value === 'bigint' && value >= 0n && value <= max ? value : fail(code))

function poolWire(pool: PoolRef): Record<string, unknown> {
  if (pool.dex !== 3 && pool.dex !== 4) fail('plan_request_pool')
  if (!Number.isSafeInteger(pool.fee) || pool.fee < 0 || pool.fee > 1_000_000 || !Number.isSafeInteger(pool.tickSpacing) || pool.tickSpacing < 1 || pool.tickSpacing > 32_767) fail('plan_request_pool')
  const currency0 = lowerAddress(pool.currency0)
  const currency1 = lowerAddress(pool.currency1)
  if (BigInt(currency0) >= BigInt(currency1)) fail('plan_request_pool')
  // Hooked v4 pools stay refused for positions (decision #6): never asked.
  if (lowerAddress(pool.hooks) !== ZERO_ADDRESS) fail('plan_request_pool_hooked')
  return { dex: pool.dex, currency0, currency1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: ZERO_ADDRESS }
}

function ticks(request: S1PlanRequest, spacing: number | null): { tickLower: number; tickUpper: number } {
  const { tickLower, tickUpper } = request
  if (!Number.isSafeInteger(tickLower) || !Number.isSafeInteger(tickUpper)) return fail('plan_request_range')
  const lower = tickLower as number
  const upper = tickUpper as number
  if (lower >= upper || lower < MIN_TICK || upper > MAX_TICK) fail('plan_request_range')
  if (spacing !== null && (lower % spacing !== 0 || upper % spacing !== 0)) fail('plan_request_range')
  return { tickLower: lower, tickUpper: upper }
}

/**
 * The request's wire form, every field checked; throws a `plan_request_*` code for anything the app would never send.
 * The order of keys is fixed, so the same request always writes the same JSON.
 */
export function planRequestWire(request: S1PlanRequest): Record<string, unknown> {
  if (!isV2ChainId(request.chainId)) fail('plan_request_chain')
  v2Chain(request.chainId)
  if (!Number.isSafeInteger(request.slippageBps) || request.slippageBps < S1_SLIPPAGE_MIN_BPS || request.slippageBps > S1_SLIPPAGE_MAX_BPS) fail('plan_request_slippage')
  // The relayed consent is never asked (decision #4); Permit2 only for a create or an increase.
  if (request.consent !== 'direct' && request.consent !== 'permit2') fail('plan_request_consent')
  if (request.consent === 'permit2' && request.action !== 'create' && request.action !== 'increase') fail('plan_request_consent')
  const wire: Record<string, unknown> = { chainId: request.chainId, action: request.action, consent: request.consent }
  const inputsWire = () => {
    const inputs = request.inputs ?? []
    if (inputs.length === 0 || inputs.length > 2) fail('plan_request_inputs')
    const seen = new Set<string>()
    return inputs.map((input) => {
      const token = lowerAddress(input.token)
      if (seen.has(token)) fail('plan_request_inputs')
      seen.add(token)
      const amount = big(input.amount, MAX_UINT128, 'plan_request_inputs')
      if (amount === 0n) fail('plan_request_inputs')
      // Permit2 takes ERC-20 only (spec §2.5.2): native ETH needs the direct path.
      if (request.consent === 'permit2' && token === ZERO_ADDRESS) fail('plan_request_permit2_native')
      return { token, amountRaw: amount.toString(10) }
    })
  }
  const position = () => {
    const p = request.position
    if (!p || (p.dex !== 3 && p.dex !== 4)) return fail('plan_request_position')
    const id = big(p.tokenId, MAX_UINT256, 'plan_request_position')
    return id === 0n ? fail('plan_request_position') : { dex: p.dex, tokenId: id.toString(10) }
  }
  const removal = () => {
    const liquidity = request.liquidityToRemove
    if (liquidity === 'all') return 'all'
    return big(liquidity, MAX_UINT128, 'plan_request_liquidity').toString(10)
  }
  const burn = () => (typeof request.burn === 'boolean' ? request.burn : fail('plan_request_burn'))
  switch (request.action) {
    case 'create': {
      if (!request.pool) return fail('plan_request_pool')
      wire.pool = poolWire(request.pool)
      Object.assign(wire, ticks(request, request.pool.tickSpacing))
      wire.inputs = inputsWire()
      const initial = request.initialPrice
      if (initial) {
        const base = lowerAddress(initial.baseToken)
        const pool = wire.pool as { currency0: string; currency1: string }
        if (base !== pool.currency0 && base !== pool.currency1) fail('plan_request_initial_price')
        if (!PRICE.test(initial.price) || /^0(\.0+)?$/.test(initial.price)) fail('plan_request_initial_price')
        for (const d of [initial.decimals0, initial.decimals1]) if (!Number.isSafeInteger(d) || d < 0 || d > 77) fail('plan_request_initial_price')
        if (typeof initial.sqrtPriceX96 !== 'bigint' || initial.sqrtPriceX96 <= 0n) fail('plan_request_initial_price')
        wire.initialPrice = { price: initial.price, baseToken: base, decimals0: initial.decimals0, decimals1: initial.decimals1 }
      }
      break
    }
    case 'increase':
      wire.position = position()
      wire.inputs = inputsWire()
      break
    case 'changeRange': {
      wire.position = position()
      Object.assign(wire, ticks(request, null))
      const liquidity = removal()
      if (liquidity === '0') fail('plan_request_liquidity')
      wire.liquidityToRemove = liquidity
      wire.burn = burn()
      if (wire.burn && liquidity !== 'all') fail('plan_request_burn')
      break
    }
    case 'exit': {
      wire.position = position()
      const liquidity = removal()
      wire.liquidityToRemove = liquidity
      wire.burn = burn()
      if (wire.burn && liquidity !== 'all') fail('plan_request_burn')
      const receive = request.receive
      if (receive === 'both') wire.receive = { mode: 'both' }
      else if (receive && typeof receive === 'object') wire.receive = { mode: 'converted', token: lowerAddress(receive.convertTo) }
      else fail('plan_request_receive')
      break
    }
    default:
      return fail('plan_request_action')
  }
  wire.slippageBps = request.slippageBps
  return wire
}
