/**
 * A current position preview as New position's deposit amount rows: what each
 * token is expected to deposit, the most it may take (the inspected maximum
 * debit), what a budget leaves unspent, and the liquidity the mint would add.
 *
 * Exact text from the raw integers with the decimals the pool read returned,
 * never guessed: unknown decimals show raw units. A null the contract allows
 * (no budget set) is an explicit none, never zero. Nothing is computed here
 * that the preview did not report: no second liquidity formula.
 */
import { formatUnits } from '../lib/read/decimal'
import type { PositionPreview } from './types'

export type AmountCell =
  /** `units` is false when the token's decimals were not read: `text` is then raw units. */
  | { kind: 'amount'; raw: string; text: string; units: boolean }
  /** The preview reported nothing for this cell; `why` is a closed code. */
  | { kind: 'none'; why: 'no_budget' }

export interface PositionAmounts {
  /** One cell per pool currency, in pool order (currency0, then currency1). */
  expected: readonly AmountCell[]
  maximum: readonly AmountCell[]
  unspent: readonly AmountCell[]
  /** The raw liquidity the mint would add, digits grouped. */
  liquidity: string
  /** `previewChecks.status`, for data attributes only. */
  checks: PositionPreview['previewChecks']['status']
}

function amount(raw: string, decimals: number | null): AmountCell {
  const units = formatUnits(raw, decimals)
  if (!units) return { kind: 'amount', raw, text: raw, units: false }
  return { kind: 'amount', raw, text: units.text, units: units.kind === 'units' }
}

/**
 * The rows for a preview whose request echo already matched the request this
 * page sent (client.ts), so its tokens are the pool's currencies in pool order
 * (the package runtime checks that order). `decimals` are the pool read's, one
 * per currency.
 */
export function positionAmounts(preview: PositionPreview, decimals: readonly [number | null, number | null]): PositionAmounts {
  const tokens = preview.position.tokens
  const at = (index: number) => decimals[index] ?? null
  return {
    expected: tokens.map((token, index) => amount(token.expectedDepositRaw, at(index))),
    maximum: tokens.map((token, index) => amount(token.maximumDebitRaw, at(index))),
    unspent: tokens.map((token, index) => (token.estimatedUnspentBudgetRaw === null ? { kind: 'none', why: 'no_budget' } : amount(token.estimatedUnspentBudgetRaw, at(index)))),
    liquidity: formatUnits(preview.position.mintLiquidityRaw, 0)?.text ?? preview.position.mintLiquidityRaw,
    checks: preview.previewChecks.status,
  }
}
