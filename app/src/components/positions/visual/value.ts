/**
 * Valuation for the positions screens (DESIGN-V2 §6.2, §13): one price per
 * position, the `/api/fees/v1/state` answer's `sqrtPriceX96` at its block,
 * "worth now at pool price". A pair with USDG is valued in USD (1 USDG = $1);
 * any other pair in its own quote token. Exact bigint arithmetic on raw
 * amounts; a value is a decimal string with 18 fraction digits (PRICE_SCALE),
 * and only the screens round it, for display. Pure and Node-safe.
 */
import { USDG } from '../../../config/mainTokens'
import { shortAmount } from '../../../lib/format/amount'
import { group, scaledText } from '../../../lib/format/decimal'
import { PRICE_SCALE, valueIn } from '../../../lib/format/price'
import { formatUsd } from '../../../lib/format/usd'
import type { PositionState, StateCurrency } from '../../../lib/fees/types'
import { unreadToken } from '../../../lib/read/project'
import { tokenAmount } from '../../../lib/read/screens/figures'
import { sqrtPriceAtTick } from '../../../lib/read/screens/poolRange'
import type { TokenDisplay } from '../../../lib/read/types'

/** What every value of one position is in, and at which price. */
export interface Basis {
  kind: 'usd' | 'quote'
  /** The currency values are in: USDG's side, or the quote token's. */
  into: 0 | 1
  decimals: readonly [number, number]
  sqrtPriceX96: bigint
  /** The block of the price (a title: "Pool price at block N"). */
  block: number
  /** The quote token's symbol for `quote` (untrusted text; null when unreadable or for USD). */
  symbol: string | null
}

export const isUsdg = (address: string) => address.toLowerCase() === USDG

/** USDG's side of a pair, or null when neither currency is USDG. */
export function usdgSide(currencies: readonly [{ address: string }, { address: string }]): 0 | 1 | null {
  return isUsdg(currencies[0].address) ? 0 : isUsdg(currencies[1].address) ? 1 : null
}

/**
 * The basis a state values at: USD when one side is USDG, else the quote side
 * (`quoteIndex`, the page's price orientation). Null when either decimals is
 * unknown or the price is not positive: nothing is guessed.
 */
export function basisOf(state: PositionState, quoteIndex: 0 | 1 = 1): Basis | null {
  const [a, b] = state.currencies
  if (a.decimals === null || b.decimals === null || state.sqrtPriceX96 <= 0n) return null
  const usd = usdgSide(state.currencies)
  const into = usd ?? quoteIndex
  return {
    kind: usd === null ? 'quote' : 'usd',
    into,
    decimals: [a.decimals, b.decimals],
    sqrtPriceX96: state.sqrtPriceX96,
    block: state.block,
    symbol: usd === null ? state.currencies[into].symbol : null,
  }
}

/** Both amounts in the basis currency, as a scaled bigint (10^18 units of it). */
export function valueUnits(basis: Basis, amounts: readonly [bigint, bigint]): bigint {
  const text = valueIn({ amounts, decimals: basis.decimals, into: basis.into, sqrtPriceX96: basis.sqrtPriceX96 })
  return BigInt(text.replace('.', ''))
}

/** A scaled value as its decimal string. */
export const unitsText = (units: bigint) => scaledText(units, PRICE_SCALE)

/** A scaled value as a plain number, for geometry only (positions on a chart, shares of a bar). */
export const unitsNumber = (units: bigint) => Number(unitsText(units))

/** Raw amounts from their decimal strings; null when either is not a whole non-negative number. */
export function rawPair(raw: readonly [string, string]): readonly [bigint, bigint] | null {
  if (!/^\d+$/.test(raw[0]) || !/^\d+$/.test(raw[1])) return null
  return [BigInt(raw[0]), BigInt(raw[1])]
}

/** The value of raw amount strings, or null when they cannot be read. */
export function valueOfRaw(basis: Basis, raw: readonly [string, string]): bigint | null {
  const amounts = rawPair(raw)
  return amounts === null ? null : valueUnits(basis, amounts)
}

/**
 * A quote-token value as a figure: grouped, at most six significant digits
 * (never fewer than its whole part), nothing rounded up.
 */
export function quoteFigure(units: bigint): string {
  const [whole, fraction = ''] = unitsText(units).split('.')
  return shortAmount(`${group(whole)}.${fraction}`).short
}

/** A value as the screens write it: `$1,234.56` for USD, a quote figure otherwise (its symbol is the caller's). */
export function valueFigure(basis: Pick<Basis, 'kind'>, units: bigint): string {
  return basis.kind === 'usd' ? formatUsd(unitsText(units)) : quoteFigure(units)
}

/**
 * A raw amount as the value band and the rows write it (the read's own rule:
 * six significant digits, rounded, grouped), so one amount reads the same
 * everywhere on a page, and every digit for its title. Null when the
 * currency's decimals are unknown.
 */
export function amountTexts(raw: bigint, currency: StateCurrency): { text: string; full: string } | null {
  const shown = tokenAmount(raw.toString(), currency.address, [stateToken(currency)])
  return shown.text === null || shown.exact === null ? null : { text: shown.text, full: shown.exact }
}

/** A currency from `/state` as the screens' token: its artwork from the curated table, its symbol as read (untrusted text). */
export function stateToken(currency: StateCurrency): TokenDisplay {
  return { ...unreadToken(currency.address), symbol: currency.symbol, decimals: currency.decimals, readStatus: currency.decimals === null ? 'partial' : 'available' }
}

/**
 * The shares of a pair's value held in each token, for a split bar: each
 * amount valued alone at the basis price. Null when the total is zero.
 */
export function valueShares(basis: Basis, amounts: readonly [bigint, bigint]): readonly [number, number] | null {
  const first = valueUnits(basis, [amounts[0], 0n])
  const second = valueUnits(basis, [0n, amounts[1]])
  const total = first + second
  if (total <= 0n) return null
  // Basis points, so the float division sees small integers only.
  const share = Number((first * 10_000n) / total) / 10_000
  return [share, 1 - share]
}

const Q96 = 1n << 96n

/**
 * A position's principal at a price, as v4 pays it out on removal (rounded
 * down): all token0 below the range, all token1 above it, both inside.
 */
export function principalAt(liquidity: bigint, sqrtPriceX96: bigint, tick: number, tickLower: number, tickUpper: number): readonly [bigint, bigint] {
  if (liquidity <= 0n) return [0n, 0n]
  const sqrtA = sqrtPriceAtTick(tickLower)
  const sqrtB = sqrtPriceAtTick(tickUpper)
  const amount0 = (from: bigint) => ((liquidity << 96n) * (sqrtB - from)) / sqrtB / from
  const amount1 = (to: bigint) => (liquidity * (to - sqrtA)) / Q96
  if (tick < tickLower) return [amount0(sqrtA), 0n]
  if (tick >= tickUpper) return [0n, amount1(sqrtB)]
  return [amount0(sqrtPriceX96), amount1(sqrtPriceX96)]
}

/** Two raw amounts that differ by rounding at most (a unit, or a billionth of the larger). */
const near = (a: bigint, b: bigint) => {
  const gap = a > b ? a - b : b - a
  const top = a > b ? a : b
  return gap <= 2n || gap * 1_000_000_000n <= top
}

/** Blocks this close in time are one moment for valuation: the price cannot have moved far. */
const SAME_MOMENT_SECONDS = 60

/**
 * Whether amounts read at one block may be valued at a `/state` price read at
 * another (§6.2, one price): the two reads are within a minute of each other,
 * or the state's own position gives exactly the amounts read (the same
 * liquidity and unclaimed fees, and its principal at the state's price), so
 * nothing moved between them. Otherwise no USD is shown rather than a figure
 * from two moments. The read's amounts are decimal strings (raw units).
 */
export function readAgrees(
  read: { timestamp: number; liquidity: string; principal: readonly [string, string]; unclaimed: readonly [string, string] },
  state: PositionState,
): boolean {
  if (Math.abs(read.timestamp - state.timestamp) <= SAME_MOMENT_SECONDS) return true
  if (!/^\d+$/.test(read.liquidity) || BigInt(read.liquidity) !== state.liquidity) return false
  const unclaimed = rawPair(read.unclaimed)
  const principal = rawPair(read.principal)
  if (!unclaimed || !principal || unclaimed[0] !== state.unclaimed[0] || unclaimed[1] !== state.unclaimed[1]) return false
  const at = principalAt(state.liquidity, state.sqrtPriceX96, state.tick, state.tickLower, state.tickUpper)
  return near(principal[0], at[0]) && near(principal[1], at[1])
}

/** Whether a value or an amount is above zero (a module helper, so components hold no bigint literal). */
export const positive = (units: bigint) => units > 0n

/** Whether either amount of a pair is above zero. */
export const anyPositive = (amounts: readonly [bigint, bigint]) => amounts[0] > 0n || amounts[1] > 0n

/** The difference of two values (the period's earned growth); never below zero. */
export const growth = (from: bigint, to: bigint) => (to > from ? to - from : 0n)
