/**
 * What the S2 screens show for an accepted answer (spec F7 §3.3-§3.5, §3.7, §3.9, §8.2): plain view models, no React,
 * built only from data the client accepted. The words are ./copy.ts's; no USD, not even the provider's
 * `originGas.usd`. Explorer links are left to the screen: a view names the chain and the transaction hash, never a URL.
 * Changed on purpose 2026-10-06 (the owner's point 4: "0.099395417139745917 WETH" and too much text): the quote's amounts
 * are written for the screen as the V2 Review writes its own (v2/plan/present.ts formatUnitsText's default: at most six
 * decimals, rounded down, so "about" and "at least" never say more than the raw amount), with every line also kept with
 * its exact amounts (./amounts.ts) for a title or the Details. The fee's measurement after `filled` stays exact.
 * Changed on purpose 2026-10-06 (the integration review): a fee is rounded up (`Rounding`), as the Review rounds its own.
 */
import { NETWORK_NAMES } from '../../lib/networkName'
import { V2_CHAINS } from '../chains'
import { amountText, createChainNames, createTokenBook, durationText, knownDecimals, tokenLabel, unnamedChain } from './amounts'
import { bpsPercent, CANDIDATE_COPY, CREATE_ON_DESTINATION, FEE_STATUS_WORDS, feeLines, fill, NO_ROUTE, PROVIDER_NAME, STATE_COPY } from './copy'
import type { Candidate, ChainNames, DepositState, DestinationChainId, FeeStatus, OriginsList, Provider, QuotePlan, StatusReport, TokenBook, TokenInfo } from './types'

export interface Naming {
  book: TokenBook
  origin: ChainNames
  destination: ChainNames
}

/**
 * The networks the app names itself, where the origins listing names them otherwise ("Arbitrum", "Optimism"): Domino's
 * own three as their profiles write them, and Ethereum and OP Mainnet as the app's other screens write them
 * (finance/v2/holdings.ts CANDIDATE_ORIGINS). Added 2026-10-06 (the owner: one name for one network, never two on one
 * screen); every other network is named as the listing names it.
 * Changed on purpose 2026-10-06 (the final check, F3: "BNB" here, "BNB Chain" in the wallet dialog): every network the
 * app's one table names (lib/networkName.ts NETWORK_NAMES: literals and the chain registry's), so the two can never
 * disagree; the listing's name only for a network that table does not name.
 */
export const OWN_NETWORK_NAMES: Readonly<Record<number, string>> = Object.freeze({
  ...Object.fromEntries(V2_CHAINS.map((chain) => [chain.chainId, chain.name])),
  ...NETWORK_NAMES,
})

/** A network as the page names it: its own name above, else the listing's (`listed`), else null. */
export const networkName = (chainId: number, listed: string | null): string | null => OWN_NETWORK_NAMES[chainId] ?? listed

/**
 * The words this page can use for tokens and chains, from the V2 profiles and, when the page has it, the origins listing.
 * Changed on purpose 2026-10-06: an origin the app names itself is named so (OWN_NETWORK_NAMES), not as the listing does.
 */
export function naming(origins?: OriginsList | null): Naming {
  const names = createChainNames(origins)
  return { book: createTokenBook(origins), origin: (chainId) => networkName(chainId, names.origin(chainId)), destination: names.destination }
}

const ZERO = '0x0000000000000000000000000000000000000000'
const RAW = /^(0|[1-9]\d*)$/

/**
 * Which way an amount is rounded for the screen (Added 2026-10-06, the integration review: v2/plan/present.ts
 * formatUnitsText's `round`): 'down' for what arrives, "at least", an estimate and a balance, so they never say more than
 * there is; 'up' for a fee, what leaves the wallet and what is still needed, so they never say less.
 */
export type Rounding = 'down' | 'up'

/**
 * `raw / 10^decimals` for the screen, as v2/plan/present.ts formatUnitsText writes it (this module imports nothing
 * outside the crosschain module and the V2 foundation, so the rule is restated; tests/v2/crosschain-copy.test.mjs holds
 * the two together): at most `maxFraction` decimals, ROUNDED DOWN by default (`round` 'up': raised to the next digit
 * shown whenever a digit is dropped), trailing zeros dropped, thousands grouped; a non-zero amount too small to show is
 * "<0.000001", never "0". Null when `raw` or the decimals are not usable.
 */
export function roundedUnits(raw: string, decimals: number, maxFraction = 6, round: Rounding = 'down'): string | null {
  if (!RAW.test(raw) || !knownDecimals(decimals)) return null
  const keep = Math.min(maxFraction, decimals)
  const dropped = 10n ** BigInt(decimals - keep)
  const value = BigInt(raw)
  const shown = round === 'up' && value % dropped !== 0n ? (value - (value % dropped) + dropped).toString() : raw
  const padded = shown.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const cut = padded.slice(padded.length - decimals, padded.length - decimals + keep).replace(/0+$/, '')
  if (whole === '0' && cut === '' && raw !== '0') return `<0.${'0'.repeat(Math.max(0, keep - 1))}1`
  return cut ? `${whole}.${cut}` : whole
}

/**
 * An amount with its token for the screen: `"0.099395 WETH"`; unknown decimals as ./amounts.ts says them (`"350000 raw
 * units of USDC"`), never a guess. Added 2026-10-06 (the owner's point 4); `round` added 2026-10-06 (roundedUnits).
 */
export function shortAmountText(raw: string, address: string, info: TokenInfo | null, round: Rounding = 'down'): string {
  const units = info && knownDecimals(info.decimals) ? roundedUnits(raw, info.decimals, 6, round) : null
  return units === null ? amountText(raw, address, info) : `${units} ${tokenLabel(address, info?.symbol)}`
}

// ---------------------------------------------------------------------------
// destinations (§3.3): only the chain's charge currencies
// ---------------------------------------------------------------------------

export interface DestinationChoice {
  chainId: DestinationChainId
  chain: string
  tokens: { address: string; symbol: string; decimals: number }[]
}

/**
 * What a deposit may deliver, per V2 chain: its stable, ETH and WETH, from the build's chain profiles. The runtime
 * refuses any other `destinationToken`; tests/v2/crosschain-copy.test.mjs checks this list against the package's.
 */
export function destinationChoices(): DestinationChoice[] {
  return V2_CHAINS.map((chain) => ({
    chainId: chain.chainId,
    chain: chain.name,
    tokens: [...chain.chargeCurrencies].sort((a, b) => a.rank - b.rank).map((c) => ({ address: c.address, symbol: c.symbol, decimals: c.decimals })),
  }))
}

// ---------------------------------------------------------------------------
// origins (§3.3)
// ---------------------------------------------------------------------------

export interface OriginsView {
  /** Each provider's availability, Relay then Across. `text` is null when it listed its chains. */
  providers: { provider: Provider; name: string; available: boolean; text: string | null }[]
  /** Origin chains in chain id order, each with its tokens; a token names the providers that bridge it. */
  chains: { chainId: number; name: string; tokens: { address: string; label: string; decimals: number | null; providers: string[] }[] }[]
  /** Unix seconds the providers' lists were read (they may be served up to an hour old if a provider fails). */
  retrievedAt: number
}

/** A provider's availability in the spec's words (§3.4): null while it listed its chains. */
const providerText = (p: OriginsList['providers'][number]): string | null => (p.status === 'listed' ? null : fill(CANDIDATE_COPY[p.status] ?? '', { provider: PROVIDER_NAME[p.provider] }))

/**
 * Added 2026-10-06 (the integration review; §3.3 "each provider's availability"): the sentence of each provider that did
 * not list its chains ("Relay is busy. Try again shortly."), Relay then Across; empty while both listed.
 */
export const providersDown = (list: OriginsList): string[] => list.providers.flatMap((p) => providerText(p) || [])

export function presentOrigins(list: OriginsList): OriginsView {
  return {
    providers: list.providers.map((p) => ({
      provider: p.provider,
      name: PROVIDER_NAME[p.provider],
      available: p.status === 'listed',
      text: providerText(p),
    })),
    chains: list.chains.map((chain) => ({
      chainId: chain.chainId,
      // Changed on purpose 2026-10-06: one name for one network (OWN_NETWORK_NAMES).
      name: networkName(chain.chainId, chain.name) ?? chain.name,
      tokens: chain.tokens.map((token) => ({
        address: token.address,
        label: tokenLabel(token.address, token.symbol),
        decimals: token.decimals,
        providers: token.providers.map((p) => PROVIDER_NAME[p]),
      })),
    })),
    retrievedAt: list.retrievedAt,
  }
}

// ---------------------------------------------------------------------------
// quote (§3.4, §3.5)
// ---------------------------------------------------------------------------

export interface CandidateView {
  provider: Provider
  name: string
  /** The candidate the service chose (the runtime recomputed the choice). */
  winner: boolean
  status: Candidate['status']
  /** Why there is no usable price; null for a quoted candidate. */
  text: string | null
  /**
   * §3.5's lines, for a priced candidate (quoted, or priced without the destination gas asked for); else null. Amounts
   * rounded for the screen (Changed on purpose 2026-10-06, the owner's point 4; shortAmountText).
   */
  lines: string[] | null
  /** The same lines with every amount exact (./amounts.ts amountText), for a title; null with `lines`. Added 2026-10-06. */
  exactLines: string[] | null
  /**
   * Of the lines, the two the quote card shows (Added 2026-10-06, the owner's point 4): "You receive about {amount} on
   * {destination} (at least {minimum})", and "Arrives in about {duration}" (null when the provider gave no time).
   */
  receive: { text: string; exact: string } | null
  eta: string | null
}

export interface QuoteView {
  decision: Provider | null
  /** "No route available right now." when neither provider quoted; else null. */
  headline: string | null
  winner: CandidateView | null
  /** Both candidates, Relay then Across. */
  candidates: CandidateView[]
  origin: string
  destination: string
}

function chainWord(names: ChainNames, chainId: number): string {
  return names(chainId) ?? unnamedChain(chainId)
}

function candidateLines(
  quote: QuotePlan,
  c: Candidate,
  name: Naming,
  origin: string,
  destination: string,
  write: (raw: string, address: string, info: TokenInfo | null, round?: Rounding) => string,
): string[] | null {
  if (c.outputRaw === null || c.minimumOutputRaw === null || c.appFee === null || c.providerFee === null) return null
  const provider = PROVIDER_NAME[c.provider]
  const { request } = quote
  const amount = (raw: string, chainId: number, token: string, round: Rounding = 'down') => write(raw, token, name.book(chainId, token), round)
  const feeChain = c.appFee.charged === 'origin_input' ? origin : destination
  // Changed on purpose 2026-10-06 (the integration review): the two fees are rounded UP, as the V2 Review rounds its
  // Domino fee, so the fee measured once the deposit is filled never reads higher than the fee quoted; what arrives,
  // "at least" and the gas delivered stay rounded down.
  const lines = [
    feeLines.domino(bpsPercent(quote.appFeeBps), amount(c.appFee.amountRaw, c.appFee.chainId, c.appFee.token, 'up'), provider, feeChain),
    feeLines.bridge(amount(c.providerFee.amountRaw, c.providerFee.chainId, c.providerFee.token, 'up')),
    feeLines.receive(
      amount(c.outputRaw, request.destinationChainId, request.destinationToken),
      destination,
      amount(c.minimumOutputRaw, request.destinationChainId, request.destinationToken),
    ),
    feeLines.network(origin, c.originGas !== null && c.originGas.feeRaw !== null ? provider : null),
  ]
  if (c.destinationGas !== null) lines.push(feeLines.destinationGas(amount(c.destinationGas.deliveredRaw, request.destinationChainId, ZERO), destination))
  if (c.etaSeconds !== null) lines.push(feeLines.eta(durationText(c.etaSeconds)))
  return lines
}

export function presentQuote(quote: QuotePlan, name: Naming): QuoteView {
  const origin = chainWord(name.origin, quote.request.originChainId)
  const destination = chainWord(name.destination, quote.request.destinationChainId)
  const candidates = quote.candidates.map((c): CandidateView => {
    const template = CANDIDATE_COPY[c.status]
    const lines = candidateLines(quote, c, name, origin, destination, shortAmountText)
    const exactLines = candidateLines(quote, c, name, origin, destination, amountText)
    return {
      provider: c.provider,
      name: PROVIDER_NAME[c.provider],
      winner: quote.decision === c.provider,
      status: c.status,
      text: template === null ? null : fill(template, { provider: PROVIDER_NAME[c.provider], destination, origin }),
      lines,
      exactLines,
      receive: lines && exactLines ? { text: lines[2], exact: exactLines[2] } : null,
      eta: lines && c.etaSeconds !== null ? feeLines.eta(durationText(c.etaSeconds)) : null,
    }
  })
  return {
    decision: quote.decision,
    headline: quote.decision === null ? NO_ROUTE : null,
    winner: candidates.find((c) => c.winner) ?? null,
    candidates,
    origin,
    destination,
  }
}

/**
 * The provider's network fee estimate on the origin, in its native token, for the details only (never in USD).
 * Null when the provider did not report one or the page cannot name the origin's native token's decimals.
 * Changed on purpose 2026-10-06 (the owner's point 4): rounded for the screen, unless `exact`.
 * Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, F7 delta of 6 Oct §1: the quote card's network cost line is
 * this estimate, "never 0"): an estimate of zero says nothing about the fee, so it is not reported either.
 */
export function originGasDetail(quote: QuotePlan, c: Candidate, name: Naming, exact = false): string | null {
  if (c.originGas === null || c.originGas.feeRaw === null || !/^[1-9]\d*$/.test(c.originGas.feeRaw)) return null
  const native = name.book(quote.request.originChainId, ZERO)
  return native === null ? null : (exact ? amountText : shortAmountText)(c.originGas.feeRaw, ZERO, native)
}

// ---------------------------------------------------------------------------
// status (§3.7, §3.9)
// ---------------------------------------------------------------------------

export interface StatusView {
  /** The state shown; null before the first answer. */
  state: DepositState | null
  text: string
  terminal: boolean
  /** The transaction to link to an explorer: the fill on the destination, or the refund on the origin. */
  link: { kind: 'fill' | 'refund'; chainId: number; hash: string } | null
  /** Filled only: the way on to S1 on the destination. */
  next: string | null
  /** Filled only, for the receipt's details: the Domino fee's measurement. Never said before `filled`. */
  feeDetail: { status: FeeStatus; words: string; amount: string | null } | null
}

export function presentStatus({
  report,
  shown,
  fillTxHash,
  refundTxHash,
  provider,
  originChainId,
  destinationChainId,
  originToken,
  name,
}: {
  /** The last accepted answer, or null before the first. */
  report: StatusReport | null
  /** The state shown (the poll's record.lastState), which a held answer did not move. */
  shown: DepositState | null
  /** The poll's kept hashes: a later held answer does not erase them. Default: the report's. */
  fillTxHash?: string | null
  refundTxHash?: string | null
  provider: Provider
  originChainId: number
  destinationChainId: number
  /** The origin token's label when the page still has the quote; "your deposit" otherwise. */
  originToken?: string | null
  name: Naming
}): StatusView {
  const origin = chainWord(name.origin, originChainId)
  const destination = chainWord(name.destination, destinationChainId)
  const state = shown
  const text = fill(STATE_COPY[state ?? 'awaiting_deposit'], { provider: PROVIDER_NAME[provider], destination, origin, token: originToken ?? 'your deposit' })
  const filled = state === 'filled'
  const fillHash = fillTxHash ?? report?.fillTxHash ?? null
  const refundHash = refundTxHash ?? report?.refundTxHash ?? null
  let link: StatusView['link'] = null
  if (filled && fillHash !== null) link = { kind: 'fill', chainId: destinationChainId, hash: fillHash }
  if (state === 'refunded' && refundHash !== null) link = { kind: 'refund', chainId: originChainId, hash: refundHash }
  let feeDetail: StatusView['feeDetail'] = null
  if (filled && report !== null) {
    const fee = report.fee
    const amount = fee.amountRaw !== null && fee.chainId !== null && fee.token !== null ? amountText(fee.amountRaw, fee.token, name.book(fee.chainId, fee.token)) : null
    feeDetail = { status: fee.status, words: FEE_STATUS_WORDS[fee.status], amount }
  }
  return {
    state,
    text,
    terminal: state === 'filled' || state === 'refunded',
    link,
    next: filled ? fill(CREATE_ON_DESTINATION, { destination }) : null,
    feeDetail,
  }
}
