/**
 * The preview forms, validated locally and serialised exactly as onboarding-v1
 * expects: lowercase addresses, the snake_case PoolKey, every optional
 * position field present (null when blank), and no owner, recipient,
 * signature or provider field at all (the closed request types forbid them).
 *
 * Amounts are entered as raw integers. Decimals of the synthetic catalog are
 * shown beside the field, but no decimal conversion is guessed on the way in.
 * Ticks are never snapped for the user: an unspaced tick is an issue, with the
 * nearest valid values named.
 */
import { isRaw, isUint256, parseSafeInteger } from '../lib/raw'
import { poolOf, tokenOf, type PreviewCatalog } from './catalog'
import type { OnboardingRequests, OnboardingRoute } from './types'

export interface InputIssue {
  field: string
  message: string
}

export type BuildResult<R extends OnboardingRoute> =
  | { ok: true; request: OnboardingRequests[R]; key: string }
  | { ok: false; issues: InputIssue[]; key: string }

export interface SwapForm {
  tokenIn: string
  tokenOut: string
  amountRaw: string
  slippageBps: string
  maxPriceImpactBps: string
}

export interface PositionForm {
  poolId: string
  /** Which currency the amount is for: '0' or '1'. */
  independent: '0' | '1'
  amountRaw: string
  tickLower: string
  tickUpper: string
  slippageBps: string
  budget0Raw: string
  budget1Raw: string
  nativeBalanceRaw: string
  nativeGasReserveRaw: string
}

export const MAX_TICK = 887272

/** A stable identity for what would be sent, so any change invalidates. */
export function requestKey(route: OnboardingRoute, value: unknown): string {
  return `${route}|${JSON.stringify(value)}`
}

function integerIn(text: string, min: number, max: number): number | null {
  const value = parseSafeInteger(text.trim())
  return value !== null && value >= min && value <= max ? value : null
}

export function buildSwapRequest(form: SwapForm, catalog: PreviewCatalog): BuildResult<'swap-preview'> {
  const key = requestKey('swap-preview', form)
  const issues: InputIssue[] = []
  const tokenIn = tokenOf(catalog, form.tokenIn)
  const tokenOut = tokenOf(catalog, form.tokenOut)
  if (!tokenIn) issues.push({ field: 'tokenIn', message: 'Choose the token you send.' })
  if (!tokenOut) issues.push({ field: 'tokenOut', message: 'Choose the token you receive.' })
  if (tokenIn && tokenOut && tokenIn.address === tokenOut.address) issues.push({ field: 'tokenOut', message: 'The two tokens must differ.' })
  const amount = form.amountRaw.trim()
  if (!isUint256(amount) || amount === '0') issues.push({ field: 'amountRaw', message: 'Enter a whole number of raw units above zero.' })
  const slippage = integerIn(form.slippageBps, 0, 9999)
  if (slippage === null) issues.push({ field: 'slippageBps', message: 'Slippage is a whole number of basis points from 0 to 9999.' })
  const impact = integerIn(form.maxPriceImpactBps, 0, 10000)
  if (impact === null) issues.push({ field: 'maxPriceImpactBps', message: 'Maximum price impact is a whole number of basis points from 0 to 10000.' })
  if (issues.length || !tokenIn || !tokenOut || slippage === null || impact === null) return { ok: false, issues, key }
  const request: OnboardingRequests['swap-preview'] = {
    chainId: 4663,
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    amountRaw: amount,
    slippageBps: slippage,
    maxPriceImpactBps: impact,
  }
  return { ok: true, request, key: requestKey('swap-preview', request) }
}

/** Blank is "not given" (null), never zero. */
function optionalRaw(text: string, field: string, label: string, issues: InputIssue[]): string | null {
  const value = text.trim()
  if (value === '') return null
  if (!isUint256(value)) {
    issues.push({ field, message: `${label} is a whole number of raw units, or blank for "not given".` })
    return null
  }
  return value
}

function nearestSpaced(tick: number, spacing: number): string {
  const below = Math.floor(tick / spacing) * spacing
  return `${below} or ${below + spacing}`
}

export function buildPositionRequest(form: PositionForm, catalog: PreviewCatalog): BuildResult<'position-preview'> {
  const key = requestKey('position-preview', form)
  const issues: InputIssue[] = []
  const pool = poolOf(catalog, form.poolId)
  if (!pool) issues.push({ field: 'poolId', message: 'Choose one of the listed pools.' })
  const amount = form.amountRaw.trim()
  if (!isUint256(amount) || amount === '0') issues.push({ field: 'amountRaw', message: 'Enter a whole number of raw units above zero.' })

  const lowerTick = integerIn(form.tickLower, -MAX_TICK, MAX_TICK)
  const upperTick = integerIn(form.tickUpper, -MAX_TICK, MAX_TICK)
  if (lowerTick === null) issues.push({ field: 'tickLower', message: `The lower tick is a whole number from -${MAX_TICK} to ${MAX_TICK}.` })
  if (upperTick === null) issues.push({ field: 'tickUpper', message: `The upper tick is a whole number from -${MAX_TICK} to ${MAX_TICK}.` })
  if (pool && lowerTick !== null && lowerTick % pool.poolKey.tick_spacing !== 0) {
    issues.push({ field: 'tickLower', message: `Ticks must be multiples of ${pool.poolKey.tick_spacing} in this pool: try ${nearestSpaced(lowerTick, pool.poolKey.tick_spacing)}.` })
  }
  if (pool && upperTick !== null && upperTick % pool.poolKey.tick_spacing !== 0) {
    issues.push({ field: 'tickUpper', message: `Ticks must be multiples of ${pool.poolKey.tick_spacing} in this pool: try ${nearestSpaced(upperTick, pool.poolKey.tick_spacing)}.` })
  }
  if (lowerTick !== null && upperTick !== null && lowerTick >= upperTick) issues.push({ field: 'tickUpper', message: 'The upper tick must be above the lower tick.' })

  const slippage = integerIn(form.slippageBps, 0, 9999)
  if (slippage === null) issues.push({ field: 'slippageBps', message: 'Slippage is a whole number of basis points from 0 to 9999.' })

  const budget0 = optionalRaw(form.budget0Raw, 'budget0Raw', 'Budget for currency 0', issues)
  const budget1 = optionalRaw(form.budget1Raw, 'budget1Raw', 'Budget for currency 1', issues)
  const balance = optionalRaw(form.nativeBalanceRaw, 'nativeBalanceRaw', 'Native balance', issues)
  const reserve = optionalRaw(form.nativeGasReserveRaw, 'nativeGasReserveRaw', 'Native gas reserve', issues)
  if (reserve !== null && balance === null) {
    issues.push({ field: 'nativeGasReserveRaw', message: 'A gas reserve needs the native balance it comes out of.' })
  }
  const independentBudget = form.independent === '0' ? budget0 : budget1
  if (independentBudget !== null && isRaw(amount) && BigInt(independentBudget) < BigInt(amount)) {
    issues.push({ field: form.independent === '0' ? 'budget0Raw' : 'budget1Raw', message: 'The budget for the token you enter an amount for must cover that amount.' })
  }

  if (issues.length || !pool || lowerTick === null || upperTick === null || slippage === null) return { ok: false, issues, key }
  const independentToken = form.independent === '0' ? pool.poolKey.currency0 : pool.poolKey.currency1
  const request: OnboardingRequests['position-preview'] = {
    chainId: 4663,
    poolId: pool.poolId,
    poolKey: { ...pool.poolKey },
    independentToken,
    amountRaw: amount,
    tickLower: lowerTick,
    tickUpper: upperTick,
    slippageBps: slippage,
    budget0Raw: budget0,
    budget1Raw: budget1,
    nativeBalanceRaw: balance,
    nativeGasReserveRaw: reserve,
  }
  return { ok: true, request, key: requestKey('position-preview', request) }
}
