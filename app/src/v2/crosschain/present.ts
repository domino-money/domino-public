/**
 * What the S2 screens show for an accepted answer (spec F7 §3.3-§3.5, §3.7, §3.9, §8.2): plain view models, no React,
 * built only from data the client accepted. The words are ./copy.ts's; amounts are exact (./amounts.ts); no USD,
 * not even the provider's `originGas.usd`. Explorer links are left to the screen: a view names the chain and the
 * transaction hash, never a URL.
 */
import { V2_CHAINS } from '../chains'
import { amountText, createChainNames, createTokenBook, durationText, tokenLabel, unnamedChain } from './amounts'
import { bpsPercent, CANDIDATE_COPY, CREATE_ON_DESTINATION, FEE_STATUS_WORDS, feeLines, fill, NO_ROUTE, PROVIDER_NAME, STATE_COPY } from './copy'
import type { Candidate, ChainNames, DepositState, DestinationChainId, FeeStatus, OriginsList, Provider, QuotePlan, StatusReport, TokenBook } from './types'

export interface Naming {
  book: TokenBook
  origin: ChainNames
  destination: ChainNames
}

/** The words this page can use for tokens and chains, from the V2 profiles and, when the page has it, the origins listing. */
export function naming(origins?: OriginsList | null): Naming {
  const names = createChainNames(origins)
  return { book: createTokenBook(origins), origin: names.origin, destination: names.destination }
}

const ZERO = '0x0000000000000000000000000000000000000000'

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

export function presentOrigins(list: OriginsList): OriginsView {
  return {
    providers: list.providers.map((p) => ({
      provider: p.provider,
      name: PROVIDER_NAME[p.provider],
      available: p.status === 'listed',
      text: p.status === 'listed' ? null : fill(CANDIDATE_COPY[p.status] ?? '', { provider: PROVIDER_NAME[p.provider] }),
    })),
    chains: list.chains.map((chain) => ({
      chainId: chain.chainId,
      name: chain.name,
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
  /** §3.5's lines, for a priced candidate (quoted, or priced without the destination gas asked for); else null. */
  lines: string[] | null
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

function candidateLines(quote: QuotePlan, c: Candidate, name: Naming, origin: string, destination: string): string[] | null {
  if (c.outputRaw === null || c.minimumOutputRaw === null || c.appFee === null || c.providerFee === null) return null
  const provider = PROVIDER_NAME[c.provider]
  const { request } = quote
  const amount = (raw: string, chainId: number, token: string) => amountText(raw, token, name.book(chainId, token))
  const feeChain = c.appFee.charged === 'origin_input' ? origin : destination
  const lines = [
    feeLines.domino(bpsPercent(quote.appFeeBps), amount(c.appFee.amountRaw, c.appFee.chainId, c.appFee.token), provider, feeChain),
    feeLines.bridge(amount(c.providerFee.amountRaw, c.providerFee.chainId, c.providerFee.token)),
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
    return {
      provider: c.provider,
      name: PROVIDER_NAME[c.provider],
      winner: quote.decision === c.provider,
      status: c.status,
      text: template === null ? null : fill(template, { provider: PROVIDER_NAME[c.provider], destination, origin }),
      lines: candidateLines(quote, c, name, origin, destination),
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
 */
export function originGasDetail(quote: QuotePlan, c: Candidate, name: Naming): string | null {
  if (c.originGas === null || c.originGas.feeRaw === null) return null
  const native = name.book(quote.request.originChainId, ZERO)
  return native === null ? null : amountText(c.originGas.feeRaw, ZERO, native)
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
