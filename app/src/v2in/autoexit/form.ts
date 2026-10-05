import { percentToBps } from '../../lib/create/sequenceDefaults'
import { checkMandateTriggers, priceFromSqrtPriceX96, roundTripPrice, translateTrigger, type PoolDecimals, type PriceMove, type PriceOrientation, type TriggerError, type TriggerField } from '../../v2/trigger'
import { RECEIVE_MODE, ZERO_ADDRESS, type Address, type ReceiveMode } from '../../v2/types'
import { AUTO_EXIT_DEFAULT_SLIPPAGE_BPS, AUTO_EXIT_DEFAULT_VALIDITY_DAYS, AUTO_EXIT_MAX_VALIDITY_DAYS, AUTO_EXIT_UI_MAX_SLIPPAGE_BPS } from './constants'
import { bpsText } from '../automate/form'

/**
 * An auto-exit order as the person types it (spec F7 §4.2, §4.3, §4.4), and the exact terms the `ExitMandate` signs.
 * Pure: the price is translated by src/v2/trigger.ts (exact integers, never a JS number), the receiving choice is
 * explicit (receiveMode is never read from convertTo), and each bound is spec §4.2's.
 *
 * Domino V2 integration (2026-10-02): the logic of src/v2ui/autoExit/form.ts, copied for the integrated screens.
 */

/** "Receive both tokens", or "Receive only {token}" for the pool's first or second token. */
export type ReceiveChoice = 'both' | 'token0' | 'token1'

export interface MandateForm {
  /** How the person says the price: the pool's token1 per token0, or the inverse. */
  orientation: PriceOrientation
  /** "Exit if the price falls to …": empty for no such trigger. */
  fallsTo: string
  /** "Exit if the price rises to …": empty for no such trigger. */
  risesTo: string
  receive: ReceiveChoice
  /** On top of the pool's fee: a shortcut (0.5, 1, 2; decision #19) or a free value from 0.01 to 5 (decision #28). */
  slippagePercent: string
  /** Whole days from now, 1 to AUTO_EXIT_MAX_VALIDITY_DAYS. */
  validityDays: string
}

export function defaultMandateForm(orientation: PriceOrientation): MandateForm {
  return {
    orientation,
    fallsTo: '',
    risesTo: '',
    receive: 'both',
    slippagePercent: bpsText(AUTO_EXIT_DEFAULT_SLIPPAGE_BPS),
    validityDays: String(AUTO_EXIT_DEFAULT_VALIDITY_DAYS),
  }
}

/** One trigger as typed and as it will be signed. */
export interface TriggerTerm {
  move: PriceMove
  /** As typed. */
  price: string
  field: TriggerField
  sqrtPriceX96: bigint
}

/** The terms of an order, before the client's review adds the owner, the vault's checks and the nonce. */
export interface MandateTerms {
  triggerBelowSqrtPriceX96: bigint
  triggerAboveSqrtPriceX96: bigint
  receiveMode: ReceiveMode
  convertTo: Address
  maxSlippageBps: number
  validUntil: bigint
  triggers: readonly TriggerTerm[]
}

export type MandateFormProblem =
  | 'form_no_trigger'
  | 'form_trigger_order'
  | 'form_slippage'
  | 'form_validity'
  | `form_falls_${TriggerError}`
  | `form_rises_${TriggerError}`

export type MandateCheck = { ok: true; terms: MandateTerms } | { ok: false; problems: readonly MandateFormProblem[] }

const DAY = 86_400

/**
 * The order's terms from the form, or what is wrong with it. `pool` is the vault's pool (currency0 < currency1),
 * `decimals` its tokens' (never guessed: unknown decimals refuse a price), `nowSeconds` the page's clock.
 * Each typed price lands in the field its move and orientation say (src/v2/trigger.ts triggerField): "falls to" in the
 * pool's orientation is triggerBelow, in the inverse orientation triggerAbove.
 */
export function mandateTermsFrom(form: MandateForm, pool: { currency0: Address; currency1: Address }, decimals: PoolDecimals, nowSeconds: number): MandateCheck {
  const problems: MandateFormProblem[] = []
  const triggers: TriggerTerm[] = []
  for (const [move, price] of [['falls', form.fallsTo.trim()], ['rises', form.risesTo.trim()]] as const) {
    if (price === '') continue
    const result = translateTrigger({ price, orientation: form.orientation, move, decimals0: decimals.decimals0, decimals1: decimals.decimals1 })
    if (!result.ok) problems.push(`form_${move}_${result.code}`)
    else triggers.push(Object.freeze({ move, price, field: result.field, sqrtPriceX96: result.sqrtPriceX96 }))
  }
  if (form.fallsTo.trim() === '' && form.risesTo.trim() === '') problems.push('form_no_trigger')
  let below = 0n
  let above = 0n
  for (const t of triggers) {
    if (t.field === 'triggerBelowSqrtPriceX96') below = t.sqrtPriceX96
    else above = t.sqrtPriceX96
  }
  if (triggers.length === 2 && checkMandateTriggers(below, above) === 'trigger_order') problems.push('form_trigger_order')
  const slippage = percentToBps(form.slippagePercent)
  if (slippage === null || slippage < 1 || slippage > AUTO_EXIT_UI_MAX_SLIPPAGE_BPS) problems.push('form_slippage')
  const days = /^[1-9]\d{0,3}$/.test(form.validityDays.trim()) ? Number(form.validityDays.trim()) : null
  if (days === null || days > AUTO_EXIT_MAX_VALIDITY_DAYS) problems.push('form_validity')
  if (problems.length) return { ok: false, problems: Object.freeze(problems) }
  const receiveMode: ReceiveMode = form.receive === 'both' ? RECEIVE_MODE.both : RECEIVE_MODE.converted
  const convertTo: Address = form.receive === 'token0' ? pool.currency0 : form.receive === 'token1' ? pool.currency1 : ZERO_ADDRESS
  return {
    ok: true,
    terms: Object.freeze({
      triggerBelowSqrtPriceX96: below,
      triggerAboveSqrtPriceX96: above,
      receiveMode,
      convertTo,
      maxSlippageBps: slippage as number,
      validUntil: BigInt(Math.floor(nowSeconds) + (days as number) * DAY),
      triggers: Object.freeze(triggers),
    }),
  }
}

const TRIGGER_ERROR_TEXT: Readonly<Record<TriggerError, string>> = Object.freeze({
  price_empty: 'Enter a price.',
  price_negative: 'Enter a price above zero.',
  price_exponent: 'Write the price in plain digits, like 2000 or 0.5.',
  price_malformed: 'Write the price in plain digits, like 2000 or 0.5.',
  price_too_many_digits: 'This price is too large.',
  price_too_many_decimals: 'Use at most 36 decimals.',
  price_zero: 'Enter a price above zero.',
  decimals_unknown: "This pool's token decimals are unknown, so a price can't be set here.",
  decimals_invalid: "This pool's token decimals are unknown, so a price can't be set here.",
  price_too_low: 'This price is below what the pool can reach.',
  price_too_high: 'This price is above what the pool can reach.',
})

/** What each problem says. */
export function mandateProblemText(problem: MandateFormProblem): string {
  if (problem === 'form_no_trigger') return 'Set a price to exit at: falls to, rises to, or both.'
  if (problem === 'form_trigger_order') return 'The "falls to" price must be below the "rises to" price.'
  if (problem === 'form_slippage') return `Enter a slippage from 0.01% to ${bpsText(AUTO_EXIT_UI_MAX_SLIPPAGE_BPS)}%.`
  if (problem === 'form_validity') return `Enter a whole number of days from 1 to ${AUTO_EXIT_MAX_VALIDITY_DAYS}.`
  const code = problem.replace(/^form_(falls|rises)_/, '') as TriggerError
  return TRIGGER_ERROR_TEXT[code] ?? 'Enter a price.'
}

/** Which input a problem sits beside. */
export function mandateProblemField(problem: MandateFormProblem): 'fallsTo' | 'risesTo' | 'slippagePercent' | 'validityDays' | 'triggers' {
  if (problem.startsWith('form_falls_')) return 'fallsTo'
  if (problem.startsWith('form_rises_')) return 'risesTo'
  if (problem === 'form_slippage') return 'slippagePercent'
  if (problem === 'form_validity') return 'validityDays'
  return 'triggers'
}

/** The move a mandate field means in an orientation: the inverse of src/v2/trigger.ts triggerField. */
export function moveOf(field: TriggerField, orientation: PriceOrientation): PriceMove {
  return (field === 'triggerBelowSqrtPriceX96') === (orientation === 'token1PerToken0') ? 'falls' : 'rises'
}

/**
 * A signed trigger's integer back as a price in an orientation (spec §4.3 "ida e volta"): the shortest decimal that
 * translates back to exactly this integer, or, when there is none within the input's limits, the price rounded to
 * eight significant digits. Null for a trigger that is off (0) or decimals that are unknown.
 */
export function triggerPrice(sqrtPriceX96: bigint, decimals: PoolDecimals, orientation: PriceOrientation): string | null {
  if (sqrtPriceX96 === 0n || decimals.decimals0 === null || decimals.decimals0 === undefined || decimals.decimals1 === null || decimals.decimals1 === undefined) return null
  try {
    return roundTripPrice(sqrtPriceX96, decimals, orientation) ?? priceFromSqrtPriceX96(sqrtPriceX96, decimals, orientation, { significant: 8 })
  } catch {
    return null
  }
}
