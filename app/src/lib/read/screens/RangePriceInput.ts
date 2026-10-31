import { parseDecimal } from '../decimal'
import { sqrtPriceAtTick, usableTicks, type PoolPrice, type PracticeRange } from './poolRange'

type Usable = Extract<PoolPrice, { state: 'usable' }>
export type PriceInputResult = { ok: true; tick: number } | { ok: false; message: string }

/**
 * Human quote/base price → outward tick-spacing boundary. Decimal strings
 * and TickMath's Q96 value are compared as exact BigInt fractions; only
 * bounded integer tick indices use Number. No log/float price conversion.
 */
export function priceInputToTick(text: string, which: 'lower' | 'upper', range: PracticeRange, price: Usable): PriceInputResult {
  // A minus sign is a number below zero, not a malformed one: said as zero is (QA round 2, Q18, 2026-10-30).
  if (/^\s*-/.test(text)) return { ok: false, message: 'Price must be greater than zero.' }
  if (text.length > 320 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return { ok: false, message: 'Enter a positive decimal price without commas or exponents.' }
  const target = parseDecimal(text)
  if (!target || target.coefficient <= 0n) return { ok: false, message: 'Price must be greater than zero.' }
  const spacing = price.tickSpacing
  const { min, max } = usableTicks(spacing)
  const [d0, d1] = price.decimals
  const leftScale = 10n ** BigInt(target.scale + Math.max(0, d0 - d1))
  const right = target.coefficient * (1n << 192n) * 10n ** BigInt(Math.max(0, d1 - d0))
  const compare = (tick: number) => {
    const sqrt = sqrtPriceAtTick(tick)
    const left = sqrt * sqrt * leftScale
    return left < right ? -1 : left > right ? 1 : 0
  }
  if (compare(min) > 0 || compare(max) < 0) return { ok: false, message: 'That price is outside this pool’s supported range.' }
  let low = min / spacing
  let high = max / spacing
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    if (compare(mid * spacing) <= 0) low = mid
    else high = mid - 1
  }
  const lower = low * spacing || 0
  const tick = which === 'upper' && compare(lower) !== 0 ? lower + spacing : lower
  if (which === 'lower' && tick >= range.upper) return { ok: false, message: 'Min price must stay below max price.' }
  if (which === 'upper' && tick <= range.lower) return { ok: false, message: 'Max price must stay above min price.' }
  return { ok: true, tick }
}

/** Displayed prices are explicitly approximate; removing decoration is not a parse of chain data. */
export const editablePrice = (text: string | null) => text?.replace(/^≈/, '').replaceAll(',', '') ?? ''
