import { useEffect, useReducer, useRef } from 'react'
import { readZapReceipt, type ZapReceipt } from '../../finance/v2/receipt'
import { capacityBusyWait, isCapacityBusy } from '../../finance/v2/requestCoordinator'
import type { PreparedV2, SignedNonce, V2Receipt } from '../../finance/v2/transact'
import type { ZapBatch, ZapReview, ZapStep } from '../../finance/v2/zap'
import { v2Chain } from '../../v2/chains'
import type { V2Gate } from '../../v2/gate'
import { requestS1Plan } from '../../v2/plan/client'
import type { ConsentChoice } from '../../v2/plan/consent'
import { readFeesToCome } from '../../v2/plan/present'
import { planRequestWire } from '../../v2/plan/request'
import { planTargetOf } from '../../v2/plan/route'
import type { S1PlanConsent, S1PlanReply, S1PlanRequest } from '../../v2/plan/types'
import type { Address, Hex, V2ChainId } from '../../v2/types'
import { JOURNEY_QUIET_REQUOTES, NEW_POOL_RACE_COPY } from './constants'
import { JOURNEY } from './copy'
import { journeyError, planFailure, SENT_CHECK_WALLET, SENT_UNKNOWN_COPY, STILL_PENDING, type JourneyError } from './errors'
import { mintedPositionIds, positionChanged } from '../lists/positionSync'
import { CREATED_POSITIONS } from '../lists/createdPositions'
import { SESSION_RECEIPTS, sessionReceiptOfZap } from '../lists/sessionReceipts'
import { recordConfirmedOperation, reorgConfirmedOperation } from '../../lib/confirmedOperations'
import type { JourneyToken } from './tokens'
import { livePlanTransport, liveContext, planRuntime } from './source'
import { connectJourney, onChain, type JourneyConnection } from './wallet'
import { RECEIPT_FOLLOW, type FollowedReceipt } from './receiptFollow'
import { journeyOperation } from './model/receiptOperation'
import { createPlanCache, type PlanAsk } from './model/planCache'
import { RECEIPT_STILL_WAITING_MS, receiptPause, receiptSettled, receiptWalletAway } from '../receiptWait'

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
 *            (a delay is never a failure). Changed on purpose 2026-10-14 (incident C3): on Robinhood Chain the view ends
 *            at inclusion ("Confirmed"); Base and Arbitrum One keep their wallet follow, which also catches a reorg.
 * A plan that fails on price (or expires) goes back to a fresh quote by itself, at most twice in a row, and the person
 * presses again on the new review; a step the wallet may have sent is never offered again (rev2 review F2), and nothing
 * else is until the chain settles it (F3: "I rejected it in my wallet").
 *
 * Changed on purpose 2026-10-30 (QA round 2, INST-2, the owner's "New position faster"; nothing the wallet is asked, no
 * amount, call, approval or signature changes):
 *   - the plan service's answer is kept for the same choices (./model/planCache.ts PLANS: the chain, the wallet and the
 *     request as sent, its consent path included) and handed out again while its quote has at least two minutes left, so
 *     Review opened again does not wait for the plan service; the money client still reviews it afresh, and a kept plan
 *     whose review fails is forgotten and asked again once, without a word. A quote asked again because the price moved
 *     or the quote ran out never takes a kept plan; Create position pressed forgets the plan it runs;
 *   - a plan still being asked for the same choices is joined, never asked twice; each quote brings its own abort, and
 *     the plan request of a quote nobody waits for any more (a new quote for other choices, Review left) is stopped;
 *   - a wallet the plan service refused Permit2 for (`consent_unsupported`) is asked for the direct path at once on that
 *     chain from then on (DIRECT_ONLY), not refused again first;
 *   - a plan request that ran out of time (the service's request_timeout or upstream_timeout, or the page's own deadline)
 *     is asked again once after TIMEOUT_RETRY_MS; a busy service keeps its 4 s / 8 s waits and its Retry-After.
 * The wallet's one-request lock and the reads an earlier review leaves on its client (`reading`, `held`) keep their order.
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
  /** Sent, and its block not seen 20 s later: the step says it is still waiting (C3, ../receiptWait.ts). */
  slow?: boolean
  /** Sent, and its last read failed on the wallet's network (`chain`) or account (`account`): the step says to switch back (C3 review). */
  away?: 'chain' | 'account'
}

export interface Reviewed {
  tokens: readonly JourneyToken[]
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
  state: 'pending' | 'included' | 'finalized' | 'reverted' | 'not-included'
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
  /** Metadata belongs to the pool reviewed, not the pool selected after this run. */
  tokens?: readonly JourneyToken[]
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

/** Added 2026-10-30 (INST-2): New position's plans, kept for the same choices across Review's openings (./model/planCache.ts). */
const PLANS = createPlanCache()
/**
 * Added 2026-10-30 (INST-2): the wallets the plan service refused Permit2 for, by chain (`chain:owner`): asked for the
 * direct path at once from then on. The refusal is the account's (its code on that chain), never the inputs': Permit2 is
 * never offered with native ETH (v2/plan/consent.ts chooseConsent).
 */
const DIRECT_ONLY = new Set<string>()
/** Added 2026-10-30 (INST-2): the one quick retry after a plan request that ran out of time, in ms. */
const TIMEOUT_RETRY_MS = 750
const TIMEOUT_CODES: ReadonlySet<string> = new Set(['request_timeout', 'upstream_timeout', 'plan_timeout'])

/** A plan's key in PLANS: the chain, the wallet and the request's own wire form (fixed key order); null for one never sent. */
function planKeyOf(chainId: V2ChainId, owner: Address, request: S1PlanRequest): string | null {
  try {
    return `${chainId}|${owner.toLowerCase()}|${JSON.stringify(planRequestWire(request))}`
  } catch {
    return null
  }
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
  const live = useRef<RunView & { prepared: PreparedV2 | null; batch: ZapBatch | null; requotes: number; planKey: string | null }>({ ...IDLE, prepared: null, batch: null, requotes: 0, planKey: null })
  const generation = useRef(0)
  /** The abort of the latest quote's plan request (INST-2). */
  const asking = useRef<AbortController | null>(null)
  const latest = useRef(input)
  useEffect(() => {
    latest.current = input
  })
  useEffect(() => () => {
    generation.current++
    asking.current?.abort()
  }, [])
  const errorOf = (error: unknown) => (error instanceof PlanFailure ? error.view : journeyError(error, latest.current.chainId, latest.current.label))

  /**
   * `fresh` (added 2026-10-30, INST-2): never a kept plan, for the one quiet retry after a kept plan's review failed. A
   * quote asked again (`requoting`) never takes a kept plan either.
   */
  async function quote(requoting: boolean, allowSwitch = true, fresh = false): Promise<void> {
    const gen = ++generation.current
    // INST-2: the previous quote's plan request is let go once this one has joined it (the same choices) or asked its
    // own, or failed before; it stops if nobody else waits for it (./model/planCache.ts).
    const previous = asking.current
    const controller = new AbortController()
    asking.current = controller
    const release = () => previous?.abort()
    Object.assign(live.current, { stage: 'quoting', requoting, reviewed: null, asked: null, steps: [], current: 0, error: null, prepared: null, batch: null, feePerGas: null, cancel: null, round: live.current.round + 1, planKey: null })
    bump()
    if (latest.current.gate.mode === 'preview') {
      release()
      return previewQuote(gen)
    }
    const { chainId, gate, inputs, request, tokens = [] } = latest.current
    let key: string | null = null
    let kept = false
    let reviewing = false
    try {
      const transport = livePlanTransport()
      if (!transport) throw new PlanFailure({ copy: JOURNEY.review.planUnavailable, code: 'plan_route_unavailable', recovery: 'none' })
      const connection = await connectJourney(chainId, gate.contracts, allowSwitch)
      // What an earlier review still reads on this client, first (one request at a time).
      await reading.get(connection.zap)
      if (gen !== generation.current) return
      const chosen = await connection.zap.consentFor('create', inputs)
      const owner = connection.zap.owner
      const context = liveContext(chainId, owner, gate.contracts)
      const wallet = `${chainId}:${owner.toLowerCase()}`
      const direct = () => Object.freeze({ ...chosen, path: 'direct' as const, planConsent: 'direct' as const, reason: 'account_has_code' as const })
      // INST-2: a wallet the plan service already refused Permit2 for on this chain goes the direct way at once.
      let consent = chosen.planConsent === 'permit2' && DIRECT_ONLY.has(wallet) ? direct() : chosen
      let asked = request(consent.planConsent)
      if (!asked) throw new Error('plan_target')
      // INST-2: the plan kept for these very choices, the ask already out for them, or a new ask with this quote's abort.
      const askPlan = (plan: S1PlanRequest): { key: string | null; answer: Promise<PlanAsk> } => {
        const planKey = planKeyOf(chainId, owner, plan)
        const send = (signal: AbortSignal) => requestS1Plan(transport, planRuntime, plan, context, undefined, signal)
        const answer = planKey === null ? send(controller.signal).then((result) => ({ result, kept: false })) : PLANS.plan(planKey, send, { signal: controller.signal, reuse: !requoting && !fresh })
        release()
        return { key: planKey, answer }
      }
      let pending = askPlan(asked)
      key = pending.key
      let answer = await pending.answer
      // §2.4: `position_plan_consent_unsupported` (Permit2 for an account with code, or with native ETH): the direct path, without a word.
      if (answer.result.kind === 'refused' && answer.result.code === 'position_plan_consent_unsupported' && consent.planConsent === 'permit2') {
        DIRECT_ONLY.add(wallet)
        consent = direct()
        asked = request('direct')
        if (!asked) throw new Error('plan_target')
        pending = askPlan(asked)
        key = pending.key
        answer = await pending.answer
      }
      const result = answer.result
      kept = answer.kept
      if (gen !== generation.current) return
      if (result.kind !== 'ok') throw new PlanFailure(planFailure(result, chainId, latest.current.label))
      // What the person asked for (rev2 review F1): the money client ties the plan's swaps to it.
      const target = planTargetOf(asked)
      if (!target) throw new Error('plan_target')
      reviewing = true
      const review = await connection.zap.review({ chainId, plan: result.reply.plan, consent: consent.planConsent, quote: result.reply.quote, target, initSqrtPriceX96: asked.initialPrice?.sqrtPriceX96 })
      if (gen !== generation.current) return
      const path: RunPath = consent.path
      const reviewed: Reviewed = { connection, consent, review, reply: result.reply, request: asked, path, at: now(), tokens: tokens.map(token => ({ ...token })) }
      Object.assign(live.current, {
        stage: 'reviewed', requoting: false, reviewed, current: 0, planKey: key,
        steps: path === 'batch' ? [{ kind: 'batch', index: -1, step: null, status: 'waiting', feeWei: null, hash: null }] : stepsOf(review),
      })
      bump()
      await prepareCurrent(gen)
    } catch (error) {
      release()
      if (gen !== generation.current) return
      // INST-2: a plan that failed (its review, or anything once it was had) is never handed out again; a kept plan whose
      // review failed is asked afresh once, without a word (the price may have moved since it was kept).
      if (key !== null) PLANS.forget(key)
      if (kept && reviewing && !fresh) return quote(requoting, allowSwitch, true)
      const view = errorOf(error)
      // An answer past its expiry, or `preview_expired`: asked again without a word, twice at most in a row.
      if (view.recovery === 'quiet-requote' && live.current.requotes < JOURNEY_QUIET_REQUOTES) {
        live.current.requotes++
        return quote(true, allowSwitch)
      }
      // Read failures get bounded, delayed recovery; no wallet transaction is retried here. Changed on purpose 2026-10-30
      // (INST-2): a request that ran out of time is asked again once after TIMEOUT_RETRY_MS; a busy service still waits
      // 4 s, then 8 s, or its Retry-After. Changed on purpose 2026-10-30 (launch capacity, CAP-6): a capacity-busy refusal
      // waits 4 to 5 s (finance/v2/requestCoordinator.ts capacityBusyWait), whatever Retry-After it names (every one says
      // 60 s, while the slot frees in a few seconds); a rate limit (CAP-5: session_rate_limited and the like) keeps its
      // Retry-After. At most JOURNEY_QUIET_REQUOTES in a row either way.
      if (view.recovery === 'retry-later' && (view.retryAfterSeconds ?? 0) <= 300 && live.current.requotes < JOURNEY_QUIET_REQUOTES) {
        const attempt = live.current.requotes++
        const wait = isCapacityBusy(view.code)
          ? capacityBusyWait()
          : Math.max(TIMEOUT_CODES.has(view.code) && attempt === 0 ? TIMEOUT_RETRY_MS : 4000 * 2 ** attempt, (view.retryAfterSeconds ?? 0) * 1000)
        await sleep(wait)
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
    // INST-2: a plan whose step failed is never handed out again.
    if (state.planKey !== null) PLANS.forget(state.planKey)
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
    // Changed on purpose 2026-10-14 (C3 review): the wait has ended, so the step no longer says it is still waiting (it
    // said so beside "nothing more is sent from here").
    if (step) { step.slow = false; step.away = undefined }
    state.prepared = null
    state.batch = null
    state.error = { copy: sent ? SENT_CHECK_WALLET : SENT_UNKNOWN_COPY, code: errorOf(error).code, recovery: 'none' }
    bump()
  }

  /**
   * Asked again and again until the step is on the chain (included) or known reverted; a delay is never a failure.
   *
   * Changed on purpose 2026-10-14 (incident C3: waiting never locks): a failed read is "ask again". It rethrew every
   * failure but three wallet codes, so a refused or lost confirmation read in the second Robinhood Chain takes to include
   * a transaction locked the step with "Sent to your wallet…" although it succeeded, and a review of two steps could not
   * go on. Only the money clients' codes that say the transaction read back is not the one reviewed end the wait (then
   * the step locks, as before: it is never offered again). The pause grows, slows after a failure (../receiptWait.ts),
   * and after 20 s `slow` lets the step say it is sent and still waiting to be seen, with its explorer link.
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
   * The action's receipt: read from its events, then, where the wallet reads finality, its one read at finality.
   *
   * Changed on purpose 2026-10-15 (pack 8, incident C5): no chain id here; the chain's row in config/receiptSources.ts says
   * whether this page itself proves the action final through the wallet (Base, Arbitrum One) or not (Robinhood Chain:
   * read-v6 lists it, and its view ends at inclusion, as below). On Base and Arbitrum One the view followed its receipt
   * through the wallet until final (./receiptFollow.ts: every 5 s, then 15 s, then 30 s, about 50 reads before a block
   * there is final, each read six wallet calls), only to say "Finalized" and to catch a block that left the chain. Its
   * receipt now goes to the confirmation queue (lib/confirmedOperations.ts) with this view's own check (`accept`,
   * unchanged), and the queue makes that read once, when read-v6's finalized mark or the chain's age says the block may
   * be final. The check is the same at that read: a block that left the chain, a transaction found in another block, a
   * batch that never ran. After a block that left the chain, its new block is looked for as before (the follow's
   * reads, until the action is in a block again or known not to have run), and then that block's finality is the queue's.
   */
  async function openReceipt(gen: number, hash: Hex | null, receipt: Extract<V2Receipt, { logs: unknown }>, again: () => Promise<FollowedReceipt>): Promise<void> {
    const reviewed = live.current.reviewed
    if (!reviewed) return
    hash ??= receipt.transactionHash ?? null
    let announced = false
    const chainId = reviewed.review.chainId
    const owner = reviewed.review.owner
    const available = () => !reviewed.connection.wallet.current() ? 'gone' as const : reviewed.connection.wallet.chainId() === chainId ? 'ready' as const : 'paused' as const
    let current = receipt
    let invalidated = false
    /** The block left the chain and no other is known yet: its new block is looked for by the follow (until a block, or "did not run"). */
    const seek = () => RECEIPT_FOLLOW.follow(`${chainId}:${reviewed.review.owner}:${reviewed.review.intentHash}`, { read: again, available, accept: (next) => accept(next) || !invalidated })
    /** This view's check of every later answer of the money client's own read (unchanged since C3; it was the follow's). */
    function accept(next: FollowedReceipt): boolean {
      if (invalidated && (next.state === 'not-included' || next.state === 'batch-reverted')) {
        if (gen === generation.current) {
          live.current.receipt = { state: 'not-included', read: null, unreadable: null, hash }
          bump()
        }
        return true
      }
      if (next.state === 'reorged') {
        if (!invalidated) {
          if (hash) reorgConfirmedOperation({ chainId, wallet: owner, hash, blockHash: current.blockHash })
          invalidated = true
          announced = false
          if (gen === generation.current) {
            live.current.receipt = { state: 'pending', read: null, unreadable: null, hash }
            bump()
          }
          seek()
        }
      } else if (next.state === 'reverted' || next.state === 'included' || next.state === 'finalized') {
        const replaced = invalidated || next.blockHash !== current.blockHash || !!next.transactionHash && next.transactionHash !== hash
        if ((replaced || next.state === 'reverted') && !invalidated && hash) reorgConfirmedOperation({ chainId, wallet: owner, hash, blockHash: current.blockHash })
        hash = next.transactionHash ?? hash
        if (replaced || next.state !== 'included') show(next)
        current = next
        invalidated = false
        return next.state !== 'included'
      }
      return false
    }
    const show = (current: Extract<V2Receipt, { logs: unknown }>) => {
      let read: ZapReceipt | null = null
      let unreadable: string | null = null
      try {
        read = readZapReceipt({ chainId: reviewed.review.chainId, zap: reviewed.review.zap, intent: reviewed.review.plan.plan.intent, owner: reviewed.review.owner, receipt: rpcReceiptOf(hash, current) })
      } catch (error) {
        unreadable = error instanceof Error ? error.message : 'receipt_invalid'
      }
      // Changed on purpose (2026-10-15, pack 8): the position's hint is kept on Robinhood Chain too (it was Base and
      // Arbitrum One only), so the Positions list has its row at once and draws it with the list's own state reading
      // (../lists/positionCollection.ts withCreatedPositions); the confirmation queue is still told only off Robinhood
      // Chain (there it would read the node). And the receipt is a row of Receipts at once (../lists/sessionReceipts.ts).
      // (2026-10-15, pack 8 review, L3): the row at once and the hint are bookkeeping: a throw in either never keeps the
      // queue, the lists or this view from hearing of the receipt (below).
      if (current.state !== 'reverted' && read && hash) {
        try {
          const pool = reviewed.review.plan.plan.intent.pool
          const entry = sessionReceiptOfZap({ wallet: reviewed.review.owner, chainId: reviewed.review.chainId, dex: pool.dex, hash, receipt: current, read, tokens: reviewed.tokens })
          if (entry) SESSION_RECEIPTS.record(entry)
        } catch { /* No row at once: read-v6's item still comes. */ }
      }
      const chain = v2Chain(reviewed.review.chainId), pool = reviewed.review.plan.plan.intent.pool
      const manager = chain.uniswap[pool.dex === 3 ? 'v3' : 'v4'].positionManager
      const tokenId = read && read.summary.tokenId > 0n ? read.summary.tokenId.toString() : null
      if (current.state !== 'reverted' && tokenId && hash) {
        try {
          CREATED_POSITIONS.record({ wallet: reviewed.review.owner, chainId: chain.chainId, positionManager: manager, dex: pool.dex,
            tokenId, hash, block: Number(current.blockNumber), blockHash: current.blockHash, observedAt: Date.now(), fee: pool.fee,
            tokens: [pool.currency0, pool.currency1].map(address => ({ address, symbol: reviewed.tokens.find(token => token.address.toLowerCase() === address.toLowerCase())?.symbol ?? null,
              decimals: reviewed.tokens.find(token => token.address.toLowerCase() === address.toLowerCase())?.decimals ?? null })) })
        } catch { /* No hint: the list finds the NFT when read-v6 lists it. */ }
      }
      // The financial client already checked this exact receipt. Share its inclusion/finality across navigation;
      // the Robinhood-only public confirmation reader must never be used for another chain.
      // Changed on purpose 2026-10-15 (pack 8, C5): with this view's own read and check (`follow`), which the queue makes
      // once at finality (lib/confirmedOperations.ts); it outlives this view, as the follow it replaces did.
      // Changed on purpose (2026-10-15, pack 8 review, L1): every receipt in a block where the wallet reads finality, as
      // main's follow took every one: also one whose reader could not decode it or that names no new NFT (then the NFT
      // of the position manager's own mint log, or none), so its block leaving the chain is still caught at that read.
      const minted = tokenId ? [tokenId] : current.state === 'reverted' ? [] : mintedPositionIds(current.logs, manager)
      const operation = journeyOperation({ chainId: chain.chainId, owner: reviewed.review.owner, positionManager: manager, hash, receipt: current, tokenIds: minted, follow: { read: again, accept, available } })
      if (operation) {
        recordConfirmedOperation(operation)
        // The queue's word names the NFT for the lists; with none named, the wallet-wide word below, as before.
        if (minted.length) announced = true
      }
      if (current.state !== 'reverted' && !announced) {
        announced = true
        // Changed on purpose 2026-10-14 (the incident of 2026-10-13, package V1): the NFT is named whenever the receipt
        // has it, from its summary or else from the position manager's own mint log, so the hold that follows covers
        // that NFT alone. Naming none held every position of the wallet on the chain ("Updating", no dollars).
        // (2026-10-15, pack 8 review): `chain`, `manager` and `minted` are worked out once, above.
        positionChanged({ chainId: chain.chainId, positionManager: manager, wallet: reviewed.review.owner, tokenIds: minted.length ? minted : undefined, block: current.blockNumber })
      }
      if (gen === generation.current) {
        live.current.receipt = { state: current.state === 'reverted' ? 'reverted' : current.state, read, unreadable, hash }
        bump()
      }
    }
    // Where the wallet reads finality, the receipt is now the queue's (`show` recorded it with its read and check above).
    show(receipt)
    // Changed on purpose 2026-10-14 (incident C3: screens finish at inclusion): on Robinhood Chain the created view asked
    // the receipt again every 1.5 s until its block was final, about 16 minutes (some 50 questions a minute to the site's
    // node while the view stayed open), only to say "Finalized" where it now says "Confirmed" from inclusion. Nothing is
    // released at finality on this path (the zap's hold goes at inclusion, finance/v2/zap.ts stepReceipt), so the view
    // ends here: finality is a line of the opened receipt (../lists/words.ts).
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
        const receipt = await untilIncluded(gen, () => zap.batchReceipt(id), slowly(gen, step), awayOf(gen, step))
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
      const receipt = await untilIncluded(gen, () => zap.receipt(hash), slowly(gen, step), awayOf(gen, step))
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
    // INST-2: the plan Create position runs is used from now on (a signature, an approval for it): never handed out again.
    if (state.planKey !== null) PLANS.forget(state.planKey)
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
      // INST-2: a plan request nobody waits for any more stops (unless another quote shares it).
      asking.current?.abort()
      asking.current = null
      Object.assign(live.current, { ...IDLE, prepared: null, batch: null, requotes: 0, planKey: null })
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
