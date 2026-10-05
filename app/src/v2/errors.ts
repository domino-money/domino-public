/**
 * Domino V2's error decoder: a contract's revert, or a wallet's refusal, said in the spec's English and with what the
 * screen does next (spec F7 §2.12, §4.9, §5.8, and the wallet's 4001 and 4902).
 *
 * The same selector means different things on different contracts, so every decode names its context:
 * - `zap`: an S1 action (create, increase, change range, exit), including Permit2's, Uniswap v3/v4's and the Universal
 *   Router's errors bubbling through the zap (§2.12);
 * - `vault`: an owner action on a V2 vault (§5.8); the operator's and the swap module's own errors are `hidden`;
 * - `autoExit`: an owner action on the auto-exit module: register, revoke, cancel a nonce, claim (§4.9);
 * - `autoExitWaiting`: why an order has not fired yet, from the operator's revert reason, shown only when a backend
 *   exposes it (§4.9's second table); the planner's own `InvalidExecution` is `hidden`.
 *
 * What comes out:
 * - `copy`: the exact English sentence of the spec's table, placeholders filled. The error's name or selector never
 *   appears in it: they go in `dataCode`, for a `data-*` attribute (as finance/words.ts does for V1).
 * - `recovery`: what the screen offers next, a closed set (`Recovery`) read from the tables' recovery columns.
 * - `dataCode`: the error's name; the raw selector when the selector is unknown; `declined` and `unknown_chain` for the
 *   wallet's 4001 and 4902 (as components/positions/PositionActions.tsx says them); `empty` for a revert without data.
 * - `detail`: `Error(string)`'s text (bounded, controls stripped) or `Panic`'s code. For a data attribute only, never
 *   shown as text: it is whatever a token contract chose to write.
 * - `token` / `target`: the address an error carries (decoded by hand from its first ABI word); `cause`: the inner error
 *   of the Universal Router's `ExecutionFailed` and of v4's `WrappedError`, decoded in the same context.
 *
 * Placeholders:
 * - `{token}`: only through the caller's labeler (a token's symbol is untrusted text; the labeler hands back a safe label
 *   or a short address). Without one, native ETH is "ETH" and any other token its short address. The label is stripped
 *   of control and bidirectional characters and bounded. Substitution is one pass: a label is never read as a template.
 * - `{chain}`: the V2 chain's name from its profile (src/v2/chains.ts).
 * - `{reason}`: `InvalidMandate`'s local reason, which the app works out before signing (§4.9).
 * A sentence whose placeholder cannot be filled falls back to the generic sentence; nothing is guessed.
 *
 * The selectors are the spec's, each recomputed from its Solidity signature by tests/v2/errors.test.mjs and cross-checked
 * against api-contracts/v2/abi. The signatures not exported there (D7) are declared here by hand.
 *
 * Plain functions: no viem, no wallet, no browser storage (tests/session.source-guard.test.mjs). The ABI words are read
 * by hand.
 */
import { V2_CHAINS } from './chains'
import type { Address, Hex, V2ChainId } from './types'

export type ErrorContext = 'zap' | 'vault' | 'autoExit' | 'autoExitWaiting'

/**
 * What the screen offers after an error. Closed:
 * - `requote`: back to the review for a fresh quote (the price moved, or the plan was refused: if it repeats, log it);
 * - `replan`: plan again (an expired review or signature; cancel a signed nonce that was never used);
 * - `new-nonce`: plan again with a fresh nonce (a signature already used or cancelled);
 * - `report-plan-bug`: the plan itself is wrong: log the code, review again;
 * - `switch-account`: switch to (or sign with) the wallet that owns the position or the vault;
 * - `sign-again-or-direct`: sign again with the owner's wallet, or use the direct transaction;
 * - `direct-transaction`: use the direct transaction instead of a signature;
 * - `reread-position`: read the position again;
 * - `reread-and-replan`: read the position again, then plan again;
 * - `reread-status`: read the order's or the vault's state again;
 * - `adjust-range`: change the price range;
 * - `adjust-range-or-price`: change the price range or the starting price;
 * - `other-pool` / `other-token` / `other-route`: choose another pool, token or route;
 * - `approve-token`: approve the exact amount of the token again and check the balance;
 * - `approve-permit2`: the step that approves the token for Permit2;
 * - `approve-position`: the step that approves the position NFT (to the zap, or to the vault);
 * - `show-target`: show the refusing contract (`target`) in the details;
 * - `retry`: try again, unchanged, a little later;
 * - `disable-chain`: switch S1 off on this chain and say so (a deployment fault);
 * - `add-chain`: the person adds the chain to their wallet;
 * - `fix-fields`: correct the form's fields;
 * - `show-existing`: show the order already registered;
 * - `predict-again`: read the factory's nonce again, predict the vault again and approve again;
 * - `unsubscribe`: remove the other app's subscription at Uniswap;
 * - `support`: the amount stays where it is; contact support;
 * - `wait`: an order that waits: a status, not a failure of the person's action;
 * - `review-again`: the generic case: back to the review;
 * - `none`: nothing to offer beyond the sentence;
 * - `hidden`: never shown to the owner (the operator's and the planner's own errors); the generic sentence stands in
 *   if one ever reaches an owner's action, and a waiting reason that is hidden is not shown at all.
 */
export type Recovery =
  | 'requote'
  | 'replan'
  | 'new-nonce'
  | 'report-plan-bug'
  | 'switch-account'
  | 'sign-again-or-direct'
  | 'direct-transaction'
  | 'reread-position'
  | 'reread-and-replan'
  | 'reread-status'
  | 'adjust-range'
  | 'adjust-range-or-price'
  | 'other-pool'
  | 'other-token'
  | 'other-route'
  | 'approve-token'
  | 'approve-permit2'
  | 'approve-position'
  | 'show-target'
  | 'retry'
  | 'disable-chain'
  | 'add-chain'
  | 'fix-fields'
  | 'show-existing'
  | 'predict-again'
  | 'unsubscribe'
  | 'support'
  | 'wait'
  | 'review-again'
  | 'none'
  | 'hidden'
  /** Added 2026-10-04 (rugged97's delta of 4 Oct §2 item 1): "Send to another address you own". */
  | 'send-elsewhere'

export const RECOVERIES: readonly Recovery[] = Object.freeze([
  'requote', 'replan', 'new-nonce', 'report-plan-bug', 'switch-account', 'sign-again-or-direct', 'direct-transaction',
  'reread-position', 'reread-and-replan', 'reread-status', 'adjust-range', 'adjust-range-or-price', 'other-pool',
  'other-token', 'other-route', 'approve-token', 'approve-permit2', 'approve-position', 'show-target', 'retry',
  'disable-chain', 'add-chain', 'fix-fields', 'show-existing', 'predict-again', 'unsubscribe', 'support', 'wait',
  'review-again', 'none', 'hidden', 'send-elsewhere',
] as const)

/** The generic sentence (§2.12's last contract row): `Error(string)`, `Panic`, no data, and every unknown selector. */
export const GENERIC_COPY = 'The transaction would fail. Review again.'
/** The app's refusal sentence (components/positions/PositionActions.tsx), for the wallet's 4001. */
export const DECLINED_COPY = 'You declined in your wallet. Nothing was sent.'
/** §1.3, §2.12: the wallet's 4902. */
export const ADD_CHAIN_COPY = 'Add {chain} to your wallet, then try again.'
/** §2.12: an ERC-20 without enough allowance to Permit2 (see `permit2ApprovalNeeded`). */
export const PERMIT2_APPROVAL_COPY = 'Approve {token} for Permit2 first.'

/** One row of a table: the error's Solidity signature, its selector, the sentence and the recovery. */
export interface ErrorRow {
  readonly signature: string
  readonly selector: Hex
  readonly copy: string
  readonly recovery: Recovery
}

const row = (signature: string, selector: Hex, copy: string, recovery: Recovery): ErrorRow => Object.freeze({ signature, selector, copy, recovery })

const PLAN_REFUSED = "This plan can't be executed. Review it again."
const RANGE_INVALID = "This price range isn't valid for this pool."
const NOT_EXACT = "{token} doesn't transfer exact amounts, so it can't be used in a position."
const SIGNATURE_UNUSABLE = "Your wallet's signature can't be used here. Use a direct transaction instead."
const APPROVE_DOMINO = 'Approve Domino to manage this position first.'
const PRICE_MOVED = 'The price moved. Review again.'
const ROUTE_LESS = 'A swap would return less than your minimum (the price moved).'
const ROUTE_FAILED = 'The swap route expired or failed. Review again.'
const NOT_AVAILABLE = "Domino isn't available on this network right now."
const VAULT_OWNER_ONLY = 'Only the owner of this automation can do this.'

/** §2.12: the zap, with Permit2, Uniswap v3/v4 and the Universal Router behind it. */
export const ZAP_ERRORS: readonly ErrorRow[] = Object.freeze([
  row('InvalidPlan()', '0x21f24259', PLAN_REFUSED, 'requote'),
  row('PlanExpired()', '0x059e8997', 'This review expired before it was confirmed. Review again for a fresh quote.', 'replan'),
  row('Unauthorized()', '0x82b42900', 'Only the wallet that holds this position can do this.', 'switch-account'),
  row('InvalidSignature()', '0x8baa579f', "The signature doesn't match this position's owner or this plan.", 'sign-again-or-direct'),
  row('NonceUsed(address,uint256)', '0x2af71f10', 'This signature was already used or cancelled.', 'new-nonce'),
  row('InsufficientLiquidity()', '0xbb55fd27', "The amount to withdraw is below this plan's minimum.", 'replan'),
  row('InsufficientLiquidity(uint128,uint128)', '0xe49b763d', 'The price moved: this would add less liquidity than your minimum. No tokens moved.', 'requote'),
  row('FeeMismatch()', '0x36a9d011', "The Domino fee in this plan doesn't match the fee rule. Review again.", 'report-plan-bug'),
  row('SwapEffectMismatch()', '0x374aa3d7', 'A swap would return less than your minimum (the price moved). No tokens moved.', 'requote'),
  row('PositionPoolMismatch(uint256)', '0xf71fd589', "This position doesn't belong to the selected pool, or it was closed.", 'reread-position'),
  row('InvalidPool()', '0x2083cd40', "This pool isn't supported.", 'other-pool'),
  row('InvalidRange(int24,int24,int24)', '0x00911c16', RANGE_INVALID, 'adjust-range'),
  row('InvalidTick(int24)', '0x8b86327a', RANGE_INVALID, 'adjust-range-or-price'),
  row('InvalidSqrtPrice(uint160)', '0x61487524', RANGE_INVALID, 'adjust-range-or-price'),
  row('PoolNotInitialized()', '0x486aa307', 'This pool has no price yet.', 'other-pool'),
  row('PartialBurn(uint256,uint128,uint128)', '0xa97bba2b', 'This position changed since the review. Review again.', 'reread-and-replan'),
  row('InvalidRecipient(address)', '0x17858bbe', PLAN_REFUSED, 'report-plan-bug'),
  row('OpenDelta(int256,int256)', '0x5e9131f6', 'Uniswap reported an unexpected state for this pool. Try again later.', 'retry'),
  row('TransferFailed(address)', '0x39f1c8d9', NOT_EXACT, 'other-token'),
  row('SettlementMismatch(address,uint256,uint256)', '0x60752ed2', NOT_EXACT, 'other-token'),
  row('ApprovalFailed(address)', '0xe5a0a42f', '{token} refused the approval.', 'other-token'),
  row('TokenCallFailed(address)', '0xfecb69b4', 'A transfer of {token} failed. Check its approval and your balance.', 'approve-token'),
  row('ReentrantCall()', '0x37ed32e8', 'A token in this action tried to call back into Domino, so the action was refused.', 'other-token'),
  row('FeeNotBacked(address)', '0x6ce78f60', "This plan doesn't cover the Domino fee. Review again.", 'report-plan-bug'),
  row('FeeTransferMismatch(address)', '0xaa22b734', 'The fee token behaved unexpectedly. Try another route.', 'other-route'),
  // Permit2
  row('InvalidSigner()', '0x815e1d64', SIGNATURE_UNUSABLE, 'direct-transaction'),
  row('InvalidContractSignature()', '0xb0669cbc', SIGNATURE_UNUSABLE, 'direct-transaction'),
  row('InvalidSignatureLength()', '0x4be6321b', SIGNATURE_UNUSABLE, 'direct-transaction'),
  row('InvalidNonce()', '0x756688fe', 'This signature was already used.', 'replan'),
  row('SignatureExpired(uint256)', '0xcd21db4f', 'The signature expired. Review again.', 'replan'),
  row('InsufficientAllowance(uint256)', '0xf96fb071', 'The swap route asked for more than approved. Review again.', 'requote'),
  row('InvalidAmount(uint256)', '0x3728b83d', PLAN_REFUSED, 'report-plan-bug'),
  row('LengthMismatch()', '0xff633a38', PLAN_REFUSED, 'report-plan-bug'),
  // Uniswap v4 (v3's "Not approved" and "Price slippage check" are Error(string): see decodeRevertData)
  row('NotApproved(address)', '0x0ca968d8', APPROVE_DOMINO, 'approve-position'),
  row('WrappedError(address,bytes4,bytes,bytes)', '0x90bfb865', 'Another app connected to this position refused the change.', 'show-target'),
  row('MaximumAmountExceeded(uint128,uint128)', '0x31e30ad0', PRICE_MOVED, 'requote'),
  row('MinimumAmountInsufficient(uint128,uint128)', '0x12816f22', PRICE_MOVED, 'requote'),
  // Universal Router
  row('V4TooLittleReceived(uint256,uint256)', '0x8b063d73', ROUTE_LESS, 'requote'),
  row('V3TooLittleReceived()', '0x39d35496', ROUTE_LESS, 'requote'),
  row('TransactionDeadlinePassed()', '0x5bf6f916', ROUTE_FAILED, 'requote'),
  row('ExecutionFailed(uint256,bytes)', '0x2c4029e9', ROUTE_FAILED, 'requote'),
  // Deployment faults
  row('DirectCall()', '0xdf146856', NOT_AVAILABLE, 'disable-chain'),
  row('InvalidZapConfig()', '0x787fe9bc', NOT_AVAILABLE, 'disable-chain'),
])

/** §4.9, first table: the owner's actions on the auto-exit module. */
export const AUTO_EXIT_ERRORS: readonly ErrorRow[] = Object.freeze([
  row('MandateAlreadyRegistered()', '0x6f6ffce9', 'This order is already registered.', 'show-existing'),
  row('InvalidMandate()', '0x544cad7e', "This order isn't valid: {reason}.", 'fix-fields'),
  row('NonceAlreadyUsed()', '0x1fb09b80', 'This signed order was already used or cancelled. Sign a new one.', 'new-nonce'),
  row('InvalidSignature()', '0x8baa579f', "The signature isn't from the owner of this automation.", 'switch-account'),
  row('Unauthorized()', '0x82b42900', VAULT_OWNER_ONLY, 'none'),
  row('MandateNotActive()', '0x952501f6', 'This order is no longer active.', 'reread-status'),
  row('NothingToClaim()', '0x969bf728', 'Nothing to claim in {token}.', 'none'),
  row('InvalidRecipient()', '0x9c8d2cd2', 'Choose a valid address to receive the funds.', 'fix-fields'),
  row('DeliveryMismatch(address)', '0xf0de72c3', '{token} moved a different amount than expected, so the claim was refused.', 'support'),
])

const WAITING_ANCHOR = 'Waiting for a valid reference price.'

/** §4.9, second table: why an order waits, from the operator's revert reasons (only if a backend exposes them). */
export const AUTO_EXIT_WAITING: readonly ErrorRow[] = Object.freeze([
  row('TriggerNotReached()', '0xdccfcae2', 'Waiting for the reference price to reach your trigger.', 'wait'),
  row('SpotOutsideBand()', '0x97befd3a', 'Waiting: the pool price is too far from the reference price.', 'wait'),
  row('BelowMinimum()', '0x860b82a9', 'Waiting: the exit would return less than your minimum.', 'wait'),
  row('ObservationExpired()', '0xf9e0c800', WAITING_ANCHOR, 'wait'),
  row('ObservationRevoked()', '0x86669805', WAITING_ANCHOR, 'wait'),
  row('InvalidObservation()', '0xcea61d22', WAITING_ANCHOR, 'wait'),
  row('TwapUnavailable()', '0x146f8be2', WAITING_ANCHOR, 'wait'),
  row('PoolUnavailable()', '0x899b8f88', WAITING_ANCHOR, 'wait'),
  row('InvalidAnchor()', '0x080631d5', WAITING_ANCHOR, 'wait'),
  row('TwapWindowTooShort()', '0xe602580b', WAITING_ANCHOR, 'wait'),
  // Added 2026-10-04 (rugged97's audit remediation, #323: MAX_TWAP_SECONDS bounds a v3 reference window from above too).
  row('TwapWindowTooLong()', '0x38fa200f', WAITING_ANCHOR, 'wait'),
  row('AutomationHalted()', '0x8d37598c', 'Paused: Domino stopped automation on {chain} for safety.', 'wait'),
  row('ExitModuleNotEnabled()', '0x50cb9524', 'Paused: auto-exit is turned off for your automation.', 'wait'),
  row('VaultOwnerChanged()', '0x5aeff3a7', 'Not valid: the owner of this automation changed.', 'none'),
  row('AutomationUnavailable()', '0xb114dfff', 'Blocked: Domino no longer has approval on this position, or it left your automation.', 'none'),
  row('InvalidPosition()', '0xce7e065e', 'Blocked: Domino no longer has approval on this position, or it left your automation.', 'none'),
  row('InvalidExecution()', '0x29adbb29', GENERIC_COPY, 'hidden'),
])

/** `InvalidInit()`'s second sentence: the creation was sent without the consent on earned fees. */
export const VAULT_CONSENT_COPY = 'Confirm that earned fees become automation fees.'

/** §5.8: the owner's actions on a vault. The last row's errors are the operator's or the swap module's: `hidden`. */
export const VAULT_ERRORS: readonly ErrorRow[] = Object.freeze([
  row('Unauthorized()', '0x82b42900', VAULT_OWNER_ONLY, 'switch-account'),
  row('InvalidInit()', '0xab849bda', "This automation can't manage this position.", 'fix-fields'),
  row('UnexpectedNonce(uint256,uint256)', '0x315f0ba0', 'Another automation was set up from this wallet. Review again: your approval must point to the new one.', 'predict-again'),
  row('AutomationUnavailable()', '0xb114dfff', 'Approve this position for your automation from the wallet that holds it, then try again.', 'approve-position'),
  row('HookedPool(address)', '0x1758b8a8', "Pools with hooks can't be automated yet.", 'none'),
  row('ForeignSubscriber(address)', '0x7889477f', 'Another app is connected to this position. Remove it at Uniswap first.', 'unsubscribe'),
  row('InvalidPolicy()', '0xd06b96b1', 'One of the settings is outside the allowed range.', 'fix-fields'),
  row('InvalidLimits()', '0xe773e0a9', 'One of the settings is outside the allowed range.', 'fix-fields'),
  row('InvalidPosition()', '0xce7e065e', "This position can't be withdrawn this way.", 'none'),
  row('InvalidAmount()', '0x2c5211c6', 'Enter an amount greater than zero.', 'fix-fields'),
  row('InsufficientReserves()', '0x945e9268', "That's more than your automation holds in {token}.", 'reread-status'),
  // Changed on purpose 2026-10-04 (rugged97's delta of 4 Oct §2 item 1, #317): a withdrawal names its recipient. A token
  // that refuses the owner's wallet (a blocklist, say) can go to another address the owner names; address(0) is the
  // app's own bug.
  row('TokenCallFailed(address)', '0xfecb69b4', 'The transfer of {token} to your wallet failed.', 'send-elsewhere'),
  row('InvalidRecipient()', '0x9c8d2cd2', 'Choose a wallet to receive the funds.', 'fix-fields'),
  row('ReentrantCall()', '0x37ed32e8', 'Another Domino action is running on your automation. Try again.', 'retry'),
  // Changed on purpose (data) 2026-10-02 (spec rev4 §5.6, #311 returnReserves, IDominoVaultLedger): anyone may return a
  // closed vault's reserves to its owner, only with the root closed and no active successor.
  row('RootOpen()', '0xdae47e24', "Your position still holds liquidity, so its fees can't be returned this way. Use Withdraw to wallet.", 'reread-status'),
  row('SuccessorActive()', '0xa1c3fa1f', 'A position your automation opened is still active. Withdraw it from your automation first.', 'reread-status'),
  // The operator's and the swap module's own (contracts/src/v2/vault/DominoV2VaultStorage.sol): never the owner's.
  // The spec names them without selectors; these are keccak256 of the signatures (tests/v2/errors.test.mjs recomputes).
  row('StaleNonce()', '0xd8d01cf0', GENERIC_COPY, 'hidden'),
  row('TooSoon()', '0x6fed7d85', GENERIC_COPY, 'hidden'),
  row('PlanExpired()', '0x059e8997', GENERIC_COPY, 'hidden'),
  row('InvalidPlan()', '0x21f24259', GENERIC_COPY, 'hidden'),
  row('InvalidRoute()', '0x84e505d2', GENERIC_COPY, 'hidden'),
  row('StepUnavailable()', '0x3fb52101', GENERIC_COPY, 'hidden'),
  row('InvalidInstruction()', '0xd8c48f68', GENERIC_COPY, 'hidden'),
  row('UnexpectedCallback()', '0xdab1e993', GENERIC_COPY, 'hidden'),
])

export const ERROR_TABLES: Readonly<Record<ErrorContext, readonly ErrorRow[]>> = Object.freeze({
  zap: ZAP_ERRORS,
  vault: VAULT_ERRORS,
  autoExit: AUTO_EXIT_ERRORS,
  autoExitWaiting: AUTO_EXIT_WAITING,
})

/** Selectors whose first ABI word is the token the sentence names. */
const TOKEN_ARGUMENT: ReadonlySet<string> = new Set([
  'TransferFailed(address)', 'SettlementMismatch(address,uint256,uint256)', 'ApprovalFailed(address)', 'TokenCallFailed(address)',
  'FeeNotBacked(address)', 'FeeTransferMismatch(address)', 'DeliveryMismatch(address)',
])
/** Selectors whose first ABI word is an address that is not a token (shown, if at all, in the details). */
const ADDRESS_ARGUMENT: ReadonlySet<string> = new Set([
  'InvalidRecipient(address)', 'NotApproved(address)', 'HookedPool(address)', 'ForeignSubscriber(address)', 'NonceUsed(address,uint256)',
  'WrappedError(address,bytes4,bytes,bytes)',
])

const ERROR_STRING = '0x08c379a0'
const PANIC = '0x4e487b71'

/** A known error's code is its Solidity signature; the others are these. */
export type V2ErrorCode = string

export interface DecodedV2Error {
  /** The error's Solidity signature ('InvalidPlan()', 'Error(string)', 'Panic(uint256)'), or `empty`, `unknown`, `declined`, `unknown_chain`, `permit2_allowance_missing`. */
  readonly code: V2ErrorCode
  /** The 4-byte selector, lowercase; null for a wallet code, an empty revert, or data shorter than a selector. */
  readonly selector: Hex | null
  readonly copy: string
  readonly recovery: Recovery
  /** For a `data-*` attribute: the error's name, the raw selector (or data) when unknown, `empty`, `declined`, `unknown_chain`. */
  readonly dataCode: string
  readonly context: ErrorContext
  /** The token an error carries (decoded from its ABI word) or names (`subjectToken`). */
  readonly token?: Address
  /** The address argument of an error that carries one and is not a token (NotApproved, HookedPool…). */
  readonly address?: Address
  /** WrappedError's target: the contract that refused (a subscriber or a hook). */
  readonly target?: Address
  /** Error(string)'s text, or Panic's code in hex: for a data attribute only, never shown as text. */
  readonly detail?: string
  /** ExecutionFailed's inner error, or WrappedError's reason, decoded in the same context. */
  readonly cause?: DecodedV2Error
}

export interface ErrorLabels {
  /** The chain of the action: its name fills `{chain}`. */
  chainId: V2ChainId
  /** A safe label for a token address (the app's TokenLabel text, or a short address). The only source of `{token}`. */
  token?: (address: Address) => string
  /** The token the action was about, for an error that names a token without carrying it (NothingToClaim, InsufficientReserves). */
  subjectToken?: Address
  /** InvalidMandate's reason, worked out locally before signing (§4.9). Without one, the generic sentence. */
  reason?: string
  /** False when a vault was created or rearmed without the consent on earned fees: InvalidInit's second sentence. */
  consentGiven?: boolean
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Whether a code point is unsafe in a sentence or an attribute: C0 and C1 controls, zero-width and bidirectional marks,
 * line and paragraph separators, the bidirectional embeddings, overrides and isolates, word joiners, and the BOM.
 */
const unsafeCodePoint = (c: number): boolean =>
  c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) || c === 0xfeff

/** Untrusted text, made safe to place in a sentence or an attribute: controls stripped, trimmed, bounded. Null when empty. */
export function safeText(text: unknown, max: number): string | null {
  if (typeof text !== 'string') return null
  const clean = Array.from(text).filter((ch) => !unsafeCodePoint(ch.codePointAt(0) as number)).join('').trim()
  if (!clean) return null
  const characters = Array.from(clean)
  return characters.length > max ? `${characters.slice(0, max).join('')}…` : clean
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const ZERO = '0x0000000000000000000000000000000000000000'

/** Without a labeler: native ETH (address(0) on every V2 chain) is "ETH", any other token its short address. */
export const shortTokenLabel = (address: Address): string => (address.toLowerCase() === ZERO ? 'ETH' : `${address.slice(0, 6)}…${address.slice(-4)}`)

function tokenLabel(address: Address | undefined, labels: ErrorLabels): string | null {
  if (!address || !ADDRESS.test(address)) return null
  let label: string | null = null
  if (labels.token) {
    try {
      label = safeText(labels.token(address), 40)
    } catch {
      label = null
    }
  }
  return label ?? shortTokenLabel(address)
}

const chainName = (chainId: number): string | null => V2_CHAINS.find((chain) => chain.chainId === chainId)?.name ?? null

/** Fills `{token}`, `{chain}` and `{reason}` in one pass; null when a placeholder the sentence has cannot be filled. */
function fill(template: string, values: { token?: string | null; chain?: string | null; reason?: string | null }): string | null {
  let missing = false
  const text = template.replace(/\{(token|chain|reason)\}/g, (_match, key: 'token' | 'chain' | 'reason') => {
    const value = values[key]
    if (!value) {
      missing = true
      return ''
    }
    return value
  })
  return missing ? null : text
}

// ---------------------------------------------------------------------------
// ABI words, by hand
// ---------------------------------------------------------------------------

const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/

/** The n-th 32-byte word after the selector, as a BigInt; null past the end. */
function word(data: string, n: number): bigint | null {
  const start = 10 + n * 64
  if (data.length < start + 64) return null
  return BigInt(`0x${data.slice(start, start + 64)}`)
}

/** The n-th word as an address: its upper 12 bytes must be zero (strict ABI). */
function addressWord(data: string, n: number): Address | null {
  const start = 10 + n * 64
  if (data.length < start + 64) return null
  const text = data.slice(start, start + 64)
  if (!/^0{24}/.test(text)) return null
  return `0x${text.slice(24)}`.toLowerCase() as Address
}

/** A dynamic `bytes` argument whose head is the n-th word: its offset is relative to the start of the arguments. */
function bytesArgument(data: string, n: number): string | null {
  const offset = word(data, n)
  if (offset === null || offset % 32n !== 0n || offset > BigInt(data.length)) return null
  const at = Number(offset) / 32
  const length = word(data, at)
  if (length === null || length > BigInt(data.length)) return null
  const start = 10 + (at + 1) * 64
  const end = start + Number(length) * 2
  if (data.length < end) return null
  return data.slice(start, end)
}

function utf8(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

const nameOf = (signature: string): string => signature.slice(0, signature.indexOf('('))

const decoded = (value: DecodedV2Error): DecodedV2Error => Object.freeze(value)

function generic(context: ErrorContext, code: string, selector: Hex | null, dataCode: string, extra: Partial<DecodedV2Error> = {}): DecodedV2Error {
  return decoded({ code, selector, copy: GENERIC_COPY, recovery: 'review-again', dataCode, context, ...extra })
}

/** v3's NonfungiblePositionManager says these two with `require(…, '…')` (§2.12). */
const V3_STRINGS: Readonly<Record<string, { copy: string; recovery: Recovery }>> = Object.freeze({
  'Not approved': { copy: APPROVE_DOMINO, recovery: 'approve-position' },
  'Price slippage check': { copy: PRICE_MOVED, recovery: 'requote' },
})

const MAX_DEPTH = 3

/**
 * A revert's data, said. `data` is the 0x-hex the call reverted with (`0x` for none). Malformed data is the generic
 * sentence with `malformed` as its data code.
 */
export function decodeRevertData(data: string, context: ErrorContext, labels: ErrorLabels): DecodedV2Error {
  if (!Object.hasOwn(ERROR_TABLES, context)) throw new Error('invalid_error_context')
  return decodeAt(data, context, labels, 0)
}

function decodeAt(raw: string, context: ErrorContext, labels: ErrorLabels, depth: number): DecodedV2Error {
  if (typeof raw !== 'string' || !HEX_DATA.test(raw)) return generic(context, 'unknown', null, 'malformed')
  const data = raw.toLowerCase()
  if (data === '0x') return generic(context, 'empty', null, 'empty')
  if (data.length < 10) return generic(context, 'unknown', null, data)
  const selector = data.slice(0, 10) as Hex

  if (selector === ERROR_STRING) {
    const body = bytesArgument(data, 0)
    const text = body === null ? null : safeText(utf8(body), 200)
    const v3 = context === 'zap' && text !== null && Object.hasOwn(V3_STRINGS, text) ? V3_STRINGS[text] : null
    const extra = text === null ? {} : { detail: text }
    return v3
      ? decoded({ code: 'Error(string)', selector, copy: v3.copy, recovery: v3.recovery, dataCode: 'Error', context, ...extra })
      : generic(context, 'Error(string)', selector, 'Error', extra)
  }
  if (selector === PANIC) {
    const code = word(data, 0)
    return generic(context, 'Panic(uint256)', selector, 'Panic', code === null ? {} : { detail: `0x${code.toString(16)}` })
  }

  const found = ERROR_TABLES[context].find((entry) => entry.selector === selector)
  if (!found) return generic(context, 'unknown', selector, selector)
  const { signature } = found
  const extra: { token?: Address; address?: Address; target?: Address; cause?: DecodedV2Error } = {}
  let tokenText: string | null = null

  if (TOKEN_ARGUMENT.has(signature)) {
    const token = addressWord(data, 0)
    // A selector we know with an argument we cannot read: said generically, never with a guessed token.
    if (token === null) return generic(context, signature, selector, nameOf(signature))
    extra.token = token
    tokenText = tokenLabel(token, labels)
  } else if (found.copy.includes('{token}')) {
    if (labels.subjectToken && ADDRESS.test(labels.subjectToken)) extra.token = labels.subjectToken.toLowerCase() as Address
    tokenText = tokenLabel(extra.token, labels)
  }
  if (ADDRESS_ARGUMENT.has(signature)) {
    const address = addressWord(data, 0)
    if (address !== null) {
      if (signature === 'WrappedError(address,bytes4,bytes,bytes)') extra.target = address
      else extra.address = address
    }
  }
  if (depth < MAX_DEPTH && signature === 'ExecutionFailed(uint256,bytes)') {
    const inner = bytesArgument(data, 1)
    if (inner !== null) extra.cause = decodeAt(`0x${inner}`, context, labels, depth + 1)
  }
  if (depth < MAX_DEPTH && signature === 'WrappedError(address,bytes4,bytes,bytes)') {
    const reason = bytesArgument(data, 2)
    if (reason !== null && reason.length > 0) extra.cause = decodeAt(`0x${reason}`, context, labels, depth + 1)
  }

  let template = found.copy
  if (context === 'vault' && signature === 'InvalidInit()' && labels.consentGiven === false) template = VAULT_CONSENT_COPY
  const reason = signature === 'InvalidMandate()' ? safeText(labels.reason, 160)?.replace(/[.\s]+$/, '') ?? null : null
  const copy = fill(template, { token: tokenText, chain: chainName(labels.chainId), reason })
  return decoded({ code: signature, selector, copy: copy ?? GENERIC_COPY, recovery: found.recovery, dataCode: nameOf(signature), context, ...extra })
}

/**
 * The person's own refusal, as finance/nonce.ts personRefused says it (post-B4 review F6): EIP-1193's 4001,
 * WalletConnect's 5000, or a hardware wallet's refusal in words (a Ledger's status 0x6985, "denied by the user", …),
 * which some wallets pass on as data that would otherwise read as a revert. Kept equal to nonce.ts's list by
 * tests/v2/errors.test.mjs; this module stays free of the finance code.
 */
const PERSON_REFUSAL_CODES: ReadonlySet<number> = new Set([4001, 5000])
const PERSON_REFUSAL_WORDS = /0x6985|denied by the user|rejected by the user|user rejected|user denied|user cancel+ed|cancel+ed by (?:the )?user|request rejected|rejected the request/i

/**
 * A thrown wallet or provider error, said: the person's refusal in their wallet (4001, 5000 or a device's words,
 * anywhere in the chain of causes), an unknown chain (4902), or the contract's revert data wherever the wallet's
 * library put it. Walks `data`, `originalError`, `error` and `cause` (and viem's `raw`) to a bounded depth, as
 * finance/setup.ts's revertOf does. Null when the error is none of these (a network failure, a rate limit): the
 * caller's own failure sentence applies.
 */
export function decodeV2Error(error: unknown, context: ErrorContext, labels: ErrorLabels): DecodedV2Error | null {
  if (!Object.hasOwn(ERROR_TABLES, context)) throw new Error('invalid_error_context')
  if (typeof error === 'string') return HEX_DATA.test(error) ? decodeAt(error, context, labels, 0) : null
  let declined = false
  let unknownChain = false
  let rateLimited = false
  let reverted = false
  let data: string | null = null
  const seen = new Set<object>()
  const walk = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 6 || seen.has(value)) return
    seen.add(value)
    const node = value as { code?: unknown; message?: unknown; data?: unknown; raw?: unknown; originalError?: unknown; cause?: unknown; error?: unknown }
    if (typeof node.code === 'number' && PERSON_REFUSAL_CODES.has(node.code)) declined = true
    if (typeof node.message === 'string' && PERSON_REFUSAL_WORDS.test(node.message)) declined = true
    if (typeof node.data === 'string' && PERSON_REFUSAL_WORDS.test(node.data)) declined = true
    if (node.code === 4902) unknownChain = true
    if (node.code === 429) rateLimited = true
    if (node.code === 3) reverted = true
    for (const candidate of [node.data, node.raw]) {
      if (typeof candidate === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(candidate)) {
        reverted = true
        data ??= candidate
      }
    }
    if (typeof node.message === 'string' && /execution reverted|revert/i.test(node.message)) reverted = true
    for (const next of [node.data, node.originalError, node.error, node.cause]) walk(next, depth + 1)
  }
  walk(error, 0)
  if (declined) return decoded({ code: 'declined', selector: null, copy: DECLINED_COPY, recovery: 'none', dataCode: 'declined', context })
  if (unknownChain) {
    const copy = fill(ADD_CHAIN_COPY, { chain: chainName(labels.chainId) })
    return decoded({ code: 'unknown_chain', selector: null, copy: copy ?? GENERIC_COPY, recovery: 'add-chain', dataCode: 'unknown_chain', context })
  }
  if (rateLimited || !reverted) return null
  return data === null ? generic(context, 'empty', null, 'empty') : decodeAt(data, context, labels, 0)
}

/**
 * §2.12's "an ERC-20 without enough allowance to Permit2": a token's or Permit2's free-text revert names no token, so
 * the decoder cannot say it. The app reads the allowance before it asks for the signature; when it falls short, this
 * is the sentence and the recovery (the step that approves the token for Permit2).
 */
export function permit2ApprovalNeeded(token: Address, labels: ErrorLabels): DecodedV2Error {
  const label = tokenLabel(token, labels)
  if (label === null) throw new Error('invalid_address')
  const copy = fill(PERMIT2_APPROVAL_COPY, { token: label }) as string
  return decoded({ code: 'permit2_allowance_missing', selector: null, copy, recovery: 'approve-permit2', dataCode: 'permit2_allowance_missing', context: 'zap', token: token.toLowerCase() as Address })
}
