import { keccak256, numberToHex, stringToHex, type Address, type Hex } from 'viem'
import { chainNonceJournal, definiteRefusal, personRefused } from '../nonce'
import type { Timing } from '../../v2/crosschain/client'
import { isJournalRecord, journalRecord, stillSendable, walletSteps, type CrosschainJournalRecord, type SendablePlan } from '../../v2/crosschain/steps'
import type { CrosschainTransport } from '../../v2/crosschain/transport'
import type { CrosschainValidators, QuotePlan } from '../../v2/crosschain/types'
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
 * Batches (EIP-5792) are not offered: approval and deposit stay two transactions until the owner and F5 say a batch
 * serves (spec open point 15; v2ui/s2/constants.ts S2_BATCH_APPROVAL_AND_DEPOSIT). A network is never added here.
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
 */
export function createOriginSender(
  wallet: OriginWallet,
  {
    runtime,
    monoMs,
    journal,
    unsettled = createUnsettledStore(null),
    now = () => Date.now() / 1000,
  }: { runtime: CrosschainValidators; monoMs: () => number; journal: DepositJournal | null; unsettled?: UnsettledStore; now?: () => number },
) {
  const owner = lower(wallet.owner) as Address
  if (!ADDRESS.test(owner)) fail('invalid_wallet_owner')
  interface ReviewState {
    offered: Set<'approval' | 'deposit'>
    approvalConfirmed: boolean
    sent: Map<Hex, { kind: 'approval' | 'deposit'; transaction: Readonly<Record<string, string>> }>
  }
  const reviews = new WeakMap<OriginReview, ReviewState>()
  /** Quotes whose deposit this page handed to the wallet: never offered again, whatever came back. */
  const offeredQuotes = new Set<string>()
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
    return offeredQuotes.has(key) || unsettled.list(owner).some((offer) => offer.kind === 'deposit' && offer.quote === key)
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

  /** Where a step this review sent stands. A successful approval receipt is what lets the deposit go. */
  async function receipt(reviewed: OriginReview, hash: Hex): Promise<OriginReceipt> {
    const state = reviews.get(reviewed) ?? fail('review_required')
    const sent = state.sent.get(lower(hash) as Hex) ?? fail('receipt_not_from_this_review')
    const origin = reviewed.plan.originChainId
    return exclusive(async (): Promise<OriginReceipt> => {
      const rpc = caller(origin, ORIGIN_READ_S)
      await identity(rpc, origin)
      const tx = (await rpc('eth_getTransactionByHash', [hash])) as Record<string, unknown> | null
      if (tx === null) return { state: 'pending' }
      const offered = sent.transaction
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
      const raw = (await rpc('eth_getTransactionReceipt', [hash])) as Record<string, unknown> | null
      if (raw === null) return { state: 'pending' }
      const got = record(raw)
      if (
        lower(String(got.transactionHash)) !== lower(hash) ||
        lower(String(got.from)) !== owner ||
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
  }
}
