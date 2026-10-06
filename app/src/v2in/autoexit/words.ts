import { AUTO_EXIT_TEXT, type AutoExitFeeKey, type AutoExitTextKey } from '../../finance/v2/autoExit'
import { group } from '../../lib/format/decimal'
import type { PriceOrientation, TriggerField } from '../../v2/trigger'
import type { TokenView } from '../automate/tokens'
import { edgeWords, moveOf, triggerPrice, type EdgeWords } from './form'

/**
 * How Auto-exit is said on screen (spec F7 §4.2's "Na tela" column, §4.5, §4.6, §4.7). Pure.
 *
 * Changed on purpose 2026-10-06 (the owner's point 5: the product is Auto-exit; its prices are the range's edges): the
 * edges in the app's own price words ("2,000 USDG per ETH"), and the one status line a position shows once it is on.
 *
 * Domino V2 integration (2026-10-02): the logic of src/v2ui/autoExit/words.ts, copied for the integrated screens.
 */

/** "2,000.5" from "2000.5": the integer part grouped. */
export const groupedPrice = (text: string): string => {
  const [integer, fraction] = text.split('.')
  return fraction === undefined ? group(integer) : `${group(integer)}.${fraction}`
}

/** "USDG per ETH" for an orientation of a pool's two tokens (the position page's own words, COPY.form.per). */
export function unitWords(tokens: readonly [TokenView, TokenView], orientation: PriceOrientation): string {
  return orientation === 'token1PerToken0' ? `${tokens[1].label} per ${tokens[0].label}` : `${tokens[0].label} per ${tokens[1].label}`
}

const decimalsOf = (tokens: readonly [TokenView, TokenView]) => ({ decimals0: tokens[0].decimals, decimals1: tokens[1].decimals })

/** The armed edges of a pair of triggers, for these tokens, the falling one first. */
export function edgesOf(triggers: { triggerBelowSqrtPriceX96: bigint; triggerAboveSqrtPriceX96: bigint }, tokens: readonly [TokenView, TokenView], orientation: PriceOrientation): EdgeWords[] {
  return edgeWords(triggers, decimalsOf(tokens), orientation)
}

/**
 * Where it closes, in one phrase: "2,000 – 3,000 USDG per ETH" for both edges (the lower price first), "3,000 USDG per
 * ETH" for one; null when a price can't be written (a token's decimals unknown) or nothing is armed.
 */
export function closesAtWords(edges: readonly EdgeWords[], tokens: readonly [TokenView, TokenView], orientation: PriceOrientation): string | null {
  if (edges.length === 0 || edges.some((edge) => edge.price === null)) return null
  return `${edges.map((edge) => edge.price).join(' – ')} ${unitWords(tokens, orientation)}`
}

/**
 * The status line once it is on (the plan, item 6), under the card's title "Auto-exit" and its "On" pill: "Closes at
 * 2,000 – 3,000 USDG per ETH". Changed on purpose 2026-10-06 (the review of point 5: the title and the pill already say
 * "Auto-exit" and "On"; the line said both again).
 */
export function onLine(edges: readonly EdgeWords[], tokens: readonly [TokenView, TokenView], orientation: PriceOrientation): string {
  const where = closesAtWords(edges, tokens, orientation)
  return where ? `Closes at ${where}` : 'Closes at the ends of your range'
}

/**
 * What the card says once Auto-exit closed the position (Added 2026-10-06, the review of point 5): that the tokens were
 * sent only when nothing waits to be claimed; otherwise where they are.
 */
export function closedLine(unclaimed: boolean): string {
  return unclaimed
    ? "Auto-exit closed this position. Some tokens couldn't be sent to your wallet: claim them below."
    : 'Auto-exit closed this position and sent the tokens to your wallet.'
}

/**
 * A signed trigger said as the person thinks of it: "Closes if the price falls to 2,000 USDG per ETH" (or "rises to"),
 * in an orientation, with the integer's own price (the round trip, §4.3). Null for a trigger that is off.
 */
export function triggerWords(field: TriggerField, sqrtPriceX96: bigint, tokens: readonly [TokenView, TokenView], orientation: PriceOrientation): string | null {
  if (sqrtPriceX96 === 0n) return null
  const price = triggerPrice(sqrtPriceX96, decimalsOf(tokens), orientation)
  const move = moveOf(field, orientation) === 'falls' ? 'falls to' : 'rises to'
  return price === null ? `Closes if the price ${move} a price that can't be shown here (a token's decimals are unknown)` : `Closes if the price ${move} ${groupedPrice(price)} ${unitWords(tokens, orientation)}`
}

/** "Both tokens" / "Only {token}" (§4.2). */
export function receiveWords(receiveMode: number, convertTo: string, tokens: readonly [TokenView, TokenView]): string {
  if (receiveMode === 0) return 'Both tokens'
  const token = tokens.find((t) => t.address === convertTo.toLowerCase())
  return `Only ${token ? token.label : convertTo}`
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

/** One wallet step's phase as the steps runner reports it (../automate/session.tsx StepPhase), structurally. */
export interface PhaseLike {
  phase: string
  note?: string
}

/**
 * The one live line while the wallet works (Added 2026-10-06, the owner's rules: one short status line, never a list of
 * steps on the main surface): "Step 1 of 2 · Sign in your wallet", "Step 2 of 2 · Confirm in your wallet", "… · Waiting
 * for the network"; one step alone has no count. Null while nothing is with the wallet or the network.
 */
export function runLine(phases: readonly PhaseLike[]): string | null {
  const index = phases.findIndex((phase) => phase.phase === 'working' || phase.phase === 'sent')
  if (index === -1) return null
  const phase = phases[index]
  const words = phase.phase === 'sent' ? 'Waiting for the network' : phase.note === 'signing' ? 'Sign in your wallet' : phase.note === 'wallet' ? 'Confirm in your wallet' : 'Checking'
  return phases.length > 1 ? `Step ${index + 1} of ${phases.length} · ${words}` : words
}
