import { keccak256, numberToHex, stringToHex, type Address, type Hex } from 'viem'
import { atomicStatus, batchCallsState, offerBatch, type AtomicStatus, type BatchCall, type BatchWallet } from '../batch'
import { chainNonceJournal, definiteRefusal, personRefused } from '../nonce'
import type { Timing } from '../../v2/crosschain/client'
import { isJournalRecord, journalRecord, stillSendable, walletSteps, type CrosschainJournalRecord, type SendablePlan } from '../../v2/crosschain/steps'
import type { CrosschainTransport } from '../../v2/crosschain/transport'
import type { CrosschainValidators, DestinationChainId, QuotePlan } from '../../v2/crosschain/types'
import { V2_CHAINS } from '../../v2/chains'
import { NONCE_LATCH_EXPIRY_S, WalletNotAsked } from './transact'

/**
 * S2, deposit from another network (spec F7 §3.4 "Regras dos passos", §3.6): the one way a deposit's transactions reach
 * the wallet, on the ORIGIN chain. The origin may be any EVM chain the crosschain-v1 origins listing names, not only one
 * of V2's, so this module is finance/v2/transact.ts's discipline bound to one validated quote instead of one V2 chain:
 *
 *   - every read and send goes through the connected wallet's own provider (the app has no RPC for arbitrary chains);
 *   - every operation is bounded in time and in calls, one money operation at a time, and stops when the wallet, its
 *     account or its chain changes (`current()`, `chainId()`, and `eth_accounts` / `eth_chainId` read at the start);
 *   - the steps come only from v2/crosschain/steps.ts `walletSteps`, which validates the quote again with the injected
 *     runtime, checks the owner and the deadline, and rebuilds the exact approval: the API's unlimited approval is
 *     never sent, and every step goes exactly as the quote gave it (`to`, `data`, `value`);
 *   - a fixture quote is never sendable (`stillSendable` is false for it): `review` and `send` refuse it before the
 *     wallet is asked anything;
 *   - the ERC-20 approval is offered only when `allowance(owner, spender)` on the origin, read through the wallet's
 *     provider, is short; the deposit only after the approval's receipt succeeded, and after the allowance is read
 *     again and covers the amount;
 *   - `stillSendable` is checked before each step and again immediately before the wallet is asked;
 *   - a nonce is offered once: the pending nonce must equal the latest (nothing in flight), it is claimed in the page's
 *     journal for the ORIGIN chain (finance/nonce.ts `chainNonceJournal(originChainId)`) before the wallet is asked, and
 *     released only after a definite refusal (`definiteRefusal`) or before the provider was invoked; a step is never
 *     sent twice, and after a refusal it is offered again only through a new review;
 *   - a step handed to the wallet whose outcome is not known (a time-out, a lost or malformed answer) is SENT for this page:
 *     its quote's deposit is never offered again, and no step of any quote is offered on that origin for this owner until
 *     the chain or the person settles it (`UnsettledStore`, kept across a reload with public data only). The chain
 *     settles it when its nonce is taken (a deposit then "may have gone": the person is told to check the wallet's
 *     activity, as no hash came back to follow); the person settles it, V1's way, by saying the wallet did not send it
 *     ("I rejected it in my wallet"), heard only while the chain shows that nonce still free with nothing pending;
 *   - a refusal of the bounded port BEFORE the provider is invoked (the account or chain changed, the window closed,
 *     too many calls) lets a claimed nonce go (transact.ts WalletNotAsked, post-B4 review F9);
 *   - the wallet's prompt is bounded by the quote: its window ends at the quote's deadline less the margin, never later;
 *   - `eth_chainId` is read again immediately before the send, after everything else (spec §1.3);
 *   - the network fee is the wallet's: twice `eth_gasPrice` as the ceiling. The tip by chain (decision #21 [owner,
 *     02/10], §1.3): none on Robinhood Chain and Arbitrum One, which order by arrival; on Base, and on every other origin
 *     (whose ordering this app does not know), the wallet's own `eth_maxPriorityFeePerGas`, kept under the ceiling;
 *   - a receipt is read only for a hash this sender sent, and the transaction behind it must be the one offered;
 *     "included" and "finalized" are separate states (the origin's `finalized` block where the chain names one), and a
 *     delay is never a failure;
 *   - the deposit's journal record (§3.6 step 4, steps.ts `journalRecord`: provider, chains, deposit hash, Relay's
 *     request id, last state shown) is written as soon as the deposit's hash is known, in localStorage under a name
 *     made of the destination chain and the owner (hashed, as finance/nonce.ts does), so tracking resumes after a
 *     reload. Public data only: no amount, key, session or calldata.
 *
 * Changed on purpose 2026-10-06 (rugged's answer of 6 Oct: the owner revoked decision #15; F7 delta of 6 Oct §2): when
 * the wallet batches atomically on the ORIGIN chain (`atomic`, finance/batch.ts atomicStatus on originChainId), an
 * ERC-20's exact approval and its deposit are offered as ONE EIP-5792 batch (`sendBatch`, finance/batch.ts offerBatch,
 * atomic required): both calls exactly as the quote gave them, behind the page's batch latch for that quote on that
 * chain, with this module's discipline (the quote still sendable, its deposit never offered twice, nothing of this owner
 * in flight on the origin, the chain read last); no simulation (the wallet simulates). Until the wallet names the one
 * transaction that carried it, the batch is kept (`PendingBatch`, with its origin, provider and request id); then that
 * transaction is the deposit's (`batchStatus`): its journal record is written with that hash. A wallet that cannot batch
 * goes step by step, as before. A network is never added here.
 *
 * This module is one of the closed V2 files that name wallet transaction methods (tests/session.source-guard.test.mjs),
 * held to exactly the methods it names. Nothing here fetches.
 */

/** The connected wallet, as the origin sender sees it: the owner, its chain, its provider and the page's nonce journal. */
export interface OriginWallet {
  owner: Address
  /** Whether the same connector and account are still connected. */
  current(): boolean
  /** The chain the connector last reported, checked before and after every wallet call. */
  chainId(): number | null
  request(method: string, params: unknown[]): Promise<unknown>
  nonceOffered(chainId: number, nonce: bigint): boolean
  claimNonce(chainId: number, nonce: bigint): Promise<string>
  releaseRejectedNonce(chainId: number, nonce: bigint, token: string): Promise<void>
  /** V1's settle (../nonce.ts): a latch on a nonce the chain shows nothing pending for, let go once its page is gone or it is older than `maxAge`. */
  settleNonce?(chainId: number, nonce: bigint, now: number, maxAge: number): Promise<boolean>
  /** V1's forget (../nonce.ts): the person says the request is gone from the wallet; the latch is let go, whoever holds it. */
  forgetNonce?(chainId: number, nonce: bigint): Promise<boolean>
  /**
   * Added 2026-10-06 (rugged's answer of 6 Oct: approval and deposit in one batch): the page's batch latch on `chainId`
   * (../nonce.ts chainNonceJournal, keyed by what the batch opens: one quote's deposit), so a batch is offered once. A
   * wallet handle without it never batches: its steps go one by one.
   */
  batchOffered?(chainId: number, key: Hex): string | null
  claimBatch?(chainId: number, key: Hex): Promise<string>
  recordBatch?(chainId: number, key: Hex, claim: string, id: string): Promise<void>
  releaseBatch?(chainId: number, key: Hex, claim: string): Promise<void>
}

/** A quote reviewed against the wallet: the steps to send, the exact approval when there is one. Frozen; issued here only. */
export interface OriginReview {
  readonly plan: SendablePlan
  readonly quote: QuotePlan
  /** The approval the deposit needs (ERC-20 origin token): token, spender and the exact amount. Null for the native token. */
  readonly approval: { readonly token: Address; readonly spender: Address; readonly amountRaw: string } | null
}

export type OriginReceipt =
  | { state: 'pending' }
  | { state: 'reorged' }
  | { state: 'included' | 'finalized' | 'reverted'; blockNumber: bigint }

export interface SentStep {
  hash: Hex
  /** For the deposit: whether its journal record was kept (false: this page could not write it; tracking stays in memory). */
  journaled: boolean
  record: CrosschainJournalRecord | null
}

/**
 * Where a deposit's batch stands, as the wallet says (Added 2026-10-06, rugged's answer of 6 Oct: approval and deposit in
 * one batch): `pending` while it is not on chain; `sent` once the wallet names the one transaction that carried it, the
 * deposit's (its journal record written with that hash); `gone` when nothing of it ran (not included, or `reverted`
 * whole); `unknown` when the wallet no longer knows it, or names no one transaction for it.
 */
export type BatchState = { state: 'pending' } | { state: 'sent'; sent: SentStep } | { state: 'gone'; reverted: boolean } | { state: 'unknown' }

/**
 * Why the sender stopped. The code is for a data-* attribute and the screen's sentence; never shown as text.
 *
 *   declined                the person refused in the wallet (4001, WalletConnect's 5000, a hardware wallet's words)
 *   wallet_refused          the wallet refused for another definite reason (4100, 4200, 4900, 4901, -32602): nothing sent
 *   wallet_result_unknown   the send's outcome is not known (a time-out, a lost answer): its nonce stays held, the step
 *                           is sent for this page, and the origin is held for this owner (UnsettledStore)
 *   wallet_request_open     an earlier step on this origin was handed to the wallet with no answer, and the chain shows
 *                           its nonce still free: the wallet may still show it (V1's code; "I rejected it in my wallet")
 *   deposit_may_have_gone   that earlier step was a deposit, and the chain has since taken its nonce: it probably went
 *                           through, with no hash to follow; the person checks the wallet's activity (said once)
 *   deposit_already_offered this quote's deposit was already handed to the wallet on this page: never twice
 *   wallet_wrong_chain      the wallet is not on the chain this step is for
 *   wallet_identity_changed the wallet's account or connector changed
 *   wallet_action_busy      another money operation of this sender is still running
 *   wallet_action_expired   the operation ran out of time or calls before anything was sent
 *   quote_synthetic         a fixture quote: never sent
 *   quote_expired           past the quote's deadline (less the margin): get a new quote
 *   quote_<reason>          steps.ts refused the quote (not_validated, no_decision, owner, shape, allowance)
 *   review_required         the review was not issued here
 *   step_not_in_plan        the review has no such step
 *   step_already_sent       this review already offered the step: never twice
 *   approval_not_confirmed  the deposit before the approval's successful receipt
 *   allowance_short         the allowance read right before the deposit does not cover the amount
 *   pending_wallet_transaction  another transaction of this owner is in flight on the origin, or its nonce is held
 *   network_fee_unavailable the wallet gave no usable fee
 *   gas_budget_exceeded     the step needs more gas than ORIGIN_MAX_GAS
 *   native_balance_insufficient  not enough of the origin's native token for the fee (and the value)
 *   step_would_fail         the wallet's estimate says the step reverts
 *   batch_unsupported       (Added 2026-10-06) the wallet cannot batch these calls on the origin; nothing it can run was
 *                           asked, and the same review goes step by step
 *   batch_upgrade_declined  (Added 2026-10-06) the person declined the wallet's account upgrade the batch needed; the same
 *                           review goes step by step
 *   receipt_not_from_this_review, transaction_does_not_match, invalid_receipt, invalid_wallet_reply, wallet_error
 */
export class OriginStepError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'OriginStepError'
    this.code = code
  }
}

/** How long a read may take, and how long a wallet prompt may stay open (finance/v2/transact.ts REVIEW_S, SIGN_WINDOW_S). */
export const ORIGIN_READ_S = 25
export const ORIGIN_SIGN_WINDOW_S = 180
/** At most this many wallet calls per operation. */
export const ORIGIN_MAX_CALLS = 48
/** An approval or a bridge deposit needs far less; anything above is refused before the wallet is asked. */
export const ORIGIN_MAX_GAS = 2_000_000n

const ZERO = '0x0000000000000000000000000000000000000000'
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const MAX_UINT128 = (1n << 128n) - 1n
/** ERC-20 allowance(address,address), balanceOf(address), decimals(). */
const ALLOWANCE = '0xdd62ed3e'
const BALANCE_OF = '0x70a08231'
const DECIMALS = '0x313ce567'

const fail = (code: string): never => {
  throw new OriginStepError(code)
}
const lower = (value: string) => value.toLowerCase()
const word = (address: string) => lower(address).replace(/^0x/, '').padStart(64, '0')
const quantity = (value: unknown): bigint =>
  typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value) ? BigInt(value) : fail('invalid_wallet_reply')
/** One ABI word, exactly: a uint256 answer. */
const uintWord = (value: unknown): bigint =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) ? BigInt(value) : fail('invalid_wallet_reply')
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : fail('invalid_wallet_reply')

/**
 * One wallet call through the bounded port. `onRefusal` runs after a definite refusal; `answerKept`: the send's own
 * call, whose answer (the hash) is kept even if the wallet moves while it is open: it may have been sent.
 */
type Rpc = (method: string, params: unknown[], options?: { onRefusal?: () => Promise<void>; answerKept?: boolean }) => Promise<unknown>

/** A quote's identity on this page: the service's fingerprint of its request and the moment it was asked. */
export const quoteKeyOf = (quote: Pick<QuotePlan, 'requestFingerprint' | 'requestedAt'>): string => `${lower(quote.requestFingerprint)}:${quote.requestedAt}`

/**
 * What the page's batch latch for one quote's batch is keyed by (Added 2026-10-06): the operation a batch opens, here that
 * quote's deposit (quoteKeyOf), hashed to the latch's 32 bytes (../nonce.ts claimBatch).
 */
export const batchKeyOf = (quoteKey: string): Hex => keccak256(stringToHex(`crosschain-batch|${quoteKey}`))

/** An error the wallet threw, as one of this module's codes. A code of this module passes through. */
export function stepErrorOf(error: unknown): OriginStepError {
  if (error instanceof OriginStepError) return error
  // The bounded port's own refusal before the provider was invoked: its message is this module's code.
  if (error instanceof WalletNotAsked) return new OriginStepError(error.message)
  if (personRefused(error)) return new OriginStepError('declined')
  if (definiteRefusal(error)) return new OriginStepError('wallet_refused')
  if (error instanceof Error && error.message === 'wallet_timeout') return new OriginStepError('wallet_action_expired')
  return new OriginStepError('wallet_error')
}

/** A wallet's refusal of an estimate: the contract would revert (code 3, or a message that says so). Never a refusal in the wallet. */
function reverts(error: unknown): boolean {
  let reverted = false
  let other = false
  const walk = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 4) return
    const node = value as { code?: unknown; message?: unknown; data?: unknown; cause?: unknown; error?: unknown }
    if (node.code === 4001 || node.code === 429) other = true
    if (node.code === 3) reverted = true
    if (typeof node.message === 'string' && /execution reverted|revert/i.test(node.message)) reverted = true
    for (const next of [node.data, node.cause, node.error]) walk(next, depth + 1)
  }
  walk(error, 0)
  return reverted && !other
}

export type OriginSender = ReturnType<typeof createOriginSender>

/**
 * The sender for one connected wallet. `monoMs` is the page's monotonic clock (the quote's deadline is on it);
 * `now` is wall seconds for the operation bounds only; `journal` keeps the deposit's record (null: none kept).
 * `batches` (Added 2026-10-06): the deposits handed to the wallet as one batch, kept until the wallet names their
 * transaction.
 */
export function createOriginSender(
  wallet: OriginWallet,
  {
    runtime,
    monoMs,
    journal,
    unsettled = createUnsettledStore(null),
    batches = createBatchJournal(null),
    now = () => Date.now() / 1000,
  }: { runtime: CrosschainValidators; monoMs: () => number; journal: DepositJournal | null; unsettled?: UnsettledStore; batches?: BatchJournal; now?: () => number },
) {
  const owner = lower(wallet.owner) as Address
  if (!ADDRESS.test(owner)) fail('invalid_wallet_owner')
  interface ReviewState {
    offered: Set<'approval' | 'deposit'>
    approvalConfirmed: boolean
    /** A batch's transaction (Added 2026-10-06) is the wallet's own: `transaction` null, only its receipt is read. */
    sent: Map<Hex, { kind: 'approval' | 'deposit' | 'batch'; transaction: Readonly<Record<string, string>> | null }>
  }
  const reviews = new WeakMap<OriginReview, ReviewState>()
  /** Quotes whose deposit this page handed to the wallet: never offered again, whatever came back. */
  const offeredQuotes = new Set<string>()
  /** The batches this sender offered, by the wallet's id, with the review they came from (Added 2026-10-06). */
  const offeredBatches = new Map<string, OriginReview>()
  let busy = false

  /** Wallet calls bound to `chainId`, inside `seconds` and ORIGIN_MAX_CALLS, stopping the moment the wallet changes. */
  function caller(chainId: number, seconds: number): Rpc {
    const end = now() + seconds
    let calls = 0
    return async (method, params, options) => {
      // Refused here, before the provider is invoked: nothing reached the wallet (WalletNotAsked, F9).
      if (!wallet.current()) throw new WalletNotAsked('wallet_identity_changed')
      if (now() >= end || ++calls > ORIGIN_MAX_CALLS) throw new WalletNotAsked('wallet_action_expired')
      if (wallet.chainId() !== chainId) throw new WalletNotAsked('wallet_wrong_chain')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // A definite refusal stays observable even after the deadline has won; an unknown outcome keeps its nonce held.
        const request = wallet.request(method, params).catch(async (error: unknown) => {
          if (definiteRefusal(error)) await options?.onRefusal?.()
          throw error
        })
        const result = await Promise.race([
          request,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('wallet_timeout')), Math.max(1, (end - now()) * 1000))
          }),
        ])
        if (options?.answerKept) return result
        if (!wallet.current()) return fail('wallet_identity_changed')
        if (wallet.chainId() !== chainId) return fail('wallet_wrong_chain')
        return result
      } finally {
        clearTimeout(timer)
      }
    }
  }

  /** One money operation at a time. */
  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (busy) return fail('wallet_action_busy')
    busy = true
    try {
      return await work()
    } catch (error) {
      throw stepErrorOf(error)
    } finally {
      busy = false
    }
  }

  /** The wallet's account must be the owner and its chain `chainId`. Another chain is `wallet_wrong_chain`: switch first. */
  async function identity(rpc: Rpc, chainId: number): Promise<void> {
    const accounts = await rpc('eth_accounts', [])
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || lower(accounts[0]) !== owner) fail('wallet_identity_changed')
    if (quantity(await rpc('eth_chainId', [])) !== BigInt(chainId)) fail('wallet_wrong_chain')
  }

  const call = async (rpc: Rpc, to: string, data: string): Promise<unknown> => rpc('eth_call', [{ to, data }, 'latest'])

  async function allowanceOf(rpc: Rpc, token: string, spender: string): Promise<bigint> {
    return uintWord(await call(rpc, token, `${ALLOWANCE}${word(owner)}${word(spender)}`))
  }

  /** Nothing of this owner may be in flight on `chainId`: the pending nonce is the latest, and it was never offered here. */
  async function freeNonce(rpc: Rpc, chainId: number): Promise<bigint> {
    const latest = quantity(await rpc('eth_getTransactionCount', [owner, 'latest']))
    const pending = quantity(await rpc('eth_getTransactionCount', [owner, 'pending']))
    if (latest !== pending) fail('pending_wallet_transaction')
    // A latch on a nonce the chain shows nothing pending for (another page's, or this page's before a reload): let go by
    // V1's rule only (its page is gone, or it is too old), as finance/v2/transact.ts does; otherwise the request may
    // still be open in the wallet.
    if (wallet.nonceOffered(chainId, pending) && !(await wallet.settleNonce?.(chainId, pending, now(), NONCE_LATCH_EXPIRY_S))) fail('pending_wallet_transaction')
    return pending
  }

  /** Where `nonce` stands on chain for this owner (V1's setup.ts nonceStanding): taken, still the next, or behind something pending. */
  async function standing(rpc: Rpc, nonce: bigint): Promise<'passed' | 'open' | 'pending' | 'behind'> {
    const latest = quantity(await rpc('eth_getTransactionCount', [owner, 'latest']))
    const pending = quantity(await rpc('eth_getTransactionCount', [owner, 'pending']))
    if (latest > nonce) return 'passed'
    if (latest < nonce) return 'behind'
    return pending > latest ? 'pending' : 'open'
  }

  /**
   * No step on `origin` while an earlier one handed to the wallet there has no known outcome (F1): refused, said by
   * where its nonce stands. A taken nonce settles it: an approval is let go (the allowance is read anyway), a deposit is
   * kept as "may have gone" and said once. Only the chain or the person's word (forgetUnsettled) settles it.
   */
  async function checkUnsettled(rpc: Rpc, origin: number): Promise<void> {
    // Added 2026-10-06: a batch the wallet took on this origin, whose transaction it has not named yet, is in flight there.
    if (batches.list(owner).some((entry) => entry.originChainId === origin)) fail('pending_wallet_transaction')
    const open = unsettled.list(owner).find((offer) => offer.originChainId === origin && offer.state === 'open')
    if (!open) return
    const nonce = BigInt(open.nonce)
    const at = await standing(rpc, nonce)
    if (at === 'passed') {
      await wallet.forgetNonce?.(origin, nonce)
      if (open.kind === 'approval') {
        unsettled.drop(owner, origin)
        return
      }
      unsettled.put(owner, { ...open, state: 'passed' })
      fail('deposit_may_have_gone')
    }
    fail(at === 'open' ? 'wallet_request_open' : 'pending_wallet_transaction')
  }

  /** The quote's deposit, once handed to the wallet on this page (or held unsettled after a reload), is never offered again. */
  const depositOffered = (quote: Pick<QuotePlan, 'requestFingerprint' | 'requestedAt'>): boolean => {
    const key = quoteKeyOf(quote)
    return offeredQuotes.has(key) || unsettled.list(owner).some((offer) => offer.kind === 'deposit' && offer.quote === key) || batches.list(owner).some((entry) => entry.quote === key)
  }

  /**
   * The quote reviewed against the wallet on its origin: the account and the chain, the allowance read for an ERC-20,
   * and the steps steps.ts gives for that reading. A fixture quote is refused before the wallet is asked anything.
   */
  async function review({ quote, timing, source }: { quote: QuotePlan; timing: Timing; source: CrosschainTransport['kind'] }): Promise<OriginReview> {
    if (source !== 'http') return fail('quote_synthetic')
    const first = walletSteps({ runtime, quote, owner, timing, nowMono: monoMs(), allowance: null, source })
    if (!first.ok) return fail(`quote_${first.reason}`)
    if (depositOffered(quote)) return fail('deposit_already_offered')
    const origin = first.originChainId
    const approvalStep = quote.steps[0]?.approval ?? null
    const approval = approvalStep
      ? Object.freeze({ token: lower(approvalStep.token) as Address, spender: lower(approvalStep.spender) as Address, amountRaw: approvalStep.amountRaw })
      : null
    return exclusive(async () => {
      const rpc = caller(origin, ORIGIN_READ_S)
      await identity(rpc, origin)
      await checkUnsettled(rpc, origin)
      const reading = approval
        ? { chainId: origin, token: approval.token, owner, spender: approval.spender, raw: (await allowanceOf(rpc, approval.token, approval.spender)).toString() }
        : null
      const plan = walletSteps({ runtime, quote, owner, timing, nowMono: monoMs(), allowance: reading, source })
      if (!plan.ok) return fail(`quote_${plan.reason}`)
      const reviewed: OriginReview = Object.freeze({ plan, quote, approval })
      reviews.set(reviewed, { offered: new Set(), approvalConfirmed: false, sent: new Map() })
      return reviewed
    })
  }

  /**
   * Offers one step of a review to the wallet, once. In order: the approval (when the review has one), then the deposit
   * after the approval's receipt succeeded. Everything is read again, the nonce claimed, and the chain read one last
   * time right before the wallet is asked. A definite refusal releases the nonce; any other outcome keeps it held.
   */
  async function send(reviewed: OriginReview, kind: 'approval' | 'deposit'): Promise<SentStep> {
    const state = reviews.get(reviewed) ?? fail('review_required')
    const { plan } = reviewed
    const step = plan.steps.find((s) => s.kind === kind) ?? fail('step_not_in_plan')
    if (state.offered.has(kind)) return fail('step_already_sent')
    if (kind === 'deposit' && plan.steps[0].kind === 'approval' && !state.approvalConfirmed) return fail('approval_not_confirmed')
    if (!stillSendable(plan, monoMs())) return fail(plan.synthetic ? 'quote_synthetic' : 'quote_expired')
    if (kind === 'deposit' && depositOffered(reviewed.quote)) return fail('deposit_already_offered')
    const origin = plan.originChainId
    if (step.chainId !== origin) return fail('wallet_wrong_chain')
    const quoteKey = quoteKeyOf(reviewed.quote)
    return exclusive(async () => {
      // The prompt never outlives the quote: the window ends at its deadline less the margin (sendBeforeMono).
      const rpc = caller(origin, Math.min(ORIGIN_SIGN_WINDOW_S, (plan.sendBeforeMono - monoMs()) / 1000))
      await identity(rpc, origin)
      await checkUnsettled(rpc, origin)
      if (kind === 'deposit' && reviewed.approval) {
        const allowance = await allowanceOf(rpc, reviewed.approval.token, reviewed.approval.spender)
        if (allowance < BigInt(reviewed.approval.amountRaw)) fail('allowance_short')
      }
      if (step.value < 0n || step.value > MAX_UINT128) fail('invalid_step')
      const tx = { from: owner, to: lower(step.to), data: step.data, value: numberToHex(step.value) }
      const gasPrice = quantity(await rpc('eth_gasPrice', []))
      // Decision #21 (§1.3): no tip where the chain orders by arrival (Robinhood Chain, Arbitrum One); else the wallet's.
      const arrival = V2_CHAINS.find((chain) => chain.chainId === origin)?.ordering === 'arrival'
      const tip = arrival ? 0n : quantity(await rpc('eth_maxPriorityFeePerGas', []))
      const maxFeePerGas = gasPrice * 2n
      if (maxFeePerGas <= 0n || maxFeePerGas > MAX_UINT128) fail('network_fee_unavailable')
      const maxPriorityFeePerGas = tip < maxFeePerGas ? tip : maxFeePerGas
      let estimate: bigint
      try {
        estimate = quantity(await rpc('eth_estimateGas', [tx]))
      } catch (error) {
        if (reverts(error)) fail('step_would_fail')
        throw error
      }
      const limit = (estimate * 120n + 99n) / 100n
      if (limit < 21_000n || limit > ORIGIN_MAX_GAS) fail('gas_budget_exceeded')
      if (quantity(await rpc('eth_getBalance', [owner, 'latest'])) < limit * maxFeePerGas + step.value) fail('native_balance_insufficient')
      const nonce = await freeNonce(rpc, origin)
      if (!stillSendable(plan, monoMs())) fail('quote_expired')
      const claim = await wallet.claimNonce(origin, nonce)
      // Immediately before the wallet is asked: the same account, the same chain, the quote still good (spec §1.3). The
      // provider has not been invoked for this nonce yet, so releasing the claim on any failure here is certain.
      let chainNow: bigint
      try {
        chainNow = quantity(await rpc('eth_chainId', []))
      } catch (error) {
        await wallet.releaseRejectedNonce(origin, nonce, claim)
        throw error
      }
      if (chainNow !== BigInt(origin) || !wallet.current() || !stillSendable(plan, monoMs())) {
        await wallet.releaseRejectedNonce(origin, nonce, claim)
        fail(chainNow !== BigInt(origin) ? 'wallet_wrong_chain' : !wallet.current() ? 'wallet_identity_changed' : 'quote_expired')
      }
      const transaction = Object.freeze({
        ...tx,
        nonce: numberToHex(nonce),
        gas: numberToHex(limit),
        maxFeePerGas: numberToHex(maxFeePerGas),
        maxPriorityFeePerGas: numberToHex(maxPriorityFeePerGas),
        chainId: numberToHex(origin),
        type: '0x2',
      })
      // Offered from here on: never again from this review, whatever the wallet answers.
      state.offered.add(kind)
      let hash: unknown = null
      try {
        hash = await rpc('eth_sendTransaction', [transaction], {
          // Only this exact claim, only after a definite refusal.
          onRefusal: () => wallet.releaseRejectedNonce(origin, nonce, claim),
          answerKept: true,
        })
      } catch (error) {
        if (error instanceof WalletNotAsked) {
          // The port refused before the provider was invoked: the wallet never saw it (F9).
          await wallet.releaseRejectedNonce(origin, nonce, claim)
          state.offered.delete(kind)
          throw error
        }
        if (definiteRefusal(error)) throw error
        hash = null
      }
      if (kind === 'deposit') offeredQuotes.add(quoteKey)
      if (typeof hash !== 'string' || !HASH.test(lower(hash))) {
        // A time-out, a lost or malformed answer: it may have been sent. Its nonce stays held, this quote's step is sent
        // for this page, and the origin is held for this owner until the chain or the person settles it (F1).
        unsettled.put(owner, {
          originChainId: origin,
          nonce: nonce.toString(),
          kind,
          quote: quoteKey,
          provider: plan.provider,
          destinationChainId: plan.destinationChainId,
          at: Math.floor(now()),
          state: 'open',
        })
        return fail('wallet_result_unknown')
      }
      const sentHash = lower(hash) as Hex
      state.sent.set(sentHash, { kind, transaction })
      if (kind === 'approval') return { hash: sentHash, journaled: false, record: null }
      const kept = journalRecord(plan, sentHash)
      let journaled = false
      if (kept && journal) {
        try {
          journal.put(owner, kept)
          journaled = true
        } catch {
          journaled = false
        }
      }
      return { hash: sentHash, journaled, record: kept }
    })
  }

  /**
   * A batch latch let go (Added 2026-10-06), by its claim or by the wallet's id, as far as this page can: one it cannot
   * let go only keeps that one quote's batch from being offered again, which never happens anyway.
   */
  async function letGoBatch(chainId: number, key: Hex, claim: string): Promise<void> {
    try {
      await wallet.releaseBatch?.(chainId, key, claim)
    } catch {
      // Kept: see above.
    }
  }

  /**
   * Added 2026-10-06 (rugged's answer of 6 Oct, F7 delta of 6 Oct §2 step 1): whether the wallet batches atomically on
   * the review's ORIGIN chain, read through its own provider (finance/batch.ts atomicStatus on originChainId):
   * `supported`, `ready` (the wallet would first upgrade the account there, EIP-7702, and asks the person to), or
   * `unsupported`, also when the read fails or times out. Reads only.
   */
  async function atomic(reviewed: OriginReview): Promise<AtomicStatus> {
    if (!reviews.has(reviewed)) return fail('review_required')
    const origin = reviewed.plan.originChainId
    return exclusive(async () => {
      const rpc = caller(origin, ORIGIN_READ_S)
      await identity(rpc, origin)
      return atomicStatus({ owner, request: (method, params) => rpc(method, params) }, 5_000, origin)
    })
  }

  /**
   * Added 2026-10-06 (rugged's answer of 6 Oct: the owner revoked decision #15; F7 delta of 6 Oct §2 steps 4 and 6): the
   * review's exact approval and its deposit offered to the wallet as ONE EIP-5792 batch (finance/batch.ts offerBatch:
   * version 2.0.0, atomic required, on the origin), both calls exactly as the quote gave them (`to`, `data`, `value`), once,
   * behind the page's batch latch for this quote on that chain. Only a review with both steps: an allowance that already
   * covers the amount leaves the deposit alone, one transaction (`send`). `send`'s discipline, without its estimate (the
   * wallet simulates a batch, and the deposit cannot be estimated before its approval runs): the quote still sendable
   * (asked again right before the wallet), its deposit never offered twice, nothing of this owner in flight on the origin,
   * the chain read last. Both steps count as offered from the moment the wallet is asked. A wallet that cannot batch
   * (`batch_unsupported`) or a declined account upgrade (`batch_upgrade_declined`) asked nothing that can run: the claim
   * goes, and the same review may go step by step. A refusal lets the claim go; an answer that never came holds the
   * origin, as a step's does (F1). The batch the wallet took is kept (`batches`) until it names its transaction
   * (`batchStatus`).
   */
  async function sendBatch(reviewed: OriginReview): Promise<PendingBatch> {
    const state = reviews.get(reviewed) ?? fail('review_required')
    const { plan } = reviewed
    if (plan.steps.length !== 2 || plan.steps[0].kind !== 'approval' || plan.steps[1].kind !== 'deposit' || reviewed.approval === null) return fail('step_not_in_plan')
    if (state.offered.size > 0) return fail('step_already_sent')
    if (!stillSendable(plan, monoMs())) return fail(plan.synthetic ? 'quote_synthetic' : 'quote_expired')
    if (depositOffered(reviewed.quote)) return fail('deposit_already_offered')
    const origin = plan.originChainId
    if (plan.steps.some((step) => step.chainId !== origin)) return fail('wallet_wrong_chain')
    const { claimBatch, recordBatch, releaseBatch } = wallet
    // No latch to offer a batch behind: never one; the steps go one by one.
    if (!claimBatch || !recordBatch || !releaseBatch) return fail('batch_unsupported')
    const quoteKey = quoteKeyOf(reviewed.quote)
    const key = batchKeyOf(quoteKey)
    // Another tab, or this one after a lost answer, already offered this quote's batch.
    if ((wallet.batchOffered?.(origin, key) ?? null) !== null) return fail('deposit_already_offered')
    return exclusive(async () => {
      // The prompt never outlives the quote: the window ends at its deadline less the margin, as a step's.
      const rpc = caller(origin, Math.min(ORIGIN_SIGN_WINDOW_S, (plan.sendBeforeMono - monoMs()) / 1000))
      await identity(rpc, origin)
      await checkUnsettled(rpc, origin)
      // Nothing of this owner in flight on the origin. Its next nonce is what settles a batch held below (a 7702 batch spends it).
      const nonce = await freeNonce(rpc, origin)
      const calls: BatchCall[] = plan.steps.map((step) => {
        if (step.value < 0n || step.value > MAX_UINT128) fail('invalid_step')
        return { to: lower(step.to) as Address, data: step.data, value: numberToHex(step.value) }
      })
      // Immediately before the wallet is asked: the same chain (spec §1.3); offerBatch asks `stillValid` again after its claim.
      if (quantity(await rpc('eth_chainId', [])) !== BigInt(origin)) fail('wallet_wrong_chain')
      // Offered from here on: never again from this review, whatever the wallet answers.
      state.offered.add('approval')
      state.offered.add('deposit')
      let claim: string | undefined
      let asked = false
      const latch: BatchWallet = {
        owner,
        request: (method, params) => rpc(method, params),
        claimBatch: async (k) => (claim = await claimBatch(origin, k)),
        recordBatch: (k, c, id) => recordBatch(origin, k, c, id),
        releaseBatch: (k, c) => releaseBatch(origin, k, c),
      }
      // The one request offerBatch makes is the offer itself; the wallet was asked only once the port invoked its provider.
      const request = async (method: string, params: unknown[]) => {
        try {
          // The answer (the batch's id) is kept even if the wallet moved while its prompt was open: the batch may run.
          const answer = await rpc(method, params, {
            onRefusal: async () => {
              if (claim !== undefined) await letGoBatch(origin, key, claim)
            },
            answerKept: true,
          })
          asked = true
          return answer
        } catch (error) {
          if (!(error instanceof WalletNotAsked)) asked = true
          throw error
        }
      }
      let batchId: string
      try {
        batchId = await offerBatch(request, latch, key, calls, () => wallet.current() && wallet.chainId() === origin && stillSendable(plan, monoMs()), origin)
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (!asked || message === 'batch_unsupported' || message === 'batch_upgrade_declined' || message === 'wallet_review_expired') {
          // Nothing the wallet can run was asked: the claim goes, and the same review may still go step by step.
          state.offered.clear()
          if (claim !== undefined) await letGoBatch(origin, key, claim)
          if (message === 'batch_unsupported' || message === 'batch_upgrade_declined') return fail(message)
          if (message === 'wallet_review_expired') return fail(!wallet.current() ? 'wallet_identity_changed' : wallet.chainId() !== origin ? 'wallet_wrong_chain' : 'quote_expired')
          // Another tab claimed this quote's batch first.
          if (message === 'wallet_batch_already_offered') return fail('deposit_already_offered')
          throw error
        }
        // A definite refusal: nothing was sent (offerBatch let its claim go). This review never offers it again; a new one can.
        if (definiteRefusal(error)) throw error
        // Handed to the wallet with no usable answer: it may run. This quote's deposit is sent for this page, and the
        // origin is held for this owner until the chain or the person settles it (F1), as a step's.
        offeredQuotes.add(quoteKey)
        unsettled.put(owner, {
          originChainId: origin,
          nonce: nonce.toString(),
          kind: 'deposit',
          quote: quoteKey,
          provider: plan.provider,
          destinationChainId: plan.destinationChainId,
          at: Math.floor(now()),
          state: 'open',
        })
        return fail('wallet_result_unknown')
      }
      offeredQuotes.add(quoteKey)
      offeredBatches.set(batchId, reviewed)
      const entry: PendingBatch = Object.freeze({
        originChainId: origin,
        destinationChainId: plan.destinationChainId,
        provider: plan.provider,
        requestId: plan.requestId,
        batchId,
        quote: quoteKey,
        at: Math.floor(now()),
      })
      try {
        batches.put(owner, entry)
      } catch {
        // An id this page cannot keep: followed on this page only (batchStatus takes the entry itself).
      }
      return entry
    })
  }

  /**
   * Added 2026-10-06 (rugged's answer of 6 Oct, F7 delta of 6 Oct §2 step 5): where a deposit's batch stands, from the
   * wallet's own status for it (finance/batch.ts batchCallsState). EIP-5792's status names no chain, so it is read on
   * whichever chain the wallet is on; a read that fails is thrown, to be asked again.
   *   - `pending` (1xx) while it is not on chain;
   *   - `sent` (2xx) once the wallet names the one transaction that carried both calls: that is the deposit's
   *     transaction (in an atomic batch, approval and deposit are one transaction). Its journal record is written with
   *     that hash (§3.6 step 4), the batch kept until then goes, and a receipt for that hash is read as `receipt` reads a
   *     step's, for the review it came from;
   *   - `gone` when nothing of it ran (4xx: not included, and the wallet will not try again; 5xx: reverted whole): it goes,
   *     and so does its latch; a new review may offer that quote's deposit again;
   *   - `unknown` when the wallet no longer knows it (5730), or names no one transaction for it: kept, for the person.
   */
  async function batchStatus(entry: PendingBatch): Promise<BatchState> {
    try {
      const chainId = wallet.chainId()
      if (chainId === null) return fail('wallet_wrong_chain')
      const rpc = caller(chainId, ORIGIN_READ_S)
      await identity(rpc, chainId)
      const said = await batchCallsState((method, params) => rpc(method, params), entry.batchId)
      if (said === null) return { state: 'unknown' }
      if (said.status >= 100 && said.status < 200) return { state: 'pending' }
      const key = batchKeyOf(entry.quote)
      if (said.status >= 400 && said.status < 600) {
        batches.drop(owner, entry.batchId)
        offeredBatches.delete(entry.batchId)
        offeredQuotes.delete(entry.quote)
        await letGoBatch(entry.originChainId, key, entry.batchId)
        return { state: 'gone', reverted: said.status >= 500 }
      }
      if (said.status < 200 || said.status >= 300 || said.transactionHash === null) return { state: 'unknown' }
      const hash = said.transactionHash
      const kept: CrosschainJournalRecord = {
        provider: entry.provider,
        originChainId: entry.originChainId,
        destinationChainId: entry.destinationChainId,
        depositTxHash: hash,
        requestId: entry.requestId,
        lastState: null,
      }
      if (!isJournalRecord(kept)) return fail('invalid_wallet_reply')
      let journaled = false
      if (journal) {
        try {
          journal.put(owner, kept)
          journaled = true
        } catch {
          journaled = false
        }
      }
      const from = offeredBatches.get(entry.batchId)
      if (from) reviews.get(from)?.sent.set(hash, { kind: 'batch', transaction: null })
      offeredBatches.delete(entry.batchId)
      batches.drop(owner, entry.batchId)
      await letGoBatch(entry.originChainId, key, entry.batchId)
      return { state: 'sent', sent: { hash, journaled, record: kept } }
    } catch (error) {
      throw stepErrorOf(error)
    }
  }

  /** Where a step this review sent stands. A successful approval receipt is what lets the deposit go. */
  async function receipt(reviewed: OriginReview, hash: Hex): Promise<OriginReceipt> {
    const state = reviews.get(reviewed) ?? fail('review_required')
    const sent = state.sent.get(lower(hash) as Hex) ?? fail('receipt_not_from_this_review')
    const origin = reviewed.plan.originChainId
    return exclusive(async (): Promise<OriginReceipt> => {
      const rpc = caller(origin, ORIGIN_READ_S)
      await identity(rpc, origin)
      // A step's transaction must be the one offered. Changed on purpose 2026-10-06 (rugged's answer of 6 Oct: approval and
      // deposit in one batch): a batch's is the wallet's own (its account's execute, or a bundler's), named by the wallet
      // (batchStatus), so only its receipt is read.
      const offered = sent.transaction
      if (offered !== null) {
        const tx = (await rpc('eth_getTransactionByHash', [hash])) as Record<string, unknown> | null
        if (tx === null) return { state: 'pending' }
        const found = record(tx)
        if (
          lower(String(found.hash)) !== lower(hash) ||
          lower(String(found.from)) !== owner ||
          lower(String(found.to)) !== offered.to ||
          lower(String(found.input)) !== lower(offered.data) ||
          quantity(found.value) !== BigInt(offered.value) ||
          quantity(found.nonce) !== BigInt(offered.nonce)
        ) {
          return fail('transaction_does_not_match')
        }
      }
      const raw = (await rpc('eth_getTransactionReceipt', [hash])) as Record<string, unknown> | null
      if (raw === null) return { state: 'pending' }
      const got = record(raw)
      if (
        lower(String(got.transactionHash)) !== lower(hash) ||
        (offered !== null && lower(String(got.from)) !== owner) ||
        typeof got.blockHash !== 'string' ||
        !HASH.test(lower(got.blockHash)) ||
        !['0x0', '0x1'].includes(String(got.status))
      ) {
        return fail('invalid_receipt')
      }
      const blockNumber = quantity(got.blockNumber)
      const block = (await rpc('eth_getBlockByNumber', [numberToHex(blockNumber), false])) as { hash?: string } | null
      if (!block || lower(String(block.hash)) !== lower(got.blockHash)) return { state: 'reorged' }
      if (got.status === '0x0') return { state: 'reverted', blockNumber }
      if (sent.kind === 'approval') state.approvalConfirmed = true
      let final: { number?: string } | null = null
      try {
        final = (await rpc('eth_getBlockByNumber', ['finalized', false])) as { number?: string } | null
      } catch (error) {
        // A chain that names no finalized block: the step is included, and stays so. This module's own stops pass.
        if (error instanceof OriginStepError) throw error
        final = null
      }
      const finalized = final !== null && typeof final.number === 'string' && quantity(final.number) >= blockNumber
      return { state: finalized ? 'finalized' : 'included', blockNumber }
    })
  }

  /**
   * Reads for the screens, through the wallet's provider, only while the wallet is on `chainId` (otherwise
   * `wallet_wrong_chain`: the screen does not guess). Never part of a money operation, so never busy.
   */
  async function read<T>(chainId: number, work: (rpc: Rpc) => Promise<T>): Promise<T> {
    try {
      const rpc = caller(chainId, ORIGIN_READ_S)
      await identity(rpc, chainId)
      return await work(rpc)
    } catch (error) {
      throw stepErrorOf(error)
    }
  }

  /**
   * "I rejected it in my wallet" (V1's own control, setup.ts forgetOpenRequest): the person says the step this page
   * handed to the wallet on `origin` with no answer is gone from the wallet. Heard only while the chain shows its nonce
   * still the next one with nothing pending; then its latch and the hold are let go and nothing is sent. Otherwise where
   * the nonce stands: `passed` (it was taken: a deposit is then kept as "may have gone"), `pending`, or `none`.
   */
  async function forgetUnsettled(origin: number): Promise<'forgotten' | 'passed' | 'pending' | 'none'> {
    return exclusive(async () => {
      const open = unsettled.list(owner).find((offer) => offer.originChainId === origin && offer.state === 'open')
      if (!open) return 'none'
      const rpc = caller(origin, ORIGIN_READ_S)
      await identity(rpc, origin)
      const nonce = BigInt(open.nonce)
      const at = await standing(rpc, nonce)
      if (at === 'passed') {
        await wallet.forgetNonce?.(origin, nonce)
        if (open.kind === 'approval') unsettled.drop(owner, origin)
        else unsettled.put(owner, { ...open, state: 'passed' })
        return 'passed'
      }
      if (at !== 'open') return 'pending'
      await wallet.forgetNonce?.(origin, nonce)
      unsettled.drop(owner, origin)
      return 'forgotten'
    })
  }

  return {
    owner,
    review,
    send,
    receipt,
    atomic,
    sendBatch,
    batchStatus,
    forgetUnsettled,
    /** Whether this quote's deposit was already handed to the wallet on this page (or is held unsettled). */
    depositOffered,
    /** The owner's balance of `token` on `chainId` (address(0): the native token), raw. */
    balance: (chainId: number, token: string): Promise<string> =>
      read(chainId, async (rpc) => {
        if (!ADDRESS.test(lower(token))) fail('invalid_token')
        if (lower(token) === ZERO) return quantity(await rpc('eth_getBalance', [owner, 'latest'])).toString()
        return uintWord(await call(rpc, token, `${BALANCE_OF}${word(owner)}`)).toString()
      }),
    /** An ERC-20's `decimals()` on `chainId`, or null when the token answers no valid uint8. */
    decimals: (chainId: number, token: string): Promise<number | null> =>
      read(chainId, async (rpc) => {
        if (!ADDRESS.test(lower(token)) || lower(token) === ZERO) fail('invalid_token')
        let answer: unknown
        try {
          answer = await call(rpc, token, DECIMALS)
        } catch (error) {
          if (error instanceof OriginStepError || definiteRefusal(error)) throw error
          return null
        }
        if (typeof answer !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(answer)) return null
        const value = BigInt(answer)
        return value <= 255n ? Number(value) : null
      }),
    /** Whether this review already offered the step (its nonce is held until the chain says what became of it). */
    wasOffered: (reviewed: OriginReview, kind: 'approval' | 'deposit') => reviews.get(reviewed)?.offered.has(kind) ?? false,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The deposits' journal (§3.6 step 4)
// ---------------------------------------------------------------------------------------------------------------------

interface StoragePort {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** The records kept for one destination chain and owner, newest first. */
export interface DepositJournal {
  list(destinationChainId: number, owner: string): readonly CrosschainJournalRecord[]
  /** Adds a record, or replaces the one for the same deposit (its new last state). */
  put(owner: string, record: CrosschainJournalRecord): void
  drop(owner: string, record: Pick<CrosschainJournalRecord, 'destinationChainId' | 'originChainId' | 'depositTxHash'>): void
}

export const DEPOSIT_JOURNAL_PREFIX = 'domino.v2.crosschain-deposits.v1.'
/** At most this many deposits kept per destination chain and owner; the oldest goes first. */
export const DEPOSIT_JOURNAL_MAX = 8

/** The storage name for a destination chain and an owner: hashed, so no address is written in a key. */
export function depositJournalKey(destinationChainId: number, owner: string): string {
  const who = lower(owner)
  if (!Number.isSafeInteger(destinationChainId) || destinationChainId < 1 || !ADDRESS.test(who)) return fail('invalid_journal_key')
  return DEPOSIT_JOURNAL_PREFIX + keccak256(stringToHex(`${destinationChainId}|${who}`)).slice(2)
}

const sameDeposit = (a: Pick<CrosschainJournalRecord, 'originChainId' | 'depositTxHash'>, b: Pick<CrosschainJournalRecord, 'originChainId' | 'depositTxHash'>) =>
  a.originChainId === b.originChainId && lower(a.depositTxHash) === lower(b.depositTxHash)

export function createDepositJournal(storage: StoragePort): DepositJournal {
  const read = (key: string): CrosschainJournalRecord[] => {
    let raw: string | null
    try {
      raw = storage.getItem(key)
    } catch {
      return []
    }
    if (raw === null) return []
    try {
      const value = JSON.parse(raw) as unknown
      // Each entry is checked closed (steps.ts isJournalRecord): anything else is left out, never repaired.
      return Array.isArray(value) ? value.filter(isJournalRecord).slice(0, DEPOSIT_JOURNAL_MAX) : []
    } catch {
      return []
    }
  }
  const write = (key: string, records: CrosschainJournalRecord[]) => {
    const value = JSON.stringify(records.map((r) => ({
      provider: r.provider,
      originChainId: r.originChainId,
      destinationChainId: r.destinationChainId,
      depositTxHash: lower(r.depositTxHash),
      requestId: r.requestId,
      lastState: r.lastState,
    })))
    if (records.length === 0) storage.removeItem(key)
    else storage.setItem(key, value)
    if (records.length > 0 && storage.getItem(key) !== value) fail('deposit_journal_unavailable')
  }
  return {
    list: (destinationChainId, owner) => Object.freeze(read(depositJournalKey(destinationChainId, owner)).map((r) => Object.freeze(r))),
    put(owner, entry) {
      if (!isJournalRecord(entry)) fail('invalid_journal_record')
      const key = depositJournalKey(entry.destinationChainId, owner)
      const kept = read(key).filter((r) => !sameDeposit(r, entry))
      write(key, [entry, ...kept].slice(0, DEPOSIT_JOURNAL_MAX))
    },
    drop(owner, entry) {
      const key = depositJournalKey(entry.destinationChainId, owner)
      const all = read(key)
      const kept = all.filter((r) => !sameDeposit(r, entry))
      if (kept.length !== all.length) write(key, kept)
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Steps handed to the wallet with no known outcome (F1)
// ---------------------------------------------------------------------------------------------------------------------

/** A step this page handed to the wallet on an origin with no answer it could use: public data only. */
export interface UnsettledOffer {
  originChainId: number
  /** The nonce it was offered with, decimal. */
  nonce: string
  kind: 'approval' | 'deposit'
  /** quoteKeyOf the quote it came from: that quote's deposit is never offered again. */
  quote: string
  provider: 'relay' | 'across'
  destinationChainId: number
  /** When it was handed to the wallet, unix seconds. */
  at: number
  /** `open`: not settled, the origin is held; `passed`: the chain took its nonce (a deposit that may have gone). */
  state: 'open' | 'passed'
}

/** The steps held for one owner, one per origin chain at most. */
export interface UnsettledStore {
  list(owner: string): readonly UnsettledOffer[]
  /** Adds the offer, or replaces the one held for the same origin. */
  put(owner: string, offer: UnsettledOffer): void
  drop(owner: string, originChainId: number): void
}

export const UNSETTLED_PREFIX = 'domino.v2.crosschain-unsettled.v1.'
const UNSETTLED_FIELDS = ['originChainId', 'nonce', 'kind', 'quote', 'provider', 'destinationChainId', 'at', 'state'] as const

/** The storage name for an owner's held steps: hashed, so no address is written in a key. */
export function unsettledKey(owner: string): string {
  const who = lower(owner)
  if (!ADDRESS.test(who)) return fail('invalid_journal_key')
  return UNSETTLED_PREFIX + keccak256(stringToHex(`unsettled|${who}`)).slice(2)
}

/** A closed check of an entry read back: exactly the eight fields, each in its only shape. */
export function isUnsettledOffer(value: unknown): value is UnsettledOffer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  const keys = Object.keys(entry)
  if (keys.length !== UNSETTLED_FIELDS.length || !UNSETTLED_FIELDS.every((key) => Object.hasOwn(entry, key))) return false
  const chainOk = (id: unknown) => typeof id === 'number' && Number.isSafeInteger(id) && id >= 1
  return (
    chainOk(entry.originChainId) &&
    chainOk(entry.destinationChainId) &&
    typeof entry.nonce === 'string' &&
    /^(0|[1-9][0-9]{0,19})$/.test(entry.nonce) &&
    (entry.kind === 'approval' || entry.kind === 'deposit') &&
    typeof entry.quote === 'string' &&
    /^[0-9a-f]{64}:[0-9]{1,16}$/.test(entry.quote) &&
    (entry.provider === 'relay' || entry.provider === 'across') &&
    typeof entry.at === 'number' &&
    Number.isSafeInteger(entry.at) &&
    entry.at >= 0 &&
    (entry.state === 'open' || entry.state === 'passed')
  )
}

/**
 * The held steps, in this page's memory and, where `storage` allows, in it too so a reload keeps the hold. This page's
 * memory wins once it wrote; a storage that refuses a write never loses a hold for this page.
 */
export function createUnsettledStore(storage: StoragePort | null): UnsettledStore {
  const memory = new Map<string, UnsettledOffer[]>()
  const read = (key: string): UnsettledOffer[] => {
    const kept = memory.get(key)
    if (kept) return kept
    if (!storage) return []
    try {
      const raw = storage.getItem(key)
      const value = raw === null ? [] : (JSON.parse(raw) as unknown)
      return Array.isArray(value) ? value.filter(isUnsettledOffer) : []
    } catch {
      return []
    }
  }
  const write = (key: string, offers: UnsettledOffer[]) => {
    memory.set(key, offers)
    if (!storage) return
    try {
      if (offers.length === 0) storage.removeItem(key)
      else storage.setItem(key, JSON.stringify(offers.map((o) => Object.fromEntries(UNSETTLED_FIELDS.map((field) => [field, o[field]])))))
    } catch {
      // Held in this page's memory; a reload will not find it.
    }
  }
  return {
    list: (owner) => Object.freeze(read(unsettledKey(owner)).map((offer) => Object.freeze({ ...offer }))),
    put(owner, offer) {
      if (!isUnsettledOffer(offer)) fail('invalid_unsettled_offer')
      const key = unsettledKey(owner)
      write(key, [offer, ...read(key).filter((o) => o.originChainId !== offer.originChainId)])
    },
    drop(owner, originChainId) {
      const key = unsettledKey(owner)
      write(key, read(key).filter((o) => o.originChainId !== originChainId))
    },
  }
}

/** The page's held steps: in localStorage where the browser keeps it, in memory otherwise. */
export function browserUnsettledStore(): UnsettledStore {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return createUnsettledStore(window.localStorage)
  } catch {
    // No storage here: memory only.
  }
  return createUnsettledStore(null)
}

// ---------------------------------------------------------------------------------------------------------------------
// Deposits handed to the wallet as one batch, until the wallet names their transaction (Added 2026-10-06)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A deposit's batch the wallet took, kept until the wallet names the transaction that carried it (Added 2026-10-06,
 * rugged's answer of 6 Oct, F7 delta of 6 Oct §2 step 5: "até o recibo, guardar o id do lote com originChainId, o provedor
 * e o requestId"): then the deposit's journal record is written with that hash, and this entry goes. Public data only:
 * the wallet's id for the batch, as the nonce journal keeps one (../nonce.ts recordBatch); no amount, calldata or key.
 */
export interface PendingBatch {
  originChainId: number
  destinationChainId: DestinationChainId
  provider: 'relay' | 'across'
  /** Relay's request id (`status` needs it); null for Across. */
  requestId: string | null
  /** The wallet's id for the batch (EIP-5792). */
  batchId: string
  /** quoteKeyOf the quote it came from: that quote's deposit is never offered again. */
  quote: string
  /** When the wallet took it, unix seconds. */
  at: number
}

/** The batches kept for one owner, newest first. */
export interface BatchJournal {
  list(owner: string): readonly PendingBatch[]
  /** Adds the batch, or replaces the one kept with the same id. */
  put(owner: string, entry: PendingBatch): void
  drop(owner: string, batchId: string): void
}

export const BATCH_JOURNAL_PREFIX = 'domino.v2.crosschain-batches.v1.'
/** At most this many kept per owner; the oldest goes first. */
export const BATCH_JOURNAL_MAX = 8
const BATCH_FIELDS = ['originChainId', 'destinationChainId', 'provider', 'requestId', 'batchId', 'quote', 'at'] as const
/** A wallet's id for a batch as the nonce journal admits one (../nonce.ts BATCH_ID): printable, at most 512 characters. */
const BATCH_ID = /^[\x21-\x7b\x7d\x7e]{1,512}$/

/** The storage name for an owner's kept batches: hashed, so no address is written in a key. */
export function batchJournalKey(owner: string): string {
  const who = lower(owner)
  if (!ADDRESS.test(who)) return fail('invalid_journal_key')
  return BATCH_JOURNAL_PREFIX + keccak256(stringToHex(`batches|${who}`)).slice(2)
}

/** A closed check of an entry read back: exactly the seven fields, each in its only shape. */
export function isPendingBatch(value: unknown): value is PendingBatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  const keys = Object.keys(entry)
  if (keys.length !== BATCH_FIELDS.length || !BATCH_FIELDS.every((key) => Object.hasOwn(entry, key))) return false
  const { originChainId, destinationChainId, provider, requestId, batchId, quote, at } = entry
  if (typeof originChainId !== 'number' || !Number.isSafeInteger(originChainId) || originChainId < 1) return false
  if (destinationChainId !== 4663 && destinationChainId !== 8453 && destinationChainId !== 42161) return false
  if (originChainId === destinationChainId) return false
  if (provider === 'relay' ? typeof requestId !== 'string' || !HASH.test(requestId) : provider !== 'across' || requestId !== null) return false
  return (
    typeof batchId === 'string' &&
    BATCH_ID.test(batchId) &&
    typeof quote === 'string' &&
    /^[0-9a-f]{64}:[0-9]{1,16}$/.test(quote) &&
    typeof at === 'number' &&
    Number.isSafeInteger(at) &&
    at >= 0
  )
}

/**
 * The kept batches, in this page's memory and, where `storage` allows, in it too so a reload finds them (the pattern of
 * createUnsettledStore: this page's memory wins once it wrote; a storage that refuses a write never loses one here).
 */
export function createBatchJournal(storage: StoragePort | null): BatchJournal {
  const memory = new Map<string, PendingBatch[]>()
  const read = (key: string): PendingBatch[] => {
    const kept = memory.get(key)
    if (kept) return kept
    if (!storage) return []
    try {
      const raw = storage.getItem(key)
      const value = raw === null ? [] : (JSON.parse(raw) as unknown)
      return Array.isArray(value) ? value.filter(isPendingBatch).slice(0, BATCH_JOURNAL_MAX) : []
    } catch {
      return []
    }
  }
  const write = (key: string, entries: PendingBatch[]) => {
    memory.set(key, entries)
    if (!storage) return
    try {
      if (entries.length === 0) storage.removeItem(key)
      else storage.setItem(key, JSON.stringify(entries.map((e) => Object.fromEntries(BATCH_FIELDS.map((field) => [field, e[field]])))))
    } catch {
      // Kept in this page's memory; a reload will not find it.
    }
  }
  return {
    list: (owner) => Object.freeze(read(batchJournalKey(owner)).map((entry) => Object.freeze({ ...entry }))),
    put(owner, entry) {
      if (!isPendingBatch(entry)) fail('invalid_batch_entry')
      const key = batchJournalKey(owner)
      write(key, [entry, ...read(key).filter((e) => e.batchId !== entry.batchId)].slice(0, BATCH_JOURNAL_MAX))
    },
    drop(owner, batchId) {
      const key = batchJournalKey(owner)
      const all = read(key)
      const kept = all.filter((e) => e.batchId !== batchId)
      if (kept.length !== all.length) write(key, kept)
    },
  }
}

/** The page's kept batches: in localStorage where the browser keeps it, in memory otherwise. */
export function browserBatchJournal(): BatchJournal {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return createBatchJournal(window.localStorage)
  } catch {
    // No storage here: memory only.
  }
  return createBatchJournal(null)
}

/** The page's own journal, in localStorage; null where the browser keeps nothing (the screen then tracks in memory). */
export function browserDepositJournal(): DepositJournal | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    return createDepositJournal(window.localStorage)
  } catch {
    return null
  }
}

/**
 * The connected wallet as the origin sender takes it, from the page's one wagmi connection (finance/v2/wallet.ts's
 * pattern, for any chain): the owner, whether the same connector and account are still there, the chain its connector
 * reports, its own provider, and the page's nonce journal for the chain a step is on. wagmi is reached through a dynamic
 * import so the node tests compile and load this module without it.
 */
export async function browserOriginWallet(): Promise<OriginWallet> {
  const [{ getConnection }, { walletConfig }] = await Promise.all([import('wagmi/actions'), import('../../wallet/config')])
  const connected = getConnection(walletConfig)
  if (connected.status !== 'connected' || !connected.connector) throw new OriginStepError('wallet_identity_changed')
  const connector = connected.connector
  const owner = lower(connected.address) as Address
  const provider = (await connector.getProvider()) as { request(args: { method: string; params?: unknown[] }): Promise<unknown> }
  return {
    owner,
    current: () => {
      const next = getConnection(walletConfig)
      return next.status === 'connected' && next.connector?.uid === connector.uid && lower(next.address) === owner
    },
    chainId: () => {
      const next = getConnection(walletConfig)
      return next.status === 'connected' && next.connector?.uid === connector.uid ? next.chainId : null
    },
    request: (method, params) => provider.request({ method, params }),
    nonceOffered: (chainId, nonce) => chainNonceJournal(chainId).offered(owner, nonce),
    claimNonce: (chainId, nonce) => chainNonceJournal(chainId).claim(owner, nonce, Date.now() / 1000),
    releaseRejectedNonce: (chainId, nonce, token) => chainNonceJournal(chainId).releaseAfterRejection(owner, nonce, token),
    settleNonce: (chainId, nonce, now, maxAge) => chainNonceJournal(chainId).settle(owner, nonce, now, maxAge),
    forgetNonce: (chainId, nonce) => chainNonceJournal(chainId).forget(owner, nonce),
    // Added 2026-10-06: the batch latch of the chain a batch is offered on (the same journal, keyed by the batch's key).
    batchOffered: (chainId, key) => chainNonceJournal(chainId).batchOffered(owner, key),
    claimBatch: (chainId, key) => chainNonceJournal(chainId).claimBatch(owner, key, Date.now() / 1000),
    recordBatch: (chainId, key, claim, id) => chainNonceJournal(chainId).recordBatch(owner, key, claim, id),
    releaseBatch: (chainId, key, claim) => chainNonceJournal(chainId).releaseBatch(owner, key, claim),
  }
}
