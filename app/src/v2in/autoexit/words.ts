import { AUTO_EXIT_TEXT, type AutoExitFeeKey, type AutoExitTextKey } from '../../finance/v2/autoExit'
import { group } from '../../lib/format/decimal'
import type { PriceOrientation, TriggerField } from '../../v2/trigger'
import type { TokenView } from '../automate/tokens'
import { moveOf, triggerPrice } from './form'

/**
 * How an auto-exit order is said on screen (spec F7 §4.2's "Na tela" column, §4.5, §4.6, §4.7). Pure.
 *
 * Domino V2 integration (2026-10-02): the logic of src/v2ui/autoExit/words.ts, copied for the integrated screens.
 */

/** "2,000.5" from "2000.5": the integer part grouped. */
export const groupedPrice = (text: string): string => {
  const [integer, fraction] = text.split('.')
  return fraction === undefined ? group(integer) : `${group(integer)}.${fraction}`
}

/** "USDG per ETH" for an orientation of a pool's two tokens. */
export function unitWords(tokens: readonly [TokenView, TokenView], orientation: PriceOrientation): string {
  return orientation === 'token1PerToken0' ? `${tokens[1].label} per ${tokens[0].label}` : `${tokens[0].label} per ${tokens[1].label}`
}

/**
 * A signed trigger said as the person thinks of it: "Exit if the price falls to 2,000 USDG per ETH" (or "rises to"),
 * in an orientation, with the integer's own price (the round trip, §4.3). Null for a trigger that is off.
 */
export function triggerWords(field: TriggerField, sqrtPriceX96: bigint, tokens: readonly [TokenView, TokenView], orientation: PriceOrientation): string | null {
  if (sqrtPriceX96 === 0n) return null
  const price = triggerPrice(sqrtPriceX96, { decimals0: tokens[0].decimals, decimals1: tokens[1].decimals }, orientation)
  const move = moveOf(field, orientation) === 'falls' ? 'falls to' : 'rises to'
  return price === null ? `Exit if the price ${move} a price that can't be shown here (a token's decimals are unknown)` : `Exit if the price ${move} ${groupedPrice(price)} ${unitWords(tokens, orientation)}`
}

/** "Receive both tokens" / "Receive only {token}" (§4.2). */
export function receiveWords(receiveMode: number, convertTo: string, tokens: readonly [TokenView, TokenView]): string {
  if (receiveMode === 0) return 'Receive both tokens'
  const token = tokens.find((t) => t.address === convertTo.toLowerCase())
  return `Receive only ${token ? token.label : convertTo}`
}

/** The fee rule of the chosen way to receive (§4.6), {token} filled with the screen's own name for it. */
export function feeRuleWords(rule: { key: AutoExitFeeKey; token: string | null }, tokens: readonly [TokenView, TokenView]): string {
  const token = rule.token ? tokens.find((t) => t.address === rule.token?.toLowerCase())?.label ?? rule.token : ''
  return AUTO_EXIT_TEXT[rule.key].replace('{token}', token)
}

/** A §4.5 condition's copy, {chain} filled. */
export function conditionWords(key: AutoExitTextKey, chainName: string): string {
  return AUTO_EXIT_TEXT[key].replace('{chain}', chainName)
}
