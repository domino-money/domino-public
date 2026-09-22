/**
 * The wallet deposit's own checks of what was typed (screens/WalletDeposit.tsx):
 * an amount in the token's units to raw base units, and a range as ticks on
 * the pool's spacing. The same rules and the same words as New position's
 * (journey.ts validateBudget and validateRange), kept apart from it so the
 * Setup screen's lazy chunk does not carry the whole journey for two checks.
 */
import { parseDecimal } from '../read/decimal'
import { usableTicks } from '../read/screens/poolRange'
import { CREATE } from './copy'

const MAX_UINT256 = (1n << 256n) - 1n
const DECIMAL_TEXT = /^(?:0|[1-9]\d*)(?:\.\d+)?$/

export type RawAmount = { ok: true; raw: string } | { ok: false; reason: string }

/** A decimal amount in the token's units to raw base units; unknown decimals block, never guess. */
export function rawAmount(text: string, decimals: number | null): RawAmount {
  if (decimals === null) return { ok: false, reason: CREATE.amount.decimalsUnknown }
  if (text === '') return { ok: false, reason: CREATE.amount.empty }
  if (text.length > 100 || !DECIMAL_TEXT.test(text)) return { ok: false, reason: CREATE.amount.format }
  const value = parseDecimal(text)
  if (!value || value.coefficient === 0n) return { ok: false, reason: CREATE.amount.zero }
  if (value.scale > decimals) return { ok: false, reason: CREATE.amount.tooManyPlaces(decimals) }
  const raw = value.coefficient * 10n ** BigInt(decimals - value.scale)
  if (raw > MAX_UINT256) return { ok: false, reason: CREATE.amount.tooLarge }
  return { ok: true, raw: raw.toString() }
}

export type TickRange = { ok: true; lower: number; upper: number } | { ok: false; reason: string }

/** Two typed ticks as a range on this spacing: whole, multiples of the spacing, inside v4's ticks, lower below upper. */
export function tickRange(lowerText: string, upperText: string, spacing: number): TickRange {
  if (lowerText.trim() === '' || upperText.trim() === '') return { ok: false, reason: CREATE.amount.noRange }
  const lower = Number(lowerText), upper = Number(upperText)
  if (!Number.isInteger(lower) || !Number.isInteger(upper)) return { ok: false, reason: CREATE.amount.rangeTicks }
  if (lower % spacing !== 0 || upper % spacing !== 0) return { ok: false, reason: CREATE.amount.rangeSpacing }
  const { min, max } = usableTicks(spacing)
  if (lower < min || upper > max) return { ok: false, reason: CREATE.amount.rangeBounds }
  if (lower >= upper) return { ok: false, reason: CREATE.amount.rangeOrder }
  return { ok: true, lower, upper }
}

/** 1.0001^tick × 10^(dec0 − dec1): currency1 per currency0, to six significant digits, never an exponent (positions.ts tickPriceText). */
export function tickPrice(tick: number, decimals0: number, decimals1: number): string | null {
  const value = Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1)
  if (!isFinite(value) || value < 1e-12 || value > 1e24) return null
  return `≈${new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 }).format(value)}`
}
