import type { AmountView } from '../../lib/read/screens/positions'

/** A raw amount whose decimals are unknown, or an unread amount, is displayed as a dash rather than a numeric value. */
export function visibleAmountQuality(amounts: readonly Pick<AmountView, 'kind'>[]): 'current' | 'partial' | null {
  const known = amounts.filter((amount) => amount.kind === 'units' || amount.kind === 'zero').length
  return known === 0 ? null : known === amounts.length ? 'current' : 'partial'
}
