import type { Holding } from '../../finance/v2/holdings'
import type { PendingBatch } from '../../finance/v2/crosschain'
import { quoteDeadlineMono, type Timing } from '../../v2/crosschain/client'
import type { CrosschainRequests, QuotePlan } from '../../v2/crosschain/types'
import { SEND_MARGIN_MS } from '../../v2/crosschain/steps'
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
  /** A reviewed retry may keep more ETH on its Ethereum origin; this is never a destination credit. */
  reserveRaw?: string
  state: 'ready' | 'sending' | 'unknown' | 'sent' | 'settled' | 'stopped'
  depositTxHash: string | null
  /** Public quote identity for associating a recovered wallet batch with its delivered asset. */
  quoteKey?: string
}

/** A wallet batch may resolve only the exact reviewed leg; older metadata remains unassociated. */
export function fundingBatchLeg(intent: FundingIntent | null, batch: Pick<PendingBatch, 'quote' | 'originChainId' | 'destinationChainId'>): FundingLeg | undefined {
  if (intent?.destinationChainId !== batch.destinationChainId) return undefined
  return intent.legs.find((leg) => leg.quoteKey === batch.quote && leg.originChainId === batch.originChainId && (leg.state === 'unknown' || leg.state === 'sending'))
}
export interface FundingIntent {
  version: 1
  id: string
  owner: string
  destinationChainId: 4663 | 8453 | 42161
  destinationToken: string
  scope: string
  requiredRaw: string
  /** Optional position input, excluding any destination gas included in requiredRaw. */
  paymentRaw?: string
  createdAt: number
  legs: FundingLeg[]
  gasRecovery?: { mode: 'native' | 'token'; reviewNeeded: boolean }
}
export interface PricedLeg { holding: Holding; quote: QuotePlan; timing: Timing }
export type QuoteFunding = (request: CrosschainRequests['quote'], options?: { signal?: AbortSignal }) => Promise<{ quote: QuotePlan; timing: Timing }>
export interface FundingPlanningOptions {
  /** The same monotonic clock used to timestamp quote requests, never the device wall clock. */
  monoMs?: () => number
  signal?: AbortSignal
  maxDurationMs?: number
  maxQuotes?: number
}
export const FUNDING_PLAN_DURATION_MS = 120_000
export const FUNDING_PLAN_QUOTE_LIMIT = 12
export const FUNDING_REVIEW_MARGIN_MS = SEND_MARGIN_MS + 15_000

/** First look for one source. Incomplete/busy discovery is never reported as insufficient funds. */
export async function planFunding(input: {
  destinationChainId: 4663 | 8453 | 42161
  destinationToken: string
  required: bigint
  holdings: readonly Holding[]
  destinationGas: boolean
  quote: QuoteFunding
  spendable?: (holding: Holding) => bigint
  cancelled(): boolean
} & FundingPlanningOptions): Promise<PricedLeg[] | null> {
  if (input.required <= 0n) return null
  const now = input.monoMs ?? (() => performance.now())
  const duration = input.maxDurationMs ?? FUNDING_PLAN_DURATION_MS
  const deadline = now() + duration
  const controller = new AbortController()
  let timedOut = false, quoteCount = 0
  const abort = () => controller.abort()
  input.signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => { timedOut = true; controller.abort() }, duration)
  const guard = () => {
    if (input.cancelled() || input.signal?.aborted) throw new Error('funding_cancelled')
    if (timedOut || now() >= deadline) throw new Error('funding_plan_timeout')
  }
  // A silent quote or scheduler must also settle: abort alone does not make an arbitrary Promise reject.
  const bounded = async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    guard()
    return new Promise<T>((resolve, reject) => {
      const stopped = () => reject(new Error(timedOut ? 'funding_plan_timeout' : 'funding_cancelled'))
      controller.signal.addEventListener('abort', stopped, { once: true })
      Promise.resolve().then(() => { guard(); return work(controller.signal) }).then(resolve, reject)
        .finally(() => controller.signal.removeEventListener('abort', stopped))
    })
  }
  try {
    guard()
    const capacity = (holding: Holding) => {
      const ordinary = sendable(holding), revised = input.spendable?.(holding) ?? ordinary
      return revised < 0n ? 0n : revised < ordinary ? revised : ordinary
    }
    const partial: { holding: Holding; estimate: bigint }[] = []
    let unavailable = false
    const ask = async (holding: Holding, amount: bigint, max: bigint | null, gas: boolean): Promise<PricedLeg> => {
      guard()
      if (quoteCount >= (input.maxQuotes ?? FUNDING_PLAN_QUOTE_LIMIT)) throw new Error('funding_plan_limit')
      quoteCount += 1
      const answer = await bounded((signal) => input.quote(quoteRequestOf({ originChainId: holding.chainId, originToken: holding.token,
        destinationChainId: input.destinationChainId, destinationToken: input.destinationToken,
        amountRaw: amount.toString(), ...(max === null ? {} : { maxInputRaw: max.toString() }),
        slippageBps: FUNDS_DEFAULT_SLIPPAGE_BPS, destinationGas: gas }), { signal }))
      guard()
      return { holding, ...answer }
    }
    const fresh = async (legs: PricedLeg[]): Promise<PricedLeg[]> => {
      const refreshed = new Set<number>()
      for (;;) {
        guard()
        const stale = legs.findIndex((leg) => quoteDeadlineMono(leg.quote, leg.timing) <= now() + FUNDING_REVIEW_MARGIN_MS)
        if (stale < 0) return legs
        // Refresh only a selected leg, once, within its already-priced debit and minimum output.
        // If refreshing another leg makes this one stale again, stop instead of cycling forever.
        if (refreshed.has(stale)) throw new Error('funding_quotes_expired')
        refreshed.add(stale)
        const previous = legs[stale], need = winningMinimum(previous.quote)
        const next = await ask(previous.holding, need, BigInt(sentRaw(previous.quote)), previous.quote.request.destinationGas)
        if (winningMinimum(next.quote) < need) throw new Error('funding_quotes_expired')
        legs[stale] = next
      }
    }
    const perOrigin = new Map<number, PricedLeg>()
    const probed = new Set<string>()
    const identityOf = (holding: Holding) => `${holding.chainId}:${holding.token.toLowerCase()}`
    const combine = async (): Promise<PricedLeg[] | null> => {
      // Estimates only order and trigger requests. Actual, newly quoted net minimums establish coverage.
      partial.sort((a, b) => a.estimate > b.estimate ? -1 : a.estimate < b.estimate ? 1 : 0)
      for (const { holding } of partial) {
        guard()
        const identity = identityOf(holding)
        if (probed.has(identity)) continue
        probed.add(identity)
        const gas = input.destinationGas && ![...perOrigin.values()].some((leg) => leg.quote.request.destinationGas)
        const contribution = await ask(holding, capacity(holding), null, gas)
        if (winningMinimum(contribution.quote) > 0n) {
          const previous = perOrigin.get(holding.chainId)
          if (!previous || winningMinimum(contribution.quote) > winningMinimum(previous.quote)) perOrigin.set(holding.chainId, contribution)
          const covered = chooseContributions([...perOrigin.values()], input.required)
          if (covered && (!input.destinationGas || covered.some((leg) => leg.quote.request.destinationGas))) break
        }
        else unavailable ||= contribution.quote.candidates.some((candidate) => candidate.status === 'unavailable' || candidate.status === 'rate_limited')
      }
      // One holding per origin avoids reusing a network's native gas allowance for independent deposits.
      const chosen = chooseContributions([...perOrigin.values()], input.required)
      if (!chosen || chosen.length > 8) return null
      // Keep the gas contribution first. Adding gas to an already full capacity would exceed its source cap.
      if (input.destinationGas) {
        const gasIndex = chosen.findIndex((leg) => leg.quote.request.destinationGas)
        if (gasIndex > 0) chosen.unshift(...chosen.splice(gasIndex, 1))
        else if (gasIndex < 0) {
          chosen[0] = await ask(chosen[0].holding, capacity(chosen[0].holding), null, true)
          if (winningMinimum(chosen[0].quote) <= 0n) throw new Error('funding_quotes_changed')
        }
      }
      let remaining = input.required
      const sized: PricedLeg[] = []
      for (const [index, leg] of chosen.entries()) {
        guard()
        if (remaining <= 0n) break
        const need = winningMinimum(leg.quote) < remaining ? winningMinimum(leg.quote) : remaining
        const gas = input.destinationGas && index === 0
        const next = need === winningMinimum(leg.quote) && leg.quote.request.destinationGas === gas
          ? leg : await ask(leg.holding, need, capacity(leg.holding), gas)
        if (winningMinimum(next.quote) < need) throw new Error('funding_quotes_changed')
        sized.push(next)
        remaining -= winningMinimum(next.quote)
      }
      if (remaining > 0n) throw new Error('funding_quotes_changed')
      return fresh(sized)
    }
    const seen = new Set<string>()
    for (const holding of input.holdings) {
      guard()
      const identity = identityOf(holding)
      if (seen.has(identity)) continue
      seen.add(identity)
      const cap = capacity(holding)
      if (cap <= 0n) continue
      const full = await ask(holding, input.required, cap, input.destinationGas)
      if (winningMinimum(full.quote) >= input.required) return await fresh([full])
      unavailable ||= full.quote.candidates.some((candidate) => candidate.status === 'unavailable' || candidate.status === 'rate_limited')
      // Only a priced route above the cap can become a smaller contribution. No blind drain-all fallback.
      const priced = full.quote.candidates.filter((candidate) => candidate.status === 'input_above_max' && candidate.inputRaw && candidate.minimumOutputRaw)
      if (priced.length) partial.push({ holding, estimate: priced.reduce((best, candidate) => {
        const estimate = cap * BigInt(candidate.minimumOutputRaw!) / BigInt(candidate.inputRaw!)
        return estimate > best ? estimate : best
      }, 0n) })
      const estimates = new Map<number, bigint>()
      for (const entry of partial) {
        if (entry.estimate > (estimates.get(entry.holding.chainId) ?? 0n)) estimates.set(entry.holding.chainId, entry.estimate)
      }
      // Do not exhaust the budget enumerating every wallet token once a useful combination can be priced.
      // A failed estimate simply continues discovery; it never becomes a displayed balance or spend plan.
      if ([...estimates.values()].reduce((sum, estimate) => sum + estimate, 0n) >= input.required) {
        const combined = await combine()
        if (combined) return combined
      }
    }
    const combined = await combine()
    if (!combined && unavailable) throw new Error('funding_routes_busy')
    return combined
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener('abort', abort)
    controller.abort()
  }
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
const ZERO = '0x0000000000000000000000000000000000000000'
export const ETHEREUM_RETRY_RESERVE = 6_000_000_000_000_000n
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
    if (value.legs.some((leg) => leg.reserveRaw !== undefined && (leg.originChainId !== 1 || leg.originToken !== ZERO || leg.reserveRaw !== ETHEREUM_RETRY_RESERVE.toString()))) return null
    if (value.legs.some((leg) => leg.quoteKey !== undefined && !/^[0-9a-f]{64}:[0-9]+$/.test(leg.quoteKey))) return null
    if (value.gasRecovery !== undefined && (!value.gasRecovery || !['native', 'token'].includes(value.gasRecovery.mode) || typeof value.gasRecovery.reviewNeeded !== 'boolean')) return null
    if (value.paymentRaw !== undefined && (typeof value.paymentRaw !== 'string' || !RAW.test(value.paymentRaw) || BigInt(value.paymentRaw) > BigInt(value.requiredRaw))) return null
    if (new Set(value.legs.map((leg) => leg.id)).size !== value.legs.length) return null
    // Explicit projection also discards injected quote/calldata fields.
    return { version: 1, id: value.id, owner: value.owner, destinationChainId: value.destinationChainId,
      destinationToken: value.destinationToken, scope: value.scope, requiredRaw: value.requiredRaw, createdAt: value.createdAt,
      ...(value.paymentRaw !== undefined ? { paymentRaw: value.paymentRaw } : {}),
      ...(value.gasRecovery ? { gasRecovery: { mode: value.gasRecovery.mode, reviewNeeded: value.gasRecovery.reviewNeeded } } : {}),
      legs: value.legs.map((leg) => ({ id: leg.id, originChainId: leg.originChainId, originToken: leg.originToken,
        symbol: leg.symbol, decimals: leg.decimals, maxInputRaw: leg.maxInputRaw, minimumOutputRaw: leg.minimumOutputRaw,
        destinationGas: leg.destinationGas, ...(leg.quoteKey ? { quoteKey: leg.quoteKey } : {}), ...(leg.reserveRaw ? { reserveRaw: leg.reserveRaw } : {}), state: leg.state === 'sending' ? 'unknown' : leg.state, depositTxHash: leg.depositTxHash })) }
  } catch { return null }
}

export function outstandingLegs(intent: FundingIntent): FundingLeg[] {
  return intent.legs.filter((leg) => leg.state === 'ready' || leg.state === 'stopped')
}

/** Only a known pre-send gas failure qualifies. Wallet silence and arbitrary refusals never reopen funding. */
export function withGasFailure(intent: FundingIntent, legId: string, code: string, offered: boolean): FundingIntent | null {
  const leg = intent.legs.find((entry) => entry.id === legId)
  if (!leg || leg.originChainId !== 1 || offered || !['native_balance_insufficient', 'funding_gas_short'].includes(code) ||
    !['ready', 'stopped'].includes(leg.state) || leg.depositTxHash !== null) return null
  return { ...intent, gasRecovery: { mode: leg.originToken === ZERO ? 'native' : 'token', reviewNeeded: true } }
}

export function fundingSpendable(holding: Holding, leg?: Pick<FundingLeg, 'reserveRaw'>): bigint {
  if (!leg?.reserveRaw || holding.chainId !== 1 || holding.token !== ZERO) return sendable(holding)
  const reserve = BigInt(leg.reserveRaw)
  return holding.raw > reserve ? holding.raw - reserve : 0n
}

/** Also invalidates a reviewed alternative if another tab progresses or edits the original plan. */
export const gasRecoveryKey = (intent: FundingIntent) => JSON.stringify([intent.id, intent.scope, intent.requiredRaw, intent.gasRecovery,
  intent.legs.map((leg) => [leg.id, leg.state, leg.depositTxHash, leg.maxInputRaw, leg.minimumOutputRaw, leg.reserveRaw])])

/** A new proposal, never a send: keep the position target, debit caps and all transferred contributions intact. */
export async function planGasRecovery(intent: FundingIntent, holdings: readonly Holding[], quote: QuoteFunding, cancelled: () => boolean, reviewId: string, options: FundingPlanningOptions = {}): Promise<{ intent: FundingIntent; quotes: PricedLeg[]; recoveryFrom: string } | null> {
  if (!intent.gasRecovery?.reviewNeeded || intent.legs.some((leg) => leg.state === 'sending' || leg.state === 'unknown')) return null
  const outstanding = outstandingLegs(intent), kept = intent.legs.filter((leg) => !outstanding.includes(leg))
  const usedOrigins = new Set(kept.map((leg) => leg.originChainId))
  const usable = holdings.filter((holding) => !usedOrigins.has(holding.chainId) && (intent.gasRecovery?.mode !== 'token' || holding.chainId !== 1))
  const caps = (holding: Holding) => {
    const previous = outstanding.find((leg) => leg.originChainId === holding.chainId && leg.originToken === holding.token)
    const available = fundingSpendable(holding, { reserveRaw: ETHEREUM_RETRY_RESERVE.toString() })
    return previous && BigInt(previous.maxInputRaw) < available ? BigInt(previous.maxInputRaw) : available
  }
  const quoted = await planFunding({ destinationChainId: intent.destinationChainId, destinationToken: intent.destinationToken,
    required: outstanding.reduce((sum, leg) => sum + BigInt(leg.minimumOutputRaw), 0n), holdings: usable,
    destinationGas: !kept.some((leg) => leg.destinationGas) && outstanding.some((leg) => leg.destinationGas), quote, cancelled, spendable: caps, ...options })
  if (!quoted || kept.length + quoted.length > 8) return null
  const next = freezeFunding(intent, quoted)
  // New ids prevent a stale observer for a stopped leg from mutating the replacement.
  const legs = next.legs.map((leg, index) => ({ ...leg, id: `${leg.originChainId}:${leg.originToken}:retry:${reviewId}:${index}`,
    ...(leg.originChainId === 1 && leg.originToken === ZERO ? { reserveRaw: ETHEREUM_RETRY_RESERVE.toString() } : {}) }))
  return { intent: { ...next, legs: [...kept, ...legs], gasRecovery: { mode: intent.gasRecovery.mode, reviewNeeded: false } },
    quotes: quoted, recoveryFrom: gasRecoveryKey(intent) }
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
