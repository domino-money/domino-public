import type { Holding } from '../../finance/v2/holdings'
import type { Timing } from '../../v2/crosschain/client'
import type { CrosschainRequests, QuotePlan } from '../../v2/crosschain/types'
import { quoteRequestOf, sendable, sentRaw } from './model'
import { FUNDS_DEFAULT_SLIPPAGE_BPS } from './constants'

/** Quotes are memory-only. Storage keeps intent and public tracking references, never signing material. */
export interface FundingLeg {
  id: string
  originChainId: number
  originToken: string
  symbol: string
  decimals: number
  maxInputRaw: string
  minimumOutputRaw: string
  destinationGas: boolean
  state: 'ready' | 'sending' | 'unknown' | 'sent' | 'settled' | 'stopped'
  depositTxHash: string | null
}
export interface FundingIntent {
  version: 1
  id: string
  owner: string
  destinationChainId: 4663 | 8453 | 42161
  destinationToken: string
  scope: string
  requiredRaw: string
  createdAt: number
  legs: FundingLeg[]
}
export interface PricedLeg { holding: Holding; quote: QuotePlan; timing: Timing }
export type QuoteFunding = (request: CrosschainRequests['quote']) => Promise<{ quote: QuotePlan; timing: Timing }>

/** First look for one source. Combine only when no quoted single source can cover the net amount. */
export async function planFunding(input: {
  destinationChainId: 4663 | 8453 | 42161
  destinationToken: string
  required: bigint
  holdings: readonly Holding[]
  destinationGas: boolean
  quote: QuoteFunding
  cancelled(): boolean
}): Promise<PricedLeg[] | null> {
  if (input.required <= 0n) return null
  const partial: Holding[] = []
  let unavailable = false
  const ask = async (holding: Holding, amount: bigint, max: bigint | null, gas: boolean): Promise<PricedLeg> => ({ holding,
    ...await input.quote(quoteRequestOf({ originChainId: holding.chainId, originToken: holding.token,
      destinationChainId: input.destinationChainId, destinationToken: input.destinationToken,
      amountRaw: amount.toString(), ...(max === null ? {} : { maxInputRaw: max.toString() }),
      slippageBps: FUNDS_DEFAULT_SLIPPAGE_BPS, destinationGas: gas })) })
  for (const holding of input.holdings) {
    if (input.cancelled()) throw new Error('funding_cancelled')
    const cap = sendable(holding)
    if (cap <= 0n) continue
    const full = await ask(holding, input.required, cap, input.destinationGas)
    if (winningMinimum(full.quote) >= input.required) return [full]
    unavailable ||= full.quote.candidates.some((candidate) => candidate.status === 'unavailable' || candidate.status === 'rate_limited')
    // Only a priced route above the cap can become a valid smaller contribution. No blind drain-all fallback.
    if (full.quote.candidates.some((candidate) => candidate.status === 'input_above_max')) partial.push(holding)
  }
  if (!partial.length && unavailable) throw new Error('funding_routes_busy')
  const capacities: PricedLeg[] = []
  for (const holding of partial) {
    if (input.cancelled()) throw new Error('funding_cancelled')
    const contribution = await ask(holding, sendable(holding), null, input.destinationGas && capacities.length === 0)
    if (winningMinimum(contribution.quote) > 0n) capacities.push(contribution)
    else unavailable ||= contribution.quote.candidates.some((candidate) => candidate.status === 'unavailable' || candidate.status === 'rate_limited')
  }
  // One holding per origin avoids reusing a network's native gas allowance for two independent deposits.
  // All holdings were considered for a single transfer above; retain the largest actual net contribution per chain.
  const perOrigin = new Map<number, PricedLeg>()
  for (const leg of capacities) {
    const previous = perOrigin.get(leg.holding.chainId)
    if (!previous || winningMinimum(leg.quote) > winningMinimum(previous.quote)) perOrigin.set(leg.holding.chainId, leg)
  }
  const chosen = chooseContributions([...perOrigin.values()], input.required)
  if (!chosen && unavailable) throw new Error('funding_routes_busy')
  if (!chosen || chosen.length > 8) return null
  // Keep the already-priced gas contribution first. If it was not selected, price the first selected capacity
  // with gas before assigning its output; otherwise adding gas to its full net capacity would exceed the source cap.
  if (input.destinationGas) {
    const gasIndex = chosen.findIndex((leg) => leg.quote.request.destinationGas)
    if (gasIndex > 0) chosen.unshift(...chosen.splice(gasIndex, 1))
    else if (gasIndex < 0) {
      chosen[0] = await ask(chosen[0].holding, sendable(chosen[0].holding), null, true)
      if (winningMinimum(chosen[0].quote) <= 0n) return null
    }
  }
  let remaining = input.required
  const sized: PricedLeg[] = []
  for (const [index, leg] of chosen.entries()) {
    if (input.cancelled()) throw new Error('funding_cancelled')
    const need = winningMinimum(leg.quote) < remaining ? winningMinimum(leg.quote) : remaining
    const gas = input.destinationGas && index === 0
    const next = need === winningMinimum(leg.quote) && leg.quote.request.destinationGas === gas
      ? leg : await ask(leg.holding, need, sendable(leg.holding), gas)
    if (winningMinimum(next.quote) < need) return null
    sized.push(next)
    remaining -= winningMinimum(next.quote)
  }
  return remaining <= 0n ? sized : null
}

export const winningMinimum = (quote: QuotePlan): bigint => {
  const winner = quote.candidates.find((candidate) => candidate.provider === quote.decision && candidate.status === 'quoted')
  return winner?.minimumOutputRaw ? BigInt(winner.minimumOutputRaw) : 0n
}

/** Only actual net minimums in the same destination token can be added. USD estimates never establish funding. */
export function chooseContributions(candidates: readonly PricedLeg[], required: bigint): PricedLeg[] | null {
  const destination = candidates[0]?.quote.request
  if (candidates.some((leg) => leg.quote.request.destinationChainId !== destination?.destinationChainId || leg.quote.request.destinationToken.toLowerCase() !== destination?.destinationToken.toLowerCase())) throw new Error('funding_destination_mismatch')
  const ranked = [...candidates].filter((leg) => winningMinimum(leg.quote) > 0n)
    .sort((a, b) => winningMinimum(a.quote) > winningMinimum(b.quote) ? -1 : winningMinimum(a.quote) < winningMinimum(b.quote) ? 1 : a.holding.chainId - b.holding.chainId)
  const chosen: PricedLeg[] = []
  let remaining = required
  for (const leg of ranked) {
    if (remaining <= 0n) break
    chosen.push(leg)
    remaining -= winningMinimum(leg.quote)
  }
  return remaining <= 0n ? chosen : null
}

export function requestForLeg(intent: Pick<FundingIntent, 'destinationChainId' | 'destinationToken'>, leg: FundingLeg): CrosschainRequests['quote'] {
  return quoteRequestOf({ originChainId: leg.originChainId, originToken: leg.originToken,
    destinationChainId: intent.destinationChainId, destinationToken: intent.destinationToken,
    amountRaw: leg.minimumOutputRaw, maxInputRaw: leg.maxInputRaw,
    destinationGas: leg.destinationGas, slippageBps: FUNDS_DEFAULT_SLIPPAGE_BPS })
}

export function freezeFunding(input: Omit<FundingIntent, 'version' | 'legs'>, quoted: readonly PricedLeg[]): FundingIntent {
  return { ...input, version: 1, legs: quoted.map((leg, index) => ({
    id: `${leg.holding.chainId}:${leg.holding.token}:${index}`,
    originChainId: leg.holding.chainId, originToken: leg.holding.token,
    symbol: leg.holding.symbol, decimals: leg.holding.decimals,
    // The reviewed spend, not all the funds found in that wallet, bounds every later refresh.
    maxInputRaw: sentRaw(leg.quote), minimumOutputRaw: winningMinimum(leg.quote).toString(),
    destinationGas: leg.quote.request.destinationGas,
    state: 'ready', depositTxHash: null,
  })) }
}

/** A replacement quote can spend less, never more, or deliver less than the leg the person accepted. */
export function respectsLeg(intent: FundingIntent, leg: FundingLeg, quote: QuotePlan): boolean {
  const request = quote.request
  return request.owner.toLowerCase() === intent.owner && request.originChainId === leg.originChainId &&
    request.originToken.toLowerCase() === leg.originToken && request.destinationChainId === intent.destinationChainId &&
    request.destinationToken.toLowerCase() === intent.destinationToken && request.destinationGas === leg.destinationGas &&
    quote.decision !== null && quote.steps.length > 0 && BigInt(sentRaw(quote)) <= BigInt(leg.maxInputRaw) &&
    winningMinimum(quote) >= BigInt(leg.minimumOutputRaw)
}

const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const RAW = /^[1-9][0-9]{0,77}$/
const STATES = new Set<FundingLeg['state']>(['ready', 'sending', 'unknown', 'sent', 'settled', 'stopped'])
export const fundingStorageKey = (owner: string, destination: number) => `domino.funding.v1:${owner.toLowerCase()}:${destination}`

/** Stored values are untrusted hints. A restored sending leg is UNKNOWN, never automatically resent. */
export function parseFunding(raw: string | null, owner: string, destination: number): FundingIntent | null {
  if (!raw || raw.length > 24_000) return null
  try {
    const value: FundingIntent = JSON.parse(raw)
    if (value.version !== 1 || value.owner !== owner.toLowerCase() || value.destinationChainId !== destination ||
      !ADDRESS.test(value.destinationToken) || typeof value.id !== 'string' || value.id.length > 100 ||
      typeof value.scope !== 'string' || value.scope.length > 4_000 || !RAW.test(value.requiredRaw) ||
      !Number.isFinite(value.createdAt) || !Array.isArray(value.legs) || value.legs.length < 1 || value.legs.length > 8) return null
    if (value.legs.some((leg) => typeof leg.id !== 'string' || leg.id.length > 150 || !Number.isSafeInteger(leg.originChainId) ||
      ![1, 10, 4663, 8453, 42161].includes(leg.originChainId) || leg.originChainId === destination || !ADDRESS.test(leg.originToken) ||
      typeof leg.symbol !== 'string' || leg.symbol.length > 24 || !Number.isInteger(leg.decimals) || leg.decimals < 0 || leg.decimals > 36 ||
      !RAW.test(leg.maxInputRaw) || !RAW.test(leg.minimumOutputRaw) || !STATES.has(leg.state) || typeof leg.destinationGas !== 'boolean' ||
      (leg.depositTxHash !== null && !HASH.test(leg.depositTxHash)))) return null
    if (new Set(value.legs.map((leg) => leg.id)).size !== value.legs.length) return null
    // Explicit projection also discards injected quote/calldata fields.
    return { version: 1, id: value.id, owner: value.owner, destinationChainId: value.destinationChainId,
      destinationToken: value.destinationToken, scope: value.scope, requiredRaw: value.requiredRaw, createdAt: value.createdAt,
      legs: value.legs.map((leg) => ({ id: leg.id, originChainId: leg.originChainId, originToken: leg.originToken,
        symbol: leg.symbol, decimals: leg.decimals, maxInputRaw: leg.maxInputRaw, minimumOutputRaw: leg.minimumOutputRaw,
        destinationGas: leg.destinationGas, state: leg.state === 'sending' ? 'unknown' : leg.state, depositTxHash: leg.depositTxHash })) }
  } catch { return null }
}

export function outstandingLegs(intent: FundingIntent): FundingLeg[] {
  return intent.legs.filter((leg) => leg.state === 'ready' || leg.state === 'stopped')
}

/** An in-flight/unknown leg reserves its contribution but is never treated as wallet credit. */
export function fundingTotals(intent: FundingIntent): { sent: bigint; unknown: bigint; remaining: bigint } {
  let sent = 0n, unknown = 0n, remaining = 0n
  for (const leg of intent.legs) {
    if (leg.state === 'sent' || leg.state === 'settled') sent += BigInt(leg.minimumOutputRaw)
    else if (leg.state === 'unknown' || leg.state === 'sending') unknown += BigInt(leg.minimumOutputRaw)
    else remaining += BigInt(leg.minimumOutputRaw)
  }
  return { sent, unknown, remaining }
}
