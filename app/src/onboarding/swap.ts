/**
 * Setup's assisted swap, previewed: the swap-preview request formed from what
 * the owner typed, and the answer as rows.
 *
 * The amount is the owner's own gross input. The pool receives it less the
 * published assisted swap fee, floor(gross × feeBps / 10000), exactly as the
 * setup contract charges it, so that net amount is what the provider quotes.
 * Nothing here decides how much to swap: the balancing amount is never
 * derived, and a typed amount is the only amount ever quoted.
 *
 * Every figure is exact text from raw integers; a null the contract allows is
 * an explicit none with a closed reason, never zero.
 */
import { SLIPPAGE_MAX_BPS, SLIPPAGE_MIN_BPS } from '../lib/create/slippage'
import { formatWeiEth, groupRaw, isUint256, parseSafeInteger } from '../lib/raw'
import type { OnboardingRequests, SwapPreview } from './types'

/** What the owner typed, and the published fee that applies to it. */
export interface SwapFields {
  /** Lowercase addresses, from the operation read on chain or the funding fields. */
  tokenIn: string
  tokenOut: string
  /** The gross swap input in smallest units, fee included, as typed. */
  grossRaw: string
  /** The published assisted swap fee, in basis points (0 to 65). */
  feeBps: number
  slippageBps: string
  maxImpactBps: string
}

export type SwapProblem = 'tokens' | 'amount' | 'slippage' | 'impact' | 'fee' | 'nothing_left'

export type SwapRequest =
  | { ok: true; request: OnboardingRequests['swap-preview']; netRaw: string; feeRaw: string }
  | { ok: false; problem: SwapProblem }

const ADDRESS = /^0x[0-9a-f]{40}$/
/** The product's bound on a person's slippage (lib/create/slippage.ts): Setup's own swap and the backend's swap-preview apply the same ends, so the preview never quotes outside them. */
export const SWAP_SLIPPAGE_MIN_BPS = SLIPPAGE_MIN_BPS
export const SWAP_SLIPPAGE_MAX_BPS = SLIPPAGE_MAX_BPS

export function swapRequest(fields: SwapFields): SwapRequest {
  if (!ADDRESS.test(fields.tokenIn) || !ADDRESS.test(fields.tokenOut) || fields.tokenIn === fields.tokenOut) return { ok: false, problem: 'tokens' }
  if (!isUint256(fields.grossRaw) || fields.grossRaw === '0') return { ok: false, problem: 'amount' }
  const slippage = parseSafeInteger(fields.slippageBps.trim())
  if (slippage === null || slippage < SWAP_SLIPPAGE_MIN_BPS || slippage > SWAP_SLIPPAGE_MAX_BPS) return { ok: false, problem: 'slippage' }
  const impact = parseSafeInteger(fields.maxImpactBps.trim())
  if (impact === null || impact < 0 || impact > 10000) return { ok: false, problem: 'impact' }
  if (!Number.isSafeInteger(fields.feeBps) || fields.feeBps < 0 || fields.feeBps > 65) return { ok: false, problem: 'fee' }
  const gross = BigInt(fields.grossRaw)
  const fee = (gross * BigInt(fields.feeBps)) / 10000n
  const net = gross - fee
  if (net <= 0n) return { ok: false, problem: 'nothing_left' }
  return {
    ok: true,
    request: { chainId: 4663, tokenIn: fields.tokenIn, tokenOut: fields.tokenOut, amountRaw: net.toString(), slippageBps: slippage, maxPriceImpactBps: impact },
    netRaw: net.toString(),
    feeRaw: fee.toString(),
  }
}

export type SwapCell = { kind: 'value'; text: string } | { kind: 'none'; why: string }

export interface SwapRow {
  id: 'input' | 'output' | 'minimum' | 'impact' | 'provider-fee' | 'gas' | 'simulation' | 'checks'
  label: string
  cell: SwapCell
}

const value = (text: string): SwapCell => ({ kind: 'value', text })
const none = (why: string): SwapCell => ({ kind: 'none', why })

/** Plain words for the checks the service ran; the enum stays in data attributes. */
export const SWAP_CHECK_WORDS: Readonly<Record<SwapPreview['previewChecks']['reasons'][number], string>> = {
  price_impact_unknown: 'Price impact was not reported.',
  price_impact_exceeded: 'Price impact is above your maximum.',
  provider_output_fee_unknown: 'The provider’s output fee is unknown.',
  provider_output_fee_unsupported_nonzero: 'The provider reported an output fee, which is not supported.',
  simulation_unknown: 'The provider did not report a simulation.',
  provider_simulation_failed: 'The provider reported a failed simulation.',
  gas_estimate_incomplete: 'The gas estimate is incomplete.',
}

/** The labels of the rows, in order. */
export const SWAP_ROW_LABELS: Readonly<Record<SwapRow['id'], string>> = {
  input: 'Quoted input',
  output: 'Output',
  minimum: 'Minimum output',
  impact: 'Price impact',
  'provider-fee': 'Provider output fee',
  gas: 'Network gas',
  simulation: 'Simulation',
  checks: 'Checks',
}

/**
 * A current swap preview as rows, in smallest units as Setup writes every
 * amount. The output is the provider's gross output and the minimum is the
 * floor your slippage sets on it; the provider fee row says whether anything
 * is taken from it, so a gross figure is never presented as net.
 */
export function swapRows(preview: SwapPreview): SwapRow[] {
  const { quote, providerOutputFee: fee, gas, simulation, previewChecks } = preview
  const row = (id: SwapRow['id'], cell: SwapCell): SwapRow => ({ id, label: SWAP_ROW_LABELS[id], cell })
  const feeCell =
    fee.status === 'reported_zero' ? value('None reported') : fee.status === 'unsupported_nonzero' ? value('Reported, not supported') : none('provider_output_fee_unknown')
  const simulationCell =
    simulation.status === 'no_provider_failure_reported'
      ? value('No failure reported')
      : simulation.status === 'provider_reported_failure'
        ? value('The provider reported a failure')
        : none('simulation_unknown')
  const checks = previewChecks.status === 'blocked' ? previewChecks.reasons.map((reason) => SWAP_CHECK_WORDS[reason]).join(' ') : 'Within your limits'
  return [
    row('input', value(groupRaw(quote.dexInputAmountRaw))),
    row('output', value(groupRaw(quote.grossOutputAmountRaw))),
    row('minimum', value(groupRaw(quote.policyMinimumOutputRaw))),
    row('impact', quote.priceImpactPercent === null ? none('price_impact_unknown') : value(`${quote.priceImpactPercent}%`)),
    row('provider-fee', feeCell),
    row('gas', gas.feeWei === null ? none('gas_estimate_incomplete') : value(formatWeiEth(gas.feeWei) ?? gas.feeWei)),
    row('simulation', simulationCell),
    row('checks', value(checks)),
  ]
}
