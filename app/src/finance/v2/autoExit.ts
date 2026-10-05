import { encodeEventTopics, encodeFunctionData, type Abi } from 'viem'
import type { V2Chain } from '../../v2/chains'
import { RECEIVE_MODE, ZERO_ADDRESS, type Address, type Dex, type ExitMandate, type Hex, type PoolRef, type ReceiveMode, type V2ChainId, type V2Component, type V2Contracts } from '../../v2/types'
import { atomicStatus, batchCallsStatus, simulateBatch, type AtomicStatus, type BatchCall } from '../batch'
import { readAccountCode } from '../delegates'
import { AUTO_EXIT_ABI, REGISTRY_ABI, VAULT_ABI } from './abi'
import { AUTO_EXIT_EVENTS_ABI, VAULT_EVENTS_ABI } from './implementations'
import { CONTRACTS_NOT_LIVE, refuseUnlessLive } from './liveLock'
import { createTransactor, quantity, refused, REVIEW_S, revertIn, SIGN_WINDOW_S, WalletNotAsked, type PreparedV2, type Rpc, type SignedNonce, type V2GasBudget, type V2Receipt, type V2Wallet } from './transact'
import { exitMandateTypedData, mandateId, signV2TypedData, typedDataDigest, type SignatureShape, type V2TypedData } from './typedData'
import {
  browserV2BatchLatch, checkBatchBudget, decodeEvents, factoryComponent, managerAbi, managerOf, offerV2Batch, pinBlock, readVaultIdentity, receiptOfBatch, simulateV2Batch,
  transactionWithLog, v2ContractsFor, V2_BATCH_LATCH_EXPIRY_S, verifyComponents, viewAt, type ReadAt, type V2BatchLatch, type V2BatchReceipt, type V2Event, type V2Snapshot, type VaultIdentity,
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
 * PHASE A: nothing here is wired to a screen, and no V2 contract is deployed anywhere. The list of an owner's orders
 * needs the V2 read API or `MandateRegistered` logs (spec §6.2): not read here.
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

// ---------------------------------------------------------------------------
// Copy (spec §4.2, §4.5, §4.6, §4.7)
// ---------------------------------------------------------------------------

/** The {reason} of "This order isn't valid: {reason}." for each closed reason code. */
export const MANDATE_REASON_TEXT = Object.freeze({
  mandate_no_trigger: 'set at least one trigger price',
  mandate_trigger_order: 'the lower trigger price must be below the upper one',
  mandate_trigger_range: 'a trigger price is out of range',
  mandate_receive_mode: 'choose to receive both tokens or only one of them',
  mandate_convert_to_both: "receiving both tokens can't also name a token to convert to",
  mandate_convert_to_token: "you can only receive one of this pool's two tokens",
  mandate_slippage: 'the slippage must be from 0.01% to 10%',
  mandate_valid_until: 'the end date must be in the future',
  mandate_position: 'the position must be in this automation',
  mandate_warnings: 'confirm you have read the warnings',
} as const)
export type MandateReason = keyof typeof MANDATE_REASON_TEXT
export const mandateInvalidText = (reason: MandateReason): string => `This order isn't valid: ${MANDATE_REASON_TEXT[reason]}.`

export const AUTO_EXIT_TEXT = Object.freeze({
  // §4.7, in order (the v3 one only on a v3 vault), then the fee line (§4.6).
  autoexit_warning_not_guaranteed: 'The trigger price is not guaranteed. In a price gap or a rug, liquidity can disappear before the exit.',
  autoexit_warning_reference_price: 'The exit runs only after the reference price crosses your trigger and the pool price is within your slippage of it.',
  autoexit_warning_v3_twap: 'On v3 pools the reference price is a time-weighted average. After a fast move the exit waits for it to catch up, and it may never happen if the pool empties first.',
  autoexit_warning_slippage_on_top: "When converting, your slippage limit comes on top of the pool's own fee.",
  autoexit_warning_turn_off_pauses: "Turning auto-exit off for your automation pauses your orders; it doesn't cancel them.",
  autoexit_warning_other_orders: 'If one order fires, your other orders on this position stay active.',
  autoexit_warning_halt: 'If Domino stops automation for safety, auto-exits stop too. You can still cancel your orders and withdraw at any time.',
  autoexit_fee_line: "Auto-exit fee: 0.2% of the position's value at exit. It's the only fee, even when converting.",
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
  mandate_module_off: 'Paused: auto-exit is turned off for your automation.',
  mandate_owner_changed: 'Not valid: the owner of this automation changed.',
  mandate_root_custody_lost: 'Paused: Domino no longer has approval on this position.',
  mandate_successor_inactive: 'This position is no longer in your automation.',
  mandate_halted: 'Paused: Domino stopped automation on {chain} for safety.',
  mandate_vault_unknown: "This order names an automation Domino didn't set up.",
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
}

export interface MandateContext {
  /** The time the order must outlive: the later of the chain's (the review block's) and the page's, in seconds. */
  now: bigint
  pool: { currency0: Address; currency1: Address }
  /** `MAX_SLIPPAGE_BPS()` as read; never above AUTO_EXIT_MAX_SLIPPAGE_BPS. */
  maxSlippageBps: number
  /** Whether `tokenId` is the vault's root or an active successor. */
  inVault: boolean
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
  pool: PoolRef
  role: 'root' | 'successor'
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
    return [
      Object.freeze({ to: identity.vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'setExitModule', args: [autoExit] }), value: '0x0' as Hex }),
      Object.freeze({ to: autoExit, data: encodeFunctionData({ abi: AUTO_EXIT_ABI, functionName: 'registerMandate', args: [review.mandate, signed.signature] }), value: '0x0' as Hex }),
    ]
  }
  const batchComponents = (review: MandateReview): readonly V2Component[] => ['autoExit', 'registry', factoryComponent(review.dex)]

  return {
    chain,
    contracts,
    owner,

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
     * Reviews an exit order (spec §4.1, §4.2, §4.4): the vault is the factory's and the wallet's, the position its root or
     * an active successor, every term of §4.2 valid, the warnings acknowledged; a fresh random nonce is chosen. The
     * steps: turning the module on (only when the vault's module is not the manifest's auto-exit), the signature, the
     * registration. Reads only, at one block; nothing is signed or recorded yet.
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
      const identity = await ownedVault(at, request.vault)
      const role = await roleOf(at, identity, request.tokenId)
      const ceiling = await view<number>(at, autoExit, AUTO_EXIT_ABI, 'MAX_SLIPPAGE_BPS')
      const time = snapshot.blockTimestamp > nowSeconds() ? snapshot.blockTimestamp : nowSeconds()
      const problems = mandateProblems(request, { now: time, pool: identity.pool, maxSlippageBps: ceiling, inVault: role !== null })
      if (problems.length || role === null) return fail(`mandate_invalid: ${problems.join(' ')}`)
      const nonce = await freshNonce(at)
      const mandate: ExitMandate = Object.freeze({
        owner,
        vault: identity.vault,
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
      const rank0 = await rankOf(at, identity.pool.currency0)
      const rank1 = await rankOf(at, identity.pool.currency1)
      const enable = lower(await view<string>(at, identity.vault, VAULT_ABI, 'exitModule')) !== autoExit
      const steps: { kind: MandateStepKind; summary: readonly string[] }[] = []
      if (enable) steps.push(Object.freeze({ kind: 'enable-exit-module' as const, summary: Object.freeze(['Turn on auto-exit for this vault.']) }))
      steps.push(Object.freeze({ kind: 'sign-mandate' as const, summary: Object.freeze(['Sign your exit order in your wallet.']) }))
      steps.push(Object.freeze({ kind: 'register-mandate' as const, summary: Object.freeze([`Register your exit order for position #${request.tokenId}.`]) }))
      const review: MandateReview = Object.freeze({
        kind: 'mandate',
        chainId: chain.chainId,
        owner,
        autoExit,
        vault: identity.vault,
        dex: identity.dex,
        pool: identity.pool,
        role,
        mandate,
        id: mandateId(mandate),
        digest: typedDataDigest(typedData),
        typedData,
        receive: mandate.receiveMode === RECEIVE_MODE.converted ? Object.freeze({ mode: 'converted' as const, token: mandate.convertTo }) : Object.freeze({ mode: 'both' as const }),
        feeRule: Object.freeze(autoExitFeeRule(mandate.receiveMode, mandate.convertTo, identity.pool, rank0, rank1)),
        warnings: autoExitWarnings(identity.dex),
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
      await ownedVault(latest, review.vault)
      const block = await t.latestBlock(rpc)
      if (review.mandate.validUntil <= block.timestamp || review.mandate.validUntil <= nowSeconds()) return fail('mandate_invalid: mandate_valid_until')
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
        return { to: autoExit, data: encodeFunctionData({ abi: AUTO_EXIT_ABI, functionName: 'revokeMandate', args: [hash] }), summary: ['Cancel this auto-exit order.'], key: `revoke|${hash}` }
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
        return { to: autoExit, data: encodeFunctionData({ abi: AUTO_EXIT_ABI, functionName: 'cancelNonce', args: [nonce] }), summary: ['Cancel a signed exit order that was never registered, so it can never be used.'], key: `cancel|${nonce}` }
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
