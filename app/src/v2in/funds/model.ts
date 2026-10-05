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
import type { DepositPlan } from '../../lib/create/depositPlan'
import { maxSpend } from '../../lib/create/reviewPlan'
import { amountText, formatUnitsExact, knownDecimals } from '../../v2/crosschain/amounts'
import type { CrosschainFailure } from '../../v2/crosschain/client'
import { FAILURE_COPY, PROVIDER_NAME } from '../../v2/crosschain/copy'
import { errorDisposition } from '../../v2/crosschain/errors'
import { destinationChoices, type Naming } from '../../v2/crosschain/present'
import type { CrosschainRequests, OriginsList, OriginToken, QuotePlan } from '../../v2/crosschain/types'
import {
  FUNDS_MAX_SLIPPAGE_BPS,
  FUNDS_MIN_SLIPPAGE_BPS,
  FUNDS_REQUEST_RETRY_MS,
  FUNDS_SUGGEST_DESTINATION_GAS_AT_OR_BELOW_WEI,
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
   * How much more of it the position needs, raw, when Review's plan says it is the token the wallet is short of; null
   * otherwise (before an amount is typed, or for the other token, which helps only through the swap: no figure claimed).
   */
  shortRaw: bigint | null
}

/**
 * The tokens to offer bringing. Decided [owner, 2026-10-02 evening]: the offer shows ONLY when the position can't be
 * funded on its chain at all, counting the one-token swap New position already makes; when the other token can cover
 * the shortfall through that swap, nothing is offered.
 *   - An amount typed: only when Review's own plan for it (lib/create/depositPlan.ts, from the amount step's balances)
 *     is `short`: neither both tokens, nor the typed one alone, nor the other one through the swap covers it. The token
 *     the plan is short of comes first, with how much more it needs (V1's Review says the same: "add {token} to your
 *     wallet"); the other token after it when a deposit can deliver it, since bringing it lets the swap cover.
 *   - Before an amount: only when the wallet holds none of either token there (native ETH after Review's gas
 *     allowance): nothing could fund any amount, swap or not. The token a one-sided range takes first, else the typed one.
 *   - Only a token a deposit may deliver to this chain (§3.3: its stable, ETH or WETH, from the build's chain profiles).
 *   - Only with both balances read: an unread balance offers nothing, never as if it were zero.
 * Neither crosschain-v1 nor read-v6 says what the wallet holds on other networks (read-v6: "Balances per owner × chain:
 * not an index read"), so whether it holds the token elsewhere is never claimed here: the offer reads it through the
 * wallet's own provider, after the wallet switches there (finance/v2/holdings.ts; the owner's decision #9).
 */
export function lackingTokens(input: {
  chainId: number
  currencies: readonly [PairToken, PairToken]
  /** The wallet's balances on the position's chain, raw, in pool order; null (or a null side) when not read. */
  balances: readonly [string | null, string | null] | null
  /** Review's plan for the typed amount, from those balances; null before an amount is typed (or while none can be planned). */
  plan: DepositPlan | null
  /** The one token a one-sided range takes, or null. */
  only: 0 | 1 | null
  /** The token the amount is typed in, or null. */
  independent: 0 | 1 | null
}): Lack[] {
  const raw = input.balances
  if (!raw || raw[0] === null || raw[1] === null || !RAW.test(raw[0]) || !RAW.test(raw[1])) return []
  const spendable = [0, 1].map((side) => maxSpend(BigInt(raw[side] as string), lower(input.currencies[side].address) === ZERO))
  const { plan } = input
  let first: 0 | 1
  let shortRaw: bigint | null = null
  if (plan) {
    // Fundable as it is, or through the swap from either token: nothing to bring.
    if (plan.kind !== 'short') return []
    first = plan.token
    shortRaw = plan.need > plan.have ? plan.need - plan.have : null
  } else {
    // Something to fund with is there: the swap can make the position from it.
    if (spendable[0] > 0n || spendable[1] > 0n) return []
    first = input.only ?? input.independent ?? 0
  }
  const choices = new Map((destinationChoices().find((d) => d.chainId === input.chainId)?.tokens ?? []).map((t) => [lower(t.address), t]))
  const lacks: Lack[] = []
  for (const side of first === 1 ? ([1, 0] as const) : ([0, 1] as const)) {
    const address = lower(input.currencies[side].address)
    const choice = choices.get(address)
    if (!choice) continue
    lacks.push({ side, token: address, symbol: choice.symbol, decimals: choice.decimals, haveRaw: spendable[side], shortRaw: side === first ? shortRaw : null })
  }
  return lacks
}

/** V2 spends the exact inputs selected on Amount, not V1's derived paired amount. No exchange rate is inferred.
 * Only complete balance reads may establish a shortfall. An alternative delivered token has no claimed equivalent
 * amount: after arrival the person explicitly chooses it as a new input and reviews a new S1 plan. */
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
      return { side: index === 1 ? 1 : 0, token: lower(token.address), symbol: token.symbol, decimals: token.decimals, haveRaw, shortRaw: wanted ? wanted.amount - haveRaw : null }
    })
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
 * (never a guess at the decimals). Null for anything else: empty, zero, a sign, an exponent, grouping, too many places,
 * or 2^128 and above.
 */
export function amountRawOf(text: string, decimals: number | null): string | null {
  const value = text.trim()
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

/** The quote request the form makes: exactly the seven fields, addresses lowercase (§3.4). */
export function quoteRequestOf(input: {
  originChainId: number
  originToken: string
  destinationChainId: CrosschainRequests['quote']['destinationChainId']
  destinationToken: string
  amountRaw: string
  slippageBps: number
  destinationGas: boolean
}): CrosschainRequests['quote'] {
  return {
    originChainId: input.originChainId,
    originToken: lower(input.originToken),
    destinationChainId: input.destinationChainId,
    destinationToken: lower(input.destinationToken),
    amountRaw: input.amountRaw,
    slippageBps: input.slippageBps,
    destinationGas: input.destinationGas,
  }
}

/** The wallet steps of a quote in words (§3.6): the switch, the approval (ERC-20 only) and the deposit, with the amount. */
export function stepWords(quote: QuotePlan, name: Naming): { origin: string; amount: string; approval: boolean } {
  const { request } = quote
  const origin = name.origin(request.originChainId) ?? `network ${request.originChainId}`
  const amount = amountText(request.amountRaw, request.originToken, name.book(request.originChainId, request.originToken))
  return { origin, amount, approval: lower(request.originToken) !== ZERO }
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
