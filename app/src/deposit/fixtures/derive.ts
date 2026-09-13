/**
 * Fixtures the deposit-v1 package does not ship, derived from the ones it
 * does (deposit digest §4 gaps, C-design §8.3). Each is a small edit of a
 * package fixture and must still pass the pinned runtime: the node tests run
 * validateResponse over every one, so a derivation that drifts from the
 * contract fails there.
 *
 * Passing the runtime is not producer acceptance: rugged97's review on #40
 * and #72 found shapes the runtime accepts that the producer cannot reach (a
 * reorged step keeping its receipt, a confirmation before finality). Each
 * edit below now follows a producer transition, cited where it is not
 * obvious. `npm run check:producer-fixtures` runs every body the lab serves
 * through the Python producer model (read-only; not part of CI), and
 * tests/consumer.fixtures.test.mjs keeps the rules it adds beyond the
 * runtime in check:app. They are synthetic display cases: they qualify no
 * token and no live execution.
 *
 * Also here: the owner-binding controls (runtime-valid, owner rewritten, the
 * client must refuse them) and list bodies built from operations.
 */
import type { DepositResponses, Operation, OperationListItem, ReceiptSummary } from '../types'

export interface FixtureSource {
  /** Raw text of a file under api-contracts/deposit-v1/fixtures/, e.g. `variants/mint.json`. */
  text(path: string): string
}

type Single = DepositResponses['get']

export const VARIANTS = [
  'cancelled',
  'confirmed',
  'erc20_approval',
  'erc20_reset',
  'fee_cap_breach',
  'legacy_receipt',
  'mint',
  'native',
  'partial_allowances',
  'pending',
  'permit2_approval',
  'proxy-event-amounts',
  'reported_nonce_conflict',
  'reviewed-proxy',
  'superseded',
  'token-review-changed',
] as const
export type VariantName = (typeof VARIANTS)[number]

export const OPERATION_ID = '00000000-0000-4000-8000-000000000040'
export const FOREIGN_OWNER = '0x1212121212121212121212121212121212121212'
const APPROVAL_HASH = `0x${'ee'.repeat(32)}`

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export function parsed<T = Single>(source: FixtureSource, path: string): T {
  return JSON.parse(source.text(path)) as T
}

/** A variant as a single-operation body with no wallet step, the way get, reconcile, cancel and report return it. */
export function withoutStep(body: Single): Single {
  return { ...clone(body), walletStep: null }
}

export function listItemOf(op: Operation): OperationListItem {
  const { history, ...rest } = clone(op)
  return { ...rest, historyCount: history.length, lastStep: history.at(-1) ?? null }
}

export function listBody(operations: Operation[], { hasMore = false }: { hasMore?: boolean } = {}): DepositResponses['list'] {
  const items = operations.map(listItemOf)
  return {
    contractVersion: '1.1.0-rc.4',
    operations: items,
    hasMore,
    nextBefore: hasMore ? items[items.length - 1].id : null,
    serverBroadcastAvailable: false,
    automationAvailable: false,
  }
}

/**
 * The operation as it stood just before its last step was issued: that step
 * gone, back in draft, one version earlier. Preparing it is a fresh issuance
 * (the answer's version is newer), which is how the lab shows a step whose
 * handoff window this page can measure.
 */
export function beforeIssue(body: Single): Single {
  const out = withoutStep(body)
  const { operation } = out
  operation.history = operation.history.slice(0, -1)
  operation.state = 'draft'
  operation.outstanding = false
  operation.version -= 1
  return out
}

export function withId(body: Single, id: string): Single {
  const out = clone(body)
  out.operation.id = id
  return out
}

/** The receipt of a finalized, successful approval: the confirmed mint's gas figures, no position. */
function approvalReceipt(source: FixtureSource): ReceiptSummary {
  const receipt = clone(parsed(source, 'variants/confirmed.json').operation.history[0].receipt as ReceiptSummary)
  return { ...receipt, transactionHash: APPROVAL_HASH, position: null }
}

type Derivation = (source: FixtureSource) => Single

const fromVariant = (source: FixtureSource, name: VariantName) => withoutStep(parsed(source, `variants/${name}.json`))
const lastOf = (body: Single) => body.operation.history[body.operation.history.length - 1]
const receiptOf = (body: Single) => {
  const receipt = lastOf(body).receipt
  if (!receipt) throw new Error('fixture has no receipt')
  return receipt
}

export const DERIVED: Readonly<Record<string, { label: string; build: Derivation }>> = {
  reverted: {
    label: 'Reverted mint',
    build(source) {
      const body = fromVariant(source, 'confirmed')
      body.operation.state = 'reverted'
      lastOf(body).reconciliationState = 'reverted'
      const receipt = receiptOf(body)
      receipt.outcome = 'reverted'
      receipt.position = null
      return body
    },
  },
  cancel_requested: {
    label: 'Cancellation requested after handoff',
    build(source) {
      const body = fromVariant(source, 'pending')
      body.operation.state = 'cancel_requested'
      return body
    },
  },
  cancel_requested_conflict: {
    label: 'Cancellation requested, with a reported off-nonce conflict',
    build(source) {
      const body = fromVariant(source, 'reported_nonce_conflict')
      body.operation.state = 'cancel_requested'
      return body
    },
  },
  cancel_requested_unresolved: {
    label: 'Cancellation requested, with a reported hash that did not resolve',
    build(source) {
      const body = fromVariant(source, 'pending')
      body.operation.state = 'cancel_requested'
      lastOf(body).reconciliationState = 'mismatched'
      return body
    },
  },
  cancel_requested_reorged: {
    label: 'Cancellation requested, then a chain reorganization',
    build(source) {
      // Only an outstanding operation can be cancelled (deposit_store.cancel),
      // so this starts from pending. A reorged observation carries no
      // receipt: the reconciler clears it (deposit_receipt.py) and the wire
      // shows the latest observation's (deposit_service._operation).
      const body = fromVariant(source, 'pending')
      body.operation.state = 'cancel_requested'
      const step = lastOf(body)
      step.reconciliationState = 'reorged'
      step.receipt = null
      return body
    },
  },
  pending_not_found: {
    label: 'Pending, reported hash not found yet',
    build(source) {
      const body = fromVariant(source, 'pending')
      lastOf(body).reconciliationState = 'not_found'
      return body
    },
  },
  attention_reorged: {
    label: 'Attention after a reorganization of a finalized mint (no newer reservation)',
    build(source) {
      // deposit_store.reconcile: a reorg of a finalized step re-enters
      // attention. With no other outstanding operation this one holds the
      // reservation again (outstanding); beside a newer reservation it would
      // stay outstanding: false. The wire receipt is cleared; the service
      // keeps the earlier finalized receipt as its own evidence.
      const body = fromVariant(source, 'confirmed')
      body.operation.state = 'attention'
      body.operation.outstanding = true
      const step = lastOf(body)
      step.reconciliationState = 'reorged'
      step.receipt = null
      return body
    },
  },
  attention_transient: {
    label: 'Attention after a re-check that could not read finality (no newer reservation)',
    build(source) {
      // A re-check of a finalized mint whose finality could not be read comes
      // back pending (deposit_receipt: finality_unavailable), which moves a
      // closed operation to attention (deposit_store.reconcile), outstanding
      // again when no other operation holds the reservation.
      const body = fromVariant(source, 'confirmed')
      body.operation.state = 'attention'
      body.operation.outstanding = true
      lastOf(body).reconciliationState = 'pending'
      receiptOf(body).finality = 'unavailable'
      return body
    },
  },
  attention_approval_unqualified: {
    label: 'An approval whose token evidence could not be qualified, held in attention',
    build(source) {
      // A finalized approval whose token review did not match (deposit_receipt:
      // changed or legacy_unqualified review -> mismatched). Not the v1
      // approval #46 fixed, which reconciles normally.
      const body = fromVariant(source, 'erc20_approval')
      body.operation.state = 'attention'
      const step = lastOf(body)
      step.transactionHash = APPROVAL_HASH
      step.reconciliationState = 'mismatched'
      step.receipt = approvalReceipt(source)
      return body
    },
  },
  draft_after_approval: {
    label: 'Draft again after a confirmed approval',
    build(source) {
      const body = fromVariant(source, 'erc20_approval')
      body.operation.state = 'draft'
      body.operation.outstanding = false
      const step = lastOf(body)
      step.transactionHash = APPROVAL_HASH
      step.reconciliationState = 'confirmed'
      step.receipt = approvalReceipt(source)
      return body
    },
  },
  cancelled_after_steps: {
    label: 'Cancelled after a confirmed approval',
    build(source) {
      const body = DERIVED.draft_after_approval.build(source)
      body.operation.state = 'cancelled'
      return body
    },
  },
  pending_provisional: {
    label: 'Mined, waiting for finality (receipt provisional)',
    build(source) {
      // A receipt below the finalized head is reported pending
      // (deposit_receipt: finality_pending); the operation stays pending and
      // outstanding. The producer never confirms before finality.
      const body = fromVariant(source, 'confirmed')
      body.operation.state = 'pending'
      body.operation.outstanding = true
      lastOf(body).reconciliationState = 'pending'
      receiptOf(body).finality = 'provisional'
      return body
    },
  },
  owner_unavailable: {
    label: 'Confirmed, current owner unreadable',
    build(source) {
      const body = fromVariant(source, 'confirmed')
      const position = receiptOf(body).position
      if (!position) throw new Error('confirmed has a position')
      position.currentOwnerStatus = 'unavailable'
      position.currentOwner = null
      return body
    },
  },
  l1_null: {
    label: 'Confirmed, L1 not reported (legacy rc.2 receipt)',
    build(source) {
      const body = fromVariant(source, 'confirmed')
      const receipt = receiptOf(body)
      receipt.l1FeeRaw = null
      receipt.l1GasUsedRaw = null
      return body
    },
  },
  l1_zero: {
    label: 'Confirmed, L1 reported as zero',
    build(source) {
      const body = fromVariant(source, 'confirmed')
      const receipt = receiptOf(body)
      receipt.l1FeeRaw = '0'
      receipt.l1GasUsedRaw = '0'
      return body
    },
  },
  basis_token_review_unavailable: {
    label: 'Confirmed, amounts unavailable: token identity unverified',
    build(source) {
      const body = fromVariant(source, 'confirmed')
      const position = receiptOf(body).position
      if (!position) throw new Error('confirmed has a position')
      Object.assign(position, { amount0Raw: null, amount1Raw: null, amount0Basis: 'token_review_unavailable', amount1Basis: 'token_review_unavailable' })
      return body
    },
  },
  basis_legacy_unqualified: {
    label: 'Confirmed, amounts unavailable: older record',
    build(source) {
      const body = fromVariant(source, 'confirmed')
      const position = receiptOf(body).position
      if (!position) throw new Error('confirmed has a position')
      Object.assign(position, { amount0Raw: null, amount1Raw: null, amount0Basis: 'legacy_token_review_unqualified', amount1Basis: 'legacy_token_review_unqualified' })
      return body
    },
  },
  basis_native_net_unavailable: {
    // variants/native.json carried to a finalized mint: currency 0 is native
    // ETH, whose net amount the service cannot qualify (the sixth basis).
    // The receipt is the confirmed one, brought inside the native selection's
    // own limits (max fee 10, priority 1) and its nonce.
    label: 'Confirmed native deposit, native amount unavailable',
    build(source) {
      const body = fromVariant(source, 'native')
      const { operation } = body
      operation.state = 'confirmed'
      operation.outstanding = false
      const step = lastOf(body)
      const receipt = clone(receiptOf(fromVariant(source, 'confirmed')))
      const transaction = receipt.transaction
      const position = receipt.position
      if (!transaction || !position) throw new Error('confirmed has a transaction and a position')
      Object.assign(receipt, { effectiveGasPriceRaw: '10', grossGasFeeRaw: '1000000', l1GasUsedRaw: '10000', l1FeeRaw: '100000' })
      Object.assign(transaction, { maxFeePerGasRaw: '10', maxPriorityFeePerGasRaw: '1', nonceRaw: step.nonceRaw, selectedLimitsExceeded: [] })
      Object.assign(position, {
        poolId: operation.selection.poolId,
        recipient: operation.owner,
        tickLower: operation.selection.tickLower,
        tickUpper: operation.selection.tickUpper,
        amount0Raw: null,
        amount0Basis: 'native_net_unavailable',
      })
      step.transactionHash = receipt.transactionHash
      step.reconciliationState = 'confirmed'
      step.receipt = receipt
      return body
    },
  },
  single_breach: {
    label: 'Confirmed, one selected limit exceeded',
    build(source) {
      const body = fromVariant(source, 'confirmed')
      const transaction = receiptOf(body).transaction
      if (!transaction) throw new Error('confirmed has a transaction')
      transaction.gasLimitRaw = '300001'
      transaction.selectedLimitsExceeded = ['gasLimit']
      return body
    },
  },
  awaiting_via_get: {
    label: 'Awaiting wallet, read back without its step',
    build: (source) => fromVariant(source, 'mint'),
  },
}

/**
 * The erc20_approval operation after it moved on elsewhere (another tab): the
 * approval at nonce 5 confirmed, then a Permit2 step issued at nonce 6, at
 * version 5. rugged97's probe for P2 on #72: an allowances answer carrying
 * this while the page still holds the approval's wallet step.
 */
export function advancedAfterApproval(source: FixtureSource): Single {
  const body = DERIVED.draft_after_approval.build(source)
  const { operation } = body
  const first = lastOf(body)
  const permit = lastOf(parsed(source, 'variants/permit2_approval.json'))
  operation.history.push({ ...clone(permit), step: 2, nonceRaw: '6', issuedAt: first.issuedAt + 60, expiresAt: first.issuedAt + 90 })
  operation.state = 'awaiting_wallet'
  operation.outstanding = true
  operation.version = 5
  operation.updatedAt = first.issuedAt + 60
  return body
}

/** Runtime-valid bodies with the owner rewritten: the client must refuse each. */
export function foreignGet(source: FixtureSource): Single {
  // The package's get response (a draft with no history, so no recipient ties it to the owner).
  const body = parsed(source, 'responses/get.json')
  body.operation.owner = FOREIGN_OWNER
  return body
}

/** A single-operation body from any package response that carries one (drops extra keys such as `allowances`). */
export function singleOf(body: Single & { allowances?: unknown }): Single {
  const { contractVersion, operation, serverBroadcastAvailable, automationAvailable } = clone(body)
  return { contractVersion, operation, walletStep: null, serverBroadcastAvailable, automationAvailable }
}

export function foreignList(source: FixtureSource): DepositResponses['list'] {
  const body = parsed<DepositResponses['list']>(source, 'responses/list.json')
  for (const item of body.operations) item.owner = FOREIGN_OWNER
  return body
}

/** A list page that says there is more (the package's list fixture has one item and no more). */
export function pagedList(source: FixtureSource): { first: DepositResponses['list']; second: DepositResponses['list'] } {
  const first = listBody(
    [withId(fromVariant(source, 'confirmed'), '00000000-0000-4000-8000-000000000061').operation, withId(fromVariant(source, 'cancelled'), '00000000-0000-4000-8000-000000000062').operation],
    { hasMore: true },
  )
  const second = listBody([withId(fromVariant(source, 'superseded'), '00000000-0000-4000-8000-000000000063').operation])
  return { first, second }
}
