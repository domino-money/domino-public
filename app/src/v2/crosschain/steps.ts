/**
 * The wallet steps of a quote (spec F7 §3.4 steps table, §3.6), as data. Pure: nothing here sends, signs or reads the
 * chain. The send is PHASE B: it goes through the wallet's own provider after switching the wallet to the origin chain
 * and re-reading `eth_chainId` right before each transaction (§1.3), one transaction at a time, waiting for the
 * approval's receipt before the deposit.
 *
 * `walletSteps` gives steps only for a quote that the injected runtime accepts again here, about the connected wallet,
 * before its deadline. It re-checks on its own what decides where money goes (defense in depth on top of the runtime,
 * which also pins the deposit target per provider and origin):
 *
 *   - every transaction is on `originChainId`, which is not the destination;
 *   - an ERC-20 is exactly [approval, deposit]; the native token is exactly [deposit], whose value is what the winner's
 *     deposit takes;
 *   - the approval is exact: to the origin token, value 0, calldata `approve(spender, amountRaw)` byte for byte, and
 *     its amount is what the winner's deposit takes; the API's unlimited approval is never used;
 *   - the steps are sent exactly as they came: `to`, `data`, and `value = BigInt(valueRaw)`.
 *
 * What the deposit takes is the winning candidate's `inputRaw` (Changed on purpose (data) 2026-10-06, crosschain-v1
 * 1.1.0-rc.1): the request's `amountRaw` when it asks by exact input (a typed amount, Other networks, everything held,
 * "All you have"), and the provider's when it asks by output (the one click sized for what the position lacks,
 * v2in/funds/BringFunds.tsx outputRequestOf), where `amountRaw` is what must arrive.
 *
 * The approval is skipped only when an allowance reading for this owner, this token and this spender on the origin
 * chain covers the amount. Without a reading the exact approval stays: it moves nothing by itself (F5).
 * After the deadline nothing is sendable: get a new quote and read the allowance again.
 */
import { quoteDeadlineMono, type Timing } from './client'
import { isS2Destination } from '../types'
import type { CrosschainTransport } from './transport'
import type { CrosschainRequests, CrosschainValidators, DepositState, DestinationChainId, Provider, QuotePlan } from './types'
import { DEPOSIT_STATES } from './types'
import { CROSSCHAIN_CONTRACT } from './version'

type Hex = `0x${string}`

/**
 * Stop offering a step this long before the quote's deadline: the person still has to read and confirm it in the
 * wallet. Recommendation (spec §3.6 says only "before expiresAt").
 */
export const SEND_MARGIN_MS = 10_000

const ZERO = '0x0000000000000000000000000000000000000000'
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const CALLDATA = /^0x(?:[0-9a-fA-F]{2})*$/
const RAW = /^(0|[1-9]\d*)$/
/** ERC-20 `approve(address,uint256)`. */
const APPROVE_SELECTOR = '0x095ea7b3'

const lower = (value: string) => value.toLowerCase()
const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')

/** The exact approval calldata the runtime also rebuilds: selector, spender, amount. */
export function approvalCalldata(spender: string, amountRaw: string): Hex {
  return `${APPROVE_SELECTOR}${word(lower(spender))}${word(BigInt(amountRaw).toString(16))}` as Hex
}

/** `allowance(owner, spender)` of `token` on `chainId`, read by the caller through the wallet's provider on the origin. */
export interface AllowanceReading {
  chainId: number
  token: string
  owner: string
  spender: string
  raw: string
}

/** One transaction to hand to the wallet, exactly as the quote gave it. */
export interface WalletStep {
  kind: 'approval' | 'deposit'
  chainId: number
  to: Hex
  data: Hex
  value: bigint
}

export type StepsRefusal =
  /** The runtime refuses the quote (tampered, or not a crosschain-v1 quote at all). */
  | 'not_validated'
  /** Neither provider quoted: there is nothing to send. */
  | 'no_decision'
  /** The quote is about another wallet. */
  | 'owner'
  /** Past the deadline (less the margin): get a new quote. */
  | 'expired'
  /** A step does not have the only shape this app sends. */
  | 'shape'
  /** The allowance reading is not about this owner, token, spender and origin chain. */
  | 'allowance'

export interface SendablePlan {
  ok: true
  provider: Provider
  originChainId: number
  destinationChainId: DestinationChainId
  steps: readonly WalletStep[]
  approvalSkipped: boolean
  /** Relay's tracking id, for `status`; null for Across. */
  requestId: string | null
  /** No step may be handed to the wallet at or after this monotonic time. */
  sendBeforeMono: number
  /** True when the quote came from the fixture transport: never handed to a wallet. */
  synthetic: boolean
}

export type StepsResult = SendablePlan | { ok: false; reason: StepsRefusal }

function exactApproval(quote: QuotePlan, step: QuotePlan['steps'][number], sent: string): boolean {
  const { request } = quote
  const approval = step.approval
  const tx = step.transaction
  if (step.kind !== 'approval' || approval === null) return false
  return (
    ADDRESS.test(approval.token) &&
    ADDRESS.test(approval.spender) &&
    lower(approval.token) === lower(request.originToken) &&
    lower(tx.to) === lower(approval.token) &&
    approval.amountRaw === sent &&
    tx.valueRaw === '0' &&
    lower(tx.data) === approvalCalldata(approval.spender, approval.amountRaw)
  )
}

/** `sent`: what the winner's deposit takes (its `inputRaw`). */
function shapeHolds(quote: QuotePlan, sent: string): boolean {
  const { request, steps } = quote
  const native = lower(request.originToken) === ZERO
  if (request.originChainId === request.destinationChainId) return false
  if (steps.length !== (native ? 1 : 2)) return false
  for (const step of steps) {
    const tx = step.transaction
    if (tx.chainId !== request.originChainId || !ADDRESS.test(tx.to) || !CALLDATA.test(tx.data) || !RAW.test(tx.valueRaw)) return false
  }
  const deposit = steps[steps.length - 1]
  if (deposit.kind !== 'deposit' || deposit.approval !== null) return false
  if (deposit.transaction.valueRaw !== (native ? sent : '0')) return false
  if (deposit.transaction.data.length < 10) return false
  return native || exactApproval(quote, steps[0], sent)
}

/**
 * The steps to send for a quote, or why there are none. `quote` is what the client returned; it is validated again
 * here, so a quote changed after the client accepted it yields no step either.
 */
export function walletSteps({
  runtime,
  quote,
  owner,
  timing,
  nowMono,
  allowance,
  source,
}: {
  runtime: CrosschainValidators
  quote: QuotePlan
  /** The connected wallet. */
  owner: string
  timing: Timing
  nowMono: number
  /** Null for the native token, or when the allowance could not be read (then the exact approval stays). */
  allowance: AllowanceReading | null
  source: CrosschainTransport['kind']
}): StepsResult {
  let valid: boolean
  try {
    valid = runtime.CONTRACT_VERSION === CROSSCHAIN_CONTRACT && runtime.validateResponse('quote', { contractVersion: CROSSCHAIN_CONTRACT, quote })
  } catch {
    valid = false
  }
  if (!valid) return { ok: false, reason: 'not_validated' }
  if (typeof owner !== 'string' || !ADDRESS.test(owner) || lower(quote.request.owner) !== lower(owner)) return { ok: false, reason: 'owner' }
  if (quote.decision === null || quote.steps.length === 0) return { ok: false, reason: 'no_decision' }
  const sendBeforeMono = quoteDeadlineMono(quote, timing) - SEND_MARGIN_MS
  if (!(nowMono < sendBeforeMono)) return { ok: false, reason: 'expired' }
  const winner = quote.candidates.find((c) => c.provider === quote.decision)
  if (!winner || winner.status !== 'quoted' || winner.tracking === null || winner.inputRaw === null) return { ok: false, reason: 'shape' }
  if (!shapeHolds(quote, winner.inputRaw)) return { ok: false, reason: 'shape' }
  const requestId = winner.tracking.requestId
  if ((quote.decision === 'relay') !== (requestId !== null) || (requestId !== null && !HASH.test(requestId))) return { ok: false, reason: 'shape' }

  let approvalSkipped = false
  const approval = quote.steps[0].approval
  if (approval !== null && allowance !== null) {
    const about =
      allowance.chainId === quote.request.originChainId &&
      typeof allowance.token === 'string' &&
      typeof allowance.owner === 'string' &&
      typeof allowance.spender === 'string' &&
      lower(allowance.token) === lower(approval.token) &&
      lower(allowance.owner) === lower(owner) &&
      lower(allowance.spender) === lower(approval.spender) &&
      typeof allowance.raw === 'string' &&
      RAW.test(allowance.raw)
    if (!about) return { ok: false, reason: 'allowance' }
    approvalSkipped = BigInt(allowance.raw) >= BigInt(approval.amountRaw)
  }

  const steps = quote.steps
    .filter((step) => !(approvalSkipped && step.kind === 'approval'))
    .map((step): WalletStep => ({
      kind: step.kind,
      chainId: step.transaction.chainId,
      to: step.transaction.to as Hex,
      data: step.transaction.data as Hex,
      value: BigInt(step.transaction.valueRaw),
    }))
  return {
    ok: true,
    provider: quote.decision,
    originChainId: quote.request.originChainId,
    destinationChainId: quote.request.destinationChainId,
    steps: Object.freeze(steps),
    approvalSkipped,
    requestId,
    sendBeforeMono,
    synthetic: source !== 'http',
  }
}

/** Right before handing a step to the wallet (and again before the deposit, after the approval's receipt). */
export const stillSendable = (plan: SendablePlan, nowMono: number): boolean => !plan.synthetic && nowMono < plan.sendBeforeMono

// ---------------------------------------------------------------------------
// The journal (§3.6 step 4): enough public data to resume tracking after a reload. Never an amount, a key or a session.
// ---------------------------------------------------------------------------

export interface CrosschainJournalRecord {
  provider: Provider
  originChainId: number
  destinationChainId: DestinationChainId
  depositTxHash: string
  requestId: string | null
  lastState: DepositState | null
}

const JOURNAL_KEYS = ['provider', 'originChainId', 'destinationChainId', 'depositTxHash', 'requestId', 'lastState'] as const

/** The record to keep once the deposit transaction's hash is known. */
export function journalRecord(plan: SendablePlan, depositTxHash: string): CrosschainJournalRecord | null {
  if (!HASH.test(depositTxHash)) return null
  return {
    provider: plan.provider,
    originChainId: plan.originChainId,
    destinationChainId: plan.destinationChainId,
    depositTxHash: lower(depositTxHash),
    requestId: plan.requestId,
    lastState: null,
  }
}

/** A closed check of a record read back from storage: exactly the six fields, each in its only shape. */
export function isJournalRecord(value: unknown): value is CrosschainJournalRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== JOURNAL_KEYS.length || !JOURNAL_KEYS.every((key) => Object.hasOwn(record, key))) return false
  const { provider, originChainId, destinationChainId, depositTxHash, requestId, lastState } = record
  if (provider !== 'relay' && provider !== 'across') return false
  if (typeof originChainId !== 'number' || !Number.isSafeInteger(originChainId) || originChainId < 1) return false
  // Changed on purpose 2026-11-09 (Elysium's day 9, the owner: funds brought to Elysium from other networks as on Base):
  // the deposit's destinations (v2/types.ts S2_DESTINATION_CHAIN_IDS), Elysium's too where funds can be brought to it.
  if (!isS2Destination(destinationChainId)) return false
  if (originChainId === destinationChainId) return false
  if (typeof depositTxHash !== 'string' || !HASH.test(depositTxHash)) return false
  if (provider === 'relay' ? typeof requestId !== 'string' || !HASH.test(requestId) : requestId !== null) return false
  return lastState === null || (typeof lastState === 'string' && (DEPOSIT_STATES as readonly string[]).includes(lastState))
}

export const withLastState = (record: CrosschainJournalRecord, state: DepositState): CrosschainJournalRecord => ({ ...record, lastState: state })

/** The `status` request a record asks: its last shown state is the `previousState`. */
export function statusRequestOf(record: CrosschainJournalRecord): CrosschainRequests['status'] {
  return {
    provider: record.provider,
    originChainId: record.originChainId,
    destinationChainId: record.destinationChainId,
    depositTxHash: record.depositTxHash,
    requestId: record.requestId,
    previousState: record.lastState,
  }
}
