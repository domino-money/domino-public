/**
 * The position dialogs' form values as plan inputs (copied from the S1 reference, the former src/v2ui/s1/forms.tsx, its pure part):
 * what an add puts in (one of the pool's tokens, both, or another token the chain's profile names), a new range around
 * the price now (presets, or custom prices on the pool's spacing), and the share of the position a change of range or a
 * withdrawal moves. Nothing here reads anything.
 *
 * Pure: no React, no wallet.
 */
import { v2Chain } from '../../v2/chains'
import { parseUnitsText, priceText, rangeAround, rangeBothWays, rangeValid, slippageBpsOf, usableTick } from '../../v2/plan/present'
import { ZERO_ADDRESS, type Address, type PoolRef, type V2ChainId } from '../../v2/types'
import { priceFromSqrtPriceX96 } from '../../v2/trigger'
import type { ActionPosition } from './model'
import { POSITION_SLIPPAGE_MAX_BPS, POSITION_SLIPPAGE_MIN_BPS, RANGE_PRESETS, type Share } from './constants'
import { decimalsOf, labelOf, type TokenBook } from './tokens'

export type AmountMode = 'one' | 'both' | 'other'
export interface AmountsValue {
  mode: AmountMode
  /** The pool currency for `one`, or the other token for `other`. */
  token: Address
  /** Typed amounts by token address. */
  text: Readonly<Record<string, string>>
}

/**
 * The tokens "Another token" offers: the chain's charge currencies, WETH and ETH, when not one of the pool's own (on a v3
 * pool with WETH, ETH pays its WETH side: the zap wraps it inside the action, rev2 §2.7); anything else is swapped by a
 * leg, with the Domino fee.
 */
export function otherTokens(chainId: V2ChainId, pool: PoolRef): Address[] {
  const chain = v2Chain(chainId)
  const own = new Set([pool.currency0, pool.currency1].map((token) => token.toLowerCase()))
  const candidates = [...chain.chargeCurrencies.map((currency) => currency.address), chain.wrappedNative.address, ZERO_ADDRESS]
  return [...new Set(candidates)].filter((token) => !own.has(token)) as Address[]
}

export function initialAmounts(pool: PoolRef): AmountsValue {
  return { mode: 'one', token: pool.currency1, text: {} }
}

/** The tokens a value pays with, in order. */
export const amountTokens = (value: AmountsValue, pool: PoolRef): Address[] => (value.mode === 'both' ? [pool.currency0, pool.currency1] : [value.token])

/** The inputs a value stands for, or null while one is missing, zero or malformed (decimals unknown: raw units only). */
export function inputsOf(value: AmountsValue, pool: PoolRef, book: TokenBook): { token: Address; amount: bigint }[] | null {
  const out: { token: Address; amount: bigint }[] = []
  for (const token of amountTokens(value, pool)) {
    const amount = parseUnitsText(value.text[token] ?? '', decimalsOf(book, token))
    if (amount === null || amount === 0n) return null
    out.push({ token: token.toLowerCase() as Address, amount })
  }
  return out
}

/** The slippage typed, in basis points within decision #2's bound; null for anything else. */
export const slippageOf = (text: string): number | null => slippageBpsOf(text, POSITION_SLIPPAGE_MIN_BPS, POSITION_SLIPPAGE_MAX_BPS)

export interface RangeValue {
  preset: string
  lower: string
  upper: string
}
export const initialRange: RangeValue = { preset: 'medium', lower: '', upper: '' }

/** Display the observed pool price, without deriving an approximate price from its integer tick. */
export function rangeReferencePrice(position: Pick<ActionPosition, 'pool' | 'sqrtPriceX96'>, book: TokenBook): string | null {
  if (position.sqrtPriceX96 === null) return null
  try {
    return priceFromSqrtPriceX96(position.sqrtPriceX96, {
      decimals0: decimalsOf(book, position.pool.currency0),
      decimals1: decimalsOf(book, position.pool.currency1),
    }, 'token1PerToken0', { significant: 8 })
  } catch { return null }
}

/** The ticks a value stands for around `tick`, on the pool's spacing; null while a custom price is missing or invalid. */
export function ticksOf(value: RangeValue, pool: PoolRef, tick: number, book: TokenBook): { tickLower: number; tickUpper: number } | null {
  const preset = RANGE_PRESETS.find((one) => one.key === value.preset)
  if (preset) return rangeAround(tick, pool.tickSpacing, preset.percent)
  const d0 = decimalsOf(book, pool.currency0)
  const d1 = decimalsOf(book, pool.currency1)
  const lower = Number(value.lower.replace(/,/g, ''))
  const upper = Number(value.upper.replace(/,/g, ''))
  if (d0 === null || d1 === null || !(lower > 0) || !(upper > lower) || !Number.isFinite(upper)) return null
  const toTick = (price: number) => Math.log(price / 10 ** (d0 - d1)) / Math.log(1.0001)
  const spacing = pool.tickSpacing
  const lo = usableTick(Math.floor(toTick(lower) / spacing) * spacing, spacing)
  const hi = usableTick(Math.ceil(toTick(upper) / spacing) * spacing, spacing)
  return rangeValid(lo, hi, spacing) ? { tickLower: lo, tickUpper: hi } : null
}

/** "1 ETH = 2,100 to 2,400 USDG": a range in plain words (currency1 per currency0). */
export function rangeSummary(book: TokenBook, pool: PoolRef, ticks: { tickLower: number; tickUpper: number }): string {
  const both = rangeBothWays(ticks.tickLower, ticks.tickUpper, decimalsOf(book, pool.currency0), decimalsOf(book, pool.currency1))
  return `1 ${labelOf(book, pool.currency0)} = ${priceText(both.forward.low) ?? '—'} to ${priceText(both.forward.high) ?? '—'} ${labelOf(book, pool.currency1)}`
}

/** The liquidity a share moves (all of it for `100`). */
export const shareOf = (liquidity: bigint, share: Share): bigint => (share === '100' ? liquidity : (liquidity * BigInt(Number(share))) / 100n)
