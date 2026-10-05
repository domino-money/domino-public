import { formatRatio, parsePrice, priceFromSqrtPriceX96, roundTripPrice, translateTrigger, type PoolDecimals, type PriceMove, type PriceOrientation } from '../../v2/trigger'
import type { MandateForm } from './form'
import type { WalletPosition } from '../../lib/walletPositions'
import type { TokenMeta } from '../automate/tokens'

/** The position page's existing read, never an independent request or a made-up price. */
export interface ExitPriceSnapshot {
  sqrtPriceX96: string | null
  block: number | null
  saved: boolean
}

/** Price belongs to the position read, not to whether an order can currently be offered. */
export function positionExitPrice(position: Pick<WalletPosition, 'sqrtPriceX96'> | null, context: Pick<ExitPriceSnapshot, 'block' | 'saved'> | null | undefined): ExitPriceSnapshot | null {
  if (!position?.sqrtPriceX96) return null
  return { sqrtPriceX96: position.sqrtPriceX96, block: context?.block ?? null, saved: context?.saved ?? true }
}

/** Fill missing metadata only from the same token address. Zero decimals is a real value. */
export function exitTokenMeta(page: TokenMeta | null, index: TokenMeta | null): TokenMeta | null {
  if (!page) return index
  if (!index || page.address.toLowerCase() !== index.address.toLowerCase()) return page
  return { ...page, symbol: page.symbol ?? index.symbol, decimals: page.decimals ?? index.decimals }
}

export function exitReferencePrice(snapshot: ExitPriceSnapshot | null | undefined, decimals: PoolDecimals, orientation: PriceOrientation): string | null {
  if (!snapshot?.sqrtPriceX96) return null
  try {
    return priceFromSqrtPriceX96(BigInt(snapshot.sqrtPriceX96), decimals, orientation, { significant: 12 })
  } catch {
    return null
  }
}

/** Explicit shortcuts only. Decimal fractions stay exact; no JS float enters a signed trigger. */
export function exitShortcutPrice(reference: string | null, move: PriceMove, percent: number): string | null {
  if (!reference || !Number.isInteger(percent) || percent <= 0 || percent >= 100) return null
  const value = parsePrice(reference)
  if (!value.ok) return null
  return formatRatio({ num: value.ratio.num * BigInt(move === 'falls' ? 100 - percent : 100 + percent), den: value.ratio.den * 100n }, 12)
}

/** A concise comparison for display; validation and signing still use mandateTermsFrom. */
export function exitPriceDistance(price: string, reference: string | null): { text: string; percent: number } | null {
  const value = parsePrice(price.trim())
  const anchor = parsePrice(reference)
  if (!value.ok || !anchor.ok) return null
  const difference = value.ratio.num * anchor.ratio.den - anchor.ratio.num * value.ratio.den
  if (difference === 0n) return { text: 'At the pool price', percent: 0 }
  const magnitude = difference < 0n ? -difference : difference
  const percent = formatRatio({ num: magnitude * 100n, den: anchor.ratio.num * value.ratio.den }, 3)
  return { text: `${difference < 0n ? '−' : '+'}${percent}% from pool price`, percent: Number(percent) * (difference < 0n ? -1 : 1) }
}

/** Turning the quote around reverses falls/rises and preserves both signed sqrt-price integers exactly. */
export function reorientExitForm(form: MandateForm, decimals: PoolDecimals, orientation: PriceOrientation): MandateForm | null {
  if (form.orientation === orientation) return form
  const next = { ...form, orientation, fallsTo: '', risesTo: '' }
  for (const [move, price] of [['falls', form.fallsTo.trim()], ['rises', form.risesTo.trim()]] as const) {
    if (!price) continue
    const result = translateTrigger({ price, move, orientation: form.orientation, ...decimals })
    if (!result.ok) return null
    const inverse = roundTripPrice(result.sqrtPriceX96, decimals, orientation)
    if (inverse === null) return null
    if (move === 'falls') next.risesTo = inverse
    else next.fallsTo = inverse
  }
  return next
}
