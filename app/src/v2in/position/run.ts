import { useEffect, useReducer, useRef } from 'react'
import { readZapReceipt, type ZapReceipt } from '../../finance/v2/receipt'
import type { PreparedV2, SignedNonce, V2Receipt } from '../../finance/v2/transact'
import type { ZapBatch, ZapReview, ZapStep } from '../../finance/v2/zap'
import { v2Chain } from '../../v2/chains'
import type { ConsentChoice } from '../../v2/plan/consent'
import { readFeesToCome } from '../../v2/plan/present'
import { planTargetOf } from '../../v2/plan/route'
import type { S1PlanConsent, S1PlanReply, S1PlanRequest } from '../../v2/plan/types'
import type { ActionName, Address, Hex, V2ChainId } from '../../v2/types'
import { COPY } from './copy'
import { SENT_CHECK_WALLET_COPY, STILL_PENDING_COPY, actionError, planFailure, type ActionError } from './errors'
import { askLivePlan } from './source'
import { connectPosition, onChain, type OpenGate, type PositionConnection } from './wallet'
import { burnedPositionIds, positionChanged } from '../lists/positionSync'
import { RECEIPT_STILL_WAITING_MS, receiptPause, receiptSettled, receiptWalletAway } from '../receiptWait'

/**
 * One zap action on the position page (spec F7 §2.4, §2.5, §2.6, §2.10, §2.11), from the quote to the receipt, the
 * shape every dialog drives (add, change of range, an exit that converts). The S1 reference's run (the former src/v2ui/s1/run.ts,
 * with its rev2 review: F1 the request's target, F2 the wallet's answer kept, F3 the owner-wide hold and "I rejected it
 * in my wallet", L2 armed roots only), made gate-aware:
 *
 *   live:    the wallet put on the action's chain (switch first), the consent path read (EIP-5792 on THIS chain, the
 *            account's code on THIS chain), the plan asked of the plan API (./source.ts over src/v2in/transports.ts: the
 *            site's route with the session's CSRF; a test suite's script in a test build) and checked by the package's
 *            validator and the app's checks, then the zap client's review (its own checks, every read at one block).
 *            Steps: a batch when the wallet batches, else each step in turn, each confirmed on the network before the
 *            next. The receipt from the zap's events, "Included" then "Finalized" (Changed on purpose 2026-10-14,
 *            incident C3: the sheet is done at inclusion, "Confirmed"; a failed read while it waits is asked again);
 *   preview: no plan is asked at all (no contract is live to plan for, and no test data stands in: Changed on purpose
 *            (data) 2026-10-02, the owner): the dialog shows what the person chose and the gate's locked sentence where
 *            the wallet's steps would be. No step is ever prepared.
 *
 * A plan that fails on price (or expires) goes back to a fresh quote by itself, at most twice in a row; nothing is sent
 * again without a new press, and a step offered stays offered.
 */

export type RunPath = 'batch' | 'permit2' | 'direct'
/** `unknown`: handed to the wallet with no answer this page can use (it may have been sent): never offered again. */
export type StepStatus = 'waiting' | 'preparing' | 'ready' | 'wallet' | 'sent' | 'unknown' | 'included' | 'finalized'

export interface RunStep {
  kind: ZapStep['kind'] | 'batch'
  /** The review's step index (-1 for the batch). */
  index: number
  step: ZapStep | null
  status: StepStatus
  feeWei: bigint | null
  hash: Hex | null
  /** Sent, and its block not seen 20 s later: the step says it is still waiting (C3, ../receiptWait.ts). */
  slow?: boolean
  /** Sent, and its last read failed on the wallet's network (`chain`) or account (`account`): the step says to switch back (C3 review). */
  away?: 'chain' | 'account'
}

export interface Reviewed {
  connection: PositionConnection & { zap: NonNullable<PositionConnection['zap']> }
  consent: ConsentChoice & { atomic: string; account: string }
  review: ZapReview
  reply: S1PlanReply
  request: S1PlanRequest
  path: RunPath
  /** Unix seconds the review was made at (for "Good for"). */
  at: number
}

export interface ReceiptView {
  state: 'pending' | 'included' | 'finalized' | 'reverted'
  read: ZapReceipt | null
  /** The receipt could not be read exactly: its code (nothing is guessed). */
  unreadable: string | null
  hash: Hex | null
  includedBlock?: bigint
}

/** A reverted Permit2 action leaves its permit valid: cancelling its nonce is offered before any new quote (review F3). */
export interface CancelOffer {
  entry: SignedNonce
  status: 'ready' | 'wallet' | 'sent'
  error: ActionError | null
}

export interface RunView {
  /** `preview`: the locked review before the deploy (the dialog draws the request; no plan is asked). */
  stage: 'idle' | 'quoting' | 'reviewed' | 'preview' | 'failed'
  requoting: boolean
  reviewed: Reviewed | null
  steps: readonly RunStep[]
  current: number
  busy: boolean
  error: ActionError | null
  receipt: ReceiptView | null
  /** The fee ceiling per gas of the steps prepared so far, for the quote's own gas estimate. */
  feePerGas: bigint | null
  cancel: CancelOffer | null
  round: number
  /** Rev2 §2.13: the person ticked the warning on an armed root's action. */
  pauseAcknowledged: boolean
  /** The armed root's vault once its action is on chain: the page offers to turn automation back on. */
  rearm: Address | null
}

export interface RunInput {
  gate: OpenGate
  action: ActionName
  /** The tokens the person puts in (an add), for the consent path. */
  inputs: readonly { token: Address }[]
  /** The plan request, for the consent the path takes (the plan service picks the nonce). */
  request: (consent: S1PlanConsent) => S1PlanRequest
  /** A safe label for a token address, for the error sentences. */
  label: (token: Address) => string
  /**
   * Added 2026-10-06 (the integration review, rugged-literal #1): the position is the root of Auto-exit's own automation,
   * its Auto-exit on or paused (./model.ts PositionVault.exitLive): a review that keeps the position's approval (no zap
   * approval replaces it), all that exit needs, has its armed root's pause acknowledged without a tick.
   */
  exitLive?: boolean
}

class PlanFailure extends Error {
  readonly view: ActionError
  constructor(view: ActionError) {
    super(view.code)
    this.view = view
  }
}

const now = () => Date.now() / 1000
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const stepsOf = (review: ZapReview): RunStep[] => review.steps.map((step, index) => ({ kind: step.kind, index, step, status: 'waiting', feeWei: null, hash: null }))

/**
 * Added 2026-10-06 (the review of point 4, a second look, as New position's run): the reads a review leaves running on
 * its zap client (its current step being prepared, then the later approvals' fees), by client. A client runs one request
 * at a time and refuses a second (`wallet_action_busy`), and the page keeps one client per chain and wallet
 * (./wallet.ts), so a new quote on it (the dialog reopened, or its review asked again) waits for them first. A review
 * that is gone stops at its next check, so this is at most the one read under way.
 */
const reading = new WeakMap<object, Promise<unknown>>()
function held<T>(zap: object, work: Promise<T>): Promise<T> {
  reading.set(zap, work.catch(() => undefined))
  return work
}

/** The zap receipt in the decoder's input shape (finance/v2/receipt.ts RpcReceipt). */
export function rpcReceiptOf(hash: Hex | null, receipt: Extract<V2Receipt, { logs: unknown }>) {
  return {
    transactionHash: hash,
    status: receipt.state === 'reverted' ? '0x0' : '0x1',
    logs: receipt.logs.map((log) => ({ address: log.address, topics: log.topics, data: log.data, logIndex: log.logIndex })),
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    l1Fee: receipt.l1Fee ?? undefined,
  }
}

const IDLE: RunView = {
  stage: 'idle', requoting: false, reviewed: null, steps: [], current: 0, busy: false, error: null, receipt: null, feePerGas: null, cancel: null, round: 0,
  pauseAcknowledged: false, rearm: null,
}

export function useActionRun(input: RunInput) {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const live = useRef<RunView & { prepared: PreparedV2 | null; batch: ZapBatch | null; requotes: number }>({ ...IDLE, prepared: null, batch: null, requotes: 0 })
  const generation = useRef(0)
  const latest = useRef(input)
  useEffect(() => {
    latest.current = input
  })
  useEffect(() => () => void generation.current++, [])
  const chainOf = (): V2ChainId => latest.current.gate.chainId
  const errorOf = (error: unknown) => (error instanceof PlanFailure ? error.view : actionError(error, chainOf(), latest.current.label))

  async function quote(requoting: boolean): Promise<void> {
    const gen = ++generation.current
    const { gate, action, inputs, request } = latest.current
    Object.assign(live.current, { stage: 'quoting', requoting, reviewed: null, steps: [], current: 0, error: null, prepared: null, batch: null, feePerGas: null, cancel: null, round: live.current.round + 1, pauseAcknowledged: false, rearm: null })
    bump()
    if (gate.mode === 'preview') return previewQuote(gen)
    try {
      const connection = await connectPosition(gate)
      const zap = connection.zap
      if (!zap) throw new Error('deployment_not_live')
      // What an earlier review still reads on this client, first (one request at a time).
      await reading.get(zap)
      if (gen !== generation.current) return
      const chosen = await zap.consentFor(action, inputs)
      const chain = v2Chain(gate.chainId)
      // The answer is held to this wallet, the chain's pinned zaps and the profile's Uniswap and Permit2 (rev2 §2.4).
      const context = {
        owner: zap.owner,
        zaps: { 3: gate.contracts.addresses.zapV3.toLowerCase() as Address, 4: gate.contracts.addresses.zapV4.toLowerCase() as Address },
        permit2: chain.permit2,
        managers: { 3: chain.uniswap.v3.positionManager, 4: chain.uniswap.v4.positionManager },
      }
      let consent = chosen
      let asked = request(consent.planConsent)
      let result = await askLivePlan(gate, asked, context)
      // §2.4: `position_plan_consent_unsupported` (Permit2 for an account with code, or with native ETH): the direct path, without a word.
      if (result.kind === 'refused' && result.code === 'position_plan_consent_unsupported' && consent.planConsent === 'permit2') {
        consent = Object.freeze({ ...chosen, path: 'direct' as const, planConsent: 'direct' as const, reason: 'account_has_code' as const })
        asked = request('direct')
        result = await askLivePlan(gate, asked, context)
      }
      if (gen !== generation.current) return
      if (result.kind !== 'ok') throw new PlanFailure(planFailure(result, gate.chainId, latest.current.label))
      // What the person asked for (rev2 review, F1): the money client ties the plan's swaps to it.
      const target = planTargetOf(asked)
      if (!target) throw new Error('plan_target')
      const review = await zap.review({ chainId: gate.chainId, plan: result.reply.plan, consent: consent.planConsent, quote: result.reply.quote, target })
      if (gen !== generation.current) return
      const path: RunPath = consent.path
      const reviewed: Reviewed = { connection: { ...connection, zap }, consent, review, reply: result.reply, request: asked, path, at: now() }
      Object.assign(live.current, {
        stage: 'reviewed', requoting: false, reviewed, current: 0,
        steps: path === 'batch' ? [{ kind: 'batch', index: -1, step: null, status: 'waiting', feeWei: null, hash: null }] : stepsOf(review),
      })
      bump()
      // An armed root's action (rev2 §2.13): nothing is prepared until the person ticks the warning (on Auto-exit's own
      // root, only when the zap's approval replaces the one its exit needs).
      if (review.pausesAutomation === null) await prepareCurrent(gen)
      else if (latest.current.exitLive && review.replacesApproval === null) await acknowledgePause()
    } catch (error) {
      if (gen !== generation.current) return
      const view = errorOf(error)
      // An answer past its expiry, or `preview_expired`: asked again without a word, twice at most in a row.
      if (view.recovery === 'quiet-requote' && live.current.requotes < 2) {
        live.current.requotes++
        return quote(true)
      }
      Object.assign(live.current, { stage: 'failed', requoting: false, error: view })
      bump()
    }
  }

  /** The preview: no plan is asked and no wallet is asked anything; the dialog shows the request and the gate's sentence. */
  async function previewQuote(gen: number): Promise<void> {
    if (gen !== generation.current) return
    Object.assign(live.current, { stage: 'preview', requoting: false })
    bump()
  }

  /** Back to steps one by one (a wallet that cannot run this batch after all): the same direct review. */
  function toSteps(): void {
    const reviewed = live.current.reviewed
    if (!reviewed) return
    reviewed.path = 'direct'
    Object.assign(live.current, { steps: stepsOf(reviewed.review), current: 0, batch: null })
  }

  /** The current step prepared for the wallet (simulated, its fee known); reads only. */
  async function prepareCurrent(gen: number): Promise<void> {
    const state = live.current
    const reviewed = state.reviewed
    const step = state.steps[state.current]
    if (!reviewed || !step || gen !== generation.current) return
    if (step.kind === 'sign-permit') {
      step.status = 'ready'
      bump()
      return
    }
    step.status = 'preparing'
    bump()
    const { zap } = reviewed.connection
    try {
      if (step.kind === 'batch') {
        const batch = await held(zap, zap.prepareBatch(reviewed.review))
        if (gen !== generation.current) return
        state.batch = batch
        step.feeWei = batch.networkFeeWei
      } else {
        const prepared = await held(zap, zap.prepareStep(reviewed.review, step.index))
        if (gen !== generation.current) return
        state.prepared = prepared
        step.feeWei = prepared.networkFeeWei
        state.feePerGas = BigInt(prepared.transaction.maxFeePerGas)
        // The approvals after this one, for their fee only (2026-10-06: the review's one network fee line counts them).
        await held(zap, readFeesToCome(state.steps, state.current, async (index) => (await zap.prepareStep(reviewed.review, index)).networkFeeWei, () => gen === generation.current))
        if (gen !== generation.current) return
      }
      step.status = 'ready'
      bump()
    } catch (error) {
      if (gen !== generation.current) return
      // A wallet without eth_simulateV1: no batch, the steps go one by one (no other node is asked, OP9).
      if (step.kind === 'batch' && error instanceof Error && error.message === 'batch_simulation_unavailable') {
        toSteps()
        bump()
        return prepareCurrent(gen)
      }
      await failed(gen, error)
    }
  }

  /** A failure said; one on price (or an expired review) goes back to a fresh quote by itself, twice at most in a row. */
  async function failed(gen: number, error: unknown): Promise<void> {
    const view = errorOf(error)
    const state = live.current
    const step = state.steps[state.current]
    if (step && step.status !== 'sent') step.status = 'ready'
    state.prepared = null
    state.batch = null
    if ((view.recovery === 'requote' || view.recovery === 'quiet-requote') && state.requotes < 2) {
      state.requotes++
      return quote(true)
    }
    state.error = view
    bump()
    void gen
  }

  /**
   * Rev2 review F2: a step the wallet may have sent stays locked, with no re-quote. `sent`: the wallet gave its hash or
   * batch id; otherwise its outcome is unknown. Never offered again from this review, and the money client refuses any
   * other action on this chain until the chain settles it (F3).
   */
  function locked(error: unknown, sent: boolean): void {
    const state = live.current
    const step = state.steps[state.current]
    if (step && step.status !== 'included' && step.status !== 'finalized') step.status = sent ? 'sent' : 'unknown'
    // Changed on purpose 2026-10-14 (C3 review): the wait has ended, so the step no longer says it is still waiting (it
    // said so beside "nothing more is sent from here").
    if (step) { step.slow = false; step.away = undefined }
    state.prepared = null
    state.batch = null
    state.error = { copy: sent ? SENT_CHECK_WALLET_COPY : COPY.wallet.sentUnknown, code: errorOf(error).code, recovery: 'none' }
    bump()
  }

  /**
   * Asked again and again until the step is on the chain (included) or known reverted; a delay is never a failure.
   *
   * Changed on purpose 2026-10-14 (incident C3: waiting never locks), as New position's (../journey/run.ts): a failed read
   * is "ask again". It rethrew every failure but three wallet codes, so a refused or lost confirmation read while the
   * transaction was being included locked Add, Change range or Withdraw with "Sent to your wallet…" although it
   * succeeded. Only the money clients' codes that say the transaction read back is not the one reviewed end the wait
   * (the step then locks, as before). The pause grows, slows after a failure (../receiptWait.ts), and after 20 s `slow`
   * lets the step say it is sent and still waiting to be seen, with its explorer link.
   */
  async function untilIncluded(gen: number, read: () => Promise<V2Receipt | { state: 'not-included' } | { state: 'batch-reverted' }>, slow?: () => void, away?: (where: 'chain' | 'account' | null) => void): Promise<V2Receipt | { state: 'not-included' } | { state: 'batch-reverted' } | null> {
    // Said at 20 s whatever the pause under way (a read after a failure may be a minute away).
    const late = slow ? setTimeout(slow, RECEIPT_STILL_WAITING_MS) : null
    let failures = 0
    try {
      for (let attempt = 0; ; attempt++) {
        await sleep(receiptPause(attempt, failures))
        if (gen !== generation.current) return null
        let receipt: Awaited<ReturnType<typeof read>> | null = null
        try {
          receipt = await read()
          failures = 0
          away?.(null)
        } catch (error) {
          if (receiptSettled(error)) throw error
          failures++
          // Changed on purpose 2026-10-14 (C3 review): the wallet on another network or account is still "ask again",
          // and the step says to switch back (it waited on "still waiting" with nothing to say why).
          away?.(receiptWalletAway(error))
        }
        if (receipt && receipt.state !== 'pending' && receipt.state !== 'reorged') return receipt
      }
    } finally {
      if (late !== null) clearTimeout(late)
    }
  }

  /** The current step's "still waiting" line, once its wait has passed 20 s (C3). */
  function slowly(gen: number, step: RunStep): () => void {
    return () => {
      if (gen !== generation.current || step.status !== 'sent') return
      step.slow = true
      bump()
    }
  }

  /** The current step's "switch your wallet back" line while its reads fail on the wallet's network or account (C3 review). */
  function awayOf(gen: number, step: RunStep): (where: 'chain' | 'account' | null) => void {
    return (where) => {
      if (gen !== generation.current || step.status !== 'sent' || (step.away ?? null) === where) return
      step.away = where ?? undefined
      bump()
    }
  }

  /**
   * The action's receipt: read from its events.
   *
   * Changed on purpose 2026-10-14 (incident C3: screens finish at inclusion): it was then asked again every 1.5 s until
   * its block was final (about 16 minutes on Robinhood Chain, 15 to 20 on Base and Arbitrum One), with the dialog held
   * busy, only to say "Finalized" where it now says "Confirmed" from inclusion. Nothing is released at finality on this
   * path (the zap's hold goes at inclusion, finance/v2/zap.ts stepReceipt and batchReceipt), so the sheet is done here.
   */
  function openReceipt(hash: Hex | null, receipt: Extract<V2Receipt, { logs: unknown }>): void {
    const reviewed = live.current.reviewed
    if (!reviewed) return
    let announced = false
    const show = (current: Extract<V2Receipt, { logs: unknown }>) => {
      let read: ZapReceipt | null = null
      let unreadable: string | null = null
      try {
        read = readZapReceipt({ chainId: reviewed.review.chainId, zap: reviewed.review.zap, intent: reviewed.review.plan.plan.intent, owner: reviewed.review.owner, receipt: rpcReceiptOf(hash, current) })
      } catch (error) {
        unreadable = error instanceof Error ? error.message : 'receipt_invalid'
      }
      if (current.state !== 'reverted' && !announced) {
        announced = true
        const chain = v2Chain(reviewed.review.chainId)
        const intent = reviewed.review.plan.plan.intent
        const tokenIds = [...new Set([intent.tokenId, read?.summary.tokenId, read?.summary.previousTokenId].filter((id): id is bigint => id !== undefined && id > 0n).map(String))]
        const positionManager = intent.pool.dex === 4 ? chain.uniswap.v4.positionManager : chain.uniswap.v3.positionManager
        positionChanged({ chainId: chain.chainId, positionManager, wallet: reviewed.review.owner, tokenIds, block: current.blockNumber, blockHash: current.blockHash, burnedTokenIds: burnedPositionIds(current.logs, positionManager) })
      }
      live.current.receipt = { state: current.state === 'reverted' ? 'reverted' : current.state, read, unreadable, hash, includedBlock: current.blockNumber }
      bump()
    }
    show(receipt)
  }

  async function advance(gen: number): Promise<void> {
    const state = live.current
    state.current++
    state.prepared = null
    bump()
    await prepareCurrent(gen)
  }

  /** The person's press on the current step: it is sent (or signed) once; the chain decides what comes next. */
  async function confirm(): Promise<void> {
    const gen = generation.current
    const state = live.current
    const reviewed = state.reviewed
    const current = state.steps[state.current]
    if (!reviewed || !current || state.busy || (current.status !== 'ready' && current.status !== 'waiting')) return
    const { zap } = reviewed.connection
    state.busy = true
    state.error = null
    current.status = 'wallet'
    bump()
    // What the wallet was handed: `sent` once it answered with a hash or a batch id; `unknown` when it was asked and
    // gave no answer this page can use. Either way a failure after it locks the step (`locked`).
    let handed: 'no' | 'unknown' | 'sent' = 'no'
    try {
      await onChain(reviewed.connection)
      if (current.kind === 'sign-permit') {
        await zap.signPermit(reviewed.review)
        current.status = 'included'
        state.requotes = 0
        await advance(gen)
        return
      }
      if (current.kind === 'batch') {
        const batch = state.batch && state.batch.expiresAt > now() + 2 ? state.batch : await zap.prepareBatch(reviewed.review)
        state.batch = null
        let id: string
        try {
          id = await zap.sendBatch(batch, true)
        } catch (error) {
          // A wallet that cannot run this batch after all (or an upgrade declined): the same steps, one by one.
          if (error instanceof Error && (error.message === 'batch_unsupported' || error.message === 'batch_upgrade_declined')) {
            toSteps()
            bump()
            await prepareCurrent(gen)
            return
          }
          if (zap.handedOver(reviewed.review)) handed = 'unknown'
          throw error
        }
        handed = 'sent'
        current.status = 'sent'
        bump()
        const receipt = await untilIncluded(gen, () => zap.batchReceipt(id), slowly(gen, current), awayOf(gen, current))
        if (!receipt) return
        if (receipt.state === 'not-included' || receipt.state === 'batch-reverted' || receipt.state === 'reverted') {
          // Known on chain: nothing of it ran, so a fresh quote may follow.
          handed = 'no'
          throw new Error(receipt.state === 'not-included' ? 'wallet_review_expired' : 'batch_simulation_reverted')
        }
        if (receipt.state !== 'included' && receipt.state !== 'finalized') return
        current.status = receipt.state
        if (reviewed.review.pausesAutomation !== null) state.rearm = reviewed.review.pausesAutomation
        bump()
        openReceipt(null, receipt)
        return
      }
      const prepared = state.prepared && state.prepared.expiresAt > now() + 2 ? state.prepared : await zap.prepareStep(reviewed.review, current.index)
      state.prepared = null
      current.feeWei = prepared.networkFeeWei
      let hash: Hex
      try {
        hash = await zap.send(prepared, true)
      } catch (error) {
        if (zap.wasOffered(prepared) || (current.kind === 'action' && zap.handedOver(reviewed.review))) handed = 'unknown'
        throw error
      }
      handed = 'sent'
      current.hash = hash
      current.status = 'sent'
      bump()
      const receipt = await untilIncluded(gen, () => zap.receipt(hash), slowly(gen, current), awayOf(gen, current))
      if (!receipt) return
      if (receipt.state === 'reverted' && current.kind === 'action' && reviewed.review.consent === 'permit2') {
        // Review F3: the permit is public and its nonce unused. Cancelling it comes first; no new quote until then.
        const nonce = reviewed.review.plan.plan.intent.nonce
        current.status = 'ready'
        state.cancel = { entry: { chainId: reviewed.review.chainId, owner: reviewed.review.owner, space: 'permit2', verifier: v2Chain(reviewed.review.chainId).permit2, nonce }, status: 'ready', error: null }
        state.error = { copy: COPY.wallet.permitReverted, code: 'permit_action_reverted', recovery: 'none' }
        return
      }
      if (receipt.state === 'reverted') {
        handed = 'no'
        throw new Error('batch_simulation_reverted')
      }
      if (receipt.state !== 'included' && receipt.state !== 'finalized') return
      current.status = receipt.state
      state.requotes = 0
      if (current.kind === 'action') {
        if (reviewed.review.pausesAutomation !== null) state.rearm = reviewed.review.pausesAutomation
        bump()
        openReceipt(hash, receipt)
        return
      }
      await advance(gen)
    } catch (error) {
      if (gen !== generation.current) return
      if (handed !== 'no') locked(error, handed === 'sent')
      else await failed(gen, error)
    } finally {
      state.busy = false
      bump()
    }
  }

  /** Review F3: the reverted Permit2 action's nonce cancelled first (one transaction), then a fresh quote. */
  async function cancelSignature(): Promise<void> {
    const gen = generation.current
    const state = live.current
    const offer = state.cancel
    const reviewed = state.reviewed
    if (!offer || !reviewed || offer.status !== 'ready' || state.busy) return
    const { zap } = reviewed.connection
    state.busy = true
    offer.status = 'wallet'
    offer.error = null
    bump()
    try {
      await onChain(reviewed.connection)
      const prepared = await zap.prepareCancelNonce(offer.entry)
      const hash = await zap.send(prepared, true)
      offer.status = 'sent'
      bump()
      const receipt = await untilIncluded(gen, () => zap.receipt(hash))
      if (!receipt) return
      if (receipt.state === 'reverted') throw new Error('batch_simulation_reverted')
      state.busy = false
      await quote(true)
    } catch (error) {
      if (gen !== generation.current) return
      offer.status = 'ready'
      offer.error = errorOf(error)
      bump()
    } finally {
      state.busy = false
      bump()
    }
  }

  /** Rev2 §2.13: the person ticked "This pauses automation for this position…": the review's steps may be prepared. */
  async function acknowledgePause(): Promise<void> {
    const gen = generation.current
    const reviewed = live.current.reviewed
    if (!reviewed || reviewed.review.pausesAutomation === null || live.current.pauseAcknowledged) return
    reviewed.connection.zap.acknowledgePause(reviewed.review)
    live.current.pauseAcknowledged = true
    bump()
    await prepareCurrent(gen)
  }

  /**
   * Rev2 review F3: "I rejected it in my wallet", under the refusal that an earlier action handed to the wallet is not
   * settled yet (`zap_action_unsettled`). The money client lets it go only while the chain shows nothing pending for this
   * wallet; then (or once the chain settled it) a fresh quote is asked. Nothing is sent.
   */
  async function forgetUnsettled(): Promise<void> {
    const state = live.current
    const { gate } = latest.current
    if (state.busy || gate.mode !== 'live') return
    state.busy = true
    state.error = null
    bump()
    let answer: 'forgotten' | 'settled' | 'pending' | 'none'
    try {
      const connection = state.reviewed?.connection ?? (await connectPosition(gate))
      if (!connection.zap) throw new Error('deployment_not_live')
      await onChain(connection)
      answer = await connection.zap.forgetUnsettled()
    } catch (error) {
      state.busy = false
      state.error = errorOf(error)
      bump()
      return
    }
    state.busy = false
    if (answer === 'pending') {
      state.error = { copy: STILL_PENDING_COPY, code: 'pending_wallet_transaction', recovery: 'none' }
      bump()
      return
    }
    state.requotes = 0
    await quote(false)
  }

  const view: RunView = live.current
  return {
    view,
    forgetUnsettled: () => void forgetUnsettled(),
    acknowledgePause: () => void acknowledgePause(),
    cancelSignature: () => void cancelSignature(),
    /** The person keeps the signature (it stays held until it expires or is cancelled), and a fresh quote is asked. */
    keepSignature: () => {
      if (live.current.busy) return
      void quote(true)
    },
    start: () => {
      live.current.requotes = 0
      live.current.receipt = null
      void quote(false)
    },
    confirm: () => void confirm(),
    reset: () => {
      generation.current++
      Object.assign(live.current, { ...IDLE, prepared: null, batch: null, requotes: 0, round: live.current.round })
      bump()
    },
  }
}

/** A step's words for the wallet card. */
export function stepLabel(step: RunStep, action: ActionName, amount: (token: Address, raw: bigint) => string, label: (token: Address) => string, permit2: Address): string {
  if (step.kind === 'batch') return COPY.stepLabel.batch
  const s = step.step
  if (!s) return ''
  switch (s.kind) {
    case 'approve-reset': return COPY.stepLabel.resetAllowance(label(s.token))
    case 'approve': {
      const text = amount(s.token, s.amount)
      const [figure, ...rest] = text.split(' ')
      return s.spender === permit2 ? COPY.stepLabel.allowForSigning(figure, rest.join(' ')) : COPY.stepLabel.allow(figure, rest.join(' '))
    }
    case 'approve-nft': return COPY.stepLabel.letManage
    case 'sign-permit': return COPY.stepLabel.signPermit
    case 'action': return COPY.stepLabel[action]
  }
}
