import { decodeEventLog, toEventSelector, type Abi, type AbiEvent } from 'viem'
import zapAbi from '../../../../api-contracts/v2/abi/IDominoZap.json'
import actionsAbi from '../../../../api-contracts/v2/abi/IDominoPositionActions.json'
import feeEventsAbi from '../../../../api-contracts/v2/abi/IDominoFeeEvents.json'
// Changed on purpose (data) 2026-10-02 (rev2 §2.11, D7 resolved in #308): SwapLegExecuted comes from the zap
// implementation's own export (api-contracts/v2/implementations), no longer declared by hand.
import zapV4Implementation from '../../../../api-contracts/v2/implementations/DominoZapV4.json'
import { v2Chain } from '../../v2/chains'
import { ACTION, FEE_KIND } from '../../v2/types'
import type { ActionCode, ActionName, Address, Hex, PoolRef, PositionIntent, V2ChainId } from '../../v2/types'
import { intentHash } from './typedData'

/**
 * An S1 action's receipt, from the zap's own events (spec F7 §2.11): what was paid in, each swap leg as measured, the
 * Domino fee exactly as charged, each position step, what came back, and the action's summary. Raw amounts as bigint and
 * tokens as addresses; never USD (a USD figure needs a qualified source, §6, and this module has none).
 *
 * Which logs count:
 * - Only logs EMITTED BY the expected zap. A log with the same topic from any other address is ignored.
 * - The plan's `PositionActionExecuted`: exactly one, matched by the `intentHash` the app computes itself
 *   (`intentHash(chainId, zap, intent)`, ./typedData.ts), with the plan's action code. None, two, or another action code
 *   is a closed error (below), never a guessed receipt.
 * - The plan's window: the zap's logs after the previous `PositionActionExecuted` of the zap in this transaction (of
 *   any intent), up to the plan's own. The zap holds a lock for a whole action (DominoActionLock) and emits every event
 *   of the action before its `PositionActionExecuted` (DominoZapBase), so two actions in one transaction never
 *   interleave, and the window is exactly the plan's action.
 * - `InputPulled` and `PositionLiquidityChanged` carry the intent hash indexed, `FeeCharged` as its `ref`: inside the
 *   window each must carry the plan's, and none of the plan's may sit outside it.
 * - `SwapLegExecuted`, `Refunded` and `FeeDeferred` carry no intent hash. They are attributed to the plan only because
 *   (1) the receipt is the one of the transaction the plan was sent in (the caller's), (2) its `PositionActionExecuted`
 *   matched, and (3) they sit in the plan's window.
 *
 * `FeeDeferred` is internal: the fee recipient could not take the fee at once, so it is owed to the recipient. The fee
 * was already counted by `FeeCharged` (the ledger emits it for the whole amount first), so it is never a second charge
 * and never a line; it is kept apart in `deferredFees`.
 *
 * Gas: `gasUsed × effectiveGasPrice` in wei, plus the L1 data fee (`l1Fee`) on a chain whose profile says the receipt
 * carries it (Base, OP Stack); on Nitro chains (Robinhood, Arbitrum) `gasUsed` already includes the L1 part. A missing
 * field makes the cost unavailable, never zero.
 *
 * Pure: it reads a receipt the caller already has, and asks nothing of the wallet or the chain.
 */

/** The receipt's line labels, as the spec words them (§2.11). The position steps' words are the screen's. */
export const RECEIPT_LABELS = Object.freeze({
  paidIn: 'Paid in',
  swapped: 'Swapped',
  fee: 'Domino fee (0.65% of the amount swapped)',
  returned: 'Returned to your wallet',
} as const)

/**
 * `SwapLegExecuted` as contracts/src/v2/route/DominoSwapExecutor.sol declares it. The receipt decodes it from the zap
 * implementation's export (api-contracts/v2/implementations, #308, D7 resolved); this copy is the reference the
 * receipt tests hold that export to.
 */
export const SWAP_LEG_EXECUTED_EVENT = {
  type: 'event',
  name: 'SwapLegExecuted',
  anonymous: false,
  inputs: [
    { indexed: true, name: 'kind', type: 'uint8' },
    { indexed: true, name: 'tokenIn', type: 'address' },
    { indexed: true, name: 'tokenOut', type: 'address' },
    { indexed: false, name: 'venue', type: 'address' },
    { indexed: false, name: 'amountIn', type: 'uint256' },
    { indexed: false, name: 'amountOut', type: 'uint256' },
  ],
} as const satisfies AbiEvent

const eventOf = (json: unknown, name: string): AbiEvent => {
  const item = (json as { abi: Abi }).abi.find((entry) => entry.type === 'event' && entry.name === name)
  if (!item) throw new Error(`missing_event_abi: ${name}`)
  return item as AbiEvent
}

export type ReceiptEventName =
  | 'InputPulled'
  | 'SwapLegExecuted'
  | 'FeeCharged'
  | 'FeeDeferred'
  | 'PositionLiquidityChanged'
  | 'Refunded'
  | 'PositionActionExecuted'

/** The events a zap receipt is read from: the exported ABIs where they have them, `SwapLegExecuted` by hand. */
export const RECEIPT_EVENTS: Readonly<Record<ReceiptEventName, AbiEvent>> = Object.freeze({
  InputPulled: eventOf(zapAbi, 'InputPulled'),
  SwapLegExecuted: eventOf(zapV4Implementation, 'SwapLegExecuted'),
  FeeCharged: eventOf(feeEventsAbi, 'FeeCharged'),
  FeeDeferred: eventOf(feeEventsAbi, 'FeeDeferred'),
  PositionLiquidityChanged: eventOf(zapAbi, 'PositionLiquidityChanged'),
  Refunded: eventOf(actionsAbi, 'Refunded'),
  PositionActionExecuted: eventOf(actionsAbi, 'PositionActionExecuted'),
})

/** Each event's topic0, from its signature (tests/v2/receipt.test.mjs compares them with the spec's table, §2.11). */
export const RECEIPT_TOPICS: Readonly<Record<ReceiptEventName, Hex>> = Object.freeze(
  Object.fromEntries(Object.entries(RECEIPT_EVENTS).map(([name, event]) => [name, toEventSelector(event)])) as Record<ReceiptEventName, Hex>,
)
const NAME_BY_TOPIC: ReadonlyMap<string, ReceiptEventName> = new Map(Object.entries(RECEIPT_TOPICS).map(([name, topic]) => [topic, name as ReceiptEventName]))

// ---------------------------------------------------------------------------
// Input and output
// ---------------------------------------------------------------------------

type Quantity = string | number | bigint | null | undefined

/** A log as `eth_getTransactionReceipt` returns it. */
export interface RpcLog {
  address: string
  topics: readonly string[]
  data: string
  logIndex?: Quantity
  transactionHash?: string | null
  removed?: boolean
}

/** A receipt as `eth_getTransactionReceipt` returns it (quantities as 0x-hex; bigints are taken too). */
export interface RpcReceipt {
  transactionHash?: string | null
  status?: Quantity
  logs: readonly RpcLog[]
  gasUsed?: Quantity
  effectiveGasPrice?: Quantity
  /** OP Stack (Base): the L1 data fee, in wei. */
  l1Fee?: Quantity
}

export interface ZapReceiptInput {
  chainId: V2ChainId
  /** The zap the plan was sent to: the manifest's `zap.v3` or `zap.v4` for the plan's dex. */
  zap: Address
  /** The plan's intent, exactly as it was sent or signed. */
  intent: PositionIntent
  /** The receipt of the transaction the plan was sent in. */
  receipt: RpcReceipt
  /** The owner the app expects (the sender, or the Permit2 signer); checked against the events when given. */
  owner?: Address
}

/** One token of a position step: `paid` into the pool (the event's amount < 0), `received` out of it (> 0), or `none`. */
export interface StepAmount {
  token: Address
  /** The magnitude. */
  amount: bigint
  direction: 'paid' | 'received' | 'none'
}

export type ReceiptLine =
  | { kind: 'paid-in'; logIndex: number; token: Address; amount: bigint; owner: Address }
  | { kind: 'swapped'; logIndex: number; legKind: number; tokenIn: Address; tokenOut: Address; venue: Address; amountIn: bigint; amountOut: bigint }
  | { kind: 'fee'; logIndex: number; token: Address; amount: bigint; payer: Address }
  | {
    kind: 'position'
    logIndex: number
    /** `liquidityDelta` > 0 added, < 0 removed, 0 collected only. */
    step: 'added' | 'removed' | 'collected'
    tokenId: bigint
    pool: PoolRef
    /** The magnitude of `liquidityDelta`. */
    liquidity: bigint
    amounts: readonly [StepAmount, StepAmount]
    owner: Address
  }
  | { kind: 'returned'; logIndex: number; token: Address; amount: bigint; recipient: Address }

export type GasCost =
  | { status: 'available'; totalWei: bigint; executionWei: bigint; l1FeeWei: bigint | null }
  | { status: 'unavailable'; reason: 'gas_used_missing' | 'gas_price_missing' | 'l1_fee_missing' }

export interface ZapReceipt {
  chainId: V2ChainId
  zap: Address
  intentHash: Hex
  transactionHash: Hex | null
  /** From `PositionActionExecuted`. `previousTokenId` is 0 on create, the position on increase and exit, the old one on a change of range. */
  summary: {
    action: ActionCode
    actionName: ActionName
    recipient: Address
    tokenId: bigint
    previousTokenId: bigint
    liquidity: bigint
  }
  /** In log order. */
  lines: readonly ReceiptLine[]
  /** The Domino fee as `FeeCharged` (kind 1) says it; null when nothing was charged (no event). */
  fee: { token: Address; amount: bigint; payer: Address } | null
  /** Internal: owed to the fee recipient, already part of `fee`. Never a line, never a second charge. */
  deferredFees: readonly { token: Address; amount: bigint; totalOwed: bigint }[]
  /** The owner the events name (the sender, or the Permit2 or relayed signer); null when no event names one. */
  owner: Address | null
  gas: GasCost
}

/**
 * Why a receipt was not read. Closed:
 * - `receipt_invalid`: not a well-formed receipt, or a zap log that does not decode as its event;
 * - `receipt_reverted`: the transaction reverted (or says no status);
 * - `receipt_no_action`: no `PositionActionExecuted` of the zap carries this plan's intent hash;
 * - `receipt_duplicate_action`: more than one does;
 * - `receipt_action_mismatch`: its action code is not the plan's;
 * - `receipt_position_mismatch`: a token id, a pool or a step that the plan does not explain;
 * - `receipt_recipient_mismatch`: a recipient that is not the plan's;
 * - `receipt_fee_mismatch`: a fee the plan's terms do not allow (kind, token, count, or a fee on a plan without one);
 * - `receipt_foreign_event`: an event of another intent inside the plan's window, or one of the plan's outside it;
 * - `receipt_owner_mismatch`: the events name different owners, or not the expected one.
 */
export type ReceiptError =
  | 'receipt_invalid'
  | 'receipt_reverted'
  | 'receipt_no_action'
  | 'receipt_duplicate_action'
  | 'receipt_action_mismatch'
  | 'receipt_position_mismatch'
  | 'receipt_recipient_mismatch'
  | 'receipt_fee_mismatch'
  | 'receipt_foreign_event'
  | 'receipt_owner_mismatch'

const fail = (code: ReceiptError): never => {
  throw new Error(code)
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const WORD = /^0x[0-9a-fA-F]{64}$/
const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/
const QUANTITY = /^0x[0-9a-fA-F]+$/

/** A receipt quantity: 0x-hex, a bigint, or a safe non-negative integer; null when absent or malformed. */
function quantity(value: Quantity): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
  if (typeof value === 'string' && QUANTITY.test(value)) return BigInt(value)
  return null
}

const lower = (value: string): Address => value.toLowerCase() as Address

const ACTION_NAMES: Readonly<Record<number, ActionName>> = Object.freeze(
  Object.fromEntries(Object.entries(ACTION).map(([name, code]) => [code, name as ActionName])),
)

interface ZapEvent {
  name: ReceiptEventName
  logIndex: number
  args: Record<string, unknown>
}

function decodeLog(log: RpcLog, name: ReceiptEventName, logIndex: number): ZapEvent {
  try {
    const { args } = decodeEventLog({
      abi: [RECEIPT_EVENTS[name]],
      data: log.data as Hex,
      topics: log.topics as [Hex, ...Hex[]],
      strict: true,
    })
    return { name, logIndex, args: args as unknown as Record<string, unknown> }
  } catch {
    return fail('receipt_invalid')
  }
}

const big = (value: unknown): bigint => (typeof value === 'bigint' ? value : fail('receipt_invalid'))
const num = (value: unknown): number => (typeof value === 'number' ? value : fail('receipt_invalid'))
const addr = (value: unknown): Address => (typeof value === 'string' && ADDRESS.test(value) ? lower(value) : fail('receipt_invalid'))
const word = (value: unknown): Hex => (typeof value === 'string' && WORD.test(value) ? (value.toLowerCase() as Hex) : fail('receipt_invalid'))

function poolOf(value: unknown): PoolRef {
  if (!value || typeof value !== 'object') return fail('receipt_invalid')
  const pool = value as Record<string, unknown>
  const dex = num(pool.dex)
  if (dex !== 3 && dex !== 4) return fail('receipt_position_mismatch')
  return { dex, currency0: addr(pool.currency0), currency1: addr(pool.currency1), fee: num(pool.fee), tickSpacing: num(pool.tickSpacing), hooks: addr(pool.hooks) }
}

const samePool = (a: PoolRef, b: PoolRef): boolean =>
  a.dex === b.dex && a.currency0 === lower(b.currency0) && a.currency1 === lower(b.currency1) && a.fee === b.fee && a.tickSpacing === b.tickSpacing && a.hooks === lower(b.hooks)

const stepAmount = (token: Address, amount: bigint): StepAmount => ({
  token,
  amount: amount < 0n ? -amount : amount,
  direction: amount < 0n ? 'paid' : amount > 0n ? 'received' : 'none',
})

/**
 * The gas a receipt cost, in wei of the chain's native ETH: `gasUsed × effectiveGasPrice`, plus `l1Fee` where the chain's
 * profile says the receipt carries it (Base). Unavailable, never zero, when a field is missing.
 */
export function gasCost(chainId: V2ChainId, receipt: Pick<RpcReceipt, 'gasUsed' | 'effectiveGasPrice' | 'l1Fee'>): GasCost {
  const chain = v2Chain(chainId)
  const gasUsed = quantity(receipt.gasUsed)
  if (gasUsed === null) return { status: 'unavailable', reason: 'gas_used_missing' }
  const price = quantity(receipt.effectiveGasPrice)
  if (price === null) return { status: 'unavailable', reason: 'gas_price_missing' }
  const executionWei = gasUsed * price
  if (!chain.l1FeeInReceipt) return { status: 'available', totalWei: executionWei, executionWei, l1FeeWei: null }
  const l1FeeWei = quantity(receipt.l1Fee)
  if (l1FeeWei === null) return { status: 'unavailable', reason: 'l1_fee_missing' }
  return { status: 'available', totalWei: executionWei + l1FeeWei, executionWei, l1FeeWei }
}

/** The plan's receipt (the rules at the top of this file). Throws a `ReceiptError` code when it cannot be read exactly. */
export function readZapReceipt(input: ZapReceiptInput): ZapReceipt {
  const chain = v2Chain(input.chainId)
  if (typeof input.zap !== 'string' || !ADDRESS.test(input.zap)) throw new Error('invalid_zap')
  const zap = lower(input.zap)
  const { intent, receipt } = input
  const hash = intentHash(chain.chainId, zap, intent).toLowerCase() as Hex
  if (input.owner !== undefined && (typeof input.owner !== 'string' || !ADDRESS.test(input.owner))) throw new Error('invalid_owner')
  const expectedOwner = input.owner === undefined ? null : lower(input.owner)

  // The receipt's shape.
  if (!receipt || typeof receipt !== 'object' || !Array.isArray(receipt.logs)) return fail('receipt_invalid')
  const status = quantity(receipt.status)
  if (status === null || status > 1n) return fail('receipt_invalid')
  if (status !== 1n) return fail('receipt_reverted')
  const transactionHash = receipt.transactionHash == null ? null : WORD.test(receipt.transactionHash) ? (receipt.transactionHash.toLowerCase() as Hex) : fail('receipt_invalid')
  const indexed = receipt.logs.map((log, position) => {
    if (!log || typeof log !== 'object' || typeof log.address !== 'string' || !ADDRESS.test(log.address)) return fail('receipt_invalid')
    if (!Array.isArray(log.topics) || log.topics.some((topic: unknown) => typeof topic !== 'string' || !WORD.test(topic))) return fail('receipt_invalid')
    if (typeof log.data !== 'string' || !HEX_DATA.test(log.data)) return fail('receipt_invalid')
    if (log.removed === true) return fail('receipt_invalid')
    if (transactionHash && log.transactionHash != null && log.transactionHash.toLowerCase() !== transactionHash) return fail('receipt_invalid')
    const index = log.logIndex === undefined || log.logIndex === null ? null : quantity(log.logIndex)
    if (log.logIndex != null && index === null) return fail('receipt_invalid')
    return { log, position, index }
  })
  // Log order: by logIndex when every log has one, as the node returned them otherwise.
  const ordered = indexed.every((entry) => entry.index !== null)
    ? [...indexed].sort((a, b) => (a.index! < b.index! ? -1 : a.index! > b.index! ? 1 : 0))
    : indexed
  if (ordered.some((entry, i) => i > 0 && entry.index !== null && entry.index === ordered[i - 1].index)) return fail('receipt_invalid')

  // The zap's own logs, decoded; any other address is ignored, whatever its topics.
  const events: ZapEvent[] = []
  for (const { log, position, index } of ordered) {
    if (lower(log.address) !== zap || log.topics.length === 0) continue
    const name = NAME_BY_TOPIC.get(log.topics[0].toLowerCase())
    if (!name) continue
    events.push(decodeLog(log, name, index === null ? position : Number(index)))
  }

  // The plan's PositionActionExecuted, and its window.
  const actions = events.map((event, i) => ({ event, i })).filter(({ event }) => event.name === 'PositionActionExecuted')
  const ours = actions.filter(({ event }) => word(event.args.intentHash) === hash)
  if (ours.length === 0) return fail('receipt_no_action')
  if (ours.length > 1) return fail('receipt_duplicate_action')
  const end = ours[0].i
  const start = actions.filter(({ i }) => i < end).reduce((last, { i }) => Math.max(last, i + 1), 0)
  const executed = ours[0].event.args
  const action = num(executed.action)
  if (action !== intent.action) return fail('receipt_action_mismatch')
  const summary = {
    action: intent.action,
    actionName: ACTION_NAMES[intent.action],
    recipient: addr(executed.recipient),
    tokenId: big(executed.tokenId),
    previousTokenId: big(executed.previousTokenId),
    liquidity: big(executed.liquidity),
  }
  if (summary.recipient !== lower(intent.recipient)) return fail('receipt_recipient_mismatch')
  if (summary.previousTokenId !== intent.tokenId) return fail('receipt_position_mismatch')
  const sameToken = intent.action === ACTION.increase || intent.action === ACTION.exit
  if (sameToken ? summary.tokenId !== intent.tokenId : summary.tokenId === 0n || summary.tokenId === intent.tokenId) return fail('receipt_position_mismatch')

  // None of the plan's intent-carrying events may sit outside its window.
  const carries = (event: ZapEvent): Hex | null =>
    event.name === 'InputPulled' || event.name === 'PositionLiquidityChanged' ? word(event.args.intentHash) : event.name === 'FeeCharged' ? word(event.args.ref) : null
  events.forEach((event, i) => {
    if ((i < start || i > end) && carries(event) === hash) fail('receipt_foreign_event')
  })

  const lines: ReceiptLine[] = []
  const owners = new Set<Address>()
  const deferredFees: { token: Address; amount: bigint; totalOwed: bigint }[] = []
  const steps: Extract<ReceiptLine, { kind: 'position' }>[] = []
  let fee: ZapReceipt['fee'] = null
  for (const event of events.slice(start, end)) {
    const { args, logIndex } = event
    const carried = carries(event)
    if (carried !== null && carried !== hash) return fail('receipt_foreign_event')
    switch (event.name) {
      case 'InputPulled': {
        const owner = addr(args.owner)
        owners.add(owner)
        lines.push({ kind: 'paid-in', logIndex, token: addr(args.token), amount: big(args.amount), owner })
        break
      }
      case 'SwapLegExecuted':
        lines.push({ kind: 'swapped', logIndex, legKind: num(args.kind), tokenIn: addr(args.tokenIn), tokenOut: addr(args.tokenOut), venue: addr(args.venue), amountIn: big(args.amountIn), amountOut: big(args.amountOut) })
        break
      case 'FeeCharged': {
        if (num(args.kind) !== FEE_KIND.assistedSwap) return fail('receipt_fee_mismatch')
        if (fee !== null || intent.feeBps === 0) return fail('receipt_fee_mismatch')
        const token = addr(args.token)
        if (token !== lower(intent.feeToken)) return fail('receipt_fee_mismatch')
        const payer = addr(args.payer)
        owners.add(payer)
        fee = { token, amount: big(args.amount), payer }
        lines.push({ kind: 'fee', logIndex, token, amount: fee.amount, payer })
        break
      }
      case 'FeeDeferred':
        deferredFees.push({ token: addr(args.token), amount: big(args.amount), totalOwed: big(args.totalOwed) })
        break
      case 'PositionLiquidityChanged': {
        const pool = poolOf(args.pool)
        if (!samePool(pool, intent.pool)) return fail('receipt_position_mismatch')
        const owner = addr(args.owner)
        owners.add(owner)
        const delta = big(args.liquidityDelta)
        const line = {
          kind: 'position' as const,
          logIndex,
          step: delta > 0n ? ('added' as const) : delta < 0n ? ('removed' as const) : ('collected' as const),
          tokenId: big(args.tokenId),
          pool,
          liquidity: delta < 0n ? -delta : delta,
          amounts: [stepAmount(pool.currency0, big(args.amount0)), stepAmount(pool.currency1, big(args.amount1))] as const,
          owner,
        }
        steps.push(line)
        lines.push(line)
        break
      }
      case 'Refunded': {
        const recipient = addr(args.recipient)
        if (recipient !== summary.recipient) return fail('receipt_recipient_mismatch')
        lines.push({ kind: 'returned', logIndex, token: addr(args.token), amount: big(args.amount), recipient })
        break
      }
      case 'PositionActionExecuted':
        // Cannot be inside the window: it is bounded by the zap's actions.
        return fail('receipt_invalid')
    }
  }

  // The position steps the action takes (DominoZapBase): one added step on create and increase; a removal (or a collect)
  // of the old position then an added step on the new one on a change of range; a removal (or a collect) on exit. The
  // summary's liquidity is the last step's.
  const expected: readonly ('in' | 'out')[] =
    intent.action === ACTION.create || intent.action === ACTION.increase ? ['in'] : intent.action === ACTION.changeRange ? ['out', 'in'] : ['out']
  if (steps.length !== expected.length) return fail('receipt_position_mismatch')
  steps.forEach((step, i) => {
    const added = step.step === 'added'
    if ((expected[i] === 'in') !== added) fail('receipt_position_mismatch')
    const tokenId = expected[i] === 'in' ? summary.tokenId : intent.tokenId
    if (step.tokenId !== tokenId) fail('receipt_position_mismatch')
  })
  if (steps[steps.length - 1].liquidity !== summary.liquidity) return fail('receipt_position_mismatch')

  if (owners.size > 1) return fail('receipt_owner_mismatch')
  const owner = owners.size === 1 ? [...owners][0] : null
  if (expectedOwner !== null && owner !== null && owner !== expectedOwner) return fail('receipt_owner_mismatch')

  return Object.freeze({
    chainId: chain.chainId,
    zap,
    intentHash: hash,
    transactionHash,
    summary: Object.freeze(summary),
    lines: Object.freeze(lines),
    fee,
    deferredFees: Object.freeze(deferredFees),
    owner,
    gas: gasCost(chain.chainId, receipt),
  })
}
