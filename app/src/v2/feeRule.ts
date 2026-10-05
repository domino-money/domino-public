/**
 * The 0.65% assisted-swap fee of a manual V2 action: which token it is charged in, and how much (spec F7 §2.8).
 *
 * A local replica of contracts/src/v2/fees/DominoFeeRules.sol, line for line, so the app can check a plan's fee terms
 * (`intent.feeBps`, `intent.feeToken`) before asking for any consent (spec §2.4 check 4). The zap enforces the same rule
 * and reverts `FeeMismatch` on any difference, so this replica never decides what anyone pays: it refuses a plan the
 * contract would refuse, and names the fee in the review.
 *
 * The rule, by rank first (the owner's decision of 2026-10-02; D1 in the spec: F0 and the interface's NatSpec still say
 * "place first", the contract does rank first):
 *   1. every token appearance in the legs has a place: a leg's `tokenIn` is an INPUT unless an earlier leg delivered
 *      it (then a HOP); a leg's `tokenOut` is an OUTPUT unless a later leg spends it (then a HOP);
 *   2. the best-ranked charge currency (lowest non-zero rank) anywhere in the route; ties go to the earlier place
 *      (input, output, hop), then to the earlier leg, then `tokenIn` before `tokenOut`;
 *   3. no charge currency in the route: the first leg's `tokenIn` (the fallback).
 * A hop inside one Universal Router call or one pool path is invisible here and does not count.
 *
 * The amount: `floor(swapped × 65 / 10000)`, with `swapped = max(Σ amountIn of legs spending the token, Σ measured
 * output of legs delivering it)`. The measured outputs exist only after execution: a review shows the fee on the
 * quote's expected outputs and says it is an estimate, the receipt shows `FeeCharged.amount` exactly.
 *
 * Pure: no viem, no wallet, no network. Ranks come from the caller: `registry.chargeCurrencyRank(token)` once a
 * deployment exists, the chain profile's charge currencies until then (src/v2/chains.ts profileRank).
 */
import { V2_FEES, ZERO_ADDRESS, type Address } from './types'

export type FeePlace = 'input' | 'output' | 'hop' | 'fallback'

/** What the rule reads of a leg. */
export interface FeeLeg {
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
}

/** A token's charge-currency rank: 1 best, 0 not a charge currency. */
export type RankOf = (token: Address) => number

const BPS = 10_000n
const PLACES = ['input', 'output', 'hop'] as const
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Where `token` sits at leg `index`, as the contract's `_place` says it. */
function placeOf(legs: readonly FeeLeg[], index: number, token: Address, asInput: boolean): 'input' | 'output' | 'hop' {
  if (asInput) {
    for (let j = 0; j < index; j++) if (same(legs[j].tokenOut, token)) return 'hop'
    return 'input'
  }
  for (let j = index + 1; j < legs.length; j++) if (same(legs[j].tokenIn, token)) return 'hop'
  return 'output'
}

/**
 * The token the assisted-swap fee is charged in, and where it was found (`DominoFeeRules.assistedSwapFeeToken`). An
 * empty route has no fee token: the contract reverts `InvalidPlan`, and so does this (`invalid_plan`).
 */
export function assistedSwapFeeToken(legs: readonly FeeLeg[], rankOf: RankOf): { token: Address; place: FeePlace } {
  if (legs.length === 0) throw new Error('invalid_plan')
  let bestRank = Number.POSITIVE_INFINITY
  let token: Address | null = null
  let place: FeePlace | null = null
  for (const wanted of PLACES) {
    for (let i = 0; i < legs.length; i++) {
      const spent = legs[i].tokenIn
      if (placeOf(legs, i, spent, true) === wanted) {
        const rank = rankOf(spent)
        if (rank !== 0 && rank < bestRank) [bestRank, token, place] = [rank, spent, wanted]
      }
      const delivered = legs[i].tokenOut
      if (placeOf(legs, i, delivered, false) === wanted) {
        const rank = rankOf(delivered)
        if (rank !== 0 && rank < bestRank) [bestRank, token, place] = [rank, delivered, wanted]
      }
    }
  }
  if (token === null || place === null) return { token: legs[0].tokenIn.toLowerCase() as Address, place: 'fallback' }
  return { token: token.toLowerCase() as Address, place }
}

/**
 * The amount the fee is a fraction of, in `token` (`DominoFeeRules.swappedAmount`): the larger of what the legs spent
 * in it and what they delivered in it, `amountsOut` being one measured (or, for a review, expected) output per leg.
 */
export function swappedAmount(legs: readonly FeeLeg[], amountsOut: readonly bigint[], token: Address): bigint {
  if (amountsOut.length !== legs.length) throw new Error('invalid_plan')
  let spent = 0n
  let delivered = 0n
  for (let i = 0; i < legs.length; i++) {
    if (same(legs[i].tokenIn, token)) spent += legs[i].amountIn
    if (same(legs[i].tokenOut, token)) delivered += amountsOut[i]
  }
  return spent > delivered ? spent : delivered
}

/** `bps` of `amount`, rounded down in the payer's favour (`DominoFeeRules.feeOf`). */
export function feeOf(amount: bigint, bps: number): bigint {
  if (amount < 0n || !Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error('invalid_fee_input')
  return (amount * BigInt(bps)) / BPS
}

/** The fee terms an intent must carry for these legs: none without legs, 65 bps in the rule's token with them. */
export function expectedFeeTerms(legs: readonly FeeLeg[], rankOf: RankOf): { feeBps: number; feeToken: Address; place: FeePlace | null } {
  if (legs.length === 0) return { feeBps: 0, feeToken: ZERO_ADDRESS, place: null }
  const { token, place } = assistedSwapFeeToken(legs, rankOf)
  return { feeBps: V2_FEES.assistedSwapBps, feeToken: token, place }
}

/** Whether an intent's fee terms are the ones the zap would accept (`DominoFeeRules.requireAssistedSwapTerms`). */
export function feeTermsMatch(legs: readonly FeeLeg[], rankOf: RankOf, feeBps: number, feeToken: Address): boolean {
  const expected = expectedFeeTerms(legs, rankOf)
  return feeBps === expected.feeBps && same(feeToken, expected.feeToken)
}

/**
 * The fee a plan would pay, from its legs and one output per leg (measured, or the quote's expected output for a
 * review), with the token, its place and the swapped basis: what "Domino fee: 3.25 USDG (0.65% of 500 USDG swapped)"
 * is written from. Null without legs ("No Domino fee").
 */
export function assistedSwapFee(legs: readonly FeeLeg[], amountsOut: readonly bigint[], rankOf: RankOf): { token: Address; place: FeePlace; swapped: bigint; amount: bigint } | null {
  if (legs.length === 0) return null
  const { token, place } = assistedSwapFeeToken(legs, rankOf)
  const swapped = swappedAmount(legs, amountsOut, token)
  return { token, place, swapped, amount: feeOf(swapped, V2_FEES.assistedSwapBps) }
}
