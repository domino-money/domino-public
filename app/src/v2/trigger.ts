/**
 * An auto-exit trigger, from a price to the `sqrtPriceX96` the `ExitMandate` signs, and back (spec F7 §4.2, §4.3). Exact
 * rational and integer arithmetic only: a price is parsed into a fraction of two BigInts, the square root is an integer
 * square root, and no value ever passes through a JS number.
 *
 * Changed on purpose 2026-10-06 (the owner's point 5; rugged97: "it is AUTO-EXIT: when the price hits the edge of the
 * range we close the position"): Auto-exit signs the range's own edges (src/v2in/autoexit/form.ts: TickMath's
 * sqrtPriceAtTick of each tick), so no price is typed on its screens any more; this module still says those integers back
 * as prices, in the orientation the screens write them, and keeps the typed-price translation its tests hold.
 *
 * The rule [F4 "Triggers"]: a trigger is the pool's sqrt price, token1 per token0, in Q64.96. "Below" fires with the
 * anchor at or under it, "above" at or over it. Whether "below" is the lower price on screen depends on the token order,
 * so a price is said in the orientation a person thinks in ("USDG per ETH", or "ETH per USDG") and as "falls to" or
 * "rises to", and this module picks the field:
 *
 *   | the person's orientation        | "falls to P"               | "rises to P"               |
 *   | token1 per token0 (the pool's)  | triggerBelowSqrtPriceX96   | triggerAboveSqrtPriceX96   |
 *   | token0 per token1 (inverted)    | triggerAboveSqrtPriceX96   | triggerBelowSqrtPriceX96   |
 *
 * The conversion (P is token1 per token0 in human units, d0 and d1 the two currencies' decimals):
 *
 *   priceRaw     = P × 10^(d1 − d0)
 *   sqrtPriceX96 = floor( sqrt(priceRaw) × 2^96 ) = isqrt( floor( priceRaw × 2^192 ) )
 *
 * (floor(sqrt(x)) = floor(sqrt(floor(x))) for any rational x ≥ 0.) An inverted price Q is P = 1/Q exactly, so the
 * integer is always the floor of the exact token1-per-token0 square root, whichever way round it was typed: the signed
 * trigger is at most one Q64.96 unit under the exact price, which no price can tell apart.
 *
 * Token order comes from the addresses: currency0 is the lower one (spec §4.3). Decimals are always given in pool order
 * (`decimals0` of currency0, `decimals1` of currency1), whatever the orientation; unknown decimals are never guessed.
 *
 * Back for the review: the integer is shown beside its price (spec §4.3, "Your wallet will show this as {sqrtPriceX96}"),
 * either as a rounded figure (`priceFromSqrtPriceX96`, half-even by default) or as the shortest decimal that translates
 * back to exactly the same integer (`roundTripPrice`).
 *
 * Plain functions: no viem, no wallet, no browser storage (tests/session.source-guard.test.mjs).
 */
import type { Address } from './types'

/** TickMath's bounds (Uniswap v3 and v4): a usable sqrt price is MIN_SQRT_PRICE ≤ s < MAX_SQRT_PRICE. */
export const MIN_SQRT_PRICE = 4295128739n
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n
const UINT160_MAX = (1n << 160n) - 1n
const Q192 = 1n << 192n

/** The longest price this module reads: 78 integer digits (a uint256 has 78) and 36 decimal places. */
export const PRICE_MAX_INTEGER_DIGITS = 78
export const PRICE_MAX_DECIMALS = 36

/** How the person says a price: the pool's token1 per token0, or the inverse, token0 per token1. */
export type PriceOrientation = 'token1PerToken0' | 'token0PerToken1'
/** "Exit if the price falls to …" or "… rises to …". */
export type PriceMove = 'falls' | 'rises'
export type TriggerField = 'triggerBelowSqrtPriceX96' | 'triggerAboveSqrtPriceX96'

/**
 * Why a typed price was refused. Closed: a screen maps each to its own words.
 * - `price_empty`: nothing typed.
 * - `price_negative`: a minus sign.
 * - `price_exponent`: exponent notation (1e3).
 * - `price_malformed`: anything else that is not a plain decimal (spaces, commas, a plus sign, leading zeros, "1.", ".5").
 * - `price_too_many_digits`: more than 78 integer digits.
 * - `price_too_many_decimals`: more than 36 decimal places.
 * - `price_zero`: the value is zero.
 */
export type PriceInputError =
  | 'price_empty'
  | 'price_negative'
  | 'price_exponent'
  | 'price_malformed'
  | 'price_too_many_digits'
  | 'price_too_many_decimals'
  | 'price_zero'

/**
 * Why a trigger could not be translated: a refused price, or
 * - `decimals_unknown`: a currency's decimals are missing (never guessed);
 * - `decimals_invalid`: decimals that are not an integer from 0 to 255;
 * - `price_too_low` / `price_too_high`: the sqrt price falls outside TickMath's bounds (or is zero), said in the
 *   orientation the person typed: an inverted price that is too high gives a sqrt price that is too low.
 */
export type TriggerError = PriceInputError | 'decimals_unknown' | 'decimals_invalid' | 'price_too_low' | 'price_too_high'

/** An exact positive fraction. */
export interface Ratio {
  num: bigint
  den: bigint
}

/** The decimals of the pool's two currencies, in pool order. */
export interface PoolDecimals {
  decimals0: number | null | undefined
  decimals1: number | null | undefined
}

export type PriceParse = { ok: true; ratio: Ratio } | { ok: false; code: PriceInputError }
export type SqrtPriceResult = { ok: true; sqrtPriceX96: bigint } | { ok: false; code: TriggerError }
export type TriggerTranslation = { ok: true; field: TriggerField; sqrtPriceX96: bigint } | { ok: false; code: TriggerError }

const PLAIN_DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/

/**
 * A typed price as an exact fraction. The grammar is the app's price input's (src/lib/read/screens/RangePriceInput.ts):
 * digits, optionally a point and more digits; no sign, no exponent, no separators, no leading zeros, no spaces.
 */
export function parsePrice(text: unknown): PriceParse {
  if (typeof text !== 'string') return { ok: false, code: 'price_malformed' }
  if (text === '') return { ok: false, code: 'price_empty' }
  if (text.startsWith('-')) return { ok: false, code: 'price_negative' }
  if (/[eE]/.test(text)) return { ok: false, code: 'price_exponent' }
  const match = PLAIN_DECIMAL.exec(text)
  if (!match) return { ok: false, code: 'price_malformed' }
  const [, integer, fraction = ''] = match
  if (integer.length > PRICE_MAX_INTEGER_DIGITS) return { ok: false, code: 'price_too_many_digits' }
  if (fraction.length > PRICE_MAX_DECIMALS) return { ok: false, code: 'price_too_many_decimals' }
  const num = BigInt(integer + fraction)
  if (num === 0n) return { ok: false, code: 'price_zero' }
  return { ok: true, ratio: { num, den: 10n ** BigInt(fraction.length) } }
}

/** floor(sqrt(n)) for n ≥ 0, by Newton's method from above. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('isqrt_negative')
  if (n < 2n) return n
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1)
  for (;;) {
    const y = (x + n / x) >> 1n
    if (y >= x) return x
    x = y
  }
}

const decimalsProblem = (d: number | null | undefined): TriggerError | null => {
  if (d === null || d === undefined) return 'decimals_unknown'
  return Number.isInteger(d) && d >= 0 && d <= 255 ? null : 'decimals_invalid'
}

/** 10^max(0, a − b), as a BigInt. */
const tenTo = (exponent: number): bigint => (exponent > 0 ? 10n ** BigInt(exponent) : 1n)

/**
 * The exact token1-per-token0 RAW price (P × 10^(d1 − d0)) of a human price in either orientation, as a fraction.
 */
function rawPrice(ratio: Ratio, d0: number, d1: number, orientation: PriceOrientation): Ratio {
  const [num, den] = orientation === 'token1PerToken0' ? [ratio.num, ratio.den] : [ratio.den, ratio.num]
  return { num: num * tenTo(d1 - d0), den: den * tenTo(d0 - d1) }
}

/** floor(sqrt(raw) × 2^96) of an exact raw price. */
const sqrtX96Of = (raw: Ratio): bigint => isqrt((raw.num * Q192) / raw.den)

/** The sqrt price of a typed human price (spec §4.3), inside TickMath's bounds or refused. */
export function sqrtPriceX96FromPrice(price: unknown, decimals: PoolDecimals, orientation: PriceOrientation): SqrtPriceResult {
  const problem = decimalsProblem(decimals.decimals0) ?? decimalsProblem(decimals.decimals1)
  if (problem) return { ok: false, code: problem }
  if (orientation !== 'token1PerToken0' && orientation !== 'token0PerToken1') throw new Error('invalid_orientation')
  const parsed = parsePrice(price)
  if (!parsed.ok) return parsed
  const sqrtPriceX96 = sqrtX96Of(rawPrice(parsed.ratio, decimals.decimals0 as number, decimals.decimals1 as number, orientation))
  // A sqrt price under the bound is a pool price too low; for an inverted price, the typed one was too high.
  const inverted = orientation === 'token0PerToken1'
  if (sqrtPriceX96 < MIN_SQRT_PRICE) return { ok: false, code: inverted ? 'price_too_high' : 'price_too_low' }
  if (sqrtPriceX96 >= MAX_SQRT_PRICE) return { ok: false, code: inverted ? 'price_too_low' : 'price_too_high' }
  return { ok: true, sqrtPriceX96 }
}

/** Which mandate field a move in an orientation sets (the table at the top of this file). */
export function triggerField(orientation: PriceOrientation, move: PriceMove): TriggerField {
  if (orientation !== 'token1PerToken0' && orientation !== 'token0PerToken1') throw new Error('invalid_orientation')
  if (move !== 'falls' && move !== 'rises') throw new Error('invalid_move')
  const below = (orientation === 'token1PerToken0') === (move === 'falls')
  return below ? 'triggerBelowSqrtPriceX96' : 'triggerAboveSqrtPriceX96'
}

export interface TriggerInput extends PoolDecimals {
  /** The price as typed. */
  price: unknown
  orientation: PriceOrientation
  move: PriceMove
}

/** "Exit if the price falls to / rises to P", said in either orientation, as the mandate field and its integer. */
export function translateTrigger(input: TriggerInput): TriggerTranslation {
  const field = triggerField(input.orientation, input.move)
  const result = sqrtPriceX96FromPrice(input.price, input, input.orientation)
  return result.ok ? { ok: true, field, sqrtPriceX96: result.sqrtPriceX96 } : result
}

// ---------------------------------------------------------------------------
// Back: the price an integer means
// ---------------------------------------------------------------------------

/** The exact human price of a sqrt price, in an orientation: s² × 10^(d0 − d1) / 2^192, or its inverse. */
function humanPrice(sqrtPriceX96: bigint, d0: number, d1: number, orientation: PriceOrientation): Ratio {
  const num = sqrtPriceX96 * sqrtPriceX96 * tenTo(d0 - d1)
  const den = Q192 * tenTo(d1 - d0)
  return orientation === 'token1PerToken0' ? { num, den } : { num: den, den: num }
}

/** m × 10^exponent as a plain decimal string: no exponent, no trailing fractional zeros, no trailing point. */
function placePoint(m: bigint, exponent: number): string {
  const digits = m.toString()
  if (exponent >= 0) return m === 0n ? '0' : digits + '0'.repeat(exponent)
  const places = -exponent
  const padded = digits.padStart(places + 1, '0')
  const integer = padded.slice(0, padded.length - places)
  const fraction = padded.slice(padded.length - places).replace(/0+$/, '')
  return fraction ? `${integer}.${fraction}` : integer
}

/** num/den ≥ 10^e. */
const atLeastPower = (num: bigint, den: bigint, e: number): boolean => (e >= 0 ? num >= den * 10n ** BigInt(e) : num * 10n ** BigInt(-e) >= den)

/**
 * A positive fraction to `significant` significant digits, as a plain decimal string.
 * - `half-even`: to the nearest, ties to the even last digit (the default);
 * - `down`: truncated toward zero, so the figure never overstates the exact price.
 */
export function formatRatio(ratio: Ratio, significant: number, rounding: 'half-even' | 'down' = 'half-even'): string {
  const { num, den } = ratio
  if (num <= 0n || den <= 0n) throw new Error('invalid_ratio')
  if (!Number.isInteger(significant) || significant < 1 || significant > 100) throw new Error('invalid_significant_digits')
  if (rounding !== 'half-even' && rounding !== 'down') throw new Error('invalid_rounding')
  // e = floor(log10(num / den)): one of two candidates from the digit counts.
  let e = num.toString().length - den.toString().length
  if (!atLeastPower(num, den, e)) e -= 1
  const shift = significant - 1 - e
  const n = shift >= 0 ? num * 10n ** BigInt(shift) : num
  const d = shift >= 0 ? den : den * 10n ** BigInt(-shift)
  let q = n / d
  const r = n % d
  if (rounding === 'half-even' && (2n * r > d || (2n * r === d && q % 2n === 1n))) q += 1n
  // Rounding 99…9 up carries into one more digit: 10^significant is 10^(significant−1) one place higher.
  if (q.toString().length > significant) {
    q /= 10n
    e += 1
  }
  return placePoint(q, e - significant + 1)
}

export interface PriceDisplayOptions {
  /** Significant digits (1 to 100; 6 by default). */
  significant?: number
  /** `half-even` by default; `down` never shows more than the exact price. */
  rounding?: 'half-even' | 'down'
}

/**
 * The price a sqrt price means, in an orientation, rounded to significant digits. Any sqrt price from 1 to the uint160
 * maximum is shown (a mandate read from the chain is shown as it is, even outside TickMath's bounds); zero is a trigger
 * that is off and has no price.
 */
export function priceFromSqrtPriceX96(sqrtPriceX96: bigint, decimals: PoolDecimals, orientation: PriceOrientation, options: PriceDisplayOptions = {}): string {
  if (typeof sqrtPriceX96 !== 'bigint' || sqrtPriceX96 <= 0n || sqrtPriceX96 > UINT160_MAX) throw new Error('invalid_sqrt_price')
  const problem = decimalsProblem(decimals.decimals0) ?? decimalsProblem(decimals.decimals1)
  if (problem) throw new Error(problem)
  if (orientation !== 'token1PerToken0' && orientation !== 'token0PerToken1') throw new Error('invalid_orientation')
  return formatRatio(humanPrice(sqrtPriceX96, decimals.decimals0 as number, decimals.decimals1 as number, orientation), options.significant ?? 6, options.rounding ?? 'half-even')
}

/**
 * The shortest decimal price, in an orientation, that translates back to exactly this sqrt price: what the review can
 * show as "the price your order fires at" with the guarantee that typing it again signs the same integer. Null when the
 * sqrt price is outside TickMath's bounds, or when no decimal within 78 integer digits and 36 decimal places does (a
 * price so small that the input could not take it either).
 *
 * The preimage of s is every price p with s ≤ sqrt(p·10^(d1−d0))·2^96 < s + 1: [s², (s+1)²) × 10^(d0−d1) / 2^192 in the
 * pool's orientation, and the inverse interval (2^192·10^(d1−d0)/(s+1)², 2^192·10^(d1−d0)/s²] the other way round. The
 * coarsest decimal grid (10^78 down to 10^−36) with a point in it gives the fewest digits; its lowest such point is taken.
 */
export function roundTripPrice(sqrtPriceX96: bigint, decimals: PoolDecimals, orientation: PriceOrientation): string | null {
  if (typeof sqrtPriceX96 !== 'bigint' || sqrtPriceX96 < MIN_SQRT_PRICE || sqrtPriceX96 >= MAX_SQRT_PRICE) return null
  const problem = decimalsProblem(decimals.decimals0) ?? decimalsProblem(decimals.decimals1)
  if (problem) throw new Error(problem)
  if (orientation !== 'token1PerToken0' && orientation !== 'token0PerToken1') throw new Error('invalid_orientation')
  const d0 = decimals.decimals0 as number
  const d1 = decimals.decimals1 as number
  const a = humanPrice(sqrtPriceX96, d0, d1, orientation)
  const b = humanPrice(sqrtPriceX96 + 1n, d0, d1, orientation)
  // Pool orientation: [a, b). Inverted: (b, a].
  const pool = orientation === 'token1PerToken0'
  const [lower, upper] = pool ? [a, b] : [b, a]
  const lowerInclusive = pool
  const upperInclusive = !pool
  for (let k = -PRICE_MAX_INTEGER_DIGITS; k <= PRICE_MAX_DECIMALS; k += 1) {
    // Grid points are m × unit, with unit = P/Q: 10^−k.
    const P = k < 0 ? 10n ** BigInt(-k) : 1n
    const Q = k > 0 ? 10n ** BigInt(k) : 1n
    // The smallest m with m·P/Q ≥ lower (> lower when the lower end is open).
    const top = lower.num * Q
    const bottom = lower.den * P
    let m = top / bottom
    if (m * bottom < top) m += 1n
    if (!lowerInclusive && m * bottom === top) m += 1n
    if (m <= 0n) m = 1n
    // m·P/Q against upper = U.num/U.den.
    const left = m * P * upper.den
    const right = upper.num * Q
    if (left < right || (upperInclusive && left === right)) {
      const text = placePoint(m, -k)
      // The grammar's limits, and the translation itself, decide: never a figure that would not come back the same.
      const back = sqrtPriceX96FromPrice(text, decimals, orientation)
      return back.ok && back.sqrtPriceX96 === sqrtPriceX96 ? text : null
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// The mandate's triggers, and the pool's token order
// ---------------------------------------------------------------------------

/**
 * What is wrong with a mandate's pair of triggers, before anything is signed (spec §4.2's table), or null:
 * - `trigger_missing`: both are zero (zero turns a trigger off, and at least one must be on);
 * - `trigger_out_of_range`: a trigger that is on lies outside TickMath's bounds, or is not a uint160;
 * - `trigger_order`: both are on and below is not under above.
 */
export type TriggerCheck = 'trigger_missing' | 'trigger_out_of_range' | 'trigger_order'

export function checkMandateTriggers(below: bigint, above: bigint): TriggerCheck | null {
  if (typeof below !== 'bigint' || typeof above !== 'bigint') return 'trigger_out_of_range'
  if (below === 0n && above === 0n) return 'trigger_missing'
  for (const trigger of [below, above]) {
    if (trigger !== 0n && (trigger < MIN_SQRT_PRICE || trigger >= MAX_SQRT_PRICE)) return 'trigger_out_of_range'
  }
  if (below !== 0n && above !== 0n && below >= above) return 'trigger_order'
  return null
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** A pool's two currencies in pool order: currency0 is the lower address (native ETH, address(0), is always first). */
export function sortCurrencies(a: Address, b: Address): [Address, Address] {
  if (!ADDRESS.test(a) || !ADDRESS.test(b)) throw new Error('invalid_address')
  const [x, y] = [a.toLowerCase() as Address, b.toLowerCase() as Address]
  if (x === y) throw new Error('identical_currencies')
  return BigInt(x) < BigInt(y) ? [x, y] : [y, x]
}

/**
 * The orientation of "the price of `base`, in the pool's other token": token1 per token0 when `base` is currency0, the
 * inverse when it is currency1. "Exit if X falls below 0.50 USDG" on a USDG/X pool (X is currency1) is
 * `orientationOf(pool, X)` = token0PerToken1, so its "falls" is `triggerAboveSqrtPriceX96` (spec §4.3).
 */
export function orientationOf(pool: { currency0: Address; currency1: Address }, base: Address): PriceOrientation {
  const t = typeof base === 'string' ? base.toLowerCase() : ''
  if (t === pool.currency0.toLowerCase()) return 'token1PerToken0'
  if (t === pool.currency1.toLowerCase()) return 'token0PerToken1'
  throw new Error('token_not_in_pool')
}
