import { useEffect, useReducer, useRef } from 'react'
import { readZapReceipt, type ZapReceipt } from '../../finance/v2/receipt'
import type { PreparedV2, SignedNonce, V2Receipt } from '../../finance/v2/transact'
import type { ZapBatch, ZapReview, ZapStep } from '../../finance/v2/zap'
import { v2Chain } from '../../v2/chains'
import type { V2Gate } from '../../v2/gate'
import { requestS1Plan } from '../../v2/plan/client'
import type { ConsentChoice } from '../../v2/plan/consent'
import { readFeesToCome } from '../../v2/plan/present'
import { planTargetOf } from '../../v2/plan/route'
import type { S1PlanConsent, S1PlanReply, S1PlanRequest } from '../../v2/plan/types'
import type { Address, Hex, V2ChainId } from '../../v2/types'
import { JOURNEY_QUIET_REQUOTES, JOURNEY_RECEIPT_POLL_MS, NEW_POOL_RACE_COPY } from './constants'
import { JOURNEY } from './copy'
import { journeyError, planFailure, SENT_CHECK_WALLET, SENT_UNKNOWN_COPY, STILL_PENDING, type JourneyError } from './errors'
import { positionChanged } from '../lists/positionSync'
import { livePlanTransport, liveContext, planRuntime } from './source'
import { connectJourney, onChain, type JourneyConnection } from './wallet'

/**
 * New position's create on Domino's new contracts, from the quote to the receipt (spec F7 rev2 §2.4, §2.5, §2.6.1,
 * §2.6.5, §2.10, §2.11), copied from the #/v2 screens' run (src/v2ui/s1/run.ts, never imported) and shaped to the
 * journey's own Create position: one press runs the wallet's steps in order, each confirmed on the network before the
 * next, as today's Create position does.
 *
 * Under a `preview` gate (before the deploy): no plan is asked at all (no contract is live to plan for, and no test data
 * stands in: Changed on purpose (data) 2026-10-02, the owner, real data only); the review shows what was chosen
 * (`asked`) and the gate's locked sentence where the wallet's steps would be (the money clients are locked there too).
 * No wallet is asked anything.
 *
 * Under a `live` gate:
 *   quote:   the wallet put on the plan's chain (switch first), the consent path read (EIP-5792 on THIS chain, the
 *            account's code on THIS chain: batch, Permit2 or direct, §2.5.4), the plan asked of the plan service (it
 *            picks the nonce), checked by the package and the app (§2.4), then the zap client's review (every check of
 *            §2.4 again, every read at one block). A `consent_unsupported` answer is asked again for the direct path, an
 *            expired one again, without a word;
 *   steps:   one press: a batch (one confirmation, [approvals…, action]) when the wallet batches; else each step in turn,
 *            each prepared (simulated, its fee known) when it becomes current, each confirmed on the network
 *            ("Included") before the next; a Permit2 signature is a step of its own. The approvals after the first are
 *            also read at the review, for their fee only (Review's one network fee line counts them);
 *   receipt: read from the zap's events, matched to the plan by its intentHash, followed from "Included" to "Finalized"
 *            (a delay is never a failure).
 * A plan that fails on price (or expires) goes back to a fresh quote by itself, at most twice in a row, and the person
 * presses again on the new review; a step the wallet may have sent is never offered again (rev2 review F2), and nothing
 * else is until the chain settles it (F3: "I rejected it in my wallet").
 */

export type RunPath = 'batch' | 'permit2' | 'direct'
export type StepStatus = 'waiting' | 'preparing' | 'ready' | 'wallet' | 'sent' | 'unknown' | 'included' | 'finalized'

export interface RunStep {
  kind: ZapStep['kind'] | 'batch'
  /** The review's step index (-1 for the batch). */
  index: number
  step: ZapStep | null
  status: StepStatus
  feeWei: bigint | null
  hash: Hex | null
}

export interface Reviewed {
  connection: JourneyConnection
  consent: ConsentChoice & { atomic: string; account: string }
  review: ZapReview
  reply: S1PlanReply
  request: S1PlanRequest
  path: RunPath
  /** Unix seconds the review was made at. */
  at: number
}

export interface ReceiptView {
  state: 'pending' | 'included' | 'finalized' | 'reverted'
  read: ZapReceipt | null
  /** The receipt could not be read exactly: its code (nothing is guessed). */
  unreadable: string | null
  hash: Hex | null
}

export interface CancelOffer {
  entry: SignedNonce
  status: 'ready' | 'wallet' | 'sent'
  error: JourneyError | null
}

export interface RunView {
  stage: 'idle' | 'quoting' | 'reviewed' | 'failed'
  requoting: boolean
  /** The `live` review; always null under `preview` (no plan is asked there). */
  reviewed: Reviewed | null
  /** Under `preview`: the request as it would be asked, for the review to show what was chosen (no figure). */
  asked: S1PlanRequest | null
  steps: readonly RunStep[]
  current: number
  /** A press is running the steps (or a wallet request is open). */
  busy: boolean
  error: JourneyError | null
  receipt: ReceiptView | null
  /** The fee ceiling per gas of the steps prepared so far, for the quote's own network cost. */
  feePerGas: bigint | null
  cancel: CancelOffer | null
  /** How many quotes this run asked for: a new one is reviewed again before any step. */
  round: number
}

export interface RunInput {
  chainId: V2ChainId
  gate: Extract<V2Gate, { mode: 'preview' | 'live' }>
  /** The plan request for a consent; null while a step is incomplete. */
  request: (consent: S1PlanConsent) => S1PlanRequest | null
  /** The tokens the person puts in, for the consent path. */
  inputs: readonly { token: Address }[]
  /** A safe label for a token address, for the error sentences. */
  label: (token: Address) => string
}

class PlanFailure extends Error {
  readonly view: JourneyError
  constructor(view: JourneyError) {
    super(view.code)
    this.view = view
  }
}

const now = () => Date.now() / 1000
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const stepsOf = (review: ZapReview): RunStep[] => review.steps.map((step, index) => ({ kind: step.kind, index, step, status: 'waiting', feeWei: null, hash: null }))

/**
 * Added 2026-10-06 (the review of point 4, a second look): the reads a review leaves running on its zap client (its
 * current step being prepared, then the later approvals' fees), by client. A client runs one request at a time and refuses
 * a second (`wallet_action_busy`), and the page keeps one client per chain and wallet (./wallet.ts), so a new quote on it
 * waits for them first: Back, then Continue, on Review met "Another request to your wallet is still open". A review that
 * is gone stops at its next check, so this is at most the one read under way.
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

/** The codes a priced-first pool shows up as in a simulation: the mint below its minimum (the zap's revert, or the plan's own check). */
const RACE_CODES: ReadonlySet<string> = new Set(['InsufficientLiquidity(uint128,uint128)', 'plan_simulated_below_minimum', 'plan_price_moved'])

const IDLE: RunView = { stage: 'idle', requoting: false, reviewed: null, asked: null, steps: [], current: 0, busy: false, error: null, receipt: null, feePerGas: null, cancel: null, round: 0 }

export function useJourneyRun(input: RunInput) {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const live = useRef<RunView & { prepared: PreparedV2 | null; batch: ZapBatch | null; requotes: number }>({ ...IDLE, prepared: null, batch: null, requotes: 0 })
  const generation = useRef(0)
  const latest = useRef(input)
  useEffect(() => {
    latest.current = input
  })
  useEffect(() => () => void generation.current++, [])
  const errorOf = (error: unknown) => (error instanceof PlanFailure ? error.view : journeyError(error, latest.current.chainId, latest.current.label))

  async function quote(requoting: boolean, allowSwitch = true): Promise<void> {
    const gen = ++generation.current
    Object.assign(live.current, { stage: 'quoting', requoting, reviewed: null, asked: null, steps: [], current: 0, error: null, prepared: null, batch: null, feePerGas: null, cancel: null, round: live.current.round + 1 })
    bump()
    if (latest.current.gate.mode === 'preview') return previewQuote(gen)
    const { chainId, gate, inputs, request } = latest.current
    try {
      const transport = livePlanTransport()
      if (!transport) throw new PlanFailure({ copy: JOURNEY.review.planUnavailable, code: 'plan_route_unavailable', recovery: 'none' })
      const connection = await connectJourney(chainId, gate.contracts, allowSwitch)
      // What an earlier review still reads on this client, first (one request at a time).
      await reading.get(connection.zap)
      if (gen !== generation.current) return
      const chosen = await connection.zap.consentFor('create', inputs)
      const context = liveContext(chainId, connection.zap.owner, gate.contracts)
      let consent = chosen
      let asked = request(consent.planConsent)
      if (!asked) throw new Error('plan_target')
      let result = await requestS1Plan(transport, planRuntime, asked, context)
      // §2.4: `position_plan_consent_unsupported` (Permit2 for an account with code, or with native ETH): the direct path, without a word.
      if (result.kind === 'refused' && result.code === 'position_plan_consent_unsupported' && consent.planConsent === 'permit2') {
        consent = Object.freeze({ ...chosen, path: 'direct' as const, planConsent: 'direct' as const, reason: 'account_has_code' as const })
        asked = request('direct')
        if (!asked) throw new Error('plan_target')
        result = await requestS1Plan(transport, planRuntime, asked, context)
      }
      if (gen !== generation.current) return
      if (result.kind !== 'ok') throw new PlanFailure(planFailure(result, chainId, latest.current.label))
      // What the person asked for (rev2 review F1): the money client ties the plan's swaps to it.
      const target = planTargetOf(asked)
      if (!target) throw new Error('plan_target')
      const review = await connection.zap.review({ chainId, plan: result.reply.plan, consent: consent.planConsent, quote: result.reply.quote, target, initSqrtPriceX96: asked.initialPrice?.sqrtPriceX96 })
      if (gen !== generation.current) return
      const path: RunPath = consent.path
      const reviewed: Reviewed = { connection, consent, review, reply: result.reply, request: asked, path, at: now() }
      Object.assign(live.current, {
        stage: 'reviewed', requoting: false, reviewed, current: 0,
        steps: path === 'batch' ? [{ kind: 'batch', index: -1, step: null, status: 'waiting', feeWei: null, hash: null }] : stepsOf(review),
      })
      bump()
      await prepareCurrent(gen)
    } catch (error) {
      if (gen !== generation.current) return
      const view = errorOf(error)
      // An answer past its expiry, or `preview_expired`: asked again without a word, twice at most in a row.
      if (view.recovery === 'quiet-requote' && live.current.requotes < JOURNEY_QUIET_REQUOTES) {
        live.current.requotes++
        return quote(true, allowSwitch)
      }
      // Read failures get bounded, delayed recovery; no wallet transaction is retried here.
      if (view.recovery === 'retry-later' && (view.retryAfterSeconds ?? 0) <= 300 && live.current.requotes < JOURNEY_QUIET_REQUOTES) {
        const attempt = live.current.requotes++
        await sleep(Math.max(4000 * 2 ** attempt, (view.retryAfterSeconds ?? 0) * 1000))
        if (gen === generation.current) return quote(true, false)
        return
      }
      Object.assign(live.current, { stage: 'failed', requoting: false, error: view })
      bump()
    }
  }

  /**
   * A `preview` gate: no plan is asked (no contract is live to plan for, and no test data stands in); the review shows
   * what was chosen and the gate's sentence. Nothing is asked of any wallet.
   */
  async function previewQuote(gen: number): Promise<void> {
    if (gen !== generation.current) return
    const { request } = latest.current
    const asked = request('direct')
    Object.assign(live.current, { stage: 'reviewed', requoting: false, asked })
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
  async function prepareCurrent(gen: number): Promise<boolean> {
    const state = live.current
    const reviewed = state.reviewed
    const step = state.steps[state.current]
    if (!reviewed || !step || gen !== generation.current) return false
    if (step.kind === 'sign-permit') {
      step.status = 'ready'
      bump()
      return true
    }
    step.status = 'preparing'
    bump()
    const { zap } = reviewed.connection
    try {
      if (step.kind === 'batch') {
        const batch = await held(zap, zap.prepareBatch(reviewed.review))
        if (gen !== generation.current) return false
        state.batch = batch
        step.feeWei = batch.networkFeeWei
      } else {
        const prepared = await held(zap, zap.prepareStep(reviewed.review, step.index))
        if (gen !== generation.current) return false
        state.prepared = prepared
        step.feeWei = prepared.networkFeeWei
        state.feePerGas = BigInt(prepared.transaction.maxFeePerGas)
        // The approvals after this one, for their fee only (2026-10-06: Review's one network fee line counts them).
        await held(zap, readFeesToCome(state.steps, state.current, async (index) => (await zap.prepareStep(reviewed.review, index)).networkFeeWei, () => gen === generation.current))
        if (gen !== generation.current) return false
      }
      step.status = 'ready'
      bump()
      return true
    } catch (error) {
      if (gen !== generation.current) return false
      // A wallet without eth_simulateV1: no batch, the steps go one by one (no other node is asked, OP9).
      if (step.kind === 'batch' && error instanceof Error && error.message === 'batch_simulation_unavailable') {
        toSteps()
        bump()
        return prepareCurrent(gen)
      }
      await failed(gen, error)
      return false
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
    // Rev2 §2.6.5's race met in the simulation (2026-10-03, audit gap 7): the mint would fall below its minimum because
    // someone priced the pool first. Said as the race, never as a price move; the screen re-reads the pool and goes on
    // with the ordinary create on the pool that now exists.
    const reviewed = state.reviewed
    if (reviewed && reviewed.review.createsPool && RACE_CODES.has(view.code) && (await poolNowPriced(reviewed))) {
      if (gen !== generation.current) return
      state.error = { copy: NEW_POOL_RACE_COPY, code: 'pool_race', recovery: 'pool-race' }
      bump()
      return
    }
    if ((view.recovery === 'requote' || view.recovery === 'quiet-requote') && state.requotes < JOURNEY_QUIET_REQUOTES && gen === generation.current) {
      state.requotes++
      state.busy = false
      return quote(true)
    }
    state.error = view
    bump()
  }

  /** Rev2 review F2: a step the wallet may have sent stays locked, never offered again from this review, with no re-quote. */
  function locked(error: unknown, sent: boolean): void {
    const state = live.current
    const step = state.steps[state.current]
    if (step && step.status !== 'included' && step.status !== 'finalized') step.status = sent ? 'sent' : 'unknown'
    state.prepared = null
    state.batch = null
    state.error = { copy: sent ? SENT_CHECK_WALLET : SENT_UNKNOWN_COPY, code: errorOf(error).code, recovery: 'none' }
    bump()
  }

  /** Asked again and again until the step is on the chain (included) or known reverted; a delay is never a failure. */
  async function untilIncluded(gen: number, read: () => Promise<V2Receipt | { state: 'not-included' } | { state: 'batch-reverted' }>): Promise<V2Receipt | { state: 'not-included' } | { state: 'batch-reverted' } | null> {
    for (;;) {
      if (gen !== generation.current) return null
      let receipt: Awaited<ReturnType<typeof read>> | null = null
      try {
        receipt = await read()
      } catch (error) {
        // The wallet busy with another request, or a node that did not answer: ask again shortly.
        if (!(error instanceof Error) || !/wallet_action_busy|wallet_timeout|wallet_action_expired/.test(error.message)) throw error
      }
      if (receipt && receipt.state !== 'pending' && receipt.state !== 'reorged') return receipt
      await sleep(JOURNEY_RECEIPT_POLL_MS)
    }
  }

  /** The action's receipt: read from its events, then followed until "Finalized". */
  async function openReceipt(gen: number, hash: Hex | null, receipt: Extract<V2Receipt, { logs: unknown }>, again: () => Promise<V2Receipt | { state: 'not-included' } | { state: 'batch-reverted' }>): Promise<void> {
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
        const dex = reviewed.review.plan.plan.intent.pool.dex
        positionChanged({ chainId: chain.chainId, positionManager: dex === 4 ? chain.uniswap.v4.positionManager : chain.uniswap.v3.positionManager, wallet: reviewed.review.owner, tokenIds: read && read.summary.tokenId > 0n ? [read.summary.tokenId.toString()] : undefined, block: current.blockNumber })
      }
      live.current.receipt = { state: current.state === 'reverted' ? 'reverted' : current.state, read, unreadable, hash }
      bump()
    }
    show(receipt)
    let current = receipt
    while (current.state === 'included' && gen === generation.current) {
      await sleep(JOURNEY_RECEIPT_POLL_MS)
      let next: Awaited<ReturnType<typeof again>> | null = null
      try {
        next = await again()
      } catch {
        next = null
      }
      if (next && (next.state === 'finalized' || next.state === 'included')) {
        current = next
        if (next.state === 'finalized') show(next)
      }
    }
  }

  /** Whether the pool a new-pool plan was to create has a price now (rev2 §2.6.5's race), read through the wallet. */
  async function poolNowPriced(reviewed: Reviewed): Promise<boolean> {
    try {
      return (await reviewed.connection.zap.readPool(reviewed.review.plan.plan.intent.pool)).initialized
    } catch {
      return false
    }
  }

  /**
   * One step, sent (or signed) once; the chain decides what comes next. 'next' when the next step may follow, 'done' when
   * the action is on chain (its receipt open), 'stop' otherwise (a failure said, a lock, a refusal).
   */
  async function confirmOne(gen: number): Promise<'next' | 'done' | 'stop'> {
    const state = live.current
    const reviewed = state.reviewed
    const step = state.steps[state.current]
    if (!reviewed || !step || (step.status !== 'ready' && step.status !== 'waiting')) return 'stop'
    const { zap } = reviewed.connection
    state.error = null
    step.status = 'wallet'
    bump()
    // Rev2 review F2: what the wallet was handed. `sent` once it answered with a hash or a batch id; `unknown` when it was
    // asked and gave no answer this page can use. Either way a failure after it locks the step: never a re-quote, unless
    // the chain says nothing of it ran (a reverted or not included one, set back to `no`).
    let handed: 'no' | 'unknown' | 'sent' = 'no'
    try {
      // The wallet put back on the plan's chain if it moved since the review (switch first, never a guess).
      await onChain(reviewed.connection)
      if (step.kind === 'sign-permit') {
        await zap.signPermit(reviewed.review)
        step.status = 'included'
        state.requotes = 0
        state.current++
        state.prepared = null
        bump()
        return (await prepareCurrent(gen)) ? 'next' : 'stop'
      }
      if (step.kind === 'batch') {
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
            return (await prepareCurrent(gen)) ? 'next' : 'stop'
          }
          if (zap.handedOver(reviewed.review)) handed = 'unknown'
          throw error
        }
        handed = 'sent'
        step.status = 'sent'
        bump()
        const receipt = await untilIncluded(gen, () => zap.batchReceipt(id))
        if (!receipt) return 'stop'
        if (receipt.state === 'not-included' || receipt.state === 'batch-reverted' || receipt.state === 'reverted') {
          handed = 'no'
          throw new Error(receipt.state === 'not-included' ? 'wallet_review_expired' : 'batch_simulation_reverted')
        }
        if (receipt.state !== 'included' && receipt.state !== 'finalized') return 'stop'
        step.status = receipt.state
        bump()
        void openReceipt(gen, null, receipt, () => zap.batchReceipt(id))
        return 'done'
      }
      const prepared = state.prepared && state.prepared.expiresAt > now() + 2 ? state.prepared : await zap.prepareStep(reviewed.review, step.index)
      state.prepared = null
      step.feeWei = prepared.networkFeeWei
      let hash: Hex
      try {
        hash = await zap.send(prepared, true)
      } catch (error) {
        // F2: handed to the wallet with no usable answer (its nonce still held, or the plan's action handed over): it may run.
        if (zap.wasOffered(prepared) || (step.kind === 'action' && zap.handedOver(reviewed.review))) handed = 'unknown'
        throw error
      }
      handed = 'sent'
      step.hash = hash
      step.status = 'sent'
      bump()
      const receipt = await untilIncluded(gen, () => zap.receipt(hash))
      if (!receipt) return 'stop'
      if (receipt.state === 'reverted' && step.kind === 'action' && reviewed.review.consent === 'permit2') {
        // Review F3: the permit is public and its nonce unused. Cancelling it comes first; no new quote until then.
        const nonce = reviewed.review.plan.plan.intent.nonce
        step.status = 'ready'
        state.cancel = { entry: { chainId: reviewed.review.chainId, owner: reviewed.review.owner, space: 'permit2', verifier: v2Chain(reviewed.review.chainId).permit2, nonce }, status: 'ready', error: null }
        state.error = { copy: JOURNEY.final.permitReverted, code: 'permit_action_reverted', recovery: 'none' }
        bump()
        return 'stop'
      }
      if (receipt.state === 'reverted' && step.kind === 'action' && reviewed.review.createsPool && (await poolNowPriced(reviewed))) {
        // Rev2 §2.6.5's race: someone priced the pool first, and the mint fell below its minimum. Said; the screen re-reads
        // the pool and goes on with the ordinary create on the pool that now exists.
        step.status = 'ready'
        state.error = { copy: NEW_POOL_RACE_COPY, code: 'pool_race', recovery: 'pool-race' }
        bump()
        return 'stop'
      }
      if (receipt.state === 'reverted') {
        handed = 'no'
        throw new Error('batch_simulation_reverted')
      }
      if (receipt.state !== 'included' && receipt.state !== 'finalized') return 'stop'
      step.status = receipt.state
      state.requotes = 0
      if (step.kind === 'action') {
        bump()
        void openReceipt(gen, hash, receipt, () => zap.receipt(hash))
        return 'done'
      }
      state.current++
      state.prepared = null
      bump()
      return (await prepareCurrent(gen)) ? 'next' : 'stop'
    } catch (error) {
      if (gen !== generation.current) return 'stop'
      if (handed !== 'no') locked(error, handed === 'sent')
      else await failed(gen, error)
      return 'stop'
    }
  }

  /** Create position: the steps in order, from the current one, until the action is on chain or one stops. */
  async function run(): Promise<void> {
    const state = live.current
    if (state.busy || !state.reviewed || state.cancel) return
    // A quote past its three minutes is asked again before any consent (decision #3); the person presses on the new review.
    if (now() >= state.reviewed.review.quoteExpiresAt) {
      state.requotes = 0
      return quote(true)
    }
    const gen = generation.current
    state.busy = true
    bump()
    try {
      for (;;) {
        const outcome = await confirmOne(gen)
        if (outcome !== 'next' || gen !== generation.current) break
      }
    } finally {
      if (gen === generation.current) {
        state.busy = false
        bump()
      }
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

  /**
   * Rev2 review F3: "I rejected it in my wallet", under the refusal that an earlier action handed to the wallet is not
   * settled yet (`zap_action_unsettled`). The money client lets it go only while the chain shows nothing pending for this
   * wallet; then a fresh quote is asked. Nothing is sent.
   */
  async function forgetUnsettled(): Promise<void> {
    const state = live.current
    if (state.busy || latest.current.gate.mode !== 'live') return
    const { chainId, gate } = latest.current
    state.busy = true
    state.error = null
    bump()
    let answer: Awaited<ReturnType<JourneyConnection['zap']['forgetUnsettled']>>
    try {
      const connection = state.reviewed?.connection ?? (await connectJourney(chainId, gate.contracts))
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
      state.error = { copy: STILL_PENDING, code: 'pending_wallet_transaction', recovery: 'none' }
      bump()
      return
    }
    state.requotes = 0
    await quote(false)
  }

  const view: RunView = live.current
  return {
    view,
    /** Asks for a quote and reviews it (the Review step opening, or Review again). */
    start: () => {
      live.current.requotes = 0
      live.current.receipt = null
      void quote(false)
    },
    /** An idle review may refresh without prompting a wallet or replaying any offered step. */
    refresh: () => {
      const state = live.current
      const connection = state.reviewed?.connection
      if (state.stage !== 'reviewed' || state.busy || state.receipt || state.cancel || state.error || !connection?.wallet.current() || connection.wallet.chainId() !== connection.chainId) return
      if (state.steps.some((step) => !['ready', 'waiting'].includes(step.status))) return
      state.requotes = 0
      void quote(true, false)
    },
    run: () => void run(),
    cancelSignature: () => void cancelSignature(),
    /** The person keeps the signature (it stays valid until its deadline), and a fresh quote is asked. */
    keepSignature: () => {
      if (live.current.busy) return
      live.current.cancel = null
      void quote(true)
    },
    forgetUnsettled: () => void forgetUnsettled(),
    reset: () => {
      generation.current++
      Object.assign(live.current, { ...IDLE, prepared: null, batch: null, requotes: 0 })
      bump()
    },
  }
}

/** A step's words, in the journey's voice ("Allow 1,000 USDC", "Sign the deposit", "Create the position"). */
export function stepTitle(step: RunStep, amount: (token: Address, raw: bigint) => string, label: (token: Address) => string, permit2: Address): string {
  if (step.kind === 'batch') return JOURNEY.steps.batch
  const s = step.step
  if (!s) return ''
  switch (s.kind) {
    case 'approve-reset': return JOURNEY.steps.resetAllowance(label(s.token))
    case 'approve': return s.spender === permit2 ? JOURNEY.steps.allowForSigning(amount(s.token, s.amount)) : JOURNEY.steps.allow(amount(s.token, s.amount))
    case 'approve-nft': return JOURNEY.steps.create
    case 'sign-permit': return JOURNEY.steps.signPermit
    case 'action': return JOURNEY.steps.create
  }
}
