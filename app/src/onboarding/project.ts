/**
 * A validated preview as rows a screen can render, without deciding anything.
 *
 * Every value is text built from strings with exact arithmetic. Every null
 * becomes an explicit `unknown` with its reason: nothing defaults to zero, a
 * gross amount is never shown as net, and the swap's Domino tariff is never an
 * amount (NF-8, NF-9, N-0). Addresses and pool ids are shown as text only.
 */
import { formatTokenAmount, formatWeiEth, hundredthsToPercentText } from '../lib/raw'
import { tokenOf, type PreviewCatalog } from './catalog'
import { POSITION_REASON_COPY, SWAP_REASON_COPY, WITHIN_LIMITS_NOTE } from './copy'
import type { PositionPreview, SwapPreview } from './types'

export type Shown =
  | { kind: 'value'; text: string; note?: string }
  | { kind: 'unknown'; reason: string }

export interface Row {
  id: string
  label: string
  value: Shown
}

export interface ChecksView {
  status: string
  label: string
  tone: 'in' | 'out' | 'wait'
  reasons: string[]
  note: string | null
}

export interface PathView {
  label: string
  share: string
  hops: string[]
}

export interface FeeOutputRow {
  recipient: string
  amount: string
  minimum: string
  rate: Shown
  kind: string
}

export interface SwapView {
  kind: 'swap'
  checks: ChecksView
  amounts: Row[]
  fee: Row[]
  feeOutputs: FeeOutputRow[] | null
  paths: PathView[]
  gas: Row[]
  other: Row[]
  provenance: Row[]
}

export interface TokenRow {
  token: string
  expected: Shown
  maximum: Shown
  budget: Shown
  budgetStatus: string
  unspent: Shown
  unspentAtMaximum: Shown
}

export interface PositionView {
  kind: 'position'
  checks: ChecksView
  tokens: TokenRow[]
  position: Row[]
  native: Row[]
  other: Row[]
  provider: Row[]
  statement: string
}

const value = (text: string, note?: string): Shown => (note ? { kind: 'value', text, note } : { kind: 'value', text })
const unknown = (reason: string): Shown => ({ kind: 'unknown', reason })
const shortHex = (hex: string) => (hex.length > 14 ? `${hex.slice(0, 8)}…${hex.slice(-6)}` : hex)

function tokenLabel(catalog: PreviewCatalog, address: string): string {
  const token = tokenOf(catalog, address)
  return token ? `${token.symbol} (${shortHex(address.toLowerCase())})` : shortHex(address.toLowerCase())
}

/** Decimals for display: the route's own when it reports them, else the curated catalog's, else unknown. */
function decimalsFor(catalog: PreviewCatalog, address: string, reported: number | null | undefined): number | null {
  if (reported !== null && reported !== undefined) return reported
  return tokenOf(catalog, address)?.decimals ?? null
}

function symbolFor(catalog: PreviewCatalog, address: string): string | null {
  return tokenOf(catalog, address)?.symbol ?? null
}

function percentOfBps(bps: number): string {
  return `${hundredthsToPercentText(String(bps)) ?? String(bps)}%`
}

function swapChecks(preview: SwapPreview): ChecksView {
  const blocked = preview.previewChecks.status === 'blocked'
  return {
    status: preview.previewChecks.status,
    label: blocked ? 'Blocked' : 'Within observed limits',
    tone: blocked ? 'out' : 'in',
    reasons: preview.previewChecks.reasons.map((reason) => SWAP_REASON_COPY[reason]),
    note: blocked ? null : WITHIN_LIMITS_NOTE,
  }
}

export function projectSwap(preview: SwapPreview, catalog: PreviewCatalog, sessionOwner: string): SwapView {
  const { quote, providerOutputFee: fee, gas, request } = preview
  const firstHop = quote.routes[0]?.[0]
  const lastHop = quote.routes[0]?.at(-1)
  const inDecimals = decimalsFor(catalog, request.tokenIn, firstHop?.tokenIn.decimals)
  const outDecimals = decimalsFor(catalog, request.tokenOut, lastHop?.tokenOut.decimals)
  const inSymbol = symbolFor(catalog, request.tokenIn)
  const outSymbol = symbolFor(catalog, request.tokenOut)
  const input = (raw: string) => formatTokenAmount(raw, inDecimals, inSymbol)
  const output = (raw: string) => formatTokenAmount(raw, outDecimals, outSymbol)
  const feeReason = fee.status === 'unknown' ? 'Not available: the provider fee is unknown.' : 'Not available: the provider fee is not supported.'

  const amounts: Row[] = [
    { id: 'dex-input', label: 'You send (DEX input)', value: value(input(quote.dexInputAmountRaw), 'Excludes any Domino tariff; none is selected.') },
    { id: 'gross-output', label: 'Gross output', value: value(output(quote.grossOutputAmountRaw)) },
    {
      id: 'net-output',
      label: 'Output after provider fee',
      value: quote.outputAfterProviderFeeRaw === null ? unknown(feeReason) : value(output(quote.outputAfterProviderFeeRaw)),
    },
    { id: 'gross-minimum', label: 'Minimum output (provider)', value: value(output(quote.grossMinimumOutputAmountRaw)) },
    {
      id: 'net-minimum',
      label: 'Minimum after provider fee',
      value: quote.minimumAfterProviderFeeRaw === null ? unknown(feeReason) : value(output(quote.minimumAfterProviderFeeRaw)),
    },
    { id: 'policy-minimum', label: 'Your slippage floor', value: value(output(quote.policyMinimumOutputRaw)) },
    {
      id: 'price-impact',
      label: 'Price impact',
      value: quote.priceImpactPercent === null ? unknown('Not reported.') : value(`${quote.priceImpactPercent}%`),
    },
  ]

  const rate = fee.bps === null ? null : hundredthsToPercentText(fee.bps)
  let status: Shown
  switch (fee.status) {
    case 'reported_zero':
      status = value(
        fee.zeroEvidence === 'aggregated_outputs'
          ? "Reported as zero, from the provider's itemised outputs"
          : "Reported as zero, from the provider's legacy fee field",
      )
      break
    case 'unsupported_nonzero':
      status = value(rate === null ? 'Non-zero fee reported (rate not reported), not supported' : `Non-zero fee reported (${rate}%), not supported`)
      break
    case 'unknown':
      status = unknown('The provider did not report its output fee.')
      break
  }
  const feeRows: Row[] = [
    { id: 'fee-status', label: 'Provider output fee', value: status },
    { id: 'fee-rate', label: 'Fee rate', value: rate === null ? unknown('Not reported.') : value(`${rate}%`) },
    { id: 'fee-amount', label: 'Fee amount', value: fee.amountRaw === null ? unknown('Not reported.') : value(output(fee.amountRaw)) },
    { id: 'fee-recipient', label: 'Paid to', value: fee.recipient === null ? unknown('Recipient not reported.') : value(fee.recipient.toLowerCase()) },
  ]
  const owner = sessionOwner.toLowerCase()
  const feeOutputs =
    fee.aggregatedOutputs === null
      ? null
      : fee.aggregatedOutputs.map((item) => {
          const outRate = item.bps === null ? null : hundredthsToPercentText(item.bps)
          return {
            recipient: item.recipient.toLowerCase() === owner ? `${item.recipient.toLowerCase()} (you)` : item.recipient.toLowerCase(),
            amount: output(item.amountRaw),
            minimum: output(item.minimumAmountRaw),
            rate: outRate === null ? unknown('Not reported.') : value(`${outRate}%`),
            kind: item.kind === 'INTEGRATOR' ? 'Integrator fee' : 'Not labelled',
          }
        })

  const paths: PathView[] = quote.routes.map((path, index) => {
    const first = path[0]
    const last = path[path.length - 1]
    const amountIn = first.amountInRaw === null ? 'not reported' : input(first.amountInRaw)
    const amountOut = last.amountOutRaw === null ? 'not reported' : output(last.amountOutRaw)
    return {
      label: quote.routes.length > 1 ? `Path ${index + 1} of ${quote.routes.length}` : 'Path',
      share: `${amountIn} in → ${amountOut} out`,
      hops: path.map(
        (hop) =>
          `${tokenLabel(catalog, hop.tokenIn.address)} → ${tokenLabel(catalog, hop.tokenOut.address)} · pool ${shortHex(hop.poolId)} · fee ${hop.poolKey.fee_pips} pips`,
      ),
    }
  })

  const gasRows: Row[] = [
    { id: 'gas-fee', label: 'Network fee (provider estimate)', value: gas.feeWei === null ? unknown('Not reported.') : value(formatWeiEth(gas.feeWei) ?? gas.feeWei) },
    { id: 'gas-units', label: 'Gas units', value: gas.units === null ? unknown('Not reported.') : value(gas.units) },
    { id: 'gas-usd', label: 'In USD (provider)', value: gas.usd === null ? unknown('Not reported.') : value(`$${gas.usd}`) },
  ]

  let simulation: Shown
  switch (preview.simulation.status) {
    case 'unknown':
      simulation = unknown('The provider did not report a simulation.')
      break
    case 'provider_reported_failure':
      simulation = value(`The provider reported a failure: ${(preview.simulation.failureCodes ?? []).join(', ') || 'no code given'}.`)
      break
    case 'no_provider_failure_reported':
      simulation = value('No failure reported by the provider. That does not prove the swap would succeed.')
      break
  }
  const approval: Shown =
    preview.approvalApplicable === null
      ? unknown('The provider did not say whether an approval applies.')
      : value(
          preview.approvalApplicable
            ? 'The provider says a token approval may apply. Approvals are out of scope here; nothing is requested.'
            : 'The provider says no token approval applies.',
        )

  return {
    kind: 'swap',
    checks: swapChecks(preview),
    amounts,
    fee: feeRows,
    feeOutputs,
    paths,
    gas: gasRows,
    other: [
      { id: 'simulation', label: 'Simulation', value: simulation },
      { id: 'approval', label: 'Approval', value: approval },
      { id: 'domino-fee', label: 'Domino fee', value: value(`Not selected (ceiling ${percentOfBps(preview.dominoFee.ceilingBps)})`) },
    ],
    provenance: [
      {
        id: 'provider-block',
        label: 'Provider block',
        value: preview.provenance.providerBlockNumber === null ? unknown('Not reported.') : value(preview.provenance.providerBlockNumber),
      },
      { id: 'verification', label: 'Verified on-chain', value: value('No. Gas excludes approvals and is not verified; token safety and owner control are not verified.') },
    ],
  }
}

function positionChecks(preview: PositionPreview): ChecksView {
  const { status, reasons } = preview.previewChecks
  return {
    status,
    label: status === 'blocked' ? 'Blocked' : status === 'incomplete' ? 'Incomplete' : 'Within your selected limits',
    tone: status === 'blocked' ? 'out' : status === 'incomplete' ? 'wait' : 'in',
    reasons: reasons.map((reason) => POSITION_REASON_COPY[reason]),
    note: status === 'within_selected_limits' ? WITHIN_LIMITS_NOTE : null,
  }
}

const BUDGET_STATUS: Readonly<Record<PositionPreview['position']['tokens'][number]['budgetStatus'], string>> = {
  unknown: 'No budget set',
  exceeded: 'Maximum exceeds budget',
  within_limit: 'Within budget',
}

export function projectPosition(preview: PositionPreview, catalog: PreviewCatalog): PositionView {
  const { position, nativeFunding, gas } = preview
  const tokens: TokenRow[] = position.tokens.map((token) => {
    const decimals = decimalsFor(catalog, token.address, null)
    const symbol = symbolFor(catalog, token.address)
    const amount = (raw: string) => formatTokenAmount(raw, decimals, symbol)
    return {
      token: tokenLabel(catalog, token.address),
      expected: value(amount(token.expectedDepositRaw), 'Estimate'),
      maximum: value(amount(token.maximumDebitRaw), 'Inspected maximum'),
      budget: token.selectedBudgetRaw === null ? unknown('Not set.') : value(amount(token.selectedBudgetRaw)),
      budgetStatus: BUDGET_STATUS[token.budgetStatus],
      unspent: token.estimatedUnspentBudgetRaw === null ? unknown('Not available.') : value(amount(token.estimatedUnspentBudgetRaw)),
      unspentAtMaximum: token.unspentAtMaximumRaw === null ? unknown('Not available.') : value(amount(token.unspentAtMaximumRaw)),
    }
  })
  const native = (raw: string) => formatTokenAmount(raw, 18, 'ETH')
  return {
    kind: 'position',
    checks: positionChecks(preview),
    tokens,
    position: [
      { id: 'ticks', label: 'Ticks', value: value(`${position.tickLower} to ${position.tickUpper}`) },
      {
        id: 'range',
        label: 'Adjusted range',
        value: value(`${position.adjustedPrices.min} – ${position.adjustedPrices.max} raw token1 per raw token0`, 'Provider-reported; not a display price.'),
      },
      { id: 'liquidity', label: 'Liquidity (raw)', value: value(position.mintLiquidityRaw) },
      { id: 'recipient', label: 'Recipient', value: value(position.recipient.toLowerCase(), 'Your signed-in address.') },
      { id: 'pool', label: 'Pool', value: value(shortHex(position.poolId)) },
    ],
    native: [
      { id: 'native-deposit', label: 'Native deposit maximum', value: value(native(nativeFunding.depositMaximumRaw)) },
      {
        id: 'native-balance',
        label: 'Native balance (you entered)',
        value: nativeFunding.reportedBalanceRaw === null ? unknown('Not provided.') : value(native(nativeFunding.reportedBalanceRaw), 'Not verified.'),
      },
      {
        id: 'native-reserve',
        label: 'Gas reserve (you entered)',
        value: nativeFunding.selectedGasReserveRaw === null ? unknown('Not provided.') : value(native(nativeFunding.selectedGasReserveRaw), 'Not verified to cover real gas.'),
      },
    ],
    other: [
      { id: 'gas', label: 'Network gas', value: gas.feeWei === null ? unknown('Gas estimate unavailable.') : value(formatWeiEth(gas.feeWei) ?? gas.feeWei, 'Provider estimate; not verified.') },
      { id: 'domino-fee', label: 'Domino fee', value: value('No Domino fee on a direct deposit (0%)') },
      { id: 'simulation', label: 'Simulation', value: unknown('Not simulated.') },
    ],
    provider: [
      { id: 'prepared-deadline', label: 'Provider preparation deadline', value: value(String(preview.preparedDeadline), 'Provider metadata (Unix seconds). Not how long this preview is valid.') },
      { id: 'fingerprint', label: 'Request fingerprint', value: value(shortHex(preview.requestFingerprint)) },
    ],
    statement: 'Balances, allowances, token safety and the slippage model are not verified.',
  }
}
