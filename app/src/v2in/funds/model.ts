/**
 * What the inline "Bring {token} from {network}" offer works out before it draws (spec F7 §3.3, §3.4, §3.6, §3.8, §3.9):
 * whether the position can't be funded on its chain at all and which of its tokens a deposit can deliver there; the typed
 * amount and slippage as the request's exact fields; whether destination gas is offered; the request itself; the wallet
 * steps as words; when a failed request asks again by itself; where the answers come from (HTTP only, once wired; never
 * test data); and, after the deposit arrived, the amount the same position continues with. Pure: no React, no wallet,
 * no storage, no clock; the node tests compile it.
 *
 * The request helpers are copied on purpose from the rejected #/v2 section (src/v2ui/s2/model.ts, reference only),
 * unchanged in what they decide.
 */
import type { ChainBalancesResponse } from 'api-contracts/read-v6/types'
import { amountText } from '../../lib/create/amountText'
import type { Decimal } from '../../lib/create/typedFigure'
import type { DepositPlan } from '../../lib/create/depositPlan'
import { CANDIDATE_ORIGINS, type Holding, type HoldingsReport, type OriginCandidate } from '../../finance/v2/holdings'
import { capacityBusyWait, isCapacityBusy } from '../../finance/v2/requestCoordinator'
import { maxSpend, REVIEW_GAS_RESERVE_WEI } from '../../lib/create/reviewPlan'
import { formatUnitsExact, knownDecimals, tokenLabel } from '../../v2/crosschain/amounts'
import type { CrosschainFailure } from '../../v2/crosschain/client'
import { FAILURE_COPY, PROVIDER_NAME } from '../../v2/crosschain/copy'
import { errorDisposition } from '../../v2/crosschain/errors'
import { destinationChoices, networkName, roundedUnits, shortAmountText, type Naming } from '../../v2/crosschain/present'
import type { CrosschainRequests, OriginsList, OriginToken, QuotePlan } from '../../v2/crosschain/types'
import { BALANCE_CHAINS, balanceChain } from '../../v2/balanceChains'
import { isV2ChainId, nativeArtwork, v2Chain, wrappedArtwork } from '../../v2/chains'
import type { V2ChainId } from '../../v2/types'
import { ELYSIUM_FUNDS_FROM, ELYSIUM_V2_ID } from '../../lib/elysiumIdentity'
import {
  FUNDS_ETHEREUM_GAS_RESERVE_WEI,
  FUNDS_FIRST_GUESS_ROOM_BPS,
  FUNDS_LINE_MIN_USD,
  FUNDS_MAX_SLIPPAGE_BPS,
  FUNDS_MIN_SLIPPAGE_BPS,
  FUNDS_REQUEST_RETRY_MS,
  FUNDS_ROUTES_BUSY_RETRY_MS,
  FUNDS_SUGGEST_DESTINATION_GAS_AT_OR_BELOW_WEI,
  FUNDS_TYPED_QUOTE_DEBOUNCE_MS,
  FUNDS_TYPED_QUOTES_PER_MINUTE,
} from './constants'

const ZERO = '0x0000000000000000000000000000000000000000'
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const RAW = /^(0|[1-9][0-9]*)$/
/** The service's own bound: `amountRaw` below 2^128 (runtime quoteRequest), and its pattern `^[1-9][0-9]{0,77}$`. */
const RAW_LIMIT = 1n << 128n
const lower = (value: string) => value.toLowerCase()

// ---------------------------------------------------------------------------------------------------------------------
// Where the offer's answers come from
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Which answers the offer may use under the gate's mode for S2 (src/v2/gate.ts): `live` → the HTTP transport only, while
 * it is wired (open point #17, the app's side done 2026-10-02: constants.ts FUNDS_HTTP_TRANSPORT_WIRED), else none;
 * `preview` → none (the owner, 2026-10-02 night: no fixtures and no test data anywhere, real data only); `off` → none.
 * None means the offer has no service to ask: it runs locked, reading only what the wallet holds on other networks
 * through the wallet's own provider (finance/v2/holdings.ts), and says so on Bring.
 */
export function fundsSource(mode: 'off' | 'preview' | 'live', httpWired: boolean): 'http' | null {
  if (mode === 'live') return httpWired ? 'http' : null
  return null
}

// ---------------------------------------------------------------------------------------------------------------------
// What the wallet lacks (the offer's trigger)
// ---------------------------------------------------------------------------------------------------------------------

/** One of the position's two tokens, as the amount step knows it. */
export interface PairToken {
  address: string
  symbol: string | null
  decimals: number | null
}

/** An explicit budget to bring, independent of what the destination wallet already holds. */
export interface FundingBudget {
  side: 0 | 1
  token: string
  symbol: string
  decimals: number
  /** Minimum destination receipt, including only a known missing native-gas reserve. */
  requiredRaw: bigint
  /** Exact input to use after arrival when a third token will fund the position; excludes gas. */
  paymentRaw?: bigint
}

/** A token to offer bringing to the position's chain: one a deposit can deliver there, while the position can't be funded. */
export interface Lack {
  /** Its side in the pool's order. */
  side: 0 | 1
  /** The destination token (lowercase): one of the chain's charge currencies (§3.3); address(0) is the chain's ETH. */
  token: string
  /** Its symbol from the chain's published profile (trusted text, not the read's). */
  symbol: string
  decimals: number
  /** What the wallet has of it there, raw; native ETH after Review's gas allowance (lib/create/reviewPlan.ts). */
  haveRaw: bigint
  /**
   * How much more of it the wallet needs there, raw, for the typed amount: for the token Review's plan is short of, what
   * the plan needs of it; for the other one (Changed on purpose 2026-10-06, the owner's point 2b), what it alone needs to
   * fund the whole position through the swap (lib/create/depositPlan.ts wholeFromOther), so a deposit of it never brings
   * everything held elsewhere. Both against the balance read, native ETH keeping Review's gas allowance. Null when no
   * figure can be worked out (no price for the swap; the zap path's alternatives): the person then types the amount.
   */
  shortRaw: bigint | null
}

/**
 * What the wallet must still receive of a token so that `need` of it can be spent: the need, plus Review's gas allowance
 * for native ETH, less the balance read (pure; never below zero). Against the raw balance, not the spendable one, so the
 * allowance is counted once (the 2026-10-06 study's correction).
 */
export function stillNeeded(need: bigint, balanceRaw: bigint, native: boolean): bigint {
  const short = need + (native ? REVIEW_GAS_RESERVE_WEI : 0n) - balanceRaw
  return short > 0n ? short : 0n
}

/**
 * The tokens to offer bringing. Decided [owner, 2026-10-02 evening]: the offer shows ONLY when the position can't be
 * funded on its chain at all, counting the one-token swap New position already makes; when the other token can cover
 * the shortfall through that swap, nothing is offered.
 *   - An amount typed: only when Review's own plan for it (lib/create/depositPlan.ts, from the amount step's balances)
 *     is `short`: neither both tokens, nor the typed one alone, nor the other one through the swap covers it. The token
 *     the plan is short of comes first, with how much more it needs (V1's Review says the same: "add {token} to your
 *     wallet"); the other token after it when a deposit can deliver it, with what it alone needs (`wholeOther`), since
 *     bringing that much lets the swap cover.
 *   - Changed on purpose 2026-10-06 (the owner's point 1): before an amount, nothing. The discreet line under the amounts
 *     names a holding on another network instead (./BringFunds.tsx, bestHolding below).
 *   - Only a token a deposit may deliver to this chain (§3.3: its stable, ETH or WETH, from the build's chain profiles).
 *   - Only with both balances read: an unread balance offers nothing, never as if it were zero.
 */
export function lackingTokens(input: {
  chainId: number
  currencies: readonly [PairToken, PairToken]
  /** The wallet's balances on the position's chain, raw, in pool order; null (or a null side) when not read. */
  balances: readonly [string | null, string | null] | null
  /** Review's plan for the typed amount, from those balances; null before an amount is typed (or while none can be planned). */
  plan: DepositPlan | null
  /** The token the amount is typed in, or null. */
  independent: 0 | 1 | null
  /**
   * Added 2026-10-06: what the token the amount is NOT typed in must be, alone, to fund the typed amount through the swap
   * (lib/create/depositPlan.ts wholeFromOther, on Review's terms); null when it cannot be worked out.
   */
  wholeOther?: bigint | null
}): Lack[] {
  const raw = input.balances
  const { plan } = input
  if (!plan || plan.kind !== 'short') return []
  if (!raw || raw[0] === null || raw[1] === null || !RAW.test(raw[0]) || !RAW.test(raw[1])) return []
  const held = [BigInt(raw[0]), BigInt(raw[1])] as const
  const native = (side: 0 | 1) => lower(input.currencies[side].address) === ZERO
  const first = plan.token
  const figure = (side: 0 | 1): bigint | null => {
    if (side === first) return stillNeeded(plan.need, held[side], native(side))
    const whole = input.independent !== null && side !== input.independent ? (input.wholeOther ?? null) : null
    return whole === null ? null : stillNeeded(whole, held[side], native(side))
  }
  const choices = new Map((destinationChoices().find((d) => d.chainId === input.chainId)?.tokens ?? []).map((t) => [lower(t.address), t]))
  const lacks: Lack[] = []
  for (const side of first === 1 ? ([1, 0] as const) : ([0, 1] as const)) {
    const address = lower(input.currencies[side].address)
    const choice = choices.get(address)
    if (!choice) continue
    lacks.push({ side, token: address, symbol: choice.symbol, decimals: choice.decimals, haveRaw: maxSpend(held[side], native(side)), shortRaw: figure(side) })
  }
  return lacks
}

/** V2 spends the exact inputs selected on Amount, not V1's derived paired amount. No exchange rate is inferred.
 * Only complete balance reads may establish a shortfall. An alternative delivered token has no claimed equivalent
 * amount: after arrival the person explicitly chooses it as a new input and reviews a new S1 plan. Changed on purpose
 * 2026-10-06 (the owner's point 2b): with no figure, the offer never brings everything held elsewhere; it opens the
 * amount to send for the person to type (./BringFunds.tsx). */
export function lackingZapTokens(input: {
  chainId: number
  inputs: readonly { token: string; amount: bigint }[] | null
  balances: ReadonlyMap<string, bigint> | null
}): Lack[] {
  if (!input.inputs?.length || !input.balances || input.inputs.some((i) => !input.balances!.has(lower(i.token)))) return []
  const spend = (token: string) => maxSpend(input.balances!.get(lower(token)) ?? 0n, lower(token) === ZERO)
  const short = input.inputs.filter((i) => i.amount > spend(i.token))
  if (!short.length) return []
  const choices = destinationChoices().find((d) => d.chainId === input.chainId)?.tokens ?? []
  return [...choices].sort((a, b) => Number(short.some((i) => lower(i.token) === b.address)) - Number(short.some((i) => lower(i.token) === a.address)))
    .filter((token) => input.balances!.has(lower(token.address)))
    .map((token, index) => {
      const wanted = short.find((i) => lower(i.token) === lower(token.address))
      const haveRaw = spend(token.address)
      const balance = input.balances!.get(lower(token.address)) ?? 0n
      return { side: index === 1 ? 1 : 0, token: lower(token.address), symbol: token.symbol, decimals: token.decimals, haveRaw, shortRaw: wanted ? stillNeeded(wanted.amount, balance, lower(token.address) === ZERO) : null }
    })
}

/**
 * Added 2026-10-06 (the 2026-10-06 study: "Use" resized the position to the whole balance): the amount typed in the step,
 * once Review's plan for it (from the balances read again after an arrival) is no longer short: "Use" then keeps it as
 * it is. Null while the plan is short or unknown, or nothing is typed: "Use" then takes the balance read (continueWith).
 * Changed on purpose 2026-10-06 (the integration review: "Use 0.012649318273645123 ETH"): the label shows the amount as
 * the screen writes amounts (at most six decimals, `decimals` the typed token's); `text` stays exact.
 */
export function keptAmount(
  plan: DepositPlan | null,
  independent: 0 | 1 | null,
  typed: string,
  symbol: string | null,
  decimals: number | null = null,
): { side: 0 | 1; text: string; label: string } | null {
  const text = typed.trim()
  if (plan === null || plan.kind === 'short' || independent === null || text === '') return null
  const raw = knownDecimals(decimals) ? amountRawOf(text, decimals) : null
  const shown = raw !== null && knownDecimals(decimals) ? (roundedUnits(raw, decimals) ?? text) : text
  return { side: independent, text, label: symbol ? `${shown} ${symbol}` : shown }
}

/**
 * §3.9: the amount the same position continues with once the deposit arrived, from the balance READ on the position's
 * chain through the wallet (native ETH less Review's gas allowance): `raw`, and `text` as the amount field takes it
 * ("1234.5", no grouping). Null when nothing of it is there, the reading is not an amount, or the decimals are unknown.
 */
export function continueWith(balanceRaw: string | null, decimals: number | null, native: boolean): { raw: string; text: string } | null {
  if (balanceRaw === null || !RAW.test(balanceRaw) || !knownDecimals(decimals)) return null
  const spend = maxSpend(BigInt(balanceRaw), native)
  if (spend <= 0n) return null
  const units = formatUnitsExact(spend.toString(), decimals)
  return units === null ? null : { raw: spend.toString(), text: units.replace(/,/g, '') }
}

// ---------------------------------------------------------------------------------------------------------------------
// The form (copied from src/v2ui/s2/model.ts)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The typed amount in the origin token's raw units, exactly as `amountRaw` takes it. With known decimals: a plain
 * decimal ("100", "0.05", ".5") with at most that many places. With unknown decimals: a whole number of raw units only
 * (never a guess at the decimals). Null for anything else: empty, zero, a sign, an exponent, too many places, or 2^128
 * and above.
 *
 * Changed on purpose 2026-10-30 (QA round 2, N99): read as New position's amount step reads a typed amount
 * (lib/create/amountText.ts): spaces around it dropped, and thousands separators too ("1,500.25"), any other comma or a
 * minus refused. A funding amount Domino writes itself was grouped (./fundingBudget.ts remotePayment), so from 1,000 up it
 * was refused here, and the offer to fund it never came.
 *
 * Changed on purpose 2026-11-02 (review of the money PRs, M4): by lib/create/typedFigure.ts's rule, an ambiguous "1,250"
 * is refused (it was 1250, a thousand times the 1.25 a decimal comma means), and "1,5" is 1.5 where the person's language
 * writes a decimal comma. remotePayment writes its amount with no separator now. `decimal`: handed in by a test.
 */
export function amountRawOf(text: string, decimals: number | null, decimal?: Decimal): string | null {
  const read = amountText(text, decimal)
  if (!read.ok) return null
  const value = read.text
  let raw: bigint
  if (!knownDecimals(decimals)) {
    if (!/^[0-9]{1,78}$/.test(value)) return null
    raw = BigInt(value)
  } else {
    if (!/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(value) || value.length > 120) return null
    const [whole = '', fraction = ''] = value.split('.')
    if (fraction.length > decimals) return null
    raw = BigInt((whole || '0') + fraction.padEnd(decimals, '0'))
  }
  if (raw <= 0n || raw >= RAW_LIMIT) return null
  return raw.toString()
}

/** Slippage typed as a percent ("0.5", "2", "0.25") as whole basis points within the service's 10 to 500; else null. */
export function slippageBpsOf(text: string): number | null {
  const value = text.trim().replace(/%$/, '').trim()
  if (!/^(?:[0-9]{1,3}(?:\.[0-9]{0,2})?|\.[0-9]{1,2})$/.test(value)) return null
  const [whole = '', fraction = ''] = value.split('.')
  const bps = Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(bps) && bps >= FUNDS_MIN_SLIPPAGE_BPS && bps <= FUNDS_MAX_SLIPPAGE_BPS ? bps : null
}

/** Basis points as the percent the field shows: 50 → "0.5", 200 → "2", 25 → "0.25". */
export function slippageText(bps: number): string {
  const whole = Math.floor(bps / 100)
  const fraction = String(bps % 100).padStart(2, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}

/**
 * §3.9 (revision 2, with decision #9): whether "Get gas on {destination}" (`destinationGas`) is shown, and why. Never for
 * a native delivery (the service refuses it with ETH). The native balance on the destination is a reading (the amount
 * step's own, or the wallet's while it is on that chain); read-v6 carries no balances (§6.2).
 *   - `suggested`: the balance was read and lacks (at most FUNDS_SUGGEST_DESTINATION_GAS_AT_OR_BELOW_WEI);
 *   - `undecided`: no balance read: the option is shown for the person to decide;
 *   - null: the balance was read and covers network fees there: not shown.
 */
export type DestinationGasOffer = 'suggested' | 'undecided' | null

export function offerDestinationGas(destinationToken: string, nativeBalanceRaw: string | null): DestinationGasOffer {
  if (lower(destinationToken) === ZERO) return null
  if (nativeBalanceRaw === null || !RAW.test(nativeBalanceRaw)) return 'undecided'
  return BigInt(nativeBalanceRaw) <= FUNDS_SUGGEST_DESTINATION_GAS_AT_OR_BELOW_WEI ? 'suggested' : null
}

/** A token of the origins listing, by chain and address; null when the listing has no such token. */
export function originToken(list: OriginsList, chainId: number | null, address: string | null): OriginToken | null {
  if (chainId === null || address === null || !ADDRESS.test(address)) return null
  return list.chains.find((c) => c.chainId === chainId)?.tokens.find((t) => lower(t.address) === lower(address)) ?? null
}

/**
 * The quote request the form makes: exactly the nine fields, addresses lowercase (§3.4). Changed on purpose (data)
 * 2026-10-06 (crosschain-v1 1.1.0-rc.1): by exact input, `amountKind: 'exact_input'` and `maxInputRaw: null`; with
 * `maxInputRaw` (Changed on purpose 2026-10-06, rugged's delta of 6 Oct §3: a one click sizes what it brings with ONE
 * quote), by output: `amountRaw` is what must arrive (destination units) and `maxInputRaw` the most the wallet may send
 * (the chosen coin's sendable balance, origin units).
 */
export function quoteRequestOf(input: {
  originChainId: number
  originToken: string
  destinationChainId: CrosschainRequests['quote']['destinationChainId']
  destinationToken: string
  amountRaw: string
  slippageBps: number
  destinationGas: boolean
  maxInputRaw?: string
}): CrosschainRequests['quote'] {
  const output = input.maxInputRaw !== undefined
  return {
    originChainId: input.originChainId,
    originToken: lower(input.originToken),
    destinationChainId: input.destinationChainId,
    destinationToken: lower(input.destinationToken),
    amountKind: output ? 'output' : 'exact_input',
    amountRaw: input.amountRaw,
    maxInputRaw: output ? (input.maxInputRaw ?? null) : null,
    slippageBps: input.slippageBps,
    destinationGas: input.destinationGas,
  }
}

/**
 * Added 2026-10-06 (rugged's delta of 6 Oct §3): a quote by output with no decision because its priced candidates need
 * more than the wallet may send (`input_above_max`): what each needs, rounded up ("Relay needs 100.92 USDC"), and the most
 * that can be sent, rounded down, for FUNDS_TEXT.aboveMax. Null for any other quote (pure).
 */
export function aboveMaxOf(quote: QuotePlan, name: Naming): { needs: string[]; max: string } | null {
  const { request } = quote
  const above = quote.candidates.filter((c) => c.status === 'input_above_max' && c.inputRaw !== null)
  if (request.amountKind !== 'output' || request.maxInputRaw === null || quote.decision !== null || above.length === 0) return null
  const info = name.book(request.originChainId, request.originToken)
  return {
    needs: above.map((c) => `${PROVIDER_NAME[c.provider]} needs ${shortAmountText(c.inputRaw ?? '0', request.originToken, info, 'up')}`),
    max: shortAmountText(request.maxInputRaw, request.originToken, info),
  }
}

/**
 * What the quote's wallet steps send (Added 2026-10-06, crosschain-v1 1.1.0-rc.1): the winner's `inputRaw`, the amount
 * asked when the quote is by exact input; the request's amount while no candidate won.
 */
export function sentRaw(quote: QuotePlan): string {
  const winner = quote.candidates.find((c) => c.provider === quote.decision)
  return winner?.inputRaw ?? quote.request.amountRaw
}

/**
 * The wallet steps of a quote in words (§3.6): the switch, the approval (ERC-20 only) and the deposit, with the amount
 * sent, rounded for the screen and exact (Changed on purpose 2026-10-06, the owner's point 4). Changed on purpose
 * 2026-10-06 (the integration review): rounded UP, since it is what the wallet is asked to approve and send, so the
 * button never says less than leaves the wallet. Changed on purpose (data) 2026-10-06 (crosschain-v1 1.1.0-rc.1): the
 * amount is what the winner's deposit takes (sentRaw), the same as the request's while it asks by exact input.
 */
export function stepWords(quote: QuotePlan, name: Naming): { origin: string; amount: string; exact: string; approval: boolean } {
  const { request } = quote
  const origin = name.origin(request.originChainId) ?? `network ${request.originChainId}`
  const info = name.book(request.originChainId, request.originToken)
  const sent = sentRaw(quote)
  const exact = info !== null && knownDecimals(info.decimals) ? `${formatUnitsExact(sent, info.decimals) ?? sent} ${tokenLabel(request.originToken, info.symbol)}` : shortAmountText(sent, request.originToken, info)
  return { origin, amount: shortAmountText(sent, request.originToken, info, 'up'), exact, approval: lower(request.originToken) !== ZERO }
}

/**
 * Added 2026-10-06 (the owner's point 4: one live status line while the wallet works): where the deposit's wallet steps
 * stand, as one short line: "Step 1 of 2 · approve in your wallet". `approval`: the quote's token is an ERC-20 whose
 * approval is not known to be covered yet. Null before the first step.
 */
export type RunStage = 'switching' | 'reviewing' | 'approval_wallet' | 'approval_sent' | 'approval_done' | 'approval_skipped' | 'deposit_wallet'
export function runLine(stage: RunStage | null, approval: boolean, origin: string): string | null {
  if (stage === null) return null
  const total = approval ? 2 : 1
  // One step alone (ETH, or an approval already there) is a sentence of its own (Changed on purpose 2026-10-06, the review).
  const step = (index: number, words: string) => (total > 1 ? `Step ${index} of ${total} · ${words}` : `${words.charAt(0).toUpperCase()}${words.slice(1)}`)
  switch (stage) {
    case 'switching':
      return `Switching to ${origin} · confirm in your wallet`
    case 'reviewing':
      return `Checking your wallet on ${origin}…`
    case 'approval_wallet':
      return step(1, 'approve in your wallet')
    case 'approval_sent':
      return step(1, 'waiting for the approval…')
    case 'approval_done':
    case 'approval_skipped':
      return step(total, 'getting the deposit ready…')
    case 'deposit_wallet':
      return step(total, 'confirm in your wallet')
  }
}

/** "Relay, Across": the providers that bridge a token, by name. */
export const providerNames = (providers: readonly ('relay' | 'across')[]) => providers.map((p) => PROVIDER_NAME[p]).join(', ')

/** What a failed origins or quote request says, its code for a data-error-code attribute, and when it asks again by itself. */
export interface RequestFailure {
  copy: string
  code: string | null
  /** Milliseconds until the page asks again by itself; null: it does not (the person changes something, or nothing helps). */
  retryMs: number | null
  /** The offer stops: the route is not there (route_not_available, not deployed). */
  featureOff: boolean
  /** A new quote is due now (preview_expired, or a quote that arrived already expired). */
  requote: boolean
}

const grow = (attempt: number, base = FUNDS_REQUEST_RETRY_MS) => Math.min(300_000, base * 2 ** Math.max(0, attempt - 1))

/**
 * Added 2026-10-30 (launch capacity, CAP-5 and CAP-6; its review): how long, at least, a failed preparation of the offer
 * waits before it is prepared again by itself (./BringFunds.tsx). No route for these tokens right now
 * (funding_routes_busy) waits a minute; so does a capacity-busy refusal, whose two quick quiet retries the quote already
 * spent (requestFailure: 4 to 5 s apart), so a busy service is never asked three more times every few seconds. Anything
 * else waits FUNDS_REQUEST_RETRY_MS. The failure's own wait applies when it is longer.
 */
export const preparationRetryFloor = (code: string | null | undefined): number =>
  code === 'funding_routes_busy' || isCapacityBusy(code) ? FUNDS_ROUTES_BUSY_RETRY_MS : FUNDS_REQUEST_RETRY_MS

/**
 * The client's failure as the offer says it (§3.8 through v2/crosschain/errors.ts; the client's own words otherwise).
 * `attempt` counts the failures in a row, for the growing wait. No Retry button anywhere: transient failures ask again.
 */
export function requestFailure(failure: CrosschainFailure, attempt: number): RequestFailure {
  const base = { code: null, retryMs: null, featureOff: false, requote: false }
  switch (failure.kind) {
    case 'aborted':
      return { ...base, copy: '' }
    case 'session_gone':
      return { ...base, copy: FAILURE_COPY.session_gone }
    case 'gate_required':
      return { ...base, copy: FAILURE_COPY.gate_required }
    case 'gate_unavailable':
      return { ...base, copy: FAILURE_COPY.gate_unavailable, retryMs: grow(attempt, 60_000) }
    case 'not_deployed':
      return { ...base, copy: FAILURE_COPY.not_deployed, featureOff: true }
    case 'request_invalid':
      return { ...base, copy: FAILURE_COPY.request_invalid }
    case 'expired':
      return { ...base, copy: FAILURE_COPY.expired, requote: true }
    case 'network':
      return { ...base, copy: FAILURE_COPY.network, retryMs: grow(attempt) }
    case 'timeout':
      return { ...base, copy: FAILURE_COPY.timeout, retryMs: grow(attempt) }
    case 'contract':
      return {
        ...base,
        copy: FAILURE_COPY[failure.detail === 'owner' ? 'owner' : failure.detail === 'echo' ? 'echo' : 'contract'],
        retryMs: attempt <= 1 ? grow(attempt) : null,
      }
    case 'error': {
      const d = errorDisposition(failure.code)
      const out = { ...base, copy: d.copy, code: d.code }
      switch (d.next) {
        case 'retry':
          return { ...out, retryMs: grow(attempt) }
        case 'later':
          return { ...out, retryMs: grow(attempt, 60_000) }
        case 'backoff':
          // Changed on purpose 2026-10-30 (launch capacity, CAP-6): a capacity-busy refusal waits 4 to 5 s, whatever
          // Retry-After it names (finance/v2/requestCoordinator.ts capacityBusyWait); a rate limit keeps its Retry-After.
          if (isCapacityBusy(failure.code)) return { ...out, retryMs: capacityBusyWait() }
          return { ...out, retryMs: Math.min(300_000, (failure.retryAfterS ?? 60) * 1000 * 2 ** Math.max(0, attempt - 1)) }
        case 'retry_once':
          return { ...out, retryMs: attempt <= 1 ? grow(attempt) : null }
        case 'requote':
          return { ...out, requote: true }
        case 'feature_off':
          return { ...out, featureOff: true }
        case 'session':
        case 'account':
        case 'edit':
        case 'stop':
        case 'stop_polling':
          return out
      }
    }
  }
}

// ---- the one click "Bring it from {network}" (Changed on purpose 2026-10-05, ./BringFunds.tsx bringFrom) ----------------

/** Ether (ETH or WETH) or a dollar (the chain's stable): the two kinds of token a deposit delivers (§3.3). */
export type Kind = 'ether' | 'dollar'

/**
 * A token's kind on one of Domino's networks, by its profile: ETH and WETH are ether, the stable (its rank-1 charge
 * currency) a dollar; anything else, and any token of another network, null (pure). Added 2026-10-06.
 * Changed on purpose 2026-10-06 (rugged97's #379: chain-balances reads Ethereum and OP Mainnet when asked): on those two,
 * by their balance-chain profiles (v2/balanceChains.ts) the same way, so what is held there joins the line, the networks,
 * the sizing and the token to pay with as any of Domino's networks' holdings do.
 * Changed on purpose 2026-11-07 (Elysium's screens): a network whose own currency is not Ether (Elysium's HYPE and WHYPE)
 * has no ether: its HYPE is never brought as ETH. Its dollar token is a dollar as anywhere else.
 */
export function kindOf(chainId: number, token: string): Kind | null {
  const elsewhere = balanceChain(chainId)
  if (elsewhere !== null) {
    const held = lower(token)
    return held === ZERO || held === elsewhere.wrapped ? 'ether' : held === elsewhere.stable ? 'dollar' : null
  }
  if (!isV2ChainId(chainId)) return null
  const chain = v2Chain(chainId)
  const address = lower(token)
  if (address === ZERO || address === lower(chain.wrappedNative.address)) return chain.nativeSymbol === 'ETH' ? 'ether' : null
  return chain.chargeCurrencies.some((c) => c.rank === 1 && lower(c.address) === address) ? 'dollar' : null
}

/**
 * What can be sent of a holding: all of a token; native ETH less the gas Review keeps (lib/create/reviewPlan.ts maxSpend).
 * Changed on purpose 2026-10-06 (the review of rugged97's #379): native ETH less the gas its own deposit takes in that
 * network's gas: on Ethereum FUNDS_ETHEREUM_GAS_RESERVE_WEI; on Domino's three and OP Mainnet, rollups, the gas Review
 * keeps, as before (Review's allowance is sized to their gas, never to Ethereum's) (pure).
 */
export function sendable({ chainId, token, raw }: Pick<Holding, 'chainId' | 'token' | 'raw'>): bigint {
  const kept = token !== ZERO ? 0n : chainId === 1 ? FUNDS_ETHEREUM_GAS_RESERVE_WEI : REVIEW_GAS_RESERVE_WEI
  return raw > kept ? raw - kept : 0n
}

/**
 * The holding to send for `target` on `destination` (pure): one the listing bridges from that network, the same kind of
 * token first (ETH or WETH for ether, the dollar for a dollar), native ETH before WETH; else the other kind.
 * Changed on purpose 2026-10-06 (the owner's point 2b): with `need` (the target's shortfall), a holding of the same kind
 * that covers it comes before one that does not, so a little ETH never stands in for the WETH that covers the position.
 */
export function holdingFor(
  holdings: readonly Holding[],
  target: string,
  destination: V2ChainId,
  origin: number,
  list: OriginsList,
  need: { raw: bigint; decimals: number } | null = null,
): Holding | null {
  const wanted = kindOf(destination, target)
  const covers = (holding: Holding) => need === null || sendable(holding) >= convertUnits(need.raw, need.decimals, holding.decimals)
  const rank = (holding: Holding) => {
    const kind = kindOf(origin, holding.token)
    const same = kind !== null && kind === wanted
    return (same ? 0 : 4) + (same && !covers(holding) ? 2 : 0) + (kind === 'ether' && holding.token !== ZERO ? 1 : 0)
  }
  return holdings.filter((holding) => holding.raw > 0n && originToken(list, origin, holding.token) !== null).sort((a, b) => rank(a) - rank(b))[0] ?? null
}

/**
 * The pool token a holding of `kind` is brought as (the owner's target rule, 2026-10-06): the one of the same kind
 * (a dollar to the stable, ether to ETH or WETH), else the other one a deposit can deliver. `deliverable`: the
 * position's tokens a deposit can deliver to `destination`, in pool order. Null when there is none (pure).
 */
export function targetFor(kind: Kind | null, deliverable: readonly string[], destination: number): string | null {
  return deliverable.find((token) => kind !== null && kindOf(destination, token) === kind) ?? deliverable[0] ?? null
}

/** The position's tokens a deposit can deliver to `destination` (§3.3: its stable, ETH or WETH), lowercase, in pool order. */
export function deliverableTokens(destination: number, poolTokens: readonly string[]): string[] {
  const choices = destinationChoices().find((d) => d.chainId === destination)?.tokens ?? []
  return poolTokens.map(lower).filter((token) => choices.some((c) => lower(c.address) === token))
}

/** `raw` in `from` decimals as `to` decimals (pure; rounding up, so a converted need is never short). */
export function convertUnits(raw: bigint, from: number, to: number): bigint {
  if (to >= from) return raw * 10n ** BigInt(to - from)
  const scale = 10n ** BigInt(from - to)
  return (raw + scale - 1n) / scale
}

/**
 * An amount with FUNDS_FIRST_GUESS_ROOM_BPS more for the fees and the slippage, rounded up (pure). Changed on purpose
 * 2026-10-06 (crosschain-v1 1.1.0-rc.1, rugged's delta of 6 Oct §3): only to choose the holding (bringChoice); the
 * amount itself is the service's, by output.
 */
function withFeeRoom(raw: bigint): bigint {
  return (raw * (10_000n + BigInt(FUNDS_FIRST_GUESS_ROOM_BPS)) + 9_999n) / 10_000n
}

/**
 * Added 2026-10-06 (the review of 2026-10-06: the cap bounded only typed changes): how long one more quote must wait, from
 * when the page asked its quotes (`asked`, ms on the page clock): none while fewer than FUNDS_TYPED_QUOTES_PER_MINUTE were
 * asked in the last minute; else until the oldest of them drops out (pure).
 */
export function quoteBudgetWait(asked: readonly number[], now: number): number {
  const recent = asked.filter((at) => now - at < 60_000)
  if (recent.length < FUNDS_TYPED_QUOTES_PER_MINUTE) return 0
  return Math.max(0, Math.min(...recent) + 60_000 - now)
}

/**
 * Added 2026-10-06 (the owner's point 4: the amount re-quotes by itself): how long to wait before asking a change's quote
 * (a typed amount, a re-size, "Get gas"): the debounce, or longer while the cap holds every quote back (pure).
 */
export function typedQuoteWait(asked: readonly number[], now: number): number {
  return Math.max(FUNDS_TYPED_QUOTE_DEBOUNCE_MS, quoteBudgetWait(asked, now))
}

/**
 * The USD price, in micro-dollars per whole token, of each kind of token a chain-balances answer priced (Added 2026-10-06,
 * the review of 2026-10-06): ether from any network's ETH or WETH, a dollar from any network's stable (read-v6 prices from
 * qualified sources only). Used only to size a first quote of another kind of token; never shown (pure).
 */
export interface KindPrices {
  ether: bigint | null
  dollar: bigint | null
}

export function kindPrices(answer: ChainBalancesResponse | null): KindPrices {
  const found: KindPrices = { ether: null, dollar: null }
  for (const chain of answer?.chains ?? []) {
    if (chain.status !== 'current') continue
    for (const balance of chain.balances) {
      const kind = kindOf(chain.chainId, balance.address)
      const usd = balance.price ? microUsd(balance.price.usd) : null
      if (kind !== null && found[kind] === null && usd !== null && usd > 0n) found[kind] = usd
    }
  }
  return found
}

/** About how much of a token worth `sentUsd` is worth `need` of one worth `needUsd` (micro-dollars per whole token), rounded up; null without both prices (pure). */
export function worthIn(need: bigint, needDecimals: number, needUsd: bigint | null, sentDecimals: number, sentUsd: bigint | null): bigint | null {
  if (needUsd === null || sentUsd === null || needUsd <= 0n || sentUsd <= 0n || need <= 0n) return null
  const num = need * needUsd * 10n ** BigInt(sentDecimals)
  const den = 10n ** BigInt(needDecimals) * sentUsd
  return (num + den - 1n) / den
}

/** A holding's worth in micro-dollars at its kind's price; null without one (pure). */
const worthOf = (holding: Holding, origin: number, prices: KindPrices): bigint | null => {
  const kind = kindOf(origin, holding.token)
  const usd = kind === null ? null : prices[kind]
  return usd === null ? null : (holding.raw * usd) / 10n ** BigInt(holding.decimals)
}

/** What one network's holdings bring (Added 2026-10-06): the lack served (null before an amount), the holding, and the pool token it arrives as. */
export interface BringChoice {
  lack: Lack | null
  holding: Holding
  target: string
}

/**
 * The lack and the holding to bring for it from one network, chosen together (Added 2026-10-06, the review of 2026-10-06:
 * a little ETH there was brought for the ETH the position lacks while 1,000 USDC there covered the USDC it lacks). In order:
 *   1. a lack with a figure (one with none opens the amount field for the person);
 *   2. a holding that covers that figure, with room for the fees: the same kind by decimals, another kind at the prices
 *      Domino's service read (with no price, not known to cover);
 *   3. the same kind (a plain bridge, which Relay and Across both quote; Across admits no other);
 *   4. among those that cover, the lacks' order (the token Review's plan is short of first), then native ETH (one
 *      transaction, a token's approval being the other); among those that don't, the one worth more (the larger
 *      position), then native ETH, then the lacks' order.
 * Before an amount (no lacks): the holding of a kind a pool token shares first, then the one worth more, then native ETH;
 * brought as that kind (targetFor). Null when no holding can be brought (pure).
 */
export function bringChoice(input: {
  lacks: readonly Lack[]
  holdings: readonly Holding[]
  destination: number
  origin: number
  deliverable: readonly string[]
  prices: KindPrices
}): BringChoice | null {
  const { lacks, holdings, destination, origin, deliverable, prices } = input
  type Ranked = BringChoice & { key: readonly bigint[] }
  const ranked: Ranked[] = []
  const usable = holdings.filter((holding) => holding.raw > 0n && sendable(holding) > 0n)
  const native = (holding: Holding) => (holding.token === ZERO ? 0n : 1n)
  // Worth more first: larger worths make smaller keys; an unknown worth after every known one.
  const rich = (holding: Holding) => {
    const worth = worthOf(holding, origin, prices)
    return worth === null ? 1n : -1n - worth
  }
  if (lacks.length === 0) {
    for (const holding of usable) {
      const kind = kindOf(origin, holding.token)
      const target = targetFor(kind, deliverable, destination)
      if (target === null) continue
      const same = kind !== null && kind === kindOf(destination, target) ? 0n : 1n
      ranked.push({ lack: null, holding, target, key: [same, rich(holding), native(holding)] })
    }
  } else {
    lacks.forEach((lack, index) => {
      const wanted = kindOf(destination, lack.token)
      for (const holding of usable) {
        const kind = kindOf(origin, holding.token)
        const same = wanted !== null && kind === wanted
        const figure = lack.shortRaw !== null && lack.shortRaw > 0n ? lack.shortRaw : null
        const need =
          figure === null ? null : same ? convertUnits(figure, lack.decimals, holding.decimals) : wanted !== null && kind !== null ? worthIn(figure, lack.decimals, prices[wanted], holding.decimals, prices[kind]) : null
        const covers = need !== null && sendable(holding) >= withFeeRoom(need)
        const order = covers ? [BigInt(index), native(holding)] : [rich(holding), native(holding), BigInt(index)]
        ranked.push({ lack, holding, target: lack.token, key: [figure === null ? 1n : 0n, covers ? 0n : 1n, same ? 0n : 1n, ...order] })
      }
    })
  }
  const first = (a: Ranked, b: Ranked): number => {
    for (let i = 0; i < Math.max(a.key.length, b.key.length); i += 1) {
      const x = a.key[i] ?? 0n
      const y = b.key[i] ?? 0n
      if (x !== y) return x < y ? -1 : 1
    }
    return 0
  }
  const best = ranked.sort(first)[0]
  return best ? { lack: best.lack, holding: best.holding, target: best.target } : null
}

/** A step held unsettled (finance/v2/crosschain.ts UnsettledOffer), as much of it as the offer's choices read. */
export interface HeldStep {
  originChainId: number
  kind: 'approval' | 'deposit'
  destinationChainId: number
}

/**
 * Whether the line and the networks are held back (Added 2026-10-06, the review: after a deposit, the line offered the
 * funds just bridged once more): while what the position lacks here may still change by itself, so a second bridge is
 * never offered while the first may be on its way: a deposit this page sent and not yet settled (the balances read are
 * from before it left; they are read again once it is settled), or a deposit held unsettled for this destination.
 * A deposit followed since a reload holds nothing back: the balances were read after it left. Changed on purpose
 * 2026-10-06 (the integration review: one approval left unanswered on Base hid every network, for every position): any
 * other held step holds back only its own origin (heldOrigins), as the sender refuses only that origin (pure).
 */
export function holdOffers(deposits: readonly { sentHere: boolean; hash: string }[], settled: ReadonlySet<string>, held: readonly HeldStep[], destination: number): boolean {
  return deposits.some((d) => d.sentHere && !settled.has(d.hash)) || heldMayArrive(held, destination)
}

/**
 * Whether a step held unsettled may still arrive at `destination`: a deposit held for it, never an approval (nothing moves)
 * nor a deposit held for another network (Added 2026-10-06, the integration review: holdOffers and the offer's "On the
 * way" read the same rule) (pure).
 */
export const heldMayArrive = (held: readonly HeldStep[], destination: number): boolean => held.some((step) => step.kind === 'deposit' && step.destinationChainId === destination)

/** The origins a held step keeps closed: nothing more is offered from them until it is settled (Added 2026-10-06, pure). */
export const heldOrigins = (held: readonly HeldStep[]): ReadonlySet<number> => new Set(held.map((step) => step.originChainId))

/**
 * The bundled mark of a holding on one of Domino's networks, by its address only (Added 2026-10-06, the review: the line
 * asked for a symbol's file that is not there): its ETH, its WETH, Robinhood Chain's USDG; else none (a plain disc).
 * Changed on purpose 2026-10-06 (rugged97's #379): on Ethereum and OP Mainnet, their ETH and WETH by their balance-chain
 * profiles; their USDC has no bundled mark, as on Base and Arbitrum One. Changed on purpose 2026-11-06 (Elysium
 * readiness): a V2 chain's native currency and wrapped token take Ether's and WETH's marks only where they are Ether's
 * (v2/chains.ts nativeArtwork, wrappedArtwork); HYPE and WHYPE have none bundled. The balance chains' are Ether's.
 */
export function holdingArtwork(chainId: number, token: string): 'ETH' | 'WETH' | 'USDG' | null {
  const elsewhere = balanceChain(chainId)
  if (elsewhere !== null) return lower(token) === ZERO ? 'ETH' : lower(token) === elsewhere.wrapped ? 'WETH' : null
  if (!isV2ChainId(chainId)) return null
  const address = lower(token)
  const chain = v2Chain(chainId)
  if (address === ZERO) return nativeArtwork(chain)
  if (address === lower(chain.wrappedNative.address)) return wrappedArtwork(chain)
  return chainId === 4663 && chain.chargeCurrencies.some((c) => c.rank === 1 && lower(c.address) === address) ? 'USDG' : null
}

/**
 * The networks read-v6's chain-balances reads (its BalanceTokenRef chainId: Domino's three). A request that names any
 * other network is refused whole (src/v2/read/v6.ts checks the request first), so nothing else is ever asked.
 * Changed on purpose 2026-10-06 (rugged97's #379, read-v6 1.1.0-rc.1, additive): the service also reads Ethereum and OP
 * Mainnet when a request names them, but never in this request: they go in one of their own (balanceChainsRequest), so a
 * Worker that still refuses them cannot take Domino's three with them. These stay Domino's three.
 */
export const SERVED_BALANCE_CHAINS: readonly number[] = Object.freeze([4663, 8453, 42161])

/**
 * Added 2026-10-06 (rugged97's delta of 5 Oct, item 3: read-v6's chain-balances): the tokens to ask Domino's service about
 * for the offer: every other network's ETH, WETH and stable that the service reads (finance/v2/holdings.ts
 * CANDIDATE_ORIGINS within SERVED_BALANCE_CHAINS), in that order; then, Changed on purpose 2026-10-06 (the owner's point
 * 1), the destination's own ETH, for "Get gas on {destination}" (§3.9). Changed on purpose 2026-10-06 (the owner: AI/PONS
 * short on Robinhood Chain, nothing offered): and its WETH and stable, so "Pay with … instead" knows what the wallet holds
 * there and what each kind is worth (`payToken`, `balanceOn`). Nine tokens, within the service's 24.
 */
export function balancesRequest(destination: number): { chainId: number; address: string }[] {
  const served = CANDIDATE_ORIGINS.filter((candidate) => SERVED_BALANCE_CHAINS.includes(candidate.chainId))
  return [...served.filter((candidate) => candidate.chainId !== destination), ...served.filter((candidate) => candidate.chainId === destination)].flatMap((candidate) =>
    candidate.tokens.map((token) => ({ chainId: candidate.chainId, address: token.address.toLowerCase() })),
  )
}

/**
 * Added 2026-10-06 (rugged97's #379, read-v6 1.1.0-rc.1, additive; the owner's decision of 6 Oct): the balance chains
 * Domino's service reads when a request names them, Ethereum and OP Mainnet (BALANCE_ORIGINS: those crosschain-v1 bridges
 * from), never the destination: each one's ETH, WETH and stable from its balance-chain profile (v2/balanceChains.ts), in
 * that order. A request of their OWN, never part of balancesRequest's: rugged97's rollout moves the reader, then the
 * Worker, then the app, so while the Worker still refuses them, or their answer cannot be had, only they go unread and
 * Domino's three are read exactly as before. Six tokens, within the service's 24; none when there is no such network.
 */
export function balanceChainsRequest(destination: number): { chainId: number; address: string }[] {
  const own = BALANCE_CHAINS.filter((chain) => chain.chainId !== destination && BALANCE_ORIGINS.includes(chain.chainId)).flatMap((chain) =>
    chain.tokens.map((token) => ({ chainId: chain.chainId, address: token.address })),
  )
  // Added 2026-11-07 (Elysium's screens): Elysium, where funds can come from it, in this request of its own too, so a
  // service that does not read it yet cannot take Domino's three with it (its tokens: finance/v2/holdings.ts CANDIDATE_ORIGINS).
  if (!ELYSIUM_FUNDS_FROM || destination === ELYSIUM_V2_ID) return own
  return [...own, ...(originCandidate(ELYSIUM_V2_ID)?.tokens ?? []).map((token) => ({ chainId: ELYSIUM_V2_ID, address: token.address.toLowerCase() }))]
}

/**
 * Added 2026-10-06 (rugged97's #379): what Domino's service read in the two requests (balancesRequest, and
 * balanceChainsRequest) as ONE answer for the offer's choices: Domino's networks first, as read, then the balance chains
 * (a chain both name, which neither request does, is Domino's read's), so whatever is taken from the first chain that has
 * it (kindPrices) is still Domino's networks' first. Either alone is itself, untouched: a balance chains' read that failed,
 * or was refused, leaves Domino's answer exactly as it was (and theirs stay unread, never empty); neither is none. Nothing
 * is summed across the two reads (the owner, 2 Oct: no sum across chains without all of them, read together): the
 * answer's own total is none, while each chain keeps its own (pure).
 */
export function mergeBalances(domino: ChainBalancesResponse | null, elsewhere: ChainBalancesResponse | null): ChainBalancesResponse | null {
  if (domino === null || elsewhere === null) return domino ?? elsewhere
  const chains = [...domino.chains, ...elsewhere.chains.filter((chain) => !domino.chains.some((own) => own.chainId === chain.chainId))]
  return { ...domino, coverage: domino.coverage === 'complete' && elsewhere.coverage === 'complete' ? 'complete' : 'partial', chains, totalUsd: null }
}

/**
 * Added 2026-10-06 (rugged97's #379): a network the offer may bring from as the app's one table names it (lib/networkName.ts,
 * through v2/crosschain/present.ts OWN_NETWORK_NAMES): "Base", "Arbitrum One", "Ethereum", "OP Mainnet" (pure).
 */
export const originName = (chainId: number): string => networkName(chainId, null) ?? `network ${chainId}`

/**
 * Added 2026-10-06 (rugged97's #379): the network the offer reads holdings on, with the tokens read there: one of Domino's
 * from finance/v2/holdings.ts CANDIDATE_ORIGINS; Ethereum and OP Mainnet from their balance-chain profiles, the very tokens
 * balanceChainsRequest asks, named by the app's one table; null for any other (pure).
 */
export function originCandidate(chainId: number): OriginCandidate | null {
  const elsewhere = balanceChain(chainId)
  if (elsewhere !== null) return { chainId, name: originName(chainId), tokens: elsewhere.tokens }
  return CANDIDATE_ORIGINS.find((candidate) => candidate.chainId === chainId) ?? null
}

/**
 * Added 2026-10-06: one balance as a chain-balances answer read it, raw, with its token's USD price per whole token
 * (qualified, 18 decimals; null without one); null when that network or that balance was not read (pure).
 */
export function balanceOn(answer: ChainBalancesResponse, chainId: number, token: string): { raw: bigint; usd: string | null } | null {
  const chain = answer.chains.find((entry) => entry.chainId === chainId)
  const read = chain?.status === 'current' ? chain.balances.find((entry) => entry.address.toLowerCase() === lower(token)) : undefined
  return read && read.status === 'read' && read.balanceRaw !== null && /^\d+$/.test(read.balanceRaw) ? { raw: BigInt(read.balanceRaw), usd: read.price?.usd ?? null } : null
}

/**
 * Added 2026-10-06 (./FundsAmounts.tsx, the deposit paid with one other token): what paying `text` of it lacks on its
 * network, against its balance there as Domino's service read it (`here`; null: unread, so nothing is said to lack), as the
 * zap path's offer works it out for its inputs (lackingZapTokens) (pure).
 */
export function payLacks(chainId: number, token: string, text: string, decimals: number | null, here: bigint | null): Lack[] {
  const raw = amountRawOf(text, decimals)
  return lackingZapTokens({ chainId, inputs: raw === null ? null : [{ token, amount: BigInt(raw) }], balances: here === null ? null : new Map([[token, here]]) })
}

/** A network's ETH as a chain-balances answer read it, raw; null when that network or that balance was not read (pure). */
export const nativeOn = (answer: ChainBalancesResponse, chainId: number): bigint | null => balanceOn(answer, chainId, ZERO)?.raw ?? null

/** Preferred observed payment asset. A bridgeable pool token never suppresses local alternatives. */
export function payToken(chainId: number, poolTokens: readonly string[], answer: ChainBalancesResponse | null): { address: string; symbol: string; decimals: number } | null {
  const first = payCandidates(chainId, poolTokens, answer)[0]
  return first ? { address: first.address, symbol: first.symbol, decimals: first.decimals } : null
}

/** Actual payment candidates. Local spendable funds take priority; ETH and WETH retain their own identities. */
export function payCandidates(chainId: number, poolTokens: readonly string[], answer: ChainBalancesResponse | null): { address: string; symbol: string; decimals: number; origins: number[] }[] {
  if (!answer) return []
  const pool = new Set(poolTokens.map(lower))
  const tokens = originCandidate(chainId)?.tokens.filter((token) => !pool.has(lower(token.address))) ?? []
  const native = nativeOn(answer, chainId)
  const local = tokens.flatMap((token) => {
    const balance = balanceOn(answer, chainId, token.address)
    const available = balance ? maxSpend(balance.raw, token.address === ZERO) : 0n
    if (available <= 0n) return []
    const value = valueUsdOf(answer, chainId, token.address)
    const worth = value === null ? null : microUsd(value)
    const spendableWorth = worth === null || !balance || balance.raw === 0n ? null : worth * available / balance.raw
    return [{ ...token, origins: [] as number[], gas: token.address === ZERO || (native !== null && native >= REVIEW_GAS_RESERVE_WEI), worth: spendableWorth }]
  }).sort((a, b) => Number(b.gas) - Number(a.gas) || (a.worth !== null && b.worth !== null ? (a.worth > b.worth ? -1 : a.worth < b.worth ? 1 : 0) : 0))
  const result = local.map(({ gas: _gas, worth: _worth, ...token }) => token)
  // Directly bridgeable pool tokens already have their own funding offer. Other pools need a destination
  // payment asset, but only when the wallet actually holds usable source funds of that kind.
  if (deliverableTokens(chainId, poolTokens).length === 0) {
    for (const target of tokens.filter((token) => token.address === ZERO || kindOf(chainId, token.address) === 'dollar')) {
      const origins = answer.chains.filter((chain) => chain.chainId !== chainId && chain.status === 'current').filter((chain) => {
        const gas = nativeOn(answer, chain.chainId)
        return gas !== null && gas > 0n && chain.balances.some((balance) => {
          const held = balanceOn(answer, chain.chainId, balance.address)
          return held !== null && kindOf(chain.chainId, balance.address) === kindOf(chainId, target.address) && sendable({ chainId: chain.chainId, token: balance.address, raw: held.raw }) > 0n
        })
      }).map((chain) => chain.chainId)
      const existing = result.find((token) => token.address === target.address)
      if (existing) existing.origins = origins
      else if (origins.length > 0) result.push({ ...target, origins })
    }
  }
  return result
}

/** One balance's value in USD as the answer gives it (a qualified price only, read-v6 1.1.0-rc.1); null without one (pure). */
export function valueUsdOf(answer: ChainBalancesResponse, chainId: number, token: string): string | null {
  const chain = answer.chains.find((entry) => entry.chainId === chainId)
  if (!chain || chain.status !== 'current') return null
  return chain.balances.find((entry) => entry.address.toLowerCase() === lower(token))?.valueUsd ?? null
}

/** A USD decimal ("100.5") in micro-dollars; null for anything else. */
const microUsd = (value: string): bigint | null => {
  const match = /^(\d{1,30})(?:\.(\d{1,18}))?$/.exec(value)
  return match ? BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0').slice(0, 6)) : null
}

/** Micro-dollars as a USD decimal ("1900.5"). */
const usdText = (micro: bigint): string => {
  const fraction = String(micro % 1_000_000n).padStart(6, '0').replace(/0+$/, '')
  return fraction ? `${micro / 1_000_000n}.${fraction}` : String(micro / 1_000_000n)
}

/** USD values summed, as micro-dollars written back ("1900.5"); null when any is missing or unreadable (pure). */
export function sumUsd(values: readonly (string | null)[]): string | null {
  let total = 0n
  for (const value of values) {
    const micro = value === null ? null : microUsd(value)
    if (micro === null) return null
    total += micro
  }
  return usdText(total)
}

/**
 * What can be sent of a holding (sendable) in micro-dollars, from its balance's USD as the answer gives it; null without
 * one (Added 2026-10-06, the integration review: native ETH keeps the gas Review keeps, so the value of its whole balance
 * overstated what is brought, by about the reserve's worth) (pure).
 */
function sendableMicroUsd(answer: ChainBalancesResponse, chainId: number, holding: Holding): bigint | null {
  const value = valueUsdOf(answer, chainId, holding.token)
  const micro = value === null ? null : microUsd(value)
  return micro === null || holding.raw <= 0n ? null : (micro * sendable(holding)) / holding.raw
}

/**
 * The holdings that can be brought from a network (Added 2026-10-06, the owner's point 7: no transaction that cannot go
 * through): native ETH above the gas Review keeps; a token only where that network's ETH was not read as zero, since the
 * ETH pays the approval and the deposit there. `gasless`: the tokens left out for that reason (pure).
 */
export function usableHoldings(holdings: readonly Holding[], nativeRaw: bigint | null): { usable: Holding[]; gasless: Holding[] } {
  const usable: Holding[] = []
  const gasless: Holding[] = []
  for (const holding of holdings) {
    if (holding.token === ZERO) {
      if (sendable(holding) > 0n) usable.push(holding)
    } else if (nativeRaw === 0n) gasless.push(holding)
    else usable.push(holding)
  }
  return { usable, gasless }
}

/**
 * What the service read on one of Domino's other networks, for its button in the short box (Added 2026-10-06, the
 * owner's points 1 and 3): `holds` what can be brought, with about how much in USD when every one of them is valued;
 * `no_gas` only tokens, with no ETH there to send them; `empty` nothing (the button goes); `unread` not read, or read in
 * part with nothing found: the button stays, and the wallet's own read there is the way (never a zero). Changed on
 * purpose 2026-10-06 (the integration review): the USD is of what can be sent (native ETH less the gas Review keeps),
 * and the box names those amounts (sendable).
 */
export type NetworkHolds =
  | { state: 'holds'; holdings: Holding[]; usd: string | null }
  | { state: 'no_gas'; holdings: Holding[] }
  | { state: 'empty' }
  | { state: 'unread' }

export function networkHolds(answer: ChainBalancesResponse | null, candidate: OriginCandidate): NetworkHolds {
  const report = answer ? holdingsFromChainBalances(answer, candidate) : null
  if (answer === null || report === null) return { state: 'unread' }
  const { usable, gasless } = usableHoldings(report.holdings, nativeOn(answer, candidate.chainId))
  if (usable.length > 0) {
    const values = usable.map((holding) => sendableMicroUsd(answer, candidate.chainId, holding))
    return { state: 'holds', holdings: usable, usd: values.every((micro) => micro !== null) ? usdText(values.reduce<bigint>((total, micro) => total + (micro ?? 0n), 0n)) : null }
  }
  if (report.unread.length > 0) return { state: 'unread' }
  if (gasless.length > 0) return { state: 'no_gas', holdings: gasless }
  return { state: 'empty' }
}

/** "100 USDC" for the screen (at most six decimals, rounded down), from a holding's trusted symbol and decimals. */
export const holdingText = (holding: Pick<Holding, 'raw' | 'token' | 'symbol' | 'decimals'>): string =>
  shortAmountText(holding.raw.toString(), holding.token, { symbol: holding.symbol, decimals: holding.decimals })

/**
 * The least of a kind of token the discreet line names when no price for it was read anywhere (Added 2026-10-06, the
 * integration review's second pass: unpriced, 0.0006 ETH on Base was named by its dust, "You have 0.0001 ETH on Base",
 * and quoting it reached no route): of ether, as much as the gas Review keeps (0.0005 ETH, worth FUNDS_LINE_MIN_USD or
 * more at any ether price above US$2,000); of a dollar, FUNDS_LINE_MIN_USD of it. Never shown (pure).
 */
function unpricedFloor(kind: Kind | null, decimals: number): bigint {
  if (kind === 'ether') return convertUnits(REVIEW_GAS_RESERVE_WEI, 18, decimals)
  return kind === 'dollar' ? BigInt(FUNDS_LINE_MIN_USD) * 10n ** BigInt(decimals) : 0n
}

/** A holding the discreet line names (Added 2026-10-06, the owner's point 1). */
export interface LineHolding {
  /** One of Domino's networks, or (Changed on purpose 2026-10-06, rugged97's #379) Ethereum or OP Mainnet. */
  chainId: number
  network: string
  /** As read (the whole balance); the line names what can be sent of it (sendable). */
  holding: Holding
  /** About how much what can be sent of it is worth, from a qualified price; null without one. */
  valueUsd: string | null
  /** The pool token it is brought as (targetFor). */
  target: string
}

/**
 * The one holding the discreet line under the amounts names, before an amount is typed (Added 2026-10-06, the owner's
 * point 1): on Domino's other networks as the service read them, only what can be brought (usableHoldings) and is worth
 * at least FUNDS_LINE_MIN_USD where valued, and only when the position has a token a deposit can deliver. A holding of
 * the same kind as a pool token first (a plain bridge), then the most valuable, then native ETH before WETH. Null when
 * every network read holds nothing to bring (pure).
 * Changed on purpose 2026-10-06 (the integration review: "You have 0.0006 ETH on Base (about $1.62)" brought 0.0001 ETH):
 * the value, the floor and `valueUsd` are of what can be sent (native ETH less the gas Review keeps); a holding with no
 * value of its own is weighed at its kind's price read elsewhere, only to leave out what is too little; with no price read
 * at all, against its kind's own floor (unpricedFloor). `except`: the origins a held step keeps closed (heldOrigins).
 * Changed on purpose 2026-10-06 (rugged97's #379): and on Ethereum and OP Mainnet as the service read them
 * (balanceChainsRequest, merged by mergeBalances), by the same rules, each named by the app's one table (originName);
 * Domino's networks first where two holdings are otherwise alike.
 */
export function bestHolding(answer: ChainBalancesResponse, destination: number, deliverable: readonly string[], except: ReadonlySet<number> = new Set()): LineHolding | null {
  if (deliverable.length === 0) return null
  const prices = kindPrices(answer)
  const floor = BigInt(FUNDS_LINE_MIN_USD) * 1_000_000n
  const found: (LineHolding & { same: boolean; micro: bigint | null })[] = []
  for (const chainId of [...SERVED_BALANCE_CHAINS, ...BALANCE_ORIGINS]) {
    const candidate = originCandidate(chainId)
    if (candidate === null || chainId === destination || except.has(chainId)) continue
    const report = holdingsFromChainBalances(answer, candidate)
    if (!report) continue
    for (const holding of usableHoldings(report.holdings, nativeOn(answer, candidate.chainId)).usable) {
      const kind = kindOf(candidate.chainId, holding.token)
      const micro = sendableMicroUsd(answer, candidate.chainId, holding)
      const weighed = micro ?? worthOf({ ...holding, raw: sendable(holding) }, candidate.chainId, prices)
      if (weighed !== null ? weighed < floor : sendable(holding) < unpricedFloor(kind, holding.decimals)) continue
      const target = targetFor(kind, deliverable, destination)
      if (target === null) continue
      found.push({ chainId: candidate.chainId, network: originName(candidate.chainId), holding, valueUsd: micro === null ? null : usdText(micro), target, same: kind !== null && kind === kindOf(destination, target), micro })
    }
  }
  const order = (a: (typeof found)[number], b: (typeof found)[number]): number => {
    if (a.same !== b.same) return a.same ? -1 : 1
    if (a.micro !== b.micro) {
      if (a.micro === null) return 1
      if (b.micro === null) return -1
      return a.micro > b.micro ? -1 : 1
    }
    return Number(a.holding.token !== ZERO) - Number(b.holding.token !== ZERO)
  }
  const best = found.sort(order)[0]
  return best ? { chainId: best.chainId, network: best.network, holding: best.holding, valueUsd: best.valueUsd, target: best.target } : null
}

/**
 * The networks crosschain-v1 pins both Relay and Across on (api-contracts/crosschain-v1 CONSTANTS.chains;
 * tests/v2/funds-model.test.mjs holds this copy to them), less Domino's own three: the short list "Other networks" offers.
 */
export const BOTH_PINNED_ORIGINS: readonly number[] = Object.freeze([1, 10, 56, 130, 137, 143, 324, 480, 999, 1868, 4217, 4326, 5042, 9745, 43114, 57073, 59144])

/**
 * Added 2026-10-06 (rugged97's #379): the balance chains read-v6's chain-balances reads when asked (v2/balanceChains.ts:
 * Ethereum, OP Mainnet) that crosschain-v1 bridges from (BOTH_PINNED_ORIGINS: the networks its origins listing names with
 * both Relay and Across pinned), in that order: the networks balanceChainsRequest asks about, beside Domino's own.
 * Changed on purpose 2026-11-07 (Elysium's screens): then Elysium, only where funds can come from it
 * (lib/elysiumIdentity.ts ELYSIUM_FUNDS_FROM), read in that same request of its own (balanceChainsRequest).
 */
export const BALANCE_ORIGINS: readonly number[] = Object.freeze([...BALANCE_CHAINS.map((chain) => chain.chainId as number).filter((chainId) => BOTH_PINNED_ORIGINS.includes(chainId)), ...(ELYSIUM_FUNDS_FROM ? [ELYSIUM_V2_ID] : [])])

/** One of the "Other networks" and the tokens to send from it. */
export interface OtherNetwork {
  chainId: number
  name: string
  tokens: { address: string; label: string; decimals: number }[]
}

/** The tokens "Other networks" offers besides a network's own currency and what both bridges list, in this order. */
const OTHER_NETWORK_SYMBOLS: readonly string[] = ['WETH', 'USDC', 'USDT']

/**
 * "Other networks" (Added 2026-10-06, the owner's point 2a): the listing's networks among BOTH_PINNED_ORIGINS, never
 * Domino's own or the destination, each named once (v2/crosschain/present.ts networkName), Ethereum and OP Mainnet first,
 * then by name; with the listing's tokens whose decimals it says (an amount is typed there, never in raw units). Changed
 * on purpose 2026-10-06 (the review of 2026-10-06: Relay lists up to 32 tokens a network, SOMI, PLUME, APE...; the owner's
 * "few functions"): only the network's own currency, WETH, USDC and USDT, and any token both Relay and Across list; the
 * network's own currency first, then in that order, then by symbol (pure).
 */
export function otherNetworks(list: OriginsList, destination: number): OtherNetwork[] {
  const first = [1, 10]
  const rank = (token: { address: string; label: string }) => (token.address === ZERO ? -1 : OTHER_NETWORK_SYMBOLS.indexOf(token.label.toUpperCase()) + 1 || 99)
  return list.chains
    .filter((chain) => BOTH_PINNED_ORIGINS.includes(chain.chainId) && chain.chainId !== destination && !isV2ChainId(chain.chainId))
    .map((chain) => ({
      chainId: chain.chainId,
      name: networkName(chain.chainId, chain.name) ?? chain.name,
      tokens: chain.tokens
        .filter((token) => knownDecimals(token.decimals))
        .map((token) => ({ address: lower(token.address), label: tokenLabel(token.address, token.symbol), decimals: token.decimals as number, both: token.providers.includes('relay') && token.providers.includes('across') }))
        .filter((token) => token.address === ZERO || token.both || OTHER_NETWORK_SYMBOLS.includes(token.label.toUpperCase()))
        .map(({ address, label, decimals }) => ({ address, label, decimals }))
        .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label)),
    }))
    .filter((chain) => chain.tokens.length > 0)
    .sort((a, b) => {
      const ra = first.indexOf(a.chainId)
      const rb = first.indexOf(b.chainId)
      if (ra !== rb) return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb)
      return a.name.localeCompare(b.name)
    })
}

/**
 * One network's holdings from a chain-balances answer, as the wallet's own read gives them (finance/v2/holdings.ts
 * readHoldingsReport): the candidate's own symbols and decimals, never the answer's text; only what is above zero; the
 * symbols whose balance could not be read in `unread`, never as a zero. Null when the answer did not read that network
 * (the wallet's own read is the way then).
 */
export function holdingsFromChainBalances(answer: ChainBalancesResponse, candidate: OriginCandidate): HoldingsReport | null {
  const chain = answer.chains.find((entry) => entry.chainId === candidate.chainId)
  if (!chain || chain.status !== 'current') return null
  const holdings: Holding[] = []
  const unread: string[] = []
  for (const token of candidate.tokens) {
    const read = chain.balances.find((entry) => entry.address.toLowerCase() === token.address.toLowerCase())
    if (!read || read.status !== 'read' || read.balanceRaw === null || !/^\d+$/.test(read.balanceRaw)) {
      unread.push(token.symbol)
      continue
    }
    const raw = BigInt(read.balanceRaw)
    if (raw > 0n) holdings.push({ chainId: candidate.chainId, chainName: candidate.name, token: token.address.toLowerCase(), symbol: token.symbol, decimals: token.decimals, raw })
  }
  return { holdings, unread }
}

/** A network's total in USD from a chain-balances answer, when the service could value every balance there; else null. */
export function totalUsdOn(answer: ChainBalancesResponse, chainId: number): string | null {
  const chain = answer.chains.find((entry) => entry.chainId === chainId)
  return chain && chain.status === 'current' ? chain.totalUsd : null
}
