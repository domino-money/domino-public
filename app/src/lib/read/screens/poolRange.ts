/**
 * Issue #3, S-PL7: practice range controls on an existing pool someone chose.
 *
 * The price is the pool's own, read from chain with the pools route: its
 * `tick` and `sqrtPriceX96` at the snapshot block, and both tokens' decimals.
 * Nothing here invents one. The tick must agree with the square-root price
 * (checked exactly, in BigInt, with Uniswap v4's TickMath), both decimals must
 * be known, and the price must be writable as a plain number; otherwise the
 * price is unavailable and there are no controls at all.
 *
 * A usable price can still be partial (token metadata the producer marked
 * partial, or a symbol it could not read) or stale (read more than five
 * minutes ago on this page: elapsed time since the reply arrived, never a
 * comparison with the payload's own clock). Both are said on screen.
 *
 * Ranges are practice only: two ticks, multiples of the pool's tick spacing,
 * inside the ticks v4 allows. No amount, quote, approval or wallet exists
 * here, and nothing is saved.
 */
import { RANGES, type RangeKey } from '../../ranges'
import { priceInverted } from '../orientation'
import type { TokenDisplay } from '../types'
import type { PoolOption } from './poolsList'
import { tickPriceText } from './positions'
import { numberFormat } from '../../format/numberFormat'

export const MIN_TICK = -887272
export const MAX_TICK = 887272
export const MIN_SQRT_PRICE = 4295128739n
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n

/** A price read longer ago than this on the page is marked stale. */
export const PRICE_STALE_MS = 300_000

const Q128 = 1n << 128n
const MAX_UINT256 = (1n << 256n) - 1n

/** Q128.128 factors 1/sqrt(1.0001^(2^i)), bit by bit, as in v4-core's TickMath.getSqrtPriceAtTick. */
const FACTORS: ReadonlyArray<readonly [number, bigint]> = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
]

const isTick = (tick: number) => tick % 1 === 0 && tick >= MIN_TICK && tick <= MAX_TICK

/** sqrt(1.0001^tick) × 2^96, rounded up, exactly as v4-core computes it. Throws outside MIN_TICK..MAX_TICK. */
export function sqrtPriceAtTick(tick: number): bigint {
  if (!isTick(tick)) throw new RangeError(`tick ${tick} is outside ${MIN_TICK}..${MAX_TICK}`)
  const abs = Math.abs(tick)
  let price = abs & 0x1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : Q128
  for (const [bit, factor] of FACTORS) if (abs & bit) price = (price * factor) >> 128n
  if (tick > 0) price = MAX_UINT256 / price
  return (price + 0xffffffffn) >> 32n
}

/**
 * The pool's tick agrees with its square-root price: sqrtAt(tick) ≤ sqrtPriceX96 ≤ sqrtAt(tick + 1).
 * The upper end is inclusive because a swap that stops exactly on a tick
 * boundary on the way down leaves the pool's tick one below it.
 */
export function tickAgrees(tick: number, sqrtPriceX96: bigint): boolean {
  if (!isTick(tick)) return false
  if (sqrtPriceX96 < MIN_SQRT_PRICE || sqrtPriceX96 >= MAX_SQRT_PRICE) return false
  if (sqrtPriceX96 < sqrtPriceAtTick(tick)) return false
  return tick === MAX_TICK || sqrtPriceX96 <= sqrtPriceAtTick(tick + 1)
}

export type PriceProblem = 'not_initialized' | 'tick_mismatch' | 'decimals_unknown' | 'beyond_display'

export type PoolPrice =
  | { state: 'unavailable'; problem: PriceProblem; block: number }
  | {
      state: 'usable'
      block: number
      /** The pool's own tick: in the pool's order, as every range's ticks are. */
      tick: number
      tickSpacing: number
      /**
       * The price the page writes, "1 `base` = `text` `quote`" (lib/read/orientation.ts, 2026-09-28): `base` in
       * `quote`, from `tickPriceText`, six significant digits, never an exponent.
       */
      text: string
      /** The token the price is written for, and the one it is written in: the pool's order, or the other way round when `inverted`. */
      base: TokenDisplay
      quote: TokenDisplay
      /** The page writes currency1 priced in currency0 (USDG or ETH is the pool's first currency). */
      inverted: boolean
      /** Both currencies' decimals, in the pool's order (currency0, currency1), whatever `inverted` says. */
      decimals: readonly [number, number]
      /** Token metadata the producer marked partial, or a symbol it could not read. */
      partial: boolean
      /** Read longer ago than PRICE_STALE_MS on this page. */
      stale: boolean
    }

const decimalsOf = (token: TokenDisplay) => (token.origin === 'read' ? token.decimals : null)

/** What the chosen pool's read data says about its price, at `now` (the page's clock, compared only with when the reply arrived). */
export function poolPrice(option: PoolOption, now: number): PoolPrice {
  const block = option.block
  let sqrt: bigint
  try {
    sqrt = BigInt(option.sqrtPriceX96)
  } catch {
    return { state: 'unavailable', problem: 'tick_mismatch', block }
  }
  if (sqrt === 0n) return { state: 'unavailable', problem: 'not_initialized', block }
  if (!tickAgrees(option.tick, sqrt)) return { state: 'unavailable', problem: 'tick_mismatch', block }
  const [currency0, currency1] = option.currencies
  const d0 = decimalsOf(currency0)
  const d1 = decimalsOf(currency1)
  if (d0 === null || d1 === null) return { state: 'unavailable', problem: 'decimals_unknown', block }
  const inverted = priceInverted(currency0.address, currency1.address)
  const text = tickPriceIn(option.tick, [d0, d1], inverted)
  if (text === null) return { state: 'unavailable', problem: 'beyond_display', block }
  const partial =
    option.tokenMetadata === 'partial' || [currency0, currency1].some((token) => token.origin === 'read' && (token.symbol === null || token.readStatus === 'partial'))
  const stale = option.readAt !== null && now - option.readAt >= PRICE_STALE_MS
  const [base, quote] = inverted ? [currency1, currency0] : [currency0, currency1]
  return { state: 'usable', block, tick: option.tick, tickSpacing: option.tickSpacing, text, base, quote, inverted, decimals: [d0, d1], partial, stale }
}

/**
 * The price at the pool's tick `tick` as the page writes it: currency1 per currency0 (`tickPriceText`), or, when
 * `inverted`, currency0 per currency1, which is the same tick read from the other side (1.0001^−tick, decimals swapped).
 */
export const tickPriceIn = (tick: number, decimals: readonly [number, number], inverted: boolean): string | null =>
  inverted ? tickPriceText(clean(-tick), decimals[1], decimals[0]) : tickPriceText(tick, decimals[0], decimals[1])

/** A practice range: two ticks, multiples of the tick spacing, lower below upper. */
export interface PracticeRange {
  lower: number
  upper: number
}

export type RangeMode = RangeKey | 'custom'

/** The lowest and highest ticks a range on this spacing can use. */
export function usableTicks(spacing: number): { min: number; max: number } {
  return { min: Math.ceil(MIN_TICK / spacing) * spacing, max: Math.floor(MAX_TICK / spacing) * spacing }
}

const LOG_STEP = Math.log(1.0001)
/** Ticks between two prices whose ratio is `ratio`. */
const ticksFor = (ratio: number) => Math.log(ratio) / LOG_STEP
// `|| 0` turns -0 into 0, so a range is never "-0".
const clean = (tick: number) => tick || 0

function clampTick(tick: number, spacing: number) {
  const { min, max } = usableTicks(spacing)
  return Math.min(max, Math.max(min, tick))
}

/** Snap to the spacing, keep inside v4's ticks, and keep at least one spacing between the bounds. */
export function normaliseRange(range: PracticeRange, spacing: number): PracticeRange {
  const { min, max } = usableTicks(spacing)
  let lower = clampTick(Math.floor(range.lower / spacing) * spacing, spacing)
  let upper = clampTick(Math.ceil(range.upper / spacing) * spacing, spacing)
  if (upper <= lower) {
    if (lower + spacing <= max) upper = lower + spacing
    else {
      upper = max
      lower = Math.max(min, max - spacing)
    }
  }
  return { lower: clean(lower), upper: clean(upper) }
}

/**
 * The app's two practice presets (RANGES in pair.ts), taken as multiples of
 * the pool's price: "Closer" is 0.7× to 1.5×, "Wider" 0.5× to 2×. Rounded
 * outward to the tick spacing, so the pool's tick is always inside.
 */
export function presetRange(tick: number, spacing: number, key: RangeKey): PracticeRange {
  const { lower, upper } = RANGES[key]
  const from = Math.floor((tick + ticksFor(lower)) / spacing) * spacing
  const to = Math.ceil((tick + ticksFor(upper)) / spacing) * spacing
  return normaliseRange({ lower: from, upper: Math.max(to, Math.floor(tick / spacing) * spacing + spacing) }, spacing)
}

/**
 * What the width choice says about a range on the pool's price now: a preset
 * only while the range is exactly that preset on this price, otherwise
 * "Custom". Derived, never remembered, so a kept range reopened or a price
 * read again can't leave a preset checked that no longer describes it.
 * `prefer` breaks a tie between presets that coincide, and an explicit
 * "Custom" choice stays custom.
 */
export function rangeMode(range: PracticeRange, tick: number, spacing: number, prefer: RangeMode | null = null): RangeMode {
  if (prefer === 'custom') return 'custom'
  const matches = (key: RangeKey) => {
    const preset = presetRange(tick, spacing, key)
    return preset.lower === range.lower && preset.upper === range.upper
  }
  if (prefer !== null && matches(prefer)) return prefer
  return (Object.keys(RANGES) as RangeKey[]).find(matches) ?? 'custom'
}

/** Move one bound to the nearest usable tick; it never crosses the other. */
export function moveBound(range: PracticeRange, which: 'lower' | 'upper', to: number, spacing: number): PracticeRange {
  const snapped = clampTick(Math.round(to / spacing) * spacing, spacing)
  const { min, max } = usableTicks(spacing)
  if (which === 'lower') return { lower: clean(Math.max(min, Math.min(snapped, range.upper - spacing))), upper: range.upper }
  return { lower: range.lower, upper: clean(Math.min(max, Math.max(snapped, range.lower + spacing))) }
}

/** Move one bound by whole tick spacings. */
export const stepBound = (range: PracticeRange, which: 'lower' | 'upper', steps: number, spacing: number) =>
  moveBound(range, which, range[which] + steps * spacing, spacing)

/** The ticks a slider covers: a quarter to four times the pool's price, widened to hold the range. */
export function sliderWindow(tick: number, spacing: number, range: PracticeRange): { min: number; max: number } {
  const span = Math.ceil(ticksFor(4) / spacing) * spacing
  const centre = Math.floor(tick / spacing) * spacing
  const { min, max } = usableTicks(spacing)
  return { min: clean(Math.max(min, Math.min(centre - span, range.lower))), max: clean(Math.min(max, Math.max(centre + span, range.upper))) }
}

/** Where the pool's tick sits against a range: v4 counts a position in range when lower ≤ tick < upper. */
export function rangePosition(range: PracticeRange, tick: number): 'inside' | 'below' | 'above' {
  if (tick < range.lower) return 'below'
  if (tick >= range.upper) return 'above'
  return 'inside'
}

/** A bound's price as text, as the page writes the pool's price (`base` in `quote`), or null when it cannot be written as a plain number. */
export const boundPrice = (tick: number, price: Extract<PoolPrice, { state: 'usable' }>) => tickPriceIn(tick, price.decimals, price.inverted === true)

/*
 * The page's own frame (2026-09-28, lib/read/orientation.ts). A pool the page reads the other way round is drawn and
 * edited as if it were a pool of `base` then `quote`: its ticks negated, so a higher tick is a higher price of `base`,
 * its range's ends swapped, and its decimals swapped. Every helper above (presets, the width's derived mode, bounds,
 * steps, the slider's window, a typed price) works unchanged in that frame; a range goes back to the pool's order with
 * `shownRange` again (it is its own inverse) before anything keeps or sends it. Where today's price sits against a
 * range is decided in the pool's order (`shownPosition`): v4's rule, lower ≤ tick < upper, is not symmetric.
 */

/** A tick in the page's frame: the pool's own, or negated when the page reads the pool the other way round. */
export const shownTick = (tick: number, inverted: boolean): number => (inverted ? clean(-tick) : tick)

/** A range in the page's frame, low then high as the page draws it; the same call takes it back to the pool's order. */
export function shownRange(range: PracticeRange, inverted: boolean): PracticeRange {
  return inverted ? { lower: clean(-range.upper), upper: clean(-range.lower) } : { lower: range.lower, upper: range.upper }
}

/** The pool's price in the page's frame: a pool of `base` then `quote`, written exactly as the pool's own price is. */
export function shownPrice(price: Extract<PoolPrice, { state: 'usable' }>): Extract<PoolPrice, { state: 'usable' }> {
  if (!price.inverted) return price
  return { ...price, tick: shownTick(price.tick, true), decimals: [price.decimals[1], price.decimals[0]], inverted: false }
}

/**
 * Where today's price sits against a range, as the page reads it: `below` the range (the range is above today's price,
 * so it holds only `base`), `above` it (only `quote`), or `inside`. v4's rule on the pool's own ticks, then turned round
 * for a pool the page reads the other way.
 */
export function shownPosition(range: PracticeRange, price: { tick: number; inverted?: boolean }): 'inside' | 'below' | 'above' {
  const at = rangePosition(range, price.tick)
  if (!price.inverted || at === 'inside') return at
  return at === 'below' ? 'above' : 'below'
}

/** A preset (Closer, Wider) on the price as the page reads it, as the pool's own ticks: 0.7× to 1.5× of that figure. */
export function presetFor(price: { tick: number; tickSpacing: number; inverted?: boolean }, key: RangeKey): PracticeRange {
  const inverted = price.inverted === true
  return shownRange(presetRange(shownTick(price.tick, inverted), price.tickSpacing, key), inverted)
}

/** A bound's distance from the pool's price, as a signed percentage for the slider thumb. */
export function fromPoolPrice(tick: number, poolTick: number): string {
  const percent = (Math.pow(1.0001, tick - poolTick) - 1) * 100
  const rounded = Math.abs(percent) < 0.05 ? 0 : percent
  const text = numberFormat({ maximumFractionDigits: Math.abs(rounded) >= 100 ? 0 : 1, minimumFractionDigits: 0 }).format(Math.abs(rounded))
  return rounded === 0 ? '0%' : `${rounded > 0 ? '+' : '−'}${text}%`
}
