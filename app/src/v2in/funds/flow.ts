/**
 * The deposit's wallet steps in order (spec F7 §3.6), as one function over injected parts so the node tests can run it
 * against a fake origin chain. Copied on purpose from the rejected #/v2 section (src/v2ui/s2/flow.ts, reference only),
 * its logic unchanged. Nothing here names a wallet method: the closed sender (finance/v2/crosschain.ts) does every read
 * and send, and the wallet port does the switch.
 *
 *   0. The quote must still be sendable here (v2/crosschain/steps.ts): one that did not come from the service over HTTP
 *      never is (the sender's own `quote_synthetic` guard), and stops before the wallet is asked anything; an expired one
 *      stops for a new quote.
 *   1. The wallet goes to the origin chain (a switch only; 4902 is "Add {origin} to your wallet, then try again.").
 *   2. The sender reviews the quote: account, chain, and for an ERC-20 the allowance read on the origin.
 *   3. When the allowance is short, the exact approval is sent and its receipt waited for (a delay is never a failure).
 *   4. Before the deposit the quote must still be sendable: past its deadline the flow stops for a new quote, which the
 *      offer shows before the person presses again (the allowance is then read again, and covers).
 *   5. The deposit is sent exactly as the quote gave it; the sender keeps its journal record. Tracking starts.
 *
 * One step at a time: two transactions. Changed on purpose 2026-10-06 (rugged's answer of 6 Oct: the owner revoked
 * decision #15; F7 delta of 6 Oct §2, steps 1 to 7): after step 2, an approval that is still needed goes with the deposit
 * as ONE EIP-5792 batch when the wallet batches atomically on the origin (the sender's `atomic`: `supported` or
 * `ready`), one confirmation; the quote is checked first, as before the deposit (step 4: past its deadline, a new
 * quote); the batch the wallet took is followed until the wallet names its one transaction, which is the deposit's
 * (the sender's `batchStatus`), and tracking starts from it. A wallet that cannot batch (or an account upgrade
 * declined) goes step by step, as before; an allowance that covers the amount sends the deposit alone, one transaction,
 * never a batch; native ETH is one transaction. FUNDS_BATCH_APPROVAL_AND_DEPOSIT turns the batch off.
 *
 * A step handed to the wallet stays offered: the sender never offers it again from that review, a deposit never again
 * from any review of that quote, and when the wallet gave no usable answer (`offered` below) nothing more is offered on
 * that origin for this owner until the chain or the person settles it (finance/v2/crosschain.ts UnsettledStore). Every
 * outcome names the step it stopped at and the hash it holds, so the offer never offers to send it again.
 */
import type { AtomicStatus } from '../../finance/batch'
import { OriginStepError, type BatchState, type OriginReceipt, type OriginReview, type OriginSender, type PendingBatch, type SentStep } from '../../finance/v2/crosschain'
import type { Timing } from '../../v2/crosschain/client'
import { stillSendable, walletSteps } from '../../v2/crosschain/steps'
import type { CrosschainTransport } from '../../v2/crosschain/transport'
import type { CrosschainValidators, QuotePlan } from '../../v2/crosschain/types'
import { FUNDS_BATCH_APPROVAL_AND_DEPOSIT } from './constants'

type Hex = `0x${string}`

export type FlowStage =
  | { stage: 'switching' }
  | { stage: 'reviewing' }
  | { stage: 'approval_wallet' }
  | { stage: 'approval_sent'; hash: Hex }
  | { stage: 'approval_done'; hash: Hex; receipt: 'included' | 'finalized' }
  | { stage: 'approval_skipped' }
  | { stage: 'deposit_wallet' }
  /** Added 2026-10-06: the approval and the deposit offered as one batch, then taken by the wallet (its id). */
  | { stage: 'batch_wallet' }
  | { stage: 'batch_sent'; batchId: string }

export type FlowStep = 'review' | 'approval' | 'deposit'

export type FlowOutcome =
  /** The deposit is in the wallet's hands, with its hash; the record is kept (or not: `sent.journaled`). */
  | { kind: 'sent'; sent: SentStep; review: OriginReview }
  /** A quote that did not come from the service over HTTP (never sendable: the sender's own `quote_synthetic`): nothing was asked of the wallet. */
  | { kind: 'synthetic' }
  /** Past the quote's deadline: get a new one. `approved`: the approval went through first. */
  | { kind: 'expired'; approved: boolean }
  /** steps.ts gives no step for this quote (no decision, another owner, a shape this app never sends). */
  | { kind: 'not_sendable'; reason: string }
  /** The wallet did not switch to the origin. */
  | { kind: 'switch'; outcome: string }
  /**
   * The sender stopped (OriginStepError's code), at a step, with the hash that step already holds if any. `offered`: the
   * step reached the wallet and its outcome is not known (wallet_result_unknown): it counts as sent on this page.
   * Added 2026-10-06, a batch's own stops, at the deposit: `batch_not_included` and `batch_reverted` (nothing of it ran),
   * `batch_unknown` (the wallet took it and cannot say what became of it: offered).
   */
  | { kind: 'error'; step: FlowStep; code: string; hash: Hex | null; offered: boolean }
  /** The approval was included and reverted: nothing was approved. */
  | { kind: 'approval_reverted'; hash: Hex }
  /** The page moved on (another wallet, account or quote). */
  | { kind: 'aborted' }

export interface FlowDeps {
  runtime: CrosschainValidators
  owner: string
  /** Added 2026-10-06: with `atomic`, `sendBatch` and `batchStatus`, the approval and the deposit may go as one batch. */
  sender: Pick<OriginSender, 'review' | 'send' | 'receipt'> & Partial<Pick<OriginSender, 'atomic' | 'sendBatch' | 'batchStatus'>>
  switchToOrigin(chainId: number): Promise<string>
  walletChainId(): number | null
  monoMs(): number
  wait(ms: number): Promise<void>
  aborted(): boolean
  receiptPollMs: number
}

export interface FlowInput {
  quote: QuotePlan
  timing: Timing
  source: CrosschainTransport['kind']
}

/** Receipt reads that fail for these reasons are asked again (a delay is never a failure); anything else stops. */
const TRANSIENT_READ = new Set(['wallet_error', 'invalid_wallet_reply', 'wallet_action_expired', 'wallet_action_busy'])

const codeOf = (error: unknown) => (error instanceof OriginStepError ? error.code : 'wallet_error')

type BatchSender = Pick<OriginSender, 'atomic' | 'sendBatch' | 'batchStatus'>

/**
 * Added 2026-10-06 (rugged's answer of 6 Oct, F7 delta of 6 Oct §2): the approval and the deposit as one batch (steps 4
 * and 5), once the wallet said it batches on the origin. Null when the wallet cannot run this batch after all, or the
 * person declined its account upgrade: nothing it can run was asked, and the same review goes step by step. Otherwise
 * the batch is followed until the wallet names its one transaction (a delay is never a failure): the deposit sent, with
 * that hash.
 */
async function sendBatched(deps: FlowDeps, sender: BatchSender, review: OriginReview, report: (stage: FlowStage) => void): Promise<FlowOutcome | null> {
  report({ stage: 'batch_wallet' })
  let entry: PendingBatch
  try {
    entry = await sender.sendBatch(review)
  } catch (error) {
    const code = codeOf(error)
    if (code === 'batch_unsupported' || code === 'batch_upgrade_declined') return null
    if (code === 'quote_expired') return { kind: 'expired', approved: false }
    return { kind: 'error', step: 'deposit', code, hash: null, offered: code === 'wallet_result_unknown' }
  }
  report({ stage: 'batch_sent', batchId: entry.batchId })
  for (;;) {
    // The batch is the wallet's from here on, kept by the sender: a page that moved on finds it again from there.
    if (deps.aborted()) return { kind: 'aborted' }
    let said: BatchState
    try {
      said = await sender.batchStatus(entry)
    } catch (error) {
      const code = codeOf(error)
      if (!TRANSIENT_READ.has(code)) return { kind: 'error', step: 'deposit', code, hash: null, offered: true }
      said = { state: 'pending' }
    }
    if (said.state === 'sent') return { kind: 'sent', sent: said.sent, review }
    if (said.state === 'gone') return { kind: 'error', step: 'deposit', code: said.reverted ? 'batch_reverted' : 'batch_not_included', hash: null, offered: false }
    if (said.state === 'unknown') return { kind: 'error', step: 'deposit', code: 'batch_unknown', hash: null, offered: true }
    await deps.wait(deps.receiptPollMs)
  }
}

export async function runDeposit(deps: FlowDeps, input: FlowInput, report: (stage: FlowStage) => void): Promise<FlowOutcome> {
  const { quote, timing, source } = input
  const preview = walletSteps({ runtime: deps.runtime, quote, owner: deps.owner, timing, nowMono: deps.monoMs(), allowance: null, source })
  if (!preview.ok) return preview.reason === 'expired' ? { kind: 'expired', approved: false } : { kind: 'not_sendable', reason: preview.reason }
  if (!stillSendable(preview, deps.monoMs())) return preview.synthetic ? { kind: 'synthetic' } : { kind: 'expired', approved: false }
  const origin = preview.originChainId

  if (deps.walletChainId() !== origin) {
    report({ stage: 'switching' })
    const outcome = await deps.switchToOrigin(origin)
    if (deps.aborted()) return { kind: 'aborted' }
    if (outcome !== 'switched') return { kind: 'switch', outcome }
  }

  report({ stage: 'reviewing' })
  let review: OriginReview
  try {
    review = await deps.sender.review({ quote, timing, source })
  } catch (error) {
    const code = codeOf(error)
    if (code === 'quote_expired') return { kind: 'expired', approved: false }
    return { kind: 'error', step: 'review', code, hash: null, offered: false }
  }
  if (deps.aborted()) return { kind: 'aborted' }

  // Added 2026-10-06 (rugged's answer of 6 Oct, F7 delta of 6 Oct §2, steps 1 to 3): an approval still needed goes with
  // the deposit as one batch where the wallet batches on the origin; the quote is checked first, as before the deposit.
  const { atomic, sendBatch, batchStatus } = deps.sender
  if (FUNDS_BATCH_APPROVAL_AND_DEPOSIT && review.plan.steps[0]?.kind === 'approval' && atomic && sendBatch && batchStatus) {
    if (!stillSendable(review.plan, deps.monoMs())) return { kind: 'expired', approved: false }
    let status: AtomicStatus
    try {
      status = await atomic(review)
    } catch (error) {
      return { kind: 'error', step: 'review', code: codeOf(error), hash: null, offered: false }
    }
    if (deps.aborted()) return { kind: 'aborted' }
    if (status === 'supported' || status === 'ready') {
      const batched = await sendBatched(deps, { atomic, sendBatch, batchStatus }, review, report)
      if (batched !== null) return batched
      if (deps.aborted()) return { kind: 'aborted' }
    }
  }

  if (review.plan.steps[0]?.kind === 'approval') {
    report({ stage: 'approval_wallet' })
    let hash: Hex
    try {
      hash = (await deps.sender.send(review, 'approval')).hash
    } catch (error) {
      const code = codeOf(error)
      if (code === 'quote_expired') return { kind: 'expired', approved: false }
      return { kind: 'error', step: 'approval', code, hash: null, offered: code === 'wallet_result_unknown' }
    }
    report({ stage: 'approval_sent', hash })
    for (;;) {
      if (deps.aborted()) return { kind: 'aborted' }
      let receipt: OriginReceipt
      try {
        receipt = await deps.sender.receipt(review, hash)
      } catch (error) {
        const code = codeOf(error)
        if (!TRANSIENT_READ.has(code)) return { kind: 'error', step: 'approval', code, hash, offered: false }
        receipt = { state: 'pending' }
      }
      if (receipt.state === 'reverted') return { kind: 'approval_reverted', hash }
      if (receipt.state === 'included' || receipt.state === 'finalized') {
        report({ stage: 'approval_done', hash, receipt: receipt.state })
        break
      }
      await deps.wait(deps.receiptPollMs)
    }
  } else {
    report({ stage: 'approval_skipped' })
  }

  if (deps.aborted()) return { kind: 'aborted' }
  if (!stillSendable(review.plan, deps.monoMs())) return { kind: 'expired', approved: review.plan.steps[0]?.kind === 'approval' }
  report({ stage: 'deposit_wallet' })
  try {
    const sent = await deps.sender.send(review, 'deposit')
    return { kind: 'sent', sent, review }
  } catch (error) {
    const code = codeOf(error)
    if (code === 'quote_expired') return { kind: 'expired', approved: review.plan.steps[0]?.kind === 'approval' }
    return { kind: 'error', step: 'deposit', code, hash: null, offered: code === 'wallet_result_unknown' }
  }
}
