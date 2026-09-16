/**
 * One deposit operation as a view, decided purely from the operation, the
 * wallet step (if a prepare just returned one) and an injected context.
 *
 * The first matching rule wins (C-design §5.3). Two things apply over any
 * state: conflicts from every history step, which can never be dismissed,
 * and "Check allowances" whenever the operation has history. Attention states
 * and conflicts are support-required: they offer Check status and Check
 * allowances only, never retry, cancel or a new deposit (R41a note 2, #68).
 *
 * Nothing here reads a clock: freshness of a wallet step is the monotonic
 * deadline the flow computed, compared with the `monoNowMs` passed in.
 * Timestamps are shown as fixed UTC text.
 */
import { cmpRaw, formatTokenAmount, formatWeiEth, groupRaw, hundredthsToPercentText, isRaw, mulRaw, parseSafeInteger } from '../lib/raw'
import { formatUnits } from '../lib/read/decimal'
import { fixedFeePercent } from '../lib/read/screens/fee'
import {
  BASIS,
  FINALITY,
  FIXED_FACTS,
  LATCH_COPY,
  LIMIT_NAME,
  NO_SEND_STATUS,
  PREPARE_OFF_WITHOUT_HANDOFF,
  RECONCILIATION,
  SELECTOR_NAME,
  STATE_LABEL,
  STEP_KIND,
  SUPPORT_REQUIRED,
  shortHex,
  utcTime,
} from './copy'
import type { AllowanceReport, DepositSelection, Operation, OperationListItem, PreparedArtifact, ReceiptSummary, StepSummary } from './types'

export type ViewKind =
  | 'attention_conflict'
  | 'attention_reorg'
  | 'attention_generic'
  | 'step_ready'
  | 'handoff_unconfirmed'
  | 'handoff_expired'
  | 'step_reserved'
  | 'pending'
  | 'cancel_requested'
  | 'cancel_requested_support'
  | 'cancel_requested_reorg'
  | 'draft_new'
  | 'draft_progress'
  | 'confirmed'
  | 'reverted'
  | 'cancelled_clean'
  | 'cancelled_after_steps'
  | 'superseded'

export type ActionId = 'check_status' | 'check_allowances' | 'cancel' | 'prepare' | 'reopen' | 'report'

export interface ActionView {
  id: ActionId
  label: string
  enabled: boolean
  reason?: string
}

export interface Fact {
  label: string
  value: string
  /** Shown as "unknown", never as a number. */
  unknown?: boolean
  note?: string
}

export interface StepView {
  kind: PreparedArtifact['kind']
  summary: string
  lines: string[]
  admission: string
  facts: Fact[]
  gas: Fact[]
  native: Fact[] | null
  selector: string
  calldata: string
}

export interface ReceiptView {
  facts: Fact[]
  gas: Fact[]
  breach: string | null
  envelope: string | null
  notFinal: string | null
  position: { facts: Fact[]; amounts: Fact[]; owner: string } | null
}

export interface ConflictView {
  step: number
  text: string
}

export interface DepositView {
  kind: ViewKind
  title: string
  body: string[]
  tone: 'in' | 'out' | 'wait' | 'neutral'
  supportRequired: boolean
  reserved: string | null
  conflicts: ConflictView[]
  actions: ActionView[]
  step: StepView | null
  receipt: ReceiptView | null
  history: Fact[]
  facts: string[]
  /** What the owner selected for this deposit, in token units where the decimals are known. */
  selection: Fact[]
}

export interface PresentContext {
  walletSendAvailable?: boolean
  monoNowMs: number
  /** Set only when the wallet step came from a prepare this page sent. */
  walletStepDeadlineMono: number | null
  /** transport.kind === 'fixture' || handoff.available */
  issueWalletStepAllowed: boolean
  latched: boolean
  busy: boolean
  /** Token symbols and decimals read for the selection's currencies, when the page has them. */
  tokens?: TokenBook
}

/** A token's symbol and decimals, as a public token read returned them. */
export interface TokenDetails {
  symbol: string | null
  decimals: number | null
}

/** Details by lowercase address; `reading` while a read is on its way. A missing address is unknown. */
export type TokenBook = ReadonlyMap<string, TokenDetails | 'reading'>

/** A token by its symbol when one was read, otherwise by its short address. */
export function tokenName(address: string, tokens?: TokenBook): string {
  const details = tokens?.get(address.toLowerCase())
  return details && details !== 'reading' && details.symbol ? details.symbol : shortHex(address.toLowerCase())
}

/**
 * A raw amount in the token's own units, "1.5 WETH". With decimals unknown it
 * stays raw and says so, "1,500 raw units of 0x1111…111111": decimals are
 * never guessed. Null while the token is still being read, or for anything
 * that is not a raw integer.
 */
export function tokenAmount(raw: string, address: string, tokens?: TokenBook): string | null {
  if (!isRaw(raw)) return null
  const details = tokens?.get(address.toLowerCase())
  if (details === 'reading') return null
  const units = details && details.decimals !== null ? formatUnits(raw, details.decimals) : null
  return units && units.kind === 'units' ? `${units.text} ${tokenName(address, tokens)}` : `${groupRaw(raw)} raw units of ${tokenName(address, tokens)}`
}

const pairOf = (key: DepositSelection['poolKey'], tokens?: TokenBook) => `${tokenName(key.currency0, tokens)} / ${tokenName(key.currency1, tokens)} · ${fixedFeePercent(key.fee_pips)}`

/** The owner's selection, fact by fact: pool, amount, range, budgets and limits. */
export function presentSelection(selection: DepositSelection, tokens?: TokenBook): Fact[] {
  const key = selection.poolKey
  const amount = (raw: string, address: string) => tokenAmount(raw, address, tokens) ?? '—'
  return [
    { label: 'Pool', value: pairOf(key, tokens), note: `Pool ID ${selection.poolId}` },
    { label: 'Deposit amount', value: amount(selection.amountRaw, selection.independentToken) },
    { label: 'Range', value: `Ticks ${selection.tickLower} to ${selection.tickUpper}` },
    { label: 'Maximum spend', value: `${amount(selection.budget0Raw, key.currency0)} · ${amount(selection.budget1Raw, key.currency1)}` },
    { label: 'Slippage limit', value: `${hundredthsToPercentText(String(selection.slippageBps)) ?? selection.slippageBps}%` },
    { label: 'Network limits per step', value: `${groupRaw(selection.maxGasLimitRaw)} gas · ${groupRaw(selection.maxFeePerGasRaw)} wei max fee · ${groupRaw(selection.maxPriorityFeePerGasRaw)} wei priority fee` },
    { label: 'Gas reserve kept', value: `${groupRaw(selection.nativeGasReserveRaw)} wei (${formatWeiEth(selection.nativeGasReserveRaw) ?? '—'})` },
  ]
}

/** One row of the owner's deposit list. */
export interface DepositRowView {
  id: string
  state: string
  pair: string
  /** Null while the token is being read. */
  amount: string | null
  updated: string
  reserved: boolean
}

export function presentListItem(item: OperationListItem, tokens?: TokenBook): DepositRowView {
  return {
    id: item.id,
    state: STATE_LABEL[item.state],
    pair: pairOf(item.selection.poolKey, tokens),
    amount: tokenAmount(item.selection.amountRaw, item.selection.independentToken, tokens),
    updated: `Updated ${utcTime(item.updatedAt)}`,
    reserved: item.outstanding,
  }
}

export const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
export const POSITION_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7'

/** The n-th 32-byte word after the selector, as an unsigned integer. Reading validated calldata, never building it. */
function word(data: string, index: number): bigint | null {
  const start = 10 + index * 64
  const hex = data.slice(start, start + 64)
  return /^[0-9a-f]{64}$/i.test(hex) ? BigInt(`0x${hex}`) : null
}

const addressWord = (data: string, index: number) => {
  const value = word(data, index)
  return value === null ? null : `0x${value.toString(16).padStart(40, '0')}`
}

function stepLines(step: PreparedArtifact, op: Operation, last: StepSummary | undefined): string[] {
  const tx = step.transaction
  const token = tx.to.toLowerCase()
  const amountOf = (index: number) => {
    const value = word(tx.data, index)
    return value === null ? '(unreadable)' : groupRaw(value.toString())
  }
  const life = last ? last.expiresAt - last.issuedAt : step.expiresAt - step.sourceBlock.timestamp
  switch (step.kind) {
    case 'erc20_reset':
      return [`Reset the ERC-20 allowance ${token} gives Permit2 (${shortHex(PERMIT2)}) to 0. This is required before an exact approval.`]
    case 'erc20_approval':
      return [
        `Approve exactly ${amountOf(1)} raw units of ${token} to Permit2 (${shortHex(PERMIT2)}). An ERC-20 approval has no time limit. It is never unlimited.`,
      ]
    case 'permit2_approval': {
      const permitToken = addressWord(tx.data, 0) ?? '(unreadable)'
      const expiration = word(tx.data, 3)
      const seconds = expiration === null ? null : parseSafeInteger(expiration.toString())
      const until = seconds === null ? 'an unreadable time' : utcTime(seconds)
      const minutes = Math.ceil((step.preparedDeadline - step.sourceBlock.timestamp) / 60)
      return [
        `Allow the Uniswap PositionManager (${shortHex(POSITION_MANAGER)}) to use exactly ${amountOf(2)} raw units of ${permitToken} through Permit2, until ${until} (about ${minutes} min).`,
      ]
    }
    case 'mint': {
      const lines = [
        `Create the position, ticks ${op.selection.tickLower} to ${op.selection.tickUpper}. Maximum token0 ${groupRaw(step.mintedBounds.amount0MaxRaw)}, token1 ${groupRaw(step.mintedBounds.amount1MaxRaw)} (raw units).`,
        `On-chain deadline ${utcTime(step.preparedDeadline)} (${step.preparedDeadline - step.sourceBlock.timestamp} s after the source block). Wallet handoff valid for about ${life} s from when it was prepared.`,
      ]
      if (step.mintedBounds.nativeValueRaw !== '0') {
        lines.push(`Sends ${groupRaw(step.mintedBounds.nativeValueRaw)} wei ETH as principal, plus network gas on a separate line below.`)
      }
      return lines
    }
  }
}

function admissionText(step: PreparedArtifact): string {
  const reviews = step.admission.tokenReviews ?? []
  if (step.admission.policyVersion === 'direct_existing_pool_v2') {
    const ids = reviews.map((review) => `${review.address.toLowerCase()} review ${shortHex(review.reviewId)}`).join('; ')
    return `Reviewed upgradeable token (${ids || 'no review ids'}). The issuer can still upgrade, pause or freeze it.`
  }
  return `Admitted under the direct existing-pool policy v1 (manifest ${shortHex(step.admission.manifestId)}).`
}

function stepView(step: PreparedArtifact, op: Operation): StepView {
  const tx = step.transaction
  const last = op.history.at(-1)
  const maxFee = mulRaw(tx.gasLimitRaw, tx.maxFeePerGasRaw)
  const eth = (wei: string) => `${groupRaw(wei)} wei (${formatWeiEth(wei) ?? wei})`
  return {
    kind: step.kind,
    summary: STEP_KIND[step.kind],
    lines: stepLines(step, op, last),
    admission: admissionText(step),
    facts: [
      { label: 'To', value: tx.to.toLowerCase() },
      { label: 'From', value: tx.from.toLowerCase() },
      { label: 'Nonce', value: tx.nonceRaw },
      { label: 'Value', value: eth(tx.valueRaw) },
      { label: 'Source block', value: `${step.sourceBlock.number} (${shortHex(step.sourceBlock.hash)}, ${utcTime(step.sourceBlock.timestamp)})` },
      { label: 'Simulation', value: `Passed at block ${step.simulation.blockNumber}` },
    ],
    gas: [
      { label: 'Max network fee for this step', value: eth(maxFee), note: 'Gas limit × max fee per gas. It already includes L1; do not add a separate L1 estimate.' },
      { label: 'Gas limit', value: groupRaw(tx.gasLimitRaw), note: 'The bundled estimate plus 20%, within your cap.' },
      { label: 'Estimated gas', value: groupRaw(step.simulation.estimatedGasRaw), note: 'An estimate, not a guarantee.' },
      { label: 'Max fee per gas', value: `${groupRaw(tx.maxFeePerGasRaw)} wei` },
      { label: 'Max priority fee per gas', value: `${groupRaw(tx.maxPriorityFeePerGasRaw)} wei` },
    ],
    native:
      op.selection.poolKey.currency0 === '0x0000000000000000000000000000000000000000'
        ? [
            { label: 'Planned native deposit', value: eth(step.mintedBounds.nativeValueRaw) },
            { label: 'Selected gas reserve', value: eth(op.selection.nativeGasReserveRaw) },
            { label: 'Step max network fee', value: eth(maxFee) },
          ]
        : null,
    selector: SELECTOR_NAME[tx.data.slice(0, 10).toLowerCase()] ?? 'Unrecognised call',
    calldata: tx.data,
  }
}

function l1Fact(label: string, raw: string | null, format: (raw: string) => string): Fact {
  if (raw === null) return { label, value: 'Not reported (unknown)', unknown: true }
  if (raw === '0') return { label, value: '0 (reported zero)' }
  return { label, value: format(raw) }
}

function receiptView(receipt: ReceiptSummary, op: Operation): ReceiptView {
  const eth = (wei: string) => `${groupRaw(wei)} wei (${formatWeiEth(wei) ?? wei})`
  const gas: Fact[] = [
    { label: 'Gross gas charge', value: eth(receipt.grossGasFeeRaw), note: 'Gas used × effective gas price.' },
    l1Fact('Of which data-posting (L1), included above', receipt.l1FeeRaw, eth),
    l1Fact('L1 gas used', receipt.l1GasUsedRaw, (raw) => `${groupRaw(raw)} gas`),
    { label: 'Net cost after refunds', value: 'Not available', unknown: true },
  ]
  let breach: string | null = null
  let envelope: string | null = null
  if (receipt.transaction === null) {
    envelope = 'Transaction envelope not recorded (older receipt). Whether it stayed within your limits is unknown.'
  } else if (receipt.transaction.selectedLimitsExceeded.length > 0) {
    const observed = receipt.transaction
    const selected = { gasLimit: op.selection.maxGasLimitRaw, maxFeePerGas: op.selection.maxFeePerGasRaw, maxPriorityFeePerGas: op.selection.maxPriorityFeePerGasRaw }
    const seen = { gasLimit: observed.gasLimitRaw, maxFeePerGas: observed.maxFeePerGasRaw, maxPriorityFeePerGas: observed.maxPriorityFeePerGasRaw }
    breach = `This transaction exceeded limits you selected: ${observed.selectedLimitsExceeded
      .map((limit) => `${LIMIT_NAME[limit]} ${groupRaw(seen[limit])} (you selected ${groupRaw(selected[limit])})`)
      .join('; ')}. This app never prepares a step above your limits.`
  }
  const position = receipt.position
  let positionView: ReceiptView['position'] = null
  if (position) {
    const amount = (raw: string | null, basis: keyof typeof BASIS, currency: string, label: string): Fact => {
      const qualifier = BASIS[basis]
      if (raw === null || !qualifier.qualified) return { label, value: qualifier.text, unknown: true }
      return { label, value: formatTokenAmount(raw, null, currency), note: qualifier.text }
    }
    positionView = {
      facts: [
        { label: 'Position NFT', value: `#${position.tokenId}` },
        { label: 'Liquidity (raw)', value: groupRaw(position.liquidityRaw) },
        { label: 'Ticks', value: `${position.tickLower} to ${position.tickUpper}` },
        { label: 'Recipient', value: position.recipient.toLowerCase() },
      ],
      amounts: [
        amount(position.amount0Raw, position.amount0Basis, op.selection.poolKey.currency0, 'Deposited, currency 0'),
        amount(position.amount1Raw, position.amount1Basis, op.selection.poolKey.currency1, 'Deposited, currency 1'),
      ],
      owner:
        position.currentOwnerStatus === 'verified' && position.currentOwner !== null
          ? `Owner ${position.currentOwner.toLowerCase()} observed at block ${position.ownershipObservedBlock.number}. A chain observation, not proof of control.`
          : 'Current owner could not be read.',
    }
  }
  return {
    facts: [
      { label: 'Transaction', value: receipt.transactionHash },
      { label: 'Block', value: `${receipt.blockNumber} (${shortHex(receipt.blockHash)})` },
      { label: 'Outcome', value: receipt.outcome === 'success' ? 'Included, succeeded' : 'Included, reverted' },
      { label: 'Finality', value: FINALITY[receipt.finality] },
    ],
    gas,
    breach,
    envelope,
    notFinal: receipt.finality === 'finalized' ? null : 'This result is not final yet and can still change.',
    position: positionView,
  }
}

function historyFacts(op: Operation): Fact[] {
  return op.history.map((step) => ({
    label: `Step ${step.step}: ${STEP_KIND[step.kind]}`,
    value: `nonce ${step.nonceRaw} · ${RECONCILIATION[step.reconciliationState ?? 'null']} · ${step.transactionHash ?? 'no hash reported'} · issued ${utcTime(step.issuedAt)}`,
  }))
}

function conflictsOf(op: Operation): ConflictView[] {
  return op.history.flatMap((step) =>
    step.reportedEffectConflicts.map((conflict) => ({
      step: step.step,
      text: `A transaction you reported at nonce ${conflict.nonceRaw} (${conflict.transactionHash}) has the same effect as step ${step.step} (nonce ${step.nonceRaw}). Both are kept as evidence. This can't be cleared here; don't retry or start a new deposit to work around it.`,
    })),
  )
}

const lastReceipt = (op: Operation) => [...op.history].reverse().find((step) => step.receipt !== null)?.receipt ?? null

export function presentOperation(op: Operation, walletStep: PreparedArtifact | null, ctx: PresentContext): DepositView {
  const history = op.history
  const last = history.at(-1)
  const nonce = last?.nonceRaw ?? '(none)'
  const anyConflict = history.some((step) => step.reportedEffectConflicts.length > 0)
  const fresh = walletStep !== null && ctx.walletStepDeadlineMono !== null && ctx.monoNowMs < ctx.walletStepDeadlineMono
  const idle = !ctx.busy
  const issueReason = ctx.latched ? LATCH_COPY : !ctx.issueWalletStepAllowed ? PREPARE_OFF_WITHOUT_HANDOFF : undefined
  const canIssue = ctx.issueWalletStepAllowed && !ctx.latched && idle

  const act = (id: ActionId, label: string, enabled = idle, reason?: string): ActionView => (reason ? { id, label, enabled, reason } : { id, label, enabled })
  const checkStatus = act('check_status', 'Check status')
  const cancel = act('cancel', 'Cancel deposit')
  const report = act('report', 'Report a transaction hash')

  let kind: ViewKind
  let title: string
  let body: string[]
  let tone: DepositView['tone'] = 'neutral'
  let actions: ActionView[] = []
  let supportRequired = false

  if (op.state === 'attention' && anyConflict) {
    kind = 'attention_conflict'
    title = 'Needs attention'
    body = ['A transaction you reported has the same effect as a step of this deposit, at a different nonce.', SUPPORT_REQUIRED]
    tone = 'out'
    supportRequired = true
    actions = [checkStatus]
  } else if (op.state === 'attention' && last?.reconciliationState === 'reorged') {
    kind = 'attention_reorg'
    title = 'Needs attention: chain reorganization'
    body = ['The chain reorganized after this step was observed, so its receipt no longer counts. The service keeps the evidence it recorded. Check status later, or contact support if it stays here.']
    tone = 'wait'
    actions = [checkStatus]
  } else if (op.state === 'attention') {
    kind = 'attention_generic'
    title = 'Needs attention'
    body = [
      'A reported transaction may not be identified yet, its evidence did not match this step, or the last check could not be completed. The reservation stays held while it is outstanding.',
      SUPPORT_REQUIRED,
    ]
    tone = 'out'
    supportRequired = true
    actions = [checkStatus]
  } else if (op.state === 'awaiting_wallet' && walletStep !== null && fresh) {
    kind = 'step_ready'
    title = 'Wallet step ready to review'
    body = [ctx.walletSendAvailable ? "Review the amounts and limits below before opening your wallet. Each step requires your confirmation." : "Review every field below. Wallet sending isn't available in this build. Nothing has been sent."]
    tone = 'wait'
    actions = [report, cancel]
  } else if (op.state === 'awaiting_wallet' && walletStep !== null && ctx.walletStepDeadlineMono === null) {
    // A re-delivered step this page did not issue (after a reload, say): the
    // service keeps its original expiration, and this page cannot tell how
    // much of it is left without comparing clocks, so it fails closed.
    kind = 'handoff_unconfirmed'
    title = "Wallet handoff: validity can't be confirmed"
    body = [
      `The service re-delivered the wallet handoff for step ${last?.step ?? '?'}, issued at ${last ? utcTime(last.issuedAt) : 'an unknown time'}, before this page asked for it. This page can't tell how much of its validity is left, so it isn't offered for review. Nonce ${nonce} stays reserved on the server until a transaction at that nonce finalizes. If your wallet already sent it, use Check status.`,
    ]
    tone = 'wait'
    actions = [checkStatus, report, cancel]
  } else if (op.state === 'awaiting_wallet' && walletStep !== null) {
    kind = 'handoff_expired'
    title = 'Wallet handoff expired'
    body = [
      `The wallet handoff for step ${last?.step ?? '?'} expired. Nonce ${nonce} stays reserved on the server until a transaction at that nonce finalizes. If your wallet already sent it, use Check status.`,
    ]
    tone = 'wait'
    actions = [checkStatus, report, cancel]
  } else if (op.state === 'awaiting_wallet') {
    kind = 'step_reserved'
    title = 'A transaction slot is reserved for your wallet'
    const life = last ? last.expiresAt - last.issuedAt : 30
    body = [
      `Step ${last?.step ?? '?'} (nonce ${nonce}) was issued at ${last ? utcTime(last.issuedAt) : 'an unknown time'}. You can re-open it only within ${life} seconds of issue; after that the handoff expires but the reservation stays held. If your wallet already sent it, use Check status.`,
    ]
    tone = 'wait'
    actions = [act('reopen', 'Re-open wallet step', canIssue, issueReason), checkStatus, report, cancel]
  } else if (op.state === 'pending') {
    kind = 'pending'
    title = 'Submitted, waiting for finalization'
    body = [
      `Your wallet reported ${last?.transactionHash ?? 'a transaction'}. That hash is a hint, not proof; status comes from the chain.`,
      ...(last?.reconciliationState === 'not_found' ? ['It has not been found on-chain yet.'] : []),
    ]
    tone = 'wait'
    actions = [checkStatus, report]
  } else if (op.state === 'cancel_requested' && (anyConflict || last?.reconciliationState === 'mismatched')) {
    // The store keeps cancel_requested (instead of attention) when a reported
    // same-effect transaction at another nonce, or a hash it could not
    // resolve, is recorded after the cancellation (#68). The step carries no
    // reason, so any mismatch here is treated as support-required.
    kind = 'cancel_requested_support'
    title = 'Cancellation requested: needs attention'
    body = [
      anyConflict
        ? 'A transaction you reported has the same effect as a step of this deposit, at a different nonce.'
        : 'A reported transaction may not be identified yet, or its evidence did not match this step.',
      `Nonce ${nonce} stays reserved on the server until a transaction at that nonce finalizes.`,
      SUPPORT_REQUIRED,
    ]
    tone = 'out'
    supportRequired = true
    actions = [checkStatus]
  } else if (op.state === 'cancel_requested' && last?.reconciliationState === 'reorged') {
    kind = 'cancel_requested_reorg'
    title = 'Cancellation requested: chain reorganization'
    body = [
      `The chain reorganized after this step was observed, so its receipt no longer counts. The service keeps the evidence it recorded. Nonce ${nonce} stays reserved until a transaction at that nonce finalizes. Check status later, or contact support if it stays here.`,
    ]
    tone = 'wait'
    actions = [checkStatus]
  } else if (op.state === 'cancel_requested') {
    kind = 'cancel_requested'
    title = 'Cancellation requested'
    body = [
      `Your wallet may still have, or may already have sent, this transaction; complete, cancel or replace it there. Nonce ${nonce} stays reserved until a transaction at that nonce finalizes. This is not proof that nothing was sent.`,
    ]
    tone = 'wait'
    actions = [checkStatus, report]
  } else if (op.state === 'draft' && history.length === 0) {
    kind = 'draft_new'
    title = 'Draft saved'
    body = ['Nothing has been sent. Preparing the first step reserves a wallet nonce on the server until a transaction at that nonce finalizes.']
    actions = [act('prepare', 'Prepare first step', canIssue, issueReason), cancel]
  } else if (op.state === 'draft') {
    kind = 'draft_progress'
    title = `Step ${last?.step ?? history.length} confirmed`
    body = [`${last ? STEP_KIND[last.kind] : 'The last step'} was confirmed on-chain. The next step is prepared only when you ask for it.`]
    tone = 'in'
    actions = [act('prepare', 'Prepare next step', canIssue, issueReason), cancel]
  } else if (op.state === 'confirmed') {
    const receipt = lastReceipt(op)
    kind = 'confirmed'
    title = receipt?.position ? `Position #${receipt.position.tokenId} created` : 'Confirmed'
    body = ['The amounts below say what evidence they come from. Principal is never shown as earned fees.']
    tone = 'in'
    actions = [checkStatus]
  } else if (op.state === 'reverted') {
    kind = 'reverted'
    title = 'Transaction reverted'
    body = ['The transaction was included but reverted, so no position was created. Network gas was still charged; see the gas details below. Earlier approvals may still be active.']
    tone = 'out'
  } else if (op.state === 'cancelled' && history.length === 0) {
    kind = 'cancelled_clean'
    title = 'Cancelled before any wallet step'
    body = ['Nothing was sent.']
  } else if (op.state === 'cancelled') {
    kind = 'cancelled_after_steps'
    title = `Cancelled after ${history.filter((step) => step.reconciliationState === 'confirmed').length} confirmed step(s)`
    body = ['Earlier approvals may still be active. Check allowances.']
  } else {
    kind = 'superseded'
    title = 'Replaced by another transaction'
    body = [
      `Another transaction from your wallet used this step's nonce (${nonce}); this step can no longer execute, and no position came from it. The receipt below is of the transaction that used the nonce.`,
    ]
  }

  // A conflict is support-required over any state (#68). The rules above
  // already cover every state the runtime accepts a conflict in; this keeps
  // any other state from offering a report, retry or cancel beside one.
  if (anyConflict && !supportRequired) {
    supportRequired = true
    tone = 'out'
    body = [...body, SUPPORT_REQUIRED]
    actions = actions.filter((action) => action.id === 'check_status' || action.id === 'check_allowances')
  }

  // Check allowances wherever the deposit has history (ALW-1).
  if (history.length > 0 && !actions.some((action) => action.id === 'check_allowances')) actions.push(act('check_allowances', 'Check allowances'))

  const receipt = lastReceipt(op)
  return {
    kind,
    title,
    body,
    tone,
    supportRequired,
    reserved: op.outstanding ? `A transaction slot (nonce ${nonce}) is reserved for your wallet.` : null,
    conflicts: conflictsOf(op),
    actions,
    step: kind === 'step_ready' && walletStep ? stepView(walletStep, op) : null,
    receipt: receipt && kind !== 'step_ready' ? receiptView(receipt, op) : null,
    history: historyFacts(op),
    facts: [
      FIXED_FACTS,
      `Domino service fee on your principal: ${hundredthsToPercentText(String(op.serviceFeeBps)) ?? op.serviceFeeBps}%. Network gas is separate.`,
    ],
    selection: presentSelection(op.selection, ctx.tokens),
  }
}

export function handoffStatus(op: Operation): string {
  return NO_SEND_STATUS.replace('{n}', op.history.at(-1)?.nonceRaw ?? '(unknown)')
}

export interface AllowanceRowView {
  currency: string
  erc20: Fact
  permit2: Fact
}

const PERMIT2_STATUS: Readonly<Record<'active' | 'expired' | 'zero' | 'unavailable', string>> = {
  active: 'Active',
  expired: 'Expired',
  zero: 'Zero',
  unavailable: 'Could not read',
}

export function presentAllowances(report: AllowanceReport): { header: string; rows: AllowanceRowView[]; guidance: string } {
  const rows = report.observations.map((observation) => {
    const erc20: Fact =
      observation.erc20Status === 'unavailable' || observation.erc20AllowanceRaw === null
        ? { label: `Token → Permit2 (${observation.erc20Spender})`, value: 'Could not read', unknown: true }
        : { label: `Token → Permit2 (${observation.erc20Spender})`, value: `${groupRaw(observation.erc20AllowanceRaw)} raw units`, note: 'An ERC-20 approval has no expiry.' }
    const permitValue =
      observation.permit2Status === 'unavailable' || observation.permit2AllowanceRaw === null
        ? 'Could not read'
        : `${groupRaw(observation.permit2AllowanceRaw)} raw units · ${PERMIT2_STATUS[observation.permit2Status]}${
            observation.permit2Expiration === null ? '' : ` · expires ${utcTime(observation.permit2Expiration)}`
          }`
    const permit2: Fact = {
      label: `Permit2 → PositionManager (${observation.permit2Spender})`,
      value: permitValue,
      unknown: observation.permit2Status === 'unavailable' || observation.permit2AllowanceRaw === null,
      note: observation.permit2Status === 'expired' ? 'An expired Permit2 allowance does not remove the ERC-20 approval above.' : undefined,
    }
    return { currency: observation.currency.toLowerCase(), erc20, permit2 }
  })
  return {
    header: `Read at block ${report.snapshot.number} (${shortHex(report.snapshot.hash)}, ${utcTime(report.snapshot.timestamp)}). A snapshot, not a token safety check.`,
    rows,
    guidance:
      'To remove these permissions, use your own wallet on Robinhood Chain (4663) to set two allowances to zero: the ERC-20 allowance each token gives Permit2 ' +
      `(${PERMIT2}), and, separately, the Permit2 allowance for the PositionManager (${POSITION_MANAGER}) on that token. This can affect other apps that use Permit2. ` +
      'This page has no button for it and builds nothing. After your wallet confirms, press Check allowances. Cancelled or replaced deposits do not revoke anything.',
  }
}

/** Whether a receipt's limits check says anything; used by the lab's scenario list. */
export const exceeded = (receipt: ReceiptSummary | null) => (receipt?.transaction?.selectedLimitsExceeded.length ?? 0) > 0

/** For node tests of exact formatting at the uint256 edge. */
export const compareRaw = cmpRaw
