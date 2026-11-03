import { heldRaw, usdOf } from '../../components/create/valuation'
import { wholeFromOther } from '../../lib/create/depositPlan'
import { validateBudget, type JourneyState, type PayWith } from '../../lib/create/journey'
import { paymentEstimate, payFunding } from '../../lib/create/payFunding'
import type { PayFacts, PayOption } from '../../lib/create/poolPrices'
import { REVIEW_GAS_RESERVE_WEI, reviewTerms, type ReviewPlan } from '../../lib/create/reviewPlan'
import { NATIVE_CURRENCY } from '../../lib/read/screens/identity'
import { destinationChoices } from '../../v2/crosschain/present'
import { formatUnitsExact } from '../../v2/crosschain/amounts'
import { isV2ChainId } from '../../v2/chains'
import { deliverableTokens, holdingArtwork, type FundingBudget } from './model'

export interface RemoteFundingChoice {
  budget: FundingBudget
  /** A third-token payment needs an explicit post-arrival choice and its own S1 Review. */
  payment: PayWith | null
}

const RAW_LIMIT = 1n << 128n

/** A funding option does not create a deficit. A covered position can still be financed from another network.
 * Missing local funds retain their existing exact-shortfall path. No quotes, reads or inferred routes live here. */
export function remoteFundingChoice(input: {
  state: JourneyState
  planned: ReviewPlan | null
  pay: PayFacts | null | undefined
  alternative: PayOption | null
  nativeRaw: bigint | string | null
}): RemoteFundingChoice | null {
  const { state, planned, pay, alternative } = input
  const nativeRaw = typeof input.nativeRaw === 'bigint' ? input.nativeRaw : input.nativeRaw !== null && /^\d+$/.test(input.nativeRaw) ? BigInt(input.nativeRaw) : null
  const pool = state.pool
  if (!pool || !state.range) return null
  const chainId = pool.currencies[0].chainId
  const choices = destinationChoices().find((entry) => entry.chainId === chainId)?.tokens ?? []
  const make = (address: string, side: 0 | 1, amount: bigint, payment: PayWith | null = null): RemoteFundingChoice | null => {
    const token = choices.find((entry) => entry.address.toLowerCase() === address.toLowerCase())
    if (!token || amount <= 0n || amount >= RAW_LIMIT) return null
    // Unknown native gas is not zero. Wait for the existing destination read before sizing an ETH transfer.
    if (token.address === NATIVE_CURRENCY && nativeRaw === null) return null
    const gas = token.address === NATIVE_CURRENCY && nativeRaw !== null && nativeRaw < REVIEW_GAS_RESERVE_WEI ? REVIEW_GAS_RESERVE_WEI - nativeRaw : 0n
    const requiredRaw = amount + gas
    if (requiredRaw >= RAW_LIMIT) return null
    return { budget: { side, token: token.address.toLowerCase(), symbol: token.symbol, decimals: token.decimals, requiredRaw, ...(payment ? { paymentRaw: amount } : {}) }, payment }
  }

  if (state.payWith) {
    const paid = state.payWith
    const amount = validateBudget(paid.text, paid.token.decimals)
    // When this selected input is short, the normal deficit path still brings only the missing amount.
    if (!amount.ok || paid.token.chainId !== chainId || payFunding(paid, pay).kind !== 'ready') return null
    return make(paid.token.address, 0, BigInt(amount.raw))
  }
  if (!planned) return null
  const delivered = deliverableTokens(chainId, pool.currencies.map((token) => token.address))
  if (delivered.length > 0) {
    const plan = planned.plan
    if (!plan || plan.kind === 'short') return null
    const terms = reviewTerms(state)
    if (!terms) return null
    const holdings = heldRaw(planned)
    // Prefer the input already shown by the local swap. Otherwise use the typed token if deliverable.
    const first = plan.kind === 'swap' ? plan.from : planned.independent
    for (const side of [first, first === 0 ? 1 : 0] as const) {
      const currency = pool.currencies[side]
      const destination = choices.find((token) => token.address.toLowerCase() === currency.address.toLowerCase())
      if (!destination || currency.decimals !== destination.decimals) continue
      const amount = plan.kind === 'swap' && plan.from === side
        ? plan.deposit
        : holdings[side === 0 ? 1 : 0] === 0n
          ? holdings[side]
          : wholeFromOther(terms, side === 0 ? 1 : 0, holdings[0], holdings[1], terms.slippageBps)
      if (amount !== null) return make(currency.address, side, amount)
    }
    return null
  }

  // Neither pool token can be bridged. Reuse the same qualified, indicative payment option already offered locally.
  // This does not establish a swap route or final token quantities; S1 Review must confirm those after arrival.
  if (!alternative || alternative.stale || alternative.token.chainId !== chainId) return null
  const destination = choices.find((token) => token.address.toLowerCase() === alternative.token.address.toLowerCase())
  if (!destination || alternative.token.decimals !== destination.decimals) return null
  const estimate = paymentEstimate(usdOf(pool, heldRaw(planned)), alternative)
  if (!estimate) return null
  const payment: PayWith = { token: alternative.token, text: estimate.text, estimated: true }
  return make(alternative.token.address, 0, estimate.raw, payment)
}

/** Continue from the reviewed transfer's frozen input, never a newly calculated price or the whole wallet balance. */
export function remotePayment(chainId: number, poolTokens: readonly string[], address: string, amountRaw: string): PayWith | null {
  if (!isV2ChainId(chainId) || !/^[1-9]\d{0,38}$/.test(amountRaw)) return null
  const raw = BigInt(amountRaw)
  if (raw >= RAW_LIMIT || poolTokens.some((token) => token.toLowerCase() === address.toLowerCase())) return null
  const token = destinationChoices().find((chain) => chain.chainId === chainId)?.tokens.find((entry) => entry.address.toLowerCase() === address.toLowerCase())
  if (!token) return null
  // Changed on purpose 2026-11-02 (review M4): written with no thousands separator, as every amount the page puts in a
  // field (./model.ts continueWith): a grouped "1,250" is refused as ambiguous when it is read back (lib/create/typedFigure.ts).
  const text = formatUnitsExact(raw.toString(), token.decimals)?.replace(/,/g, '') ?? null
  if (!text) return null
  return { token: { origin: 'read', chainId, address: token.address.toLowerCase(), symbol: token.symbol, decimals: token.decimals, readStatus: 'available', artwork: holdingArtwork(chainId, token.address) }, text, estimated: true }
}
