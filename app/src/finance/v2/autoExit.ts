import { decodeFunctionResult, encodeAbiParameters, encodeEventTopics, encodeFunctionData, getContractAddress, keccak256, type Abi } from 'viem'
import v3PoolAbi from '../../../../api-contracts/v2/abi/IUniswapV3PoolMinimal.json'
import v4StateViewAbi from '../../../../api-contracts/v2/abi/IV4StateViewMinimal.json'
import type { V2Chain } from '../../v2/chains'
import { RECEIVE_MODE, ZERO_ADDRESS, type Address, type Dex, type ExitMandate, type Hex, type ReceiveMode, type V2ChainId, type V2Component, type V2Contracts } from '../../v2/types'
import { atomicStatus, batchCallsStatus, simulateBatch, type AtomicStatus, type BatchCall } from '../batch'
import { readAccountCode } from '../delegates'
import { AUTO_EXIT_ABI, REGISTRY_ABI, V3_POSITION_MANAGER_ABI, V4_POSITION_MANAGER_ABI, VAULT_ABI, VAULT_FACTORY_ABI } from './abi'
import { AUTO_EXIT_EVENTS_ABI, VAULT_EVENTS_ABI, VAULT_FACTORY_EVENTS_ABI } from './implementations'
import { CONTRACTS_NOT_LIVE, refuseUnlessLive } from './liveLock'
import { createTransactor, quantity, refused, REVIEW_S, revertIn, SIGN_WINDOW_S, WalletNotAsked, type PreparedV2, type Rpc, type SignedNonce, type V2GasBudget, type V2Receipt, type V2Wallet } from './transact'
import { exitMandateTypedData, mandateId, signV2TypedData, typedDataDigest, type SignatureShape, type V2TypedData } from './typedData'
import {
  browserV2BatchLatch, checkBatchBudget, decodeEvents, factoryComponent, factoryOf, managerAbi, managerOf, newVaultRoot, offerV2Batch, pinBlock, readVaultIdentity, receiptOfBatch, settleBatchLatch,
  simulateV2Batch, transactionWithLog, v2ContractsFor, V2_BATCH_LATCH_EXPIRY_S, vaultBatchKey, vaultCreation, verifyComponents, viewAt, type ReadAt, type V2BatchLatch, type V2BatchReceipt, type V2Event,
  type V2Snapshot, type VaultCreateRequest, type VaultIdentity, type VaultStepKind,
} from './vault'

/**
 * Domino V2's auto-exit (service S3, spec F7 §4, milestone M4), as a vault's owner drives it from the wallet: review an
 * exit order for a position inside the owner's vault, turn the module on for that vault, sign the `ExitMandate`, register
 * it, read where it stands, cancel it, cancel a signed order that was never registered, and claim what an exit could
 * not deliver. Every write goes through the shared V2 sender (./transact.ts), every signature through the one typed-data
 * signer (./typedData.ts), every read through the connected wallet's own provider, pinned to one block per review.
 *
 * Auto-exit is the only power Domino has over principal, and it exists only with a signed, revocable order and the
 * module enabled on the vault (spec §1.5). So:
 *   - the vault is never taken from outside: the factory of its DEX must say it made it, and its `owner()` must be the
 *     wallet, which is the order's owner and its signer;
 *   - the position is the vault's root or an ACTIVE successor;
 *   - every term of spec §4.2's table is checked before anything is signed, each failure a closed reason code
 *     (MANDATE_REASON_TEXT words it for "This order isn't valid: {reason}."). `receiveMode` is taken as given, never
 *     inferred from `convertTo` (address(0) is ETH on v4 AND the "no conversion" value of RECEIVE_BOTH);
 *   - the nonce is random (256 bits), unused on chain and not held in the page's signature journal; it is recorded in
 *     the journal BEFORE the wallet is asked, forgotten after a definite refusal (4001) only, and kept until the chain
 *     says it was used (registered or cancelled, at a finalized block) otherwise;
 *   - the signature is checked locally (an EOA's recovers to the owner with a low s), bound to its review, and only that
 *     review's registration carries it;
 *   - the module is only ever set to the manifest's `autoExit`; turning it off is the vault client's
 *     `set-exit-module` to address(0), which pauses the orders and does not cancel them.
 *
 * Changed on purpose 2026-10-06 (the owner's point 5, rugged97: "it is AUTO-EXIT, separate from the rest, automatic"):
 * the screens call it Auto-exit (src/v2in/autoexit), and turn it on for a plain position as ONE signature and ONE
 * EIP-5792 batch, with today's contracts (the study p5-auto-exit.md, "activation"): the order is reviewed and signed for
 * the vault the wallet's next `createVault` makes (`predictVault(owner, nextNonce(owner))`, `MandateRequest.newVault`),
 * then `[approve(predicted vault, tokenId), createVault(protection-only Init), setExitModule(autoExit),
 * registerMandate(mandate, signature)]` goes as one batch (prepareProtectBatch), the approval and the creation derived by
 * the vault client's own code (./vault.ts vaultCreation). Without batching, the same calls go one by one. The list of an
 * owner's orders is read-v6's (spec §6.2), not read here.
 *
 * Changed on purpose 2026-10-06 (the review of point 5: an edge the price has already crossed fires on the operator's
 * next pass and closes the position at once, with the 0.2% fee; neither the module nor the backend checks it at
 * registration): the pool's own price is read on chain (v4 StateView `getSlot0`, v3 the pool's `slot0`), at the review's
 * block and again right before the signature, the batch and the registration step, and an armed trigger it has reached
 * (at or below the lower one, at or above the upper one: the module's own rule) is refused, `mandate_trigger_reached`.
 * `readPoolPrice` gives the screens that price to choose the edges by (src/v2in/autoexit/form.ts exitEdges).
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const MAX_UINT64 = (1n << 64n) - 1n
const MAX_UINT160 = (1n << 160n) - 1n
const MAX_UINT256 = (1n << 256n) - 1n
/** `MAX_SLIPPAGE_BPS` of the module (10%, spec §4.2): the read value may only lower this, never raise it. */
export const AUTO_EXIT_MAX_SLIPPAGE_BPS = 1000

const fail = (code: string): never => { throw new Error(code) }
const isAddress = (value: unknown): value is Address => typeof value === 'string' && ADDRESS.test(value)
const lower = (value: string): Address => (isAddress(value) ? (value.toLowerCase() as Address) : fail('invalid_wallet_reply'))

/** Uniswap's two price views (the chain profile's v4 StateView, a v3 pool's own `slot0`), as the zap and direct clients read them. */
const V3_POOL_ABI = (v3PoolAbi as unknown as { abi: Abi }).abi
const V4_STATE_VIEW_ABI = (v4StateViewAbi as unknown as { abi: Abi }).abi
const POOL_KEY = [{ type: 'tuple', components: [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] }] as const

/** A pool as its price is read: a v4 pool by its key's id, a v3 pool by its tokens and tier. */
interface PricedPool {
  dex: Dex
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number | null
  hooks: Address
}

/** A v3 pool's address: CREATE2 of the chain profile's factory with its init code hash, salt keccak256(abi.encode(token0, token1, fee)). */
const v3PoolAt = (chain: V2Chain, pool: PricedPool): Address =>
  getContractAddress({ opcode: 'CREATE2', from: chain.uniswap.v3.factory, salt: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }], [pool.currency0, pool.currency1, pool.fee])), bytecodeHash: chain.uniswap.v3.poolInitCodeHash }).toLowerCase() as Address

/**
 * Whether the pool's price has reached an armed trigger (Added 2026-10-06, the review of point 5): at or below the lower
 * one, or at or above a nonzero upper one, exactly the module's rule (DominoAutoExit._authorize) and the backend's
 * (v2_autoexit.Mandate.triggered). An order registered so fires on the operator's next pass. Pure.
 */
export function triggerReached(triggers: { triggerBelowSqrtPriceX96: bigint; triggerAboveSqrtPriceX96: bigint }, sqrtPriceX96: bigint): boolean {
  return sqrtPriceX96 <= triggers.triggerBelowSqrtPriceX96 || (triggers.triggerAboveSqrtPriceX96 !== 0n && sqrtPriceX96 >= triggers.triggerAboveSqrtPriceX96)
}

// ---------------------------------------------------------------------------
// Copy (spec §4.2, §4.5, §4.6, §4.7)
// ---------------------------------------------------------------------------

/**
 * The {reason} of "This Auto-exit isn't valid: {reason}." for each closed reason code. Changed on purpose 2026-10-06 (the
 * owner's point 5: the product is Auto-exit, never an "order" on screen): its prices are the range's edges.
 */
export const MANDATE_REASON_TEXT = Object.freeze({
  mandate_no_trigger: 'it needs at least one price to close at',
  mandate_trigger_order: 'its lower price must be below its upper price',
  mandate_trigger_range: 'a price to close at is outside what the pool can reach',
  mandate_receive_mode: 'choose to receive both tokens or only one of them',
  mandate_convert_to_both: "receiving both tokens can't also name a token to convert to",
  mandate_convert_to_token: "you can only receive one of this pool's two tokens",
  mandate_slippage: 'the slippage must be from 0.01% to 10%',
  mandate_valid_until: 'the end date must be in the future',
  mandate_position: 'the position must be in this automation',
  mandate_warnings: 'confirm you have read the warnings',
  // Added 2026-10-06 (the review of point 5): an armed edge the pool's price has already reached would close it at once.
  mandate_trigger_reached: 'the price has already reached the end of the range it would close at',
} as const)
export type MandateReason = keyof typeof MANDATE_REASON_TEXT
export const mandateInvalidText = (reason: MandateReason): string => `This Auto-exit isn't valid: ${MANDATE_REASON_TEXT[reason]}.`

export const AUTO_EXIT_TEXT = Object.freeze({
  // §4.7, in order (the v3 one only on a v3 vault), then the fee line (§4.6). Changed on purpose 2026-10-06 (the owner's
  // point 5): in Auto-exit's own words, its prices being the range's edges; the meaning of each is the spec's.
  autoexit_warning_not_guaranteed: "The exit price is not guaranteed. In a sudden gap or a rug, the pool's liquidity can disappear before Domino closes the position.",
  autoexit_warning_reference_price: 'Domino closes it once the reference price passes the end of your range and the pool price is within the slippage limit of it.',
  autoexit_warning_v3_twap: 'On v3 pools the reference price is a time-weighted average. After a fast move the exit waits for it to catch up, and it may never happen if the pool empties first.',
  autoexit_warning_slippage_on_top: "When converting, your slippage limit comes on top of the pool's own fee.",
  autoexit_warning_turn_off_pauses: "Leave automation pauses Auto-exit; it doesn't turn it off for good.",
  autoexit_warning_other_orders: 'If one Auto-exit closes the position, any other on it stays active.',
  autoexit_warning_halt: 'If Domino stops automation for safety, Auto-exit stops too. You can still turn it off and withdraw at any time.',
  autoexit_fee_line: "Fee: 0.2% of the position's value, only if it closes. It's the only fee.",
  // §4.6: the rule of the chosen way to receive.
  autoexit_fee_converted_charge: '0.2% of what you receive, taken in {token}.',
  autoexit_fee_converted_other: '0.2% of each token withdrawn, taken before converting. What you receive is not charged again.',
  autoexit_fee_both_charge: "0.2% of both tokens' value at the reference price, taken in {token}. If that isn't enough, the rest comes from the other token.",
  autoexit_fee_both_none: '0.2% of each token withdrawn.',
  // §4.5: why an order cannot fire now.
  mandate_status_unknown: 'Not registered',
  mandate_status_expired: 'Expired',
  mandate_status_revoked: 'Cancelled',
  mandate_status_executed: 'Executed',
  mandate_module_off: 'Paused: Auto-exit is turned off for this position.',
  mandate_owner_changed: 'Not valid: the owner of this automation changed.',
  mandate_root_custody_lost: 'Paused: Domino no longer has approval on this position.',
  mandate_successor_inactive: 'This position is no longer in your automation.',
  mandate_halted: 'Paused: Domino stopped automation on {chain} for safety.',
  mandate_vault_unknown: "This Auto-exit names an automation Domino didn't set up.",
} as const)
export type AutoExitTextKey = keyof typeof AUTO_EXIT_TEXT

export type AutoExitFeeKey = 'autoexit_fee_converted_charge' | 'autoexit_fee_converted_other' | 'autoexit_fee_both_charge' | 'autoexit_fee_both_none'

/** The §4.7 warnings for a vault's DEX: the TWAP one only on v3; the fee line last. */
export function autoExitWarnings(dex: Dex): readonly AutoExitTextKey[] {
  return Object.freeze([
    'autoexit_warning_not_guaranteed',
    'autoexit_warning_reference_price',
    ...(dex === 3 ? (['autoexit_warning_v3_twap'] as const) : []),
    'autoexit_warning_slippage_on_top',
    'autoexit_warning_turn_off_pauses',
    'autoexit_warning_other_orders',
    'autoexit_warning_halt',
    'autoexit_fee_line',
  ] as AutoExitTextKey[])
}

/**
 * The §4.6 fee rule for the chosen way to receive, from the charge-currency ranks of the pool's tokens (0 is "not a
 * charge currency"; lower is better). Receiving both with a charge currency names the better-ranked one (token0 on a
 * tie): the fee is taken there when that token came out non-zero, which only the exit itself knows.
 */
export function autoExitFeeRule(receiveMode: ReceiveMode, convertTo: Address, pool: { currency0: Address; currency1: Address }, rank0: number, rank1: number): { key: AutoExitFeeKey; token: Address | null } {
  if (receiveMode === RECEIVE_MODE.converted) {
    const rank = convertTo === pool.currency0 ? rank0 : rank1
    return rank > 0 ? { key: 'autoexit_fee_converted_charge', token: convertTo } : { key: 'autoexit_fee_converted_other', token: null }
  }
  if (rank0 > 0 && (rank1 === 0 || rank0 <= rank1)) return { key: 'autoexit_fee_both_charge', token: pool.currency0 }
  if (rank1 > 0) return { key: 'autoexit_fee_both_charge', token: pool.currency1 }
  return { key: 'autoexit_fee_both_none', token: null }
}

// ---------------------------------------------------------------------------
// The order's terms (spec §4.2)
// ---------------------------------------------------------------------------

/** What the owner asks for. Every field is explicit; nothing is inferred. */
export interface MandateRequest {
  vault: Address
  tokenId: bigint
  /** Fires with the reference price at or below this (token1 per token0, Q64.96); 0 turns it off. */
  triggerBelowSqrtPriceX96: bigint
  /** Fires with the reference price at or above this; 0 turns it off. */
  triggerAboveSqrtPriceX96: bigint
  /** 0 receive both tokens, 1 receive only `convertTo`. Never inferred from `convertTo`. */
  receiveMode: ReceiveMode
  /** address(0) with mode 0; with mode 1 one of the pool's two currencies (address(0) is ETH on v4). */
  convertTo: Address
  /** 1 to 1,000, on top of the pool's own fee. */
  maxSlippageBps: number
  /** Unix seconds; in the future, below 2^64. */
  validUntil: bigint
  /** The owner ticked that they read the warnings (spec §4.7 recommendation). */
  acknowledgedWarnings: boolean
  /**
   * Added 2026-10-06 (the owner's point 5: Auto-exit as one signature and one batch): `vault` is not created yet. It must
   * be exactly the vault this wallet's next `createVault` on this DEX's factory makes (`predictVault(owner,
   * nextNonce(owner))`, still free), for `tokenId` as its root, held by the wallet: the order is signed for it, and
   * registered in the same batch that creates it (prepareProtectBatch). Absent: the vault must already be the wallet's.
   */
  newVault?: { dex: Dex }
}

export interface MandateContext {
  /** The time the order must outlive: the later of the chain's (the review block's) and the page's, in seconds. */
  now: bigint
  pool: { currency0: Address; currency1: Address }
  /** `MAX_SLIPPAGE_BPS()` as read; never above AUTO_EXIT_MAX_SLIPPAGE_BPS. */
  maxSlippageBps: number
  /** Whether `tokenId` is the vault's root or an active successor. */
  inVault: boolean
  /**
   * Added 2026-10-06 (the review of point 5): the pool's sqrt price at the review's block. An armed trigger it has reached
   * is `mandate_trigger_reached`. Absent: not checked (the pure table alone).
   */
  sqrtPriceX96?: bigint
}

/** Every term of spec §4.2's table the request breaks, as closed reason codes; empty when the order is valid. Pure. */
export function mandateProblems(request: MandateRequest, context: MandateContext): MandateReason[] {
  const problems: MandateReason[] = []
  const below = request.triggerBelowSqrtPriceX96
  const above = request.triggerAboveSqrtPriceX96
  const triggersOk = typeof below === 'bigint' && typeof above === 'bigint' && below >= 0n && above >= 0n && below <= MAX_UINT160 && above <= MAX_UINT160
  if (!triggersOk) problems.push('mandate_trigger_range')
  else if (below === 0n && above === 0n) problems.push('mandate_no_trigger')
  else if (below > 0n && above > 0n && below >= above) problems.push('mandate_trigger_order')
  else if (typeof context.sqrtPriceX96 === 'bigint' && triggerReached({ triggerBelowSqrtPriceX96: below, triggerAboveSqrtPriceX96: above }, context.sqrtPriceX96)) problems.push('mandate_trigger_reached')
  const mode: unknown = request.receiveMode
  if (mode !== RECEIVE_MODE.both && mode !== RECEIVE_MODE.converted) problems.push('mandate_receive_mode')
  else if (!isAddress(request.convertTo)) problems.push(mode === RECEIVE_MODE.both ? 'mandate_convert_to_both' : 'mandate_convert_to_token')
  else {
    const convertTo = request.convertTo.toLowerCase()
    if (mode === RECEIVE_MODE.both && convertTo !== ZERO_ADDRESS) problems.push('mandate_convert_to_both')
    if (mode === RECEIVE_MODE.converted && convertTo !== context.pool.currency0 && convertTo !== context.pool.currency1) problems.push('mandate_convert_to_token')
  }
  const ceiling = Math.min(context.maxSlippageBps, AUTO_EXIT_MAX_SLIPPAGE_BPS)
  if (typeof request.maxSlippageBps !== 'number' || !Number.isInteger(request.maxSlippageBps) || request.maxSlippageBps < 1 || request.maxSlippageBps > ceiling) problems.push('mandate_slippage')
  if (typeof request.validUntil !== 'bigint' || request.validUntil <= context.now || request.validUntil > MAX_UINT64) problems.push('mandate_valid_until')
  if (!context.inVault) problems.push('mandate_position')
  if (request.acknowledgedWarnings !== true) problems.push('mandate_warnings')
  return problems
}

// ---------------------------------------------------------------------------
// Reviews, status
// ---------------------------------------------------------------------------

export type MandateStepKind = 'enable-exit-module' | 'sign-mandate' | 'register-mandate'

export interface MandateReview {
  kind: 'mandate'
  chainId: V2ChainId
  owner: Address
  autoExit: Address
  vault: Address
  dex: Dex
  /** The vault's pool (a vault not created yet: its root's, read from the position manager; v3's spacing from the profile, null outside its table). */
  pool: { dex: Dex; currency0: Address; currency1: Address; fee: number; tickSpacing: number | null; hooks: Address }
  role: 'root' | 'successor'
  /**
   * Added 2026-10-06 (the owner's point 5): the vault is the one the wallet's next `createVault` makes (its factory and the
   * factory's nonce for the wallet at the review), not created yet; null for a vault the wallet already owns.
   */
  predicted: { factory: Address; nonce: bigint } | null
  /**
   * Added 2026-10-06 (the review of point 5): the pool's sqrt price at the review's block, which no armed trigger has
   * reached (the screens choose the edges against it).
   */
  sqrtPriceX96: bigint
  mandate: ExitMandate
  /** The order's id: its EIP-712 struct hash (`mandateStatus`, `mandateOf`, `revokeMandate` take it), not the digest. */
  id: Hex
  /** What the wallet signs. */
  digest: Hex
  typedData: V2TypedData
  receive: { mode: 'both' } | { mode: 'converted'; token: Address }
  feeRule: { key: AutoExitFeeKey; token: Address | null }
  warnings: readonly AutoExitTextKey[]
  steps: readonly { kind: MandateStepKind; summary: readonly string[] }[]
  snapshot: V2Snapshot
}

export type MandateStatusName = 'unknown' | 'active' | 'revoked' | 'executed'
const STATUS_NAMES: readonly MandateStatusName[] = ['unknown', 'active', 'revoked', 'executed']

/** `mandateOf(id)`. */
export interface MandateRecord {
  owner: Address
  validUntil: bigint
  maxSlippageBps: number
  receiveMode: number
  status: number
  vault: Address
  convertTo: Address
  triggerBelowSqrtPriceX96: bigint
  triggerAboveSqrtPriceX96: bigint
  tokenId: bigint
}

/** Where an order stands, with spec §4.5's "can it fire?" conditions, all read at one block. */
export interface MandateStatusView extends V2Snapshot {
  id: Hex
  status: MandateStatusName
  record: MandateRecord | null
  /** Active but past `validUntil`: "Expired" is not a contract status (it still reads 1 and never executes). */
  expired: boolean
  checks: {
    active: boolean
    moduleEnabled: boolean | null
    ownerUnchanged: boolean | null
    /** The root's custody (owner holds it, vault approved), or a successor still active; null when unread. */
    position: boolean | null
    notHalted: boolean
  }
  /** The failing conditions' copy keys, in the table's order: the first is the card's line. */
  failing: readonly AutoExitTextKey[]
  canFire: boolean
  ownedByWallet: boolean
}

export type AutoExitReceipt = V2Receipt & { events: readonly V2Event[] }

/**
 * A signed order's module step and registration sent as ONE EIP-5792 batch (spec §4.4 item 7 recommendation: "depois
 * de assinar, setExitModule e registerMandate podem ir num lote"): `[vault.setExitModule(autoExit),
 * autoExit.registerMandate(mandate, signature)]`, only for a review that turns the module on, derived from the chain
 * right before and simulated whole through the wallet. Frozen; only the client that prepared it sends it, once.
 */
export interface MandateBatch {
  chainId: V2ChainId
  owner: Address
  /** The latch key: the order's id (its EIP-712 struct hash). */
  key: Hex
  id: Hex
  vault: Address
  kinds: readonly ('enable-exit-module' | 'register-mandate')[]
  calls: readonly BatchCall[]
  gasUsed: bigint
  networkFeeWei: bigint
  /** Unix seconds: good until then (25 s after its simulation). */
  expiresAt: number
}

/**
 * Added 2026-10-06 (the owner's point 5: Auto-exit as a signature plus ONE confirmation): a plain position's protection-
 * only vault and its signed order as ONE EIP-5792 batch, `[approve(predicted vault, tokenId) when missing,
 * createVault(init, n), setExitModule(autoExit), registerMandate(mandate, signature)]`. The approval and the creation are
 * derived by the vault client's own code (./vault.ts vaultCreation), for the vault the order was signed for, and the
 * whole is simulated through the wallet. Latched as the vault's creation batch (vaultBatchKey: one batch per factory
 * nonce of the owner). Frozen; only the client that prepared it sends it, once.
 */
export interface ProtectBatch {
  chainId: V2ChainId
  owner: Address
  /** The latch key: vaultBatchKey(chainId, factory, owner, n). */
  key: Hex
  /** The order's id (its EIP-712 struct hash). */
  id: Hex
  vault: Address
  factory: Address
  nonce: bigint
  kinds: readonly ('approve-root' | 'create-vault' | 'enable-exit-module' | 'register-mandate')[]
  calls: readonly BatchCall[]
  gasUsed: bigint
  networkFeeWei: bigint
  /** Unix seconds: good until then (25 s after its simulation). */
  expiresAt: number
}

/** What the protection-only vault of a ProtectBatch is (spec F7 §5.1 decision #25): paused, Auto-compound's mode with one position. */
const protectionOnly = (request: VaultCreateRequest): boolean =>
  !!request && typeof request === 'object' && request.startPaused === true && request.policy?.mode === 1 && request.policy.maxPositions === 1 && request.consentToUncollectedFees === true

interface ReviewInternal {
  /** The review asked to turn the module on: the registration then waits until it is on. */
  enable: boolean
}

interface StepOrigin {
  kind: string
  /**
   * The step's hand-over key (post-B4 review F2): what it does on chain, once (`enable|vault|stateNonce`,
   * `register|id`, `revoke|id`, `cancel|nonce`, `claim|token|recipient|amount`).
   */
  key: string
  /** The checks to run again right before the send (the latest block). */
  recheck: (rpc: Rpc) => Promise<void>
  /** A signature nonce this step uses up on chain: forgotten from the journal once its receipt is finalized. */
  nonce?: SignedNonce
  vault?: Address
}

/** 256 random bits from the platform's CSPRNG. */
function randomNonce(): bigint {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value
}

/**
 * The auto-exit client for one wallet on one chain, with that chain's pinned contracts set. Construction refuses a set
 * of another chain, a malformed one, and a fixture in a deployable build. `random` draws a nonce candidate (tests only).
 */
/**
 * The signer's own refusals before any prompt (./typedData.ts signV2TypedData), and the money lock (./liveLock.ts): nothing
 * was signed. Not `wallet_wrong_chain` or `wallet_identity_changed` as plain errors: the bounded port raises those AFTER
 * the wallet answered too (./transact.ts), so a nonce that may have been signed stays held.
 */
// Changed on purpose (data) 2026-10-02 (Domino V2 integration): the signer's own lock (./liveLock.ts) refuses before any prompt too.
const SIGNER_BEFORE_PROMPT: ReadonlySet<string> = new Set(['typed_data_chain_mismatch', 'typed_data_signer_mismatch', 'typed_data_not_signable', CONTRACTS_NOT_LIVE])

/**
 * Whether an exit order's signature attempt failed with nothing signed, so its nonce may leave the journal (Changed on
 * purpose (data) 2026-10-02, money/signing review L1, as ./zap.ts signHeld): a definite refusal (4001 and its
 * equivalents), the bounded port's refusal BEFORE it invoked the provider (WalletNotAsked: the window closed, the account
 * or the chain changed, too many calls, the preview lock), or the signer's refusals before any prompt. Any other outcome
 * (the wallet's node failed, a check after the wallet answered, a malformed or foreign signature) may have produced a
 * signature: the nonce stays held, and the person can void it with cancelNonce. @internal
 */
export function signedNothing(error: unknown): boolean {
  return refused(error) || error instanceof WalletNotAsked || (error instanceof Error && SIGNER_BEFORE_PROMPT.has(error.message))
}

export function createAutoExitClient(wallet: V2Wallet, chain: V2Chain, supplied: V2Contracts, now: () => number = () => Date.now() / 1000, random: () => bigint = randomNonce) {
  const contracts = v2ContractsFor(chain, supplied)
  // Changed on purpose (data) 2026-10-02 (Domino V2 integration): every step, signature and batch of this client only with
  // live contracts (./liveLock.ts), refused before any wallet request.
  const t = createTransactor(wallet, chain, now, () => refuseUnlessLive(chain.chainId, contracts))
  const owner = t.owner
  const autoExit = contracts.addresses.autoExit
  const verify = (rpc: Rpc, components: readonly V2Component[]) => verifyComponents(rpc, contracts, components)
  const reviews = new WeakMap<MandateReview, ReviewInternal>()
  const signatures = new WeakMap<MandateReview, { signature: Hex; shape: SignatureShape }>()
  const issued = new WeakMap<PreparedV2, StepOrigin>()
  const sentSteps = new Map<Hex, StepOrigin>()
  /**
   * The steps handed to the wallet whose outcome is not known yet (post-B4 review F2), by hand-over key. Marked right
   * before the shared sender is called; let go only when the wallet was never asked or refused definitely, or once the
   * step's receipt is final (finalized, or reverted: nothing of it ran).
   */
  const handedOver = new Set<string>()
  const issuedBatches = new WeakSet<MandateBatch>()
  const batchOrigins = new WeakMap<MandateBatch, MandateReview>()
  const offeredBatches = new Map<string, { batch: MandateBatch; review: MandateReview }>()
  const view = <T>(at: ReadAt, to: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], onRevert?: string) => viewAt<T>(t, at, to, abi, functionName, args, onRevert)
  const entryOf = (nonce: bigint): SignedNonce => Object.freeze({ chainId: chain.chainId, owner, space: 'autoExit' as const, verifier: autoExit, nonce })
  const nowSeconds = () => BigInt(Math.floor(now()))
  const nonceUsed = (at: ReadAt, nonce: bigint) => view<boolean>(at, autoExit, AUTO_EXIT_ABI, 'nonceUsed', [owner, nonce])

  /** The vault's identity (the factory's), and the wallet must be its owner: the order's owner and signer. */
  async function ownedVault(at: ReadAt, vault: string): Promise<VaultIdentity> {
    const identity = await readVaultIdentity(t, chain, contracts, at, vault)
    if (identity.owner !== owner) return fail('vault_not_owner')
    return identity
  }

  /** The vault's root, or one of its active successors. */
  async function roleOf(at: ReadAt, identity: VaultIdentity, tokenId: unknown): Promise<'root' | 'successor' | null> {
    if (typeof tokenId !== 'bigint' || tokenId <= 0n || tokenId > MAX_UINT256) return null
    if (tokenId === identity.root.tokenId) return 'root'
    const member = await view<{ active: boolean }>(at, identity.vault, VAULT_ABI, 'member', [tokenId])
    return member.active ? 'successor' : null
  }

  /** A random nonce, unused on chain and not held in the page's journal. */
  async function freshNonce(at: ReadAt): Promise<bigint> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const nonce = random()
      if (typeof nonce !== 'bigint' || nonce < 0n || nonce > MAX_UINT256) continue
      if (wallet.signatures.held(entryOf(nonce))) continue
      if (await nonceUsed(at, nonce)) continue
      return nonce
    }
    return fail('mandate_nonce_unavailable')
  }

  const rankOf = (at: ReadAt, token: Address) => view<number>(at, contracts.addresses.registry, REGISTRY_ABI, 'chargeCurrencyRank', [token])

  /** A single-transaction step, with the checks it runs at prepare and again right before the send. */
  async function prepareChecked(rpc: Rpc, origin: Omit<StepOrigin, 'recheck' | 'key'>, components: readonly V2Component[], build: (at: ReadAt) => Promise<{ to: Address; data: Hex; summary: readonly string[]; key: string }>, gas: V2GasBudget | null): Promise<PreparedV2> {
    await t.identity(rpc)
    await verify(rpc, components)
    const draft = await build({ rpc, block: 'latest' })
    // A step handed over whose outcome is not known yet is never prepared again (F2).
    if (handedOver.has(draft.key)) return fail('review_already_sent')
    // `gas` null: the budget is read by the shared sender, through this bounded port, at this review (F8).
    const prepared = await t.prepare(rpc, { kind: origin.kind, to: draft.to, data: draft.data, value: 0n, summary: draft.summary }, gas)
    issued.set(prepared, {
      ...origin,
      key: draft.key,
      recheck: async (again) => {
        await verify(again, components)
        const fresh = await build({ rpc: again, block: 'latest' })
        if (fresh.to !== draft.to || fresh.data !== draft.data) fail('mandate_review_stale')
      },
    })
    return prepared
  }

  /**
   * A signed review's module step and registration, as one batch's calls, derived at `at`: the review turned the module
   * on and it is still off (else `batch_not_needed`: the registration goes on its own), and every check the registration
   * step makes (the nonce unused, the id unknown, still valid, the position still in the vault).
   */
  async function registerBatchCalls(at: ReadAt, review: MandateReview): Promise<BatchCall[]> {
    const internal = reviews.get(review)
    if (!internal) return fail('mandate_review_unknown')
    const signed = signatures.get(review)
    if (!signed) return fail('mandate_not_signed')
    if (!internal.enable) return fail('batch_not_needed')
    const identity = await ownedVault(at, review.vault)
    if (lower(await view<string>(at, identity.vault, VAULT_ABI, 'exitModule')) === autoExit) return fail('batch_not_needed')
    if (await nonceUsed(at, review.mandate.nonce)) return fail('mandate_nonce_used')
    if ((await view<number>(at, autoExit, AUTO_EXIT_ABI, 'mandateStatus', [review.id])) !== 0) return fail('mandate_already_registered')
    const block = await t.latestBlock(at.rpc)
    if (review.mandate.validUntil <= block.timestamp || review.mandate.validUntil <= nowSeconds()) return fail('mandate_invalid: mandate_valid_until')
    if ((await roleOf(at, identity, review.mandate.tokenId)) === null) return fail('mandate_invalid: mandate_position')
    await triggersAhead(at, review)
    return [
      Object.freeze({ to: identity.vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'setExitModule', args: [autoExit] }), value: '0x0' as Hex }),
      Object.freeze({ to: autoExit, data: encodeFunctionData({ abi: AUTO_EXIT_ABI, functionName: 'registerMandate', args: [review.mandate, signed.signature] }), value: '0x0' as Hex }),
    ]
  }
  const batchComponents = (review: MandateReview): readonly V2Component[] => ['autoExit', 'registry', factoryComponent(review.dex)]

  // ----- Auto-exit in one batch (Added on purpose 2026-10-06, the owner's point 5) -----

  const issuedProtect = new WeakSet<ProtectBatch>()
  const protectOrigins = new WeakMap<ProtectBatch, { review: MandateReview; create: VaultCreateRequest }>()
  const offeredProtect = new Map<string, { batch: ProtectBatch; review: MandateReview }>()

  /** Whether the factory of `dex` made `vault`. */
  const madeBy = (at: ReadAt, dex: Dex, vault: Address) => view<boolean>(at, factoryOf(contracts, dex), VAULT_FACTORY_ABI, 'isVault', [vault])

  // ----- The pool's price (Added on purpose 2026-10-06, the review of point 5) -----

  /** One price view's first word, the sqrt price; a refusal, an address with no code or no price is `mandate_price_unavailable`. */
  async function sqrtPriceOf(at: ReadAt, to: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<bigint> {
    let data: Hex
    try {
      data = await t.call(at.rpc, to, encodeFunctionData({ abi, functionName, args }), at.block)
    } catch (error) {
      if (revertIn(error)) return fail('mandate_price_unavailable')
      throw error
    }
    if (data === '0x') return fail('mandate_price_unavailable')
    const [sqrt] = decodeFunctionResult({ abi, functionName, data }) as readonly unknown[]
    return typeof sqrt === 'bigint' && sqrt > 0n && sqrt <= MAX_UINT160 ? sqrt : fail('mandate_price_unavailable')
  }

  /**
   * The pool's sqrt price at `at`, the spot the module's anchor compares (and, on v4 and young v3 pools, the very price
   * the publisher signs): v4 by the chain profile's StateView (`getSlot0(poolId)`), v3 by the pool's own `slot0`.
   */
  function poolPriceAt(at: ReadAt, pool: PricedPool): Promise<bigint> {
    if (pool.dex === 3) return sqrtPriceOf(at, v3PoolAt(chain, pool), V3_POOL_ABI, 'slot0', [])
    if (pool.dex !== 4 || pool.tickSpacing === null) return Promise.reject(new Error('mandate_price_unavailable'))
    const id = keccak256(encodeAbiParameters(POOL_KEY, [{ currency0: pool.currency0, currency1: pool.currency1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks }]))
    return sqrtPriceOf(at, chain.uniswap.v4.stateView, V4_STATE_VIEW_ABI, 'getSlot0', [id])
  }

  /** A position's pool as the chain profile's position manager of its DEX says it (v4 its key, v3 its tokens and tier). */
  async function positionPool(at: ReadAt, dex: Dex, tokenId: bigint): Promise<PricedPool> {
    if (dex !== 3 && dex !== 4) return fail('vault_invalid_dex')
    if (typeof tokenId !== 'bigint' || tokenId <= 0n || tokenId > MAX_UINT256) return fail('vault_invalid_token_id')
    if (dex === 4) {
      const [key] = await view<readonly [{ currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }]>(at, managerOf(chain, 4), V4_POSITION_MANAGER_ABI, 'getPoolAndPositionInfo', [tokenId], 'vault_position_not_found')
      if (key.tickSpacing === 0) return fail('vault_position_not_found')
      return { dex, currency0: lower(key.currency0), currency1: lower(key.currency1), fee: key.fee, tickSpacing: key.tickSpacing, hooks: lower(key.hooks) }
    }
    const row = await view<readonly unknown[]>(at, managerOf(chain, 3), V3_POSITION_MANAGER_ABI, 'positions', [tokenId], 'vault_position_not_found')
    return { dex, currency0: lower(row[2] as string), currency1: lower(row[3] as string), fee: Number(row[4]), tickSpacing: null, hooks: ZERO_ADDRESS }
  }

  /** A review's armed triggers still ahead of the pool's price at `at` (else `mandate_trigger_reached`): right before each send. */
  async function triggersAhead(at: ReadAt, review: MandateReview): Promise<void> {
    if (triggerReached(review.mandate, await poolPriceAt(at, review.pool))) fail('mandate_invalid: mandate_trigger_reached')
  }

  /**
   * The vault a predicted review was signed for, still as it was: not created yet, the factory's nonce for the wallet
   * unmoved and its prediction the same (else `vault_nonce_moved`: another vault of this wallet landed first, review
   * again); or created since by the wallet's own steps, the wallet's, with the order's position as its root.
   */
  async function predictedStill(at: ReadAt, review: MandateReview): Promise<'free' | 'created'> {
    const predicted = review.predicted
    if (!predicted) return fail('mandate_review_unknown')
    const nonce = await view<bigint>(at, predicted.factory, VAULT_FACTORY_ABI, 'nextNonce', [owner])
    const vault = lower(await view<string>(at, predicted.factory, VAULT_FACTORY_ABI, 'predictVault', [owner, nonce]))
    if (nonce === predicted.nonce && vault === review.vault) return 'free'
    // The factory moved past the prediction: the wallet's own steps created this very vault, or another one landed first.
    if (await madeBy(at, review.dex, review.vault)) {
      const identity = await readVaultIdentity(t, chain, contracts, at, review.vault)
      if (identity.owner === owner && identity.root.tokenId === review.mandate.tokenId) return 'created'
    }
    return fail('vault_nonce_moved')
  }

  /**
   * A predicted review's whole activation as one batch's calls, derived at `at`: the protection-only vault's approval
   * (when missing) and creation exactly as the vault client derives them, for the vault the order was signed for, then
   * the module and the registration, with every check the registration step makes (the nonce unused, the id unknown,
   * still valid). A vault created since is `batch_not_needed` (its own module step and registration go instead).
   */
  async function protectBatchCalls(at: ReadAt, review: MandateReview, create: VaultCreateRequest): Promise<{ kinds: ProtectBatch['kinds'][number][]; calls: BatchCall[]; vault: Address; factory: Address; nonce: bigint }> {
    const internal = reviews.get(review)
    if (!internal) return fail('mandate_review_unknown')
    const signed = signatures.get(review)
    if (!signed) return fail('mandate_not_signed')
    if (!review.predicted) return fail('batch_not_needed')
    if (!protectionOnly(create) || create.dex !== review.dex || create.tokenId !== review.mandate.tokenId) return fail('vault_invalid_request')
    if ((await predictedStill(at, review)) === 'created') return fail('batch_not_needed')
    const creation = await vaultCreation(t, chain, contracts, at, create)
    if (creation.vault !== review.vault || creation.nonce !== review.predicted.nonce || creation.factory !== review.predicted.factory) return fail('vault_nonce_moved')
    if (await nonceUsed(at, review.mandate.nonce)) return fail('mandate_nonce_used')
    if ((await view<number>(at, autoExit, AUTO_EXIT_ABI, 'mandateStatus', [review.id])) !== 0) return fail('mandate_already_registered')
    const block = await t.latestBlock(at.rpc)
    if (review.mandate.validUntil <= block.timestamp || review.mandate.validUntil <= nowSeconds()) return fail('mandate_invalid: mandate_valid_until')
    await triggersAhead(at, review)
    const kinds: ProtectBatch['kinds'][number][] = []
    const calls: BatchCall[] = []
    for (const step of creation.steps) {
      kinds.push(step.kind as Extract<VaultStepKind, 'approve-root' | 'create-vault'>)
      calls.push(Object.freeze({ to: step.to, data: step.data, value: '0x0' as Hex }))
    }
    kinds.push('enable-exit-module', 'register-mandate')
    calls.push(
      Object.freeze({ to: creation.vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'setExitModule', args: [autoExit] }), value: '0x0' as Hex }),
      Object.freeze({ to: autoExit, data: encodeFunctionData({ abi: AUTO_EXIT_ABI, functionName: 'registerMandate', args: [review.mandate, signed.signature] }), value: '0x0' as Hex }),
    )
    return { kinds, calls, vault: creation.vault, factory: creation.factory, nonce: creation.nonce }
  }

  return {
    chain,
    contracts,
    owner,

    /**
     * Added 2026-10-06 (the review of point 5): where the pool of position `tokenId` stands now, the price an Auto-exit's
     * edges are chosen against (src/v2in/autoexit/form.ts exitEdges): the position's pool from the chain profile's
     * position manager of its DEX (v4 `getPoolAndPositionInfo`, v3 `positions`), then its sqrt price (v4 StateView
     * `getSlot0`, v3 the pool's `slot0`), at one block through the wallet's own provider. Reads only.
     */
    readPoolPrice: (dex: Dex, tokenId: bigint) => t.bounded(async (rpc): Promise<V2Snapshot & { sqrtPriceX96: bigint }> => {
      await t.identity(rpc)
      const { at, snapshot } = await pinBlock(t, rpc)
      const pool = await positionPool(at, dex, tokenId)
      return Object.freeze({ ...snapshot, sqrtPriceX96: await poolPriceAt(at, pool) })
    }),

    /**
     * What the connected wallet can do with an EIP-5792 batch on this chain (finance/batch.ts atomicStatus, through the
     * wallet's own provider): 'supported' or 'ready' offers the module step and the registration as one batch. Reads only.
     */
    atomicSupport: () => t.bounded(async (rpc): Promise<AtomicStatus> => {
      await t.identity(rpc)
      return atomicStatus({ owner, request: (method, params) => rpc(method, params) }, 5_000, chain.chainId)
    }),

    /**
     * A SIGNED review's `[setExitModule(autoExit), registerMandate(mandate, signature)]` as ONE batch (spec §4.4 item 7),
     * derived at the latest block and simulated whole through the wallet's eth_simulateV1 only (a wallet without it is
     * `batch_simulation_unavailable`: the steps instead), its cost checked against the budget and the owner's ETH.
     */
    prepareRegisterBatch: (review: MandateReview, gas: V2GasBudget | null = null) => t.bounded(async (rpc): Promise<MandateBatch> => {
      if (!reviews.has(review)) return fail('mandate_review_unknown')
      if (gas) checkBatchBudget(gas)
      await t.identity(rpc)
      // Nothing of this owner in flight on this chain, as before a step (post-B4 review item 3, V1 setup's rule).
      await t.freeNonce(rpc)
      await verify(rpc, batchComponents(review))
      const calls = await registerBatchCalls({ rpc, block: 'latest' }, review)
      // `gas` null: the budget read here, through this bounded port; Base's L1 data fee ceiling in the cost (F8, F5).
      const { gasUsed, networkFeeWei } = await simulateV2Batch(rpc, chain, owner, calls, gas)
      const batch: MandateBatch = Object.freeze({
        chainId: chain.chainId,
        owner,
        key: review.id,
        id: review.id,
        vault: review.vault,
        kinds: Object.freeze(['enable-exit-module', 'register-mandate'] as const),
        calls: Object.freeze(calls),
        gasUsed,
        networkFeeWei,
        expiresAt: now() + REVIEW_S,
      }) as MandateBatch
      issuedBatches.add(batch)
      batchOrigins.set(batch, review)
      return batch
    }),

    /**
     * Offers a prepared registration batch to the wallet once, behind the page's latch for this order's id (on this
     * chain's latch): the calls derived again and simulated again, `eth_chainId` read right before the wallet, never
     * offered twice. The wallet's id for the batch.
     */
    sendRegisterBatch: async (batch: MandateBatch, acknowledged: boolean, latchFor: (chainId: V2ChainId, owner: Address) => V2BatchLatch = browserV2BatchLatch): Promise<string> => {
      refuseUnlessLive(chain.chainId, contracts)
      const review = batchOrigins.get(batch)
      if (!acknowledged || !review || !issuedBatches.has(batch) || batch.expiresAt <= now() || batch.owner !== owner || batch.chainId !== chain.chainId) return fail('wallet_review_required')
      const latch = latchFor(chain.chainId, owner)
      if (latch.batchOffered(batch.key) !== null && !(await latch.expireBatch(batch.key, V2_BATCH_LATCH_EXPIRY_S))) return fail('batch_already_offered')
      return t.bounded(async (rpc) => {
        await t.identity(rpc)
        await t.freeNonce(rpc)
        await verify(rpc, batchComponents(review))
        const calls = await registerBatchCalls({ rpc, block: 'latest' }, review)
        if (calls.length !== batch.calls.length || calls.some((call, i) => call.to !== batch.calls[i].to || call.data !== batch.calls[i].data)) fail('mandate_review_stale')
        await simulateBatch((method, params) => rpc(method, params), owner, batch.calls)
        if (batch.expiresAt <= now()) fail('wallet_review_expired')
        // Immediately before the wallet is asked: the same chain, still (spec §1.3).
        if (quantity(await rpc('eth_chainId', [])) !== BigInt(chain.chainId)) fail('wallet_wrong_chain')
        issuedBatches.delete(batch)
        const id = await offerV2Batch(rpc, owner, chain.chainId, latch, batch.key, batch.calls, () => wallet.current() && wallet.chainId() === chain.chainId && batch.expiresAt > now())
        offeredBatches.set(id, { batch, review })
        return id
      }, SIGN_WINDOW_S)
    },

    /**
     * Where a registration batch this client offered stands: the wallet's status while it knows it (100 pending; 400 or
     * 500: nothing of it ran, its latch let go), then the chain: the transaction carrying this order's
     * `MandateRegistered`, from the review's block, and its receipt, "included" then "finalized", with the module's and
     * the vault's events. Once it ran its latch is let go, and once finalized the order's nonce leaves the journal.
     */
    registerBatchReceipt: (id: string, latchFor: (chainId: V2ChainId, owner: Address) => V2BatchLatch = browserV2BatchLatch) => t.bounded(async (rpc): Promise<V2BatchReceipt> => {
      const known = offeredBatches.get(id)
      if (!known) return fail('receipt_not_from_this_review')
      const { batch, review } = known
      await t.identity(rpc)
      const latch = latchFor(chain.chainId, owner)
      const none: readonly V2Event[] = Object.freeze([])
      const status = await batchCallsStatus((method, params) => rpc(method, params), id)
      if (status !== null && status >= 100 && status < 200) return { state: 'pending', events: none }
      if (status === 400 || status === 500) {
        await latch.releaseBatch(batch.key, id)
        return { state: status === 400 ? 'not-included' : 'batch-reverted', events: none }
      }
      const topics = (encodeEventTopics({ abi: AUTO_EXIT_ABI, eventName: 'MandateRegistered', args: { mandateHash: review.id } } as Parameters<typeof encodeEventTopics>[0]) as (Hex | null)[]).slice(0, 2)
      const hash = await transactionWithLog(rpc, autoExit, topics, review.snapshot.blockNumber)
      if (hash === null) return { state: 'pending', events: none }
      const receipt = await receiptOfBatch(rpc, chain, hash, (logs) => logs.some((log) => log.address === autoExit && log.topics[0] === topics[0] && log.topics[1] === review.id))
      if (receipt.state === 'pending' || receipt.state === 'reorged') return { ...receipt, events: none }
      await latch.releaseBatch(batch.key, id)
      if (receipt.state === 'reverted') return { ...receipt, events: none }
      // A finalized registration used the nonce for good: the journal lets it go, as the step path's receipt does.
      if (receipt.state === 'finalized') await wallet.signatures.forget(entryOf(review.mandate.nonce))
      return { ...receipt, events: decodeEvents(receipt.logs, [{ address: autoExit, abi: AUTO_EXIT_EVENTS_ABI }, { address: review.vault, abi: VAULT_EVENTS_ABI }]) }
    }),

    /**
     * Added 2026-10-06 (the owner's point 5: Auto-exit as a signature plus ONE confirmation). A SIGNED predicted review's
     * whole activation as ONE batch (ProtectBatch): the protection-only vault (`create`: paused, mode 1, one position, the
     * consent; anything else is `vault_invalid_request`), derived at the latest block by the vault client's own code for
     * the vault the order names, then the module and the registration; simulated whole through the wallet's
     * eth_simulateV1 only (a wallet without it is `batch_simulation_unavailable`: the same calls one by one instead), its
     * cost checked against the budget and the owner's ETH. Reads only.
     */
    prepareProtectBatch: (review: MandateReview, create: VaultCreateRequest, gas: V2GasBudget | null = null) => t.bounded(async (rpc): Promise<ProtectBatch> => {
      if (!reviews.has(review)) return fail('mandate_review_unknown')
      if (gas) checkBatchBudget(gas)
      await t.identity(rpc)
      // Nothing of this owner in flight on this chain, as before a step (post-B4 review item 3, V1 setup's rule).
      await t.freeNonce(rpc)
      await verify(rpc, batchComponents(review))
      const derived = await protectBatchCalls({ rpc, block: 'latest' }, review, create)
      // `gas` null: the budget read here, through this bounded port; Base's L1 data fee ceiling in the cost (F8, F5).
      const { gasUsed, networkFeeWei } = await simulateV2Batch(rpc, chain, owner, derived.calls, gas)
      const batch: ProtectBatch = Object.freeze({
        chainId: chain.chainId,
        owner,
        key: vaultBatchKey(chain.chainId, derived.factory, owner, derived.nonce),
        id: review.id,
        vault: derived.vault,
        factory: derived.factory,
        nonce: derived.nonce,
        kinds: Object.freeze(derived.kinds),
        calls: Object.freeze(derived.calls),
        gasUsed,
        networkFeeWei,
        expiresAt: now() + REVIEW_S,
      })
      issuedProtect.add(batch)
      protectOrigins.set(batch, { review, create })
      return batch
    }),

    /**
     * Offers a prepared ProtectBatch to the wallet once, behind the page's latch for the owner's factory nonce (the vault
     * creation batch's key), the latches of earlier nonces let go first as the vault client does: the calls derived again
     * and simulated again, `eth_chainId` read right before the wallet, never offered twice. The wallet's id for the batch.
     */
    sendProtectBatch: async (batch: ProtectBatch, acknowledged: boolean, latchFor: (chainId: V2ChainId, owner: Address) => V2BatchLatch = browserV2BatchLatch): Promise<string> => {
      refuseUnlessLive(chain.chainId, contracts)
      const origin = protectOrigins.get(batch)
      if (!acknowledged || !origin || !issuedProtect.has(batch) || batch.expiresAt <= now() || batch.owner !== owner || batch.chainId !== chain.chainId) return fail('wallet_review_required')
      const latch = latchFor(chain.chainId, owner)
      for (let n = batch.nonce > 4n ? batch.nonce - 4n : 0n; n < batch.nonce; n++) await settleBatchLatch(latch, vaultBatchKey(chain.chainId, batch.factory, owner, n))
      if (latch.batchOffered(batch.key) !== null && !(await latch.expireBatch(batch.key, V2_BATCH_LATCH_EXPIRY_S))) return fail('batch_already_offered')
      return t.bounded(async (rpc) => {
        await t.identity(rpc)
        await t.freeNonce(rpc)
        await verify(rpc, batchComponents(origin.review))
        const { calls } = await protectBatchCalls({ rpc, block: 'latest' }, origin.review, origin.create)
        if (calls.length !== batch.calls.length || calls.some((call, i) => call.to !== batch.calls[i].to || call.data !== batch.calls[i].data)) fail('mandate_review_stale')
        await simulateBatch((method, params) => rpc(method, params), owner, batch.calls)
        if (batch.expiresAt <= now()) fail('wallet_review_expired')
        // Immediately before the wallet is asked: the same chain, still (spec §1.3).
        if (quantity(await rpc('eth_chainId', [])) !== BigInt(chain.chainId)) fail('wallet_wrong_chain')
        issuedProtect.delete(batch)
        const id = await offerV2Batch(rpc, owner, chain.chainId, latch, batch.key, batch.calls, () => wallet.current() && wallet.chainId() === chain.chainId && batch.expiresAt > now())
        offeredProtect.set(id, { batch, review: origin.review })
        return id
      }, SIGN_WINDOW_S)
    },

    /**
     * Where a ProtectBatch this client offered stands: the wallet's status while it knows it (100 pending; 400 or 500:
     * nothing of it ran, its latch let go), then the chain: the one transaction carrying both this owner's
     * `VaultCreated` for the vault and this order's `MandateRegistered`, from the review's block, "included" then
     * "finalized", with the factory's, the vault's and the module's events. Once it ran its latch is let go, and once
     * finalized the order's nonce leaves the journal.
     */
    protectBatchReceipt: (id: string, latchFor: (chainId: V2ChainId, owner: Address) => V2BatchLatch = browserV2BatchLatch) => t.bounded(async (rpc): Promise<V2BatchReceipt> => {
      const known = offeredProtect.get(id)
      if (!known) return fail('receipt_not_from_this_review')
      const { batch, review } = known
      await t.identity(rpc)
      const latch = latchFor(chain.chainId, owner)
      const none: readonly V2Event[] = Object.freeze([])
      const status = await batchCallsStatus((method, params) => rpc(method, params), id)
      if (status !== null && status >= 100 && status < 200) return { state: 'pending', events: none }
      if (status === 400 || status === 500) {
        await latch.releaseBatch(batch.key, id)
        return { state: status === 400 ? 'not-included' : 'batch-reverted', events: none }
      }
      const registered = (encodeEventTopics({ abi: AUTO_EXIT_ABI, eventName: 'MandateRegistered', args: { mandateHash: review.id } } as Parameters<typeof encodeEventTopics>[0]) as (Hex | null)[]).slice(0, 2)
      const created = (encodeEventTopics({ abi: VAULT_FACTORY_ABI, eventName: 'VaultCreated', args: { owner, vault: batch.vault } } as Parameters<typeof encodeEventTopics>[0]) as (Hex | null)[]).slice(0, 3)
      const hash = await transactionWithLog(rpc, autoExit, registered, review.snapshot.blockNumber)
      if (hash === null) return { state: 'pending', events: none }
      const receipt = await receiptOfBatch(rpc, chain, hash, (logs) =>
        logs.some((log) => log.address === autoExit && log.topics[0] === registered[0] && log.topics[1] === review.id)
        && logs.some((log) => log.address === batch.factory && log.topics[0] === created[0] && log.topics[2] === created[2]))
      if (receipt.state === 'pending' || receipt.state === 'reorged') return { ...receipt, events: none }
      await latch.releaseBatch(batch.key, id)
      if (receipt.state === 'reverted') return { ...receipt, events: none }
      // A finalized registration used the nonce for good: the journal lets it go, as the step path's receipt does.
      if (receipt.state === 'finalized') await wallet.signatures.forget(entryOf(review.mandate.nonce))
      return { ...receipt, events: decodeEvents(receipt.logs, [{ address: batch.factory, abi: VAULT_FACTORY_EVENTS_ABI }, { address: batch.vault, abi: VAULT_EVENTS_ABI }, { address: autoExit, abi: AUTO_EXIT_EVENTS_ABI }]) }
    }),

    /**
     * Reviews an exit order (spec §4.1, §4.2, §4.4): the vault is the factory's and the wallet's, the position its root or
     * an active successor, every term of §4.2 valid, the warnings acknowledged; a fresh random nonce is chosen. The
     * steps: turning the module on (only when the vault's module is not the manifest's auto-exit), the signature, the
     * registration. Reads only, at one block; nothing is signed or recorded yet.
     *
     * Changed on purpose 2026-10-06 (the owner's point 5: Auto-exit as one signature and one batch): with
     * `request.newVault`, the vault may be the one this wallet's next `createVault` makes, not created yet: it must be
     * exactly `predictVault(owner, nextNonce(owner))` on that DEX's factory, still free, for `tokenId` as its root, held by
     * the wallet (the vault client's own reads, ./vault.ts newVaultRoot). Its steps are then the signature, the module and
     * the registration, the last two once the vault exists (or in the same batch that creates it, prepareProtectBatch).
     *
     * Changed on purpose 2026-10-06 (the review of point 5): the pool's own price is read at the review's block, and an
     * armed trigger it has reached is refused (`mandate_trigger_reached`); the review carries that price.
     */
    reviewMandate: (input: MandateRequest) => t.bounded(async (rpc): Promise<MandateReview> => {
      if (!input || typeof input !== 'object') return fail('mandate_invalid_request')
      // A frozen copy, taken before any read: what is checked is exactly what is signed, whatever the caller's object
      // does while the reads are in flight.
      let request: MandateRequest
      try {
        request = Object.freeze(structuredClone(input))
      } catch {
        return fail('mandate_invalid_request')
      }
      await t.identity(rpc)
      const { at, snapshot } = await pinBlock(t, rpc)
      const fresh = request.newVault !== undefined ? request.newVault : null
      if (fresh !== null && (!fresh || (fresh.dex !== 3 && fresh.dex !== 4))) return fail('vault_invalid_dex')
      if (!isAddress(request.vault)) return fail('vault_invalid_address')
      const asked = request.vault.toLowerCase() as Address
      // A vault not created yet, while it is not: the wallet's next one on that factory, for this position as its root.
      const root = fresh !== null && !(await madeBy(at, fresh.dex, asked)) ? await newVaultRoot(t, chain, contracts, at, fresh.dex, request.tokenId) : null
      if (root && root.vault !== asked) return fail('vault_nonce_moved')
      const identity = root ? null : await ownedVault(at, asked)
      // Created since: this wallet's vault for this very position, or another of its vaults took the prediction.
      if (fresh !== null && identity && identity.root.tokenId !== request.tokenId) return fail('vault_nonce_moved')
      const vault = root ? root.vault : (identity as VaultIdentity).vault
      const dex = root ? root.dex : (identity as VaultIdentity).dex
      const pool: MandateReview['pool'] = root ? Object.freeze({ dex: root.dex, ...root.pool }) : (identity as VaultIdentity).pool
      const role = root ? 'root' as const : await roleOf(at, identity as VaultIdentity, request.tokenId)
      const ceiling = await view<number>(at, autoExit, AUTO_EXIT_ABI, 'MAX_SLIPPAGE_BPS')
      const time = snapshot.blockTimestamp > nowSeconds() ? snapshot.blockTimestamp : nowSeconds()
      // Changed on purpose 2026-10-06 (the review of point 5): the pool's own price at this block, which no armed trigger
      // may have reached.
      const sqrtPriceX96 = await poolPriceAt(at, pool)
      const problems = mandateProblems(request, { now: time, pool, maxSlippageBps: ceiling, inVault: role !== null, sqrtPriceX96 })
      if (problems.length || role === null) return fail(`mandate_invalid: ${problems.join(' ')}`)
      const nonce = await freshNonce(at)
      const mandate: ExitMandate = Object.freeze({
        owner,
        vault,
        tokenId: request.tokenId,
        triggerBelowSqrtPriceX96: request.triggerBelowSqrtPriceX96,
        triggerAboveSqrtPriceX96: request.triggerAboveSqrtPriceX96,
        receiveMode: request.receiveMode,
        convertTo: request.convertTo.toLowerCase() as Address,
        maxSlippageBps: request.maxSlippageBps,
        validUntil: request.validUntil,
        nonce,
      })
      const typedData = exitMandateTypedData(chain.chainId, autoExit, mandate)
      const rank0 = await rankOf(at, pool.currency0)
      const rank1 = await rankOf(at, pool.currency1)
      // A vault not created yet starts with no module: it is turned on in the batch that creates it, or right after.
      const enable = root ? true : lower(await view<string>(at, vault, VAULT_ABI, 'exitModule')) !== autoExit
      const steps: { kind: MandateStepKind; summary: readonly string[] }[] = []
      const enableStep = Object.freeze({ kind: 'enable-exit-module' as const, summary: Object.freeze(['Turn on Auto-exit for this position.']) })
      if (enable && !root) steps.push(enableStep)
      steps.push(Object.freeze({ kind: 'sign-mandate' as const, summary: Object.freeze(['Sign your Auto-exit in your wallet.']) }))
      if (root) steps.push(enableStep)
      steps.push(Object.freeze({ kind: 'register-mandate' as const, summary: Object.freeze([`Register Auto-exit for position #${request.tokenId}.`]) }))
      const review: MandateReview = Object.freeze({
        kind: 'mandate',
        chainId: chain.chainId,
        owner,
        autoExit,
        vault,
        dex,
        pool,
        role,
        predicted: root ? Object.freeze({ factory: root.factory, nonce: root.nonce }) : null,
        sqrtPriceX96,
        mandate,
        id: mandateId(mandate),
        digest: typedDataDigest(typedData),
        typedData,
        receive: mandate.receiveMode === RECEIVE_MODE.converted ? Object.freeze({ mode: 'converted' as const, token: mandate.convertTo }) : Object.freeze({ mode: 'both' as const }),
        feeRule: Object.freeze(autoExitFeeRule(mandate.receiveMode, mandate.convertTo, pool, rank0, rank1)),
        warnings: autoExitWarnings(dex),
        steps: Object.freeze(steps),
        snapshot,
      })
      reviews.set(review, { enable })
      return review
    }),

    /**
     * Signs a review's order, once (spec §4.2, §4.4): the nonce still unused and not held, the wallet's account code read
     * on THIS chain (a plain account signs ECDSA with a low s, checked here; a delegated or contract account is verified
     * by the module through EIP-1271), the nonce recorded in the journal BEFORE the prompt, and forgotten only when nothing
     * was signed (signedNothing: a definite refusal, or a refusal before the prompt). The signature is bound to this
     * review for its registration.
     */
    signMandate: (review: MandateReview) => {
      // Before the journal entry and any wallet request (./liveLock.ts): a refusal here signed nothing.
      try {
        refuseUnlessLive(chain.chainId, contracts)
      } catch (error) {
        return Promise.reject(error)
      }
      return t.bounded(async (rpc) => {
      const internal = reviews.get(review)
      if (!internal) return fail('mandate_review_unknown')
      if (signatures.has(review)) return fail('mandate_already_signed')
      await t.identity(rpc)
      const entry = entryOf(review.mandate.nonce)
      if (wallet.signatures.held(entry)) return fail('mandate_nonce_held')
      // The order names the manifest's module as its verifier: its code is checked before anything is signed for it.
      await verify(rpc, ['autoExit', 'registry', factoryComponent(review.dex)])
      const latest: ReadAt = { rpc, block: 'latest' }
      if (await nonceUsed(latest, review.mandate.nonce)) return fail('mandate_nonce_used')
      // Changed on purpose 2026-10-06 (the owner's point 5): an order signed for the vault the wallet's next createVault
      // makes needs that prediction to still hold (or the vault created since, the wallet's, with this root).
      if (review.predicted) await predictedStill(latest, review)
      else await ownedVault(latest, review.vault)
      const block = await t.latestBlock(rpc)
      if (review.mandate.validUntil <= block.timestamp || review.mandate.validUntil <= nowSeconds()) return fail('mandate_invalid: mandate_valid_until')
      // Changed on purpose 2026-10-06 (the review of point 5): nothing is signed for an edge the price has reached since.
      await triggersAhead(latest, review)
      // What is signed is built again from the review's frozen mandate, never taken from an object a caller could change.
      const typedData = exitMandateTypedData(chain.chainId, autoExit, review.mandate)
      if (typedDataDigest(typedData) !== review.digest || mandateId(review.mandate) !== review.id) return fail('mandate_review_stale')
      const account = await readAccountCode(rpc, owner, 'latest')
      const shape: SignatureShape = account.kind === 'plain' ? 'ecdsa-low-s' : 'contract'
      await wallet.signatures.record(entry)
      let signed
      try {
        signed = await signV2TypedData({ owner, current: () => wallet.current(), request: (method, params) => rpc(method, params) }, typedData, { chainId: chain.chainId, signer: owner, shape })
      } catch (error) {
        // Nothing signed (a definite refusal, or a refusal before the prompt): the nonce leaves the journal, and no
        // cancelNonce (a paid transaction) is ever offered for it. Any other outcome keeps it held (review L1).
        if (signedNothing(error)) await wallet.signatures.forget(entry)
        throw error
      }
      if (signed.digest !== review.digest) return fail('mandate_signature_mismatch')
      signatures.set(review, Object.freeze({ signature: signed.signature, shape }))
      return Object.freeze({ signature: signed.signature, digest: signed.digest, shape })
    }, SIGN_WINDOW_S)
    },

    /**
     * A transaction step of a review, prepared for the wallet after the deployment's code check and the step's checks
     * at the latest block: turning the module on (only while it is not), or registering the SIGNED order (its nonce
     * unused, its id unknown, still valid, the position still in the vault, the module on when the review turned it on).
     */
    prepareStep: (review: MandateReview, index: number, gas: V2GasBudget | null = null) => t.bounded(async (rpc): Promise<PreparedV2> => {
      const internal = reviews.get(review)
      if (!internal) return fail('mandate_review_unknown')
      if (!Number.isInteger(index) || index < 0 || index >= review.steps.length) return fail('mandate_step_unknown')
      const kind = review.steps[index].kind
      const components: readonly V2Component[] = ['autoExit', 'registry', factoryComponent(review.dex)]
      if (kind === 'sign-mandate') return fail('mandate_step_is_signature')
      if (kind === 'enable-exit-module') {
        return prepareChecked(rpc, { kind, vault: review.vault }, components, async (at) => {
          const identity = await ownedVault(at, review.vault)
          if (lower(await view<string>(at, identity.vault, VAULT_ABI, 'exitModule')) === autoExit) fail('mandate_step_not_needed')
          const stateNonce = await view<bigint>(at, identity.vault, VAULT_ABI, 'stateNonce')
          return { to: identity.vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'setExitModule', args: [autoExit] }), summary: review.steps[index].summary, key: `enable|${identity.vault}|${stateNonce}` }
        }, gas)
      }
      const signed = signatures.get(review)
      if (!signed) return fail('mandate_not_signed')
      const entry = entryOf(review.mandate.nonce)
      return prepareChecked(rpc, { kind, vault: review.vault, nonce: entry }, components, async (at) => {
        const identity = await ownedVault(at, review.vault)
        if (internal.enable && lower(await view<string>(at, identity.vault, VAULT_ABI, 'exitModule')) !== autoExit) fail('mandate_module_not_enabled')
        if (await nonceUsed(at, review.mandate.nonce)) {
          // Used at the latest block: refuse to go on. The journal lets the nonce go only once a FINALIZED block shows it
          // used (a registration still in an unfinalized block can be reorged out, leaving a valid signature behind).
          if (await nonceUsed({ rpc: at.rpc, block: 'finalized' as Hex }, review.mandate.nonce)) await wallet.signatures.forget(entry)
          fail('mandate_nonce_used')
        }
        if ((await view<number>(at, autoExit, AUTO_EXIT_ABI, 'mandateStatus', [review.id])) !== 0) fail('mandate_already_registered')
        const block = await t.latestBlock(at.rpc)
        if (review.mandate.validUntil <= block.timestamp || review.mandate.validUntil <= nowSeconds()) fail('mandate_invalid: mandate_valid_until')
        if ((await roleOf(at, identity, review.mandate.tokenId)) === null) fail('mandate_invalid: mandate_position')
        // Changed on purpose 2026-10-06 (the review of point 5): at the prepare and again right before the send.
        await triggersAhead(at, review)
        return {
          to: autoExit,
          data: encodeFunctionData({ abi: AUTO_EXIT_ABI, functionName: 'registerMandate', args: [review.mandate, signed.signature] }),
          summary: review.steps[index].summary,
          key: `register|${review.id}`,
        }
      }, gas)
    }),

    /** Offers a prepared step once (shared sender), after its checks run again at the latest block. */
    send: async (prepared: PreparedV2, acknowledged: boolean): Promise<Hex> => {
      refuseUnlessLive(chain.chainId, contracts)
      const origin = issued.get(prepared)
      if (!origin) return fail('wallet_review_required')
      // The very step already offered is the shared sender's refusal (never sent twice); another review's is this one's.
      if (handedOver.has(origin.key)) return fail(t.wasOffered(prepared) ? 'wallet_review_required' : 'review_already_sent')
      handedOver.add(origin.key)
      let hash: Hex
      try {
        hash = await t.send(prepared, acknowledged, origin.recheck)
      } catch (error) {
        if (refused(error) || !t.wasOffered(prepared)) handedOver.delete(origin.key)
        throw error
      }
      sentSteps.set(hash, origin)
      return hash
    },

    /** Whether a prepared step was handed to the wallet (its outcome is then the chain's to say; it is never offered again). */
    wasOffered: (prepared: PreparedV2): boolean => t.wasOffered(prepared),

    /**
     * Where a step this client sent stands, with the module's and the vault's events decoded. A registration or a
     * cancelled nonce, once finalized, releases its nonce from the journal (the chain now says it is used).
     */
    receipt: async (hash: Hex): Promise<AutoExitReceipt> => {
      const receipt = await t.receipt(hash)
      const origin = sentSteps.get(hash)
      // Final: what the step did (or that it reverted, doing nothing) is known for good.
      if (origin && (receipt.state === 'finalized' || receipt.state === 'reverted')) handedOver.delete(origin.key)
      if (receipt.state === 'pending' || receipt.state === 'reorged' || !origin) return { ...receipt, events: Object.freeze([]) }
      // Decoded with what each contract itself declares (./implementations.ts), so every event a step emits is said.
      const sources: { address: Address; abi: Abi }[] = [{ address: autoExit, abi: AUTO_EXIT_EVENTS_ABI }]
      if (origin.vault) sources.push({ address: origin.vault, abi: VAULT_EVENTS_ABI })
      const events = decodeEvents(receipt.logs, sources)
      if (receipt.state === 'finalized' && origin.nonce) await wallet.signatures.forget(origin.nonce)
      return { ...receipt, events }
    },

    /** An order's status and spec §4.5's conditions, at one block. Reads only. */
    status: (id: Hex) => t.bounded(async (rpc): Promise<MandateStatusView> => {
      if (typeof id !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(id)) return fail('mandate_invalid_id')
      await t.identity(rpc)
      const { at, snapshot } = await pinBlock(t, rpc)
      const code = await view<number>(at, autoExit, AUTO_EXIT_ABI, 'mandateStatus', [id])
      const status = STATUS_NAMES[code] ?? fail('invalid_wallet_reply')
      const halted = await view<boolean>(at, contracts.addresses.registry, REGISTRY_ABI, 'automationHalted')
      const failing: AutoExitTextKey[] = []
      if (status === 'unknown') {
        failing.push('mandate_status_unknown')
        if (halted) failing.push('mandate_halted')
        return Object.freeze({ ...snapshot, id: id.toLowerCase() as Hex, status, record: null, expired: false, checks: Object.freeze({ active: false, moduleEnabled: null, ownerUnchanged: null, position: null, notHalted: !halted }), failing: Object.freeze(failing), canFire: false, ownedByWallet: false })
      }
      const raw = await view<MandateRecord>(at, autoExit, AUTO_EXIT_ABI, 'mandateOf', [id])
      const record: MandateRecord = Object.freeze({ ...raw, owner: lower(raw.owner), vault: lower(raw.vault), convertTo: lower(raw.convertTo) })
      const expired = status === 'active' && snapshot.blockTimestamp > record.validUntil
      if (status === 'revoked') failing.push('mandate_status_revoked')
      if (status === 'executed') failing.push('mandate_status_executed')
      if (expired) failing.push('mandate_status_expired')
      let moduleEnabled: boolean | null = null
      let ownerUnchanged: boolean | null = null
      let position: boolean | null = null
      let identity: VaultIdentity | null = null
      try {
        identity = await readVaultIdentity(t, chain, contracts, at, record.vault)
      } catch (error) {
        if (!(error instanceof Error) || (error.message !== 'vault_unknown' && error.message !== 'vault_identity_mismatch')) throw error
        failing.push('mandate_vault_unknown')
      }
      if (identity) {
        moduleEnabled = lower(await view<string>(at, identity.vault, VAULT_ABI, 'exitModule')) === autoExit
        if (!moduleEnabled) failing.push('mandate_module_off')
        ownerUnchanged = identity.owner === record.owner
        if (!ownerUnchanged) failing.push('mandate_owner_changed')
        if (record.tokenId === identity.root.tokenId) {
          let holder: Address | null = null
          let approved: Address | null = null
          try {
            holder = lower(await view<string>(at, managerOf(chain, identity.dex), managerAbi(identity.dex), 'ownerOf', [record.tokenId]))
            approved = lower(await view<string>(at, managerOf(chain, identity.dex), managerAbi(identity.dex), 'getApproved', [record.tokenId]))
          } catch (error) {
            // Only the manager's refusal (a burned root has no owner) means custody is gone; a wallet failure is thrown.
            if (!revertIn(error)) throw error
          }
          position = holder === record.owner && approved === identity.vault
          if (!position) failing.push('mandate_root_custody_lost')
        } else {
          position = (await view<{ active: boolean }>(at, identity.vault, VAULT_ABI, 'member', [record.tokenId])).active
          if (!position) failing.push('mandate_successor_inactive')
        }
      }
      if (halted) failing.push('mandate_halted')
      return Object.freeze({
        ...snapshot,
        id: id.toLowerCase() as Hex,
        status,
        record,
        expired,
        checks: Object.freeze({ active: status === 'active' && !expired, moduleEnabled, ownerUnchanged, position, notHalted: !halted }),
        failing: Object.freeze(failing),
        canFire: status === 'active' && failing.length === 0,
        ownedByWallet: record.owner === owner,
      })
    }),

    /** Cancels an ACTIVE order of this owner (spec §4.5 "Cancel order"): at any time, halted, module off or expired. */
    prepareRevoke: (id: Hex, gas: V2GasBudget | null = null) => t.bounded(async (rpc) => {
      if (typeof id !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(id)) return fail('mandate_invalid_id')
      const hash = id.toLowerCase() as Hex
      return prepareChecked(rpc, { kind: 'revoke-mandate' }, ['autoExit', 'registry'], async (at) => {
        if ((await view<number>(at, autoExit, AUTO_EXIT_ABI, 'mandateStatus', [hash])) !== 1) fail('mandate_not_active')
        const record = await view<MandateRecord>(at, autoExit, AUTO_EXIT_ABI, 'mandateOf', [hash])
        if (lower(record.owner) !== owner) fail('mandate_not_owner')
        return { to: autoExit, data: encodeFunctionData({ abi: AUTO_EXIT_ABI, functionName: 'revokeMandate', args: [hash] }), summary: ['Turn off this Auto-exit.'], key: `revoke|${hash}` }
      }, gas)
    }),

    /**
     * Voids a signature this page asked for and that was never registered (spec §4.4): the nonce must be held in the
     * journal and still unused on chain. Once the cancellation is finalized the journal lets it go.
     */
    prepareCancelNonce: (nonce: bigint, gas: V2GasBudget | null = null) => t.bounded(async (rpc) => {
      if (typeof nonce !== 'bigint' || nonce < 0n || nonce > MAX_UINT256) return fail('mandate_invalid_nonce')
      const entry = entryOf(nonce)
      if (!wallet.signatures.held(entry)) return fail('mandate_nonce_not_held')
      return prepareChecked(rpc, { kind: 'cancel-nonce', nonce: entry }, ['autoExit', 'registry'], async (at) => {
        if (await nonceUsed(at, nonce)) {
          // As above: forgotten only once a finalized block shows it used.
          if (await nonceUsed({ rpc: at.rpc, block: 'finalized' as Hex }, nonce)) await wallet.signatures.forget(entry)
          fail('mandate_nonce_used')
        }
        return { to: autoExit, data: encodeFunctionData({ abi: AUTO_EXIT_ABI, functionName: 'cancelNonce', args: [nonce] }), summary: ['Cancel a signed Auto-exit that was never registered, so it can never be used.'], key: `cancel|${nonce}` }
      }, gas)
    }),

    /** Claims what an exit could not deliver (spec §4.8) to an address the owner chose: never address(0), never nothing. */
    prepareClaim: (token: Address, recipient: Address, gas: V2GasBudget | null = null) => t.bounded(async (rpc) => {
      if (!isAddress(token)) return fail('claim_invalid_token')
      if (!isAddress(recipient) || recipient.toLowerCase() === ZERO_ADDRESS) return fail('claim_invalid_recipient')
      const asset = token.toLowerCase() as Address
      const to = recipient.toLowerCase() as Address
      return prepareChecked(rpc, { kind: 'claim' }, ['autoExit', 'registry'], async (at) => {
        const amount = await view<bigint>(at, autoExit, AUTO_EXIT_ABI, 'unclaimed', [owner, asset])
        if (amount === 0n) fail('claim_nothing')
        return { to: autoExit, data: encodeFunctionData({ abi: AUTO_EXIT_ABI, functionName: 'claim', args: [asset, to] }), summary: [`Claim ${amount} (raw units) of ${asset} to ${to}.`], key: `claim|${asset}|${to}|${amount}` }
      }, gas)
    }),

    /** What the module holds for this owner in each token (`unclaimed`), at one block. Reads only. */
    readUnclaimed: (tokens: readonly Address[]) => t.bounded(async (rpc) => {
      if (!Array.isArray(tokens) || tokens.length === 0 || tokens.length > 8 || !tokens.every(isAddress)) return fail('claim_invalid_token')
      await t.identity(rpc)
      const { at, snapshot } = await pinBlock(t, rpc)
      const amounts = []
      for (const token of tokens) {
        const asset = token.toLowerCase() as Address
        amounts.push(Object.freeze({ token: asset, amount: await view<bigint>(at, autoExit, AUTO_EXIT_ABI, 'unclaimed', [owner, asset]) }))
      }
      return Object.freeze({ ...snapshot, amounts: Object.freeze(amounts) })
    }),

    /** The order nonces this page signed for on this chain and still holds: signatures that may need cancelling. */
    heldNonces: (): readonly SignedNonce[] => wallet.signatures.list(chain.chainId, owner).filter((entry) => entry.space === 'autoExit' && entry.verifier === autoExit),

    /** Lets go of every held nonce the chain says is used (registered or cancelled) at its finalized block. */
    reconcileNonces: () => t.bounded(async (rpc) => {
      await t.identity(rpc)
      const finalized: ReadAt = { rpc, block: 'finalized' as Hex }
      for (const entry of wallet.signatures.list(chain.chainId, owner)) {
        if (entry.space !== 'autoExit' || entry.verifier !== autoExit) continue
        if (await nonceUsed(finalized, entry.nonce)) await wallet.signatures.forget(entry)
      }
      return wallet.signatures.list(chain.chainId, owner).filter((entry) => entry.space === 'autoExit' && entry.verifier === autoExit)
    }),
  }
}
export type AutoExitClient = ReturnType<typeof createAutoExitClient>
