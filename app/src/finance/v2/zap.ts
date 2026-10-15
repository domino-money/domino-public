import { BaseError, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, numberToHex, type Abi, type Address, type Hex } from 'viem'
import v3FactoryAbi from '../../../../api-contracts/v2/abi/IUniswapV3FactoryMinimal.json'
import v3PoolAbi from '../../../../api-contracts/v2/abi/IUniswapV3PoolMinimal.json'
import v4StateViewAbi from '../../../../api-contracts/v2/abi/IV4StateViewMinimal.json'
import { profileRank, v3TickSpacing, type V2Chain } from '../../v2/chains'
import { assistedSwapFee, type FeePlace } from '../../v2/feeRule'
import { V2_FIXTURE_SETS_TAKEN } from '../../v2/flag'
import { chooseConsent, type ConsentChoice } from '../../v2/plan/consent'
import { BATCH_FRAME_GAS, BATCH_UNSUPPORTED, atomicStatus, batchCallsStatus, offerBatch, simulateBatch, type AtomicStatus, type BatchCall } from '../batch'
import { chainNonceJournal, definiteRefusal } from '../nonce'
import { RECEIPT_TOPICS } from './receipt'
import { V2_FEES, ZERO_ADDRESS, type ActionName, type Dex, type PermitBatch, type PoolRef, type TokenAmount, type V2ChainId, type V2Component, type V2Contracts, type ZapPlan } from '../../v2/types'
import { readAccountCode, type AccountCode } from '../delegates'
import type { PlanTarget } from '../../v2/plan/route'
import { ERC20_ABI, PERMIT2_ABI, REGISTRY_ABI, V3_POSITION_MANAGER_ABI, V4_POSITION_MANAGER_ABI, VAULT_ABI, VAULT_FACTORY_ABI, ZAP_ABI } from './abi'
import { actionResultOf, actionResultProblems, basisProblems, checkPlan, relayedActionOf, reviewLegs, zapFor, type PlanBasis, type PlanContext, type PositionOnChain, type QuotedLeg } from './plan'
import { admitV2Contracts, checkZapPositionManager, verifyV2Code } from './deployment'
import { CONTRACTS_NOT_LIVE, refuseUnlessLive } from './liveLock'
import { edgeReadsReceipts } from '../../config/receiptSources'
import { REVIEW_S, SIGN_WINDOW_S, WalletNotAsked, createTransactor, headerTime, l1FeeCeiling, quantity, refused, revertIn, suggestV2Gas, type PreparedV2, type Rpc, type SignedNonce, type StepDraft, type V2GasBudget, type V2Log, type V2Receipt, type V2Wallet } from './transact'
import { PERMIT2, intentHash, permit2WitnessTypedData, relayedActionTypedData, signV2TypedData, type SignedTypedData } from './typedData'
import { browserUnsettledActions, type UnsettledAction, type UnsettledActions } from './zapUnsettled'

/**
 * Domino V2's S1 money client (spec F7 §2): create, increase, change range and exit through the zap, one transaction
 * each, on Uniswap v3 and v4, on the ONE chain this client is bound to. The V1 owner clients' shape
 * (finance/position.ts): review → prepare a step → send it → read its receipt, every read and every send through the
 * connected wallet's own provider and the one shared V2 sender (./transact.ts). Nothing here is wired to a screen, and
 * no V2 contract is deployed anywhere yet: a client exists only for a contracts set from a pinned manifest.
 *
 * What it keeps, always:
 *   - The plan is checked before any consent is asked (./plan.ts, the twelve checks of §2.4), with every input read
 *     through the wallet at ONE pinned block: the position, the registry's charge-currency ranks and router versions,
 *     the account's code on THIS chain, the allowances and the NFT approval. Any failure refuses the whole review.
 *   - The Domino contracts are the manifest's: before the first write, once per client, each component's runtime code
 *     hashes to the manifest's, the zap names the chain profile's position manager, and its hooks policy is read.
 *     A FIXTURE contracts set never runs in a deployable build.
 *   - Approvals are exact: an ERC-20 approval is the amount the step pulls, a short non-zero allowance is reset to zero
 *     first (tokens like USDT refuse a non-zero to non-zero change, finance/setup.ts does the same); an NFT approval
 *     names one tokenId on the chain's own position manager, never setApprovalForAll; a revoke is approve(0, tokenId).
 *   - Every step is re-read right before it is prepared: an approval already in place is `step_not_needed`, the action
 *     needs every earlier step done; a plan less than a minute from its deadline is `plan_expiring` (re-quote).
 *   - Signature nonces (Permit2's unordered nonce, the zap's relayed nonce) are free on chain and not held when chosen,
 *     recorded in the page's signature journal BEFORE the wallet is asked, forgotten only when nothing was signed (a
 *     4001, or a refusal before the prompt), and settled from the chain's bitmaps afterwards.
 *   - Sending is the transactor's: simulated again, the nonce claimed, `eth_chainId` read right before the wallet is
 *     asked, never sent twice.
 *
 * Changed on purpose (data) 2026-10-02 (Domino V2 rev2 review of the S1 money and signing paths):
 *   - F1: every swap leg leads to what the person asked (the request's target: an exit converts into its token only, an
 *     exit to both tokens swaps nothing, a mint ends in the pool's currencies), and the plan's inputs are the request's.
 *   - F2: the wallet's answer to a send or a batch offer is kept even when the wallet changed right after giving it.
 *   - F3: an action handed to the wallet with no known outcome is held for this owner on this chain (./zapUnsettled.ts):
 *     no new review, action, batch or permit signature until the chain settles it, or the person says, while the chain
 *     shows nothing pending, that they rejected it (`forgetUnsettled`).
 *   - F4: the plan's minimums are tied to this client's own reads at the review (the pool's price inside the plan's band,
 *     the position its removal used) and to its own simulation of the action (its ActionResult, as a step or in a batch).
 *   - L2: only a root its vault reads ARMED (`rootArmed()`, `root()`) pauses automation; L5: no chosen recipient.
 *
 * The relayed consent (a signature a relayer submits) is not offered: no relayer exists (spec open point 4). Its
 * signature is built and tested (`signRelayed`), and nothing submits it.
 */

// Declared here, module-scoped, as finance/pin.ts does: a compile outside Vite sees no ambient flag. Vite replaces the
// identifier with the build mode's literal; a deployable build refuses a fixture contracts set.
declare const __DOMINO_DEPLOYABLE__: boolean | undefined
// Changed on purpose (data) 2026-10-02 (Domino V2 integration, the preview-v2 build): preview-v2 is the real site for V1
// (`__DOMINO_DEPLOYABLE__` true there) yet takes fixture sets up to a review (V2_FIXTURE_SETS_TAKEN, src/v2/flag.ts): their
// sends and signatures are refused by ./liveLock.ts instead. The deployable builds refuse them here, as before.
const DEPLOYABLE: boolean = typeof __DOMINO_DEPLOYABLE__ === 'boolean' && __DOMINO_DEPLOYABLE__ && !V2_FIXTURE_SETS_TAKEN

/** A plan this close to its deadline (seconds) is not offered: the wallet prompt and the block could outlive it. */
export const MIN_DEADLINE_LEFT_S = 60

export type ZapConsent = 'direct' | 'permit2'

/** The quote the plan came with (position-plan-v1: `requestedAt`, `expiresAt`, `legs`, `simulation`, `fee.ranks`), raw integers as bigint. */
export interface ZapQuote {
  /**
   * Unix seconds: when the quote was made (the deadline is at most 5 minutes after it) and when it stops being good (no
   * consent at or after it), decision #3. Changed on purpose (data) 2026-10-02 (rev2 §2.4): `requestedAt` added.
   */
  requestedAt: number
  expiresAt: number
  /**
   * The registry ranks the plan's fee rule used (`fee.ranks`, every token the legs touch): equal to what the review reads
   * from the registry, or the plan is refused (rev2 §2.4 app check 2). Absent: the review's own reads only.
   */
  ranks?: readonly { token: Address; rank: number }[]
  /** One per plan leg, with the plan's own minimum (check 12). */
  legs: readonly QuotedLeg[]
  /** The server's simulation of the plan at a block (check 11's first half). */
  simulation: { ok: boolean; block: bigint; error: string | null }
  /** What a change of range or an exit is expected to take out of the position, per currency (conversion legs spend at most that). */
  expectedRemoved?: readonly [bigint, bigint]
  /**
   * What the plan's minimums were computed from (its pool price, post-swap price, bands, expected liquidity, position):
   * tied at the review to what this client reads through the wallet, and at every simulation to its ActionResult.
   * Changed on purpose (data) 2026-10-02 (Domino V2 rev2 review, F4).
   */
  basis: PlanBasis
}

export interface ZapReviewInput {
  /** The chain the plan was built for (the plan request's chainId): it must be this client's. A plan carries no chain of its own. */
  chainId: number
  plan: ZapPlan
  /** 'relayed' is refused: no relayer exists (open point 4). */
  consent: ZapConsent | 'relayed'
  quote: ZapQuote
  /**
   * What the person asked for (the plan request, ../../v2/plan/route.ts planTargetOf): the plan's inputs must be the
   * request's and every swap leg must lead to what it names. Changed on purpose (data) 2026-10-02 (Domino V2 rev2 review,
   * F1). The recipient is always the connected wallet: `chosenRecipient` was removed (L5).
   */
  target: PlanTarget
  /**
   * A new pool's starting price as the APP computed it from the typed price (src/v2/plan/initialPrice.ts): a plan with a
   * non-zero initSqrtPriceX96 is accepted only when it equals this AND the pool reads unpriced at the review's block
   * (rev2 §2.6.5, §2.4 check 13). Absent: the plan must not initialize a pool.
   */
  initSqrtPriceX96?: bigint
}

export type ZapActionFunction = 'create' | 'createWithPermit' | 'increase' | 'increaseWithPermit' | 'changeRange' | 'exit'

/** One step of a review, in order. Only `sign-permit` is not a transaction (see `signPermit`). */
export type ZapStep =
  | { readonly kind: 'approve-reset'; readonly token: Address; readonly spender: Address; readonly amount: bigint }
  | { readonly kind: 'approve'; readonly token: Address; readonly spender: Address; readonly amount: bigint }
  | { readonly kind: 'approve-nft'; readonly manager: Address; readonly tokenId: bigint; readonly spender: Address }
  | { readonly kind: 'sign-permit'; readonly nonce: bigint }
  | { readonly kind: 'action'; readonly functionName: ZapActionFunction; readonly to: Address; readonly value: bigint }

/**
 * The warnings a review must show (closed keys; the screen words them):
 *   - `v3_weth_leftovers`: "On v3 pools, unused ETH comes back as WETH." (§2.7)
 *   - `v4_increase_sends_fees`: "Uncollected fees will also be sent to your wallet." (§2.6.2)
 *   - `change_range_new_nft`: "Changing the range closes this position and opens a new one (new NFT)." (§2.6.3)
 *   - `exit_conversion_dust`: "You may also receive a small amount of {other token} that could not be converted exactly." (§2.6.4)
 *   - `nft_approval_stays`: the NFT approval to the zap stays after the action (§2.5.1); the card offers "Revoke".
 */
export type ZapWarning = 'v3_weth_leftovers' | 'v4_increase_sends_fees' | 'change_range_new_nft' | 'exit_conversion_dust' | 'nft_approval_stays'

export interface ZapFee {
  /** The quote's expected outputs, not measured ones: the receipt's FeeCharged is the exact figure. */
  estimate: true
  bps: number
  token: Address
  place: FeePlace
  swapped: bigint
  amount: bigint
}

export interface ZapReview {
  chainId: V2ChainId
  owner: Address
  action: ActionName
  dex: Dex
  zap: Address
  consent: ZapConsent
  /** The zap's intentHash for this plan: every receipt event carries it. */
  intentHash: Hex
  /** The block every read of this review was pinned to. */
  block: bigint
  deadline: bigint
  quoteExpiresAt: number
  /** The plan exactly as checked and as it will be encoded (a frozen copy). */
  plan: ZapPlan
  steps: readonly ZapStep[]
  /** The route, leg by leg, for the review (check 12). */
  legs: readonly NonNullable<ReturnType<typeof reviewLegs>>[number][]
  /** Null without legs: "No Domino fee". */
  fee: ZapFee | null
  warnings: readonly ZapWarning[]
  /** The account's code on this chain: only a plain account may use Permit2 (§2.5.4). */
  account: AccountCode['kind']
  /** Whether Permit2 could be offered for this plan from this account (else the direct path). */
  permit2Offered: boolean
  /** ETH the action carries (direct path: the native inputs). */
  value: bigint
  /** The position acted on, as read (increase, change range, exit). */
  position: PositionOnChain | null
  /**
   * The address whose individual approval on this NFT the zap's approval step replaces (an NFT holds one, spec §1.5):
   * another app's, or a V2 vault's, whose automation then stops for this position (§2.13). Null when none is replaced.
   */
  replacesApproval: Address | null
  /**
   * The armed root's vault when this action pauses its automation (rev2 §2.13, decision #5: increase, exit and collect
   * on a vault's root are allowed after the warning "This pauses automation for this position. You can turn it back on
   * afterwards."; a change of range on one is refused). Null otherwise. No step of such a review is prepared, signed or
   * sent until `acknowledgePause(review)`. Changed on purpose (data) 2026-10-02 (Domino V2 rev2 review, L2): only a root
   * the vault reads ARMED (`rootArmed()`, its `root()` this position): a root disarmed earlier pauses nothing.
   */
  pausesAutomation: Address | null
  /**
   * The vault whose root this position is, armed or not (its `root()` names this position): an exit leaves that vault's
   * reserves behind (rev3 §2.13), so the review still says so for a disarmed root. Null when it is no vault's root.
   */
  vaultRoot: Address | null
  /** A new pool this plan initializes (create with initSqrtPriceX96 ≠ 0, read unpriced at `block`). */
  createsPool: boolean
}

/** "Domino can manage this position for you when you ask": the NFT's approval, as the position card shows it (§2.5.1). */
export interface PositionApproval {
  chainId: V2ChainId
  dex: Dex
  tokenId: bigint
  manager: Address
  holder: Address
  approved: Address
  zapApproved: boolean
  /** Offered only when the zap is the approved one and this wallet holds the NFT. */
  revocable: boolean
  block: bigint
}

/**
 * An S1 review sent whole as one EIP-5792 batch (spec §2.5.1 "Lote", §2.5.4): direct consent, the calls exactly the
 * review's transaction steps still needed at the block it was prepared at, `[approvals…, NFT approval?, action]`,
 * simulated whole through the wallet (eth_simulateV1; no other node is asked, OP9). Frozen; only the client that
 * prepared it can send it, once.
 */
export interface ZapBatch {
  chainId: V2ChainId
  owner: Address
  /** The latch key: the review's intentHash (one batch per plan, ever, on this page and its other tabs). */
  key: Hex
  intentHash: Hex
  /** The review's step kinds the calls stand for, in order (`action` last). */
  kinds: readonly ZapStep['kind'][]
  calls: readonly BatchCall[]
  gasUsed: bigint
  /** The most the batch may cost in network fees: its calls' gas, with room for the wallet's own frame, at the fee ceiling. */
  networkFeeWei: bigint
  /** ETH the batch carries (the action's native inputs). */
  value: bigint
  /** Unix seconds: the batch is good until then (25 s after its simulation). */
  expiresAt: number
}

/** Where an offered batch stands; `included` and `finalized` carry the action's own receipt, as `receipt()` reads one. */
export type ZapBatchReceipt = V2Receipt | { state: 'not-included' } | { state: 'batch-reverted' }

/**
 * The page's latch for the batch of one plan (finance/nonce.ts's batch latch, keyed by chain and owner): claimed before
 * the wallet is asked, so another tab, or this one after a lost answer, never offers the same plan twice. Let go only
 * when the batch is known never to run (refused, unsupported, or not included).
 */
export interface ZapBatchLatch {
  batchOffered(key: Hex): string | null
  claimBatch(key: Hex): Promise<string>
  recordBatch(key: Hex, claim: string, id: string): Promise<void>
  releaseBatch(key: Hex, claim: string): Promise<void>
  /** Frees the latch claimed more than `maxAge` seconds ago (or whose page is gone without an answer): true when it did. */
  expireBatch(key: Hex, maxAge: number): Promise<boolean>
}

/**
 * How long a zap batch's latch holds when met again, 25 minutes, as V1's setup (finance/setup.ts BATCH_LATCH_EXPIRY_S):
 * past it the plan's deadline is long gone, so nothing of that batch can run. A latch is also let go once its batch is
 * read back on chain (included or reverted) or the wallet says it never ran (400, 500). This page never offers the same
 * plan twice in any case (the client's handed-over mark).
 */
export const ZAP_BATCH_LATCH_EXPIRY_S = 1_500

/** The page's own batch latch for one owner on one chain, in the browser (finance/nonce.ts chainNonceJournal). */
export function browserBatchLatch(chainId: V2ChainId, owner: Address): ZapBatchLatch {
  const journal = chainNonceJournal(chainId)
  const who = owner.toLowerCase()
  return {
    batchOffered: (key) => journal.batchOffered(who, key),
    claimBatch: (key) => journal.claimBatch(who, key, Date.now() / 1000),
    recordBatch: (key, claim, id) => journal.recordBatch(who, key, claim, id),
    releaseBatch: (key, claim) => journal.releaseBatch(who, key, claim),
    expireBatch: (key, maxAge) => journal.expireBatch(who, key, Date.now() / 1000, maxAge),
  }
}

/** A refusal with every reason: the message is the first code, `failures` the whole list. */
export class ZapRefusal extends Error {
  readonly failures: readonly string[]
  constructor(failures: readonly string[]) {
    super(failures[0] ?? 'zap_refused')
    this.name = 'ZapRefusal'
    this.failures = Object.freeze([...failures])
  }
}

interface ReviewState {
  plan: ZapPlan
  context: PlanContext
  /** What the plan's minimums were computed from (F4): every simulation of its action is checked against it. */
  basis: PlanBasis
  permit: PermitBatch | null
  manager: Address
  needsNft: boolean
  signature: SignedTypedData | null
  /** rev2 §2.13: the person ticked "This pauses automation for this position…" (only asked when `pausesAutomation`). */
  pauseAcknowledged: boolean
}

/**
 * A pool as the chain has it, read through the wallet (rev2 §6.2 "O que o read-v6 ainda não tem": no pool list for
 * Base and Arbitrum, so the pool the person indicates is read here): whether it exists and has a price, its price, tick
 * and active liquidity. `exists` is v3's factory answer (a v4 pool is state of the PoolManager: it "exists" once priced).
 */
export interface PoolOnChain {
  pool: PoolRef
  /** The v3 pool's address, or the v4 pool id. */
  id: Hex
  exists: boolean
  initialized: boolean
  sqrtPriceX96: bigint
  tick: number
  liquidity: bigint
  block: bigint
}

/** A token's own `decimals()` and `symbol()` as read (the symbol is untrusted text; a read that fails is null, never guessed). */
export interface TokenOnChain {
  address: Address
  decimals: number | null
  symbol: string | null
}

const ERC20_META_ABI = [
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const

const MAX_UINT256 = (1n << 256n) - 1n
const MAX_UINT160 = (1n << 160n) - 1n
const MAX_UINT128 = (1n << 128n) - 1n
const MAX_UINT64 = (1n << 64n) - 1n
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const fail = (code: string): never => { throw new Error(code) }
const lower = (value: string): Address => (ADDRESS.test(value) ? (value.toLowerCase() as Address) : fail('invalid_wallet_reply'))
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const isNative = (token: string) => same(token, ZERO_ADDRESS)
const V3_FACTORY_ABI = v3FactoryAbi.abi as unknown as Abi
const V3_POOL_ABI = v3PoolAbi.abi as unknown as Abi
const V4_STATE_VIEW_ABI = v4StateViewAbi.abi as unknown as Abi
const POOL_KEY = [{ type: 'tuple', components: [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] }] as const
/**
 * Multicall3's aggregate3 at the chain profile's `multicall3` (a manifest dependency of every V2 chain): many reads in one
 * eth_call, each allowed to fail on its own. Added 2026-10-05 (readPools).
 */
const MULTICALL3_ABI = [{
  name: 'aggregate3', type: 'function', stateMutability: 'payable',
  inputs: [{ name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'allowFailure', type: 'bool' }, { name: 'callData', type: 'bytes' }] }],
  outputs: [{ name: 'returnData', type: 'tuple[]', components: [{ name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' }] }],
}] as const
/** One read inside an aggregate3. */
type Ask = { target: Address; abi: Abi; functionName: string; args: readonly unknown[] }

/** The PositionManager's packed PositionInfo: 200 bits of pool id | 24 tickUpper | 24 tickLower | 8 hasSubscriber (finance/position.ts). */
function positionInfo(info: bigint) {
  return { tickLower: Number(BigInt.asIntN(24, info >> 8n)), tickUpper: Number(BigInt.asIntN(24, info >> 32n)), poolIdPrefix: info >> 56n }
}

// ---------------------------------------------------------------------------
// The plan's shape: a server's plan is checked field by field before any check reads it.
// ---------------------------------------------------------------------------

const big = (value: unknown, max: bigint) => typeof value === 'bigint' && value >= 0n && value <= max
const int = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const addr = (value: unknown) => typeof value === 'string' && ADDRESS.test(value)
const hex = (value: unknown) => typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value)
const obj = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)
const INT24 = 8_388_607

function wellFormedPool(value: unknown): boolean {
  const pool = obj(value)
  return !!pool && (pool.dex === 3 || pool.dex === 4) && addr(pool.currency0) && addr(pool.currency1) && int(pool.fee, 0, 16_777_215)
    && int(pool.tickSpacing, -INT24 - 1, INT24) && addr(pool.hooks)
}
function wellFormedIntent(value: unknown): boolean {
  const i = obj(value)
  return !!i && int(i.action, 1, 4) && wellFormedPool(i.pool) && big(i.tokenId, MAX_UINT256) && int(i.tickLower, -INT24 - 1, INT24)
    && int(i.tickUpper, -INT24 - 1, INT24) && big(i.minLiquidity, MAX_UINT128) && int(i.feeBps, 0, 65_535) && addr(i.feeToken)
    && typeof i.routesHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(i.routesHash) && addr(i.recipient) && big(i.nonce, MAX_UINT256) && big(i.deadline, MAX_UINT64)
}
function wellFormedLegs(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => {
    const leg = obj(entry)
    return !!leg && int(leg.kind, 0, 255) && addr(leg.router) && addr(leg.tokenIn) && addr(leg.tokenOut) && big(leg.amountIn, MAX_UINT128)
      && big(leg.minAmountOut, MAX_UINT128) && hex(leg.data)
  })
}
const wellFormedInputs = (value: unknown) => Array.isArray(value) && value.every((entry) => { const input = obj(entry); return !!input && addr(input.token) && big(input.amount, MAX_UINT128) })

/** Every field of a plan typed and in its Solidity range, so no check below compares a string with a bigint. */
export function wellFormedPlan(value: unknown): value is ZapPlan {
  const zapPlan = obj(value)
  const plan = obj(zapPlan?.plan)
  if (!zapPlan || !plan || !wellFormedIntent(plan.intent) || !wellFormedLegs(plan.legs)) return false
  switch (zapPlan.action) {
    case 'create':
      return wellFormedInputs(plan.inputs) && big(plan.amount0Max, MAX_UINT128) && big(plan.amount1Max, MAX_UINT128) && big(plan.initSqrtPriceX96, MAX_UINT160)
    case 'increase':
      return wellFormedInputs(plan.inputs) && big(plan.amount0Max, MAX_UINT128) && big(plan.amount1Max, MAX_UINT128)
    case 'changeRange':
      return big(plan.liquidityToRemove, MAX_UINT128) && big(plan.amount0MinRemoved, MAX_UINT128) && big(plan.amount1MinRemoved, MAX_UINT128)
        && big(plan.amount0Max, MAX_UINT128) && big(plan.amount1Max, MAX_UINT128) && typeof plan.burnOld === 'boolean'
    case 'exit':
      return big(plan.liquidityToRemove, MAX_UINT128) && big(plan.amount0MinRemoved, MAX_UINT128) && big(plan.amount1MinRemoved, MAX_UINT128) && typeof plan.burn === 'boolean'
    default:
      return false
  }
}

/** A sqrt price, a band of them, or null where the basis allows none. */
const sqrtOrNull = (value: unknown) => value === null || big(value, MAX_UINT160)
const bandOrNull = (value: unknown) => {
  if (value === null) return true
  const band = obj(value)
  return !!band && Object.keys(band).length === 2 && big(band.lower, MAX_UINT160) && big(band.upper, MAX_UINT160) && (band.lower as bigint) <= (band.upper as bigint)
}
/** The plan's basis typed (F4): every figure a bigint in its Solidity range, a band's ends in order. */
function wellFormedBasis(value: unknown): value is PlanBasis {
  const basis = obj(value)
  if (!basis || !int(basis.slippageBps, 10, 500) || !sqrtOrNull(basis.poolSqrtPriceX96) || !sqrtOrNull(basis.sqrtPriceX96After) || !big(basis.expectedLiquidity, MAX_UINT128)) return false
  if (!bandOrNull(basis.mintBand) || !bandOrNull(basis.removalBand)) return false
  if (basis.position === null) return true
  const position = obj(basis.position)
  return !!position && int(position.tickLower, -INT24 - 1, INT24) && int(position.tickUpper, -INT24 - 1, INT24) && big(position.liquidity, MAX_UINT128)
}

/** The request's target typed (F1): an action, and its inputs (create, increase) or what an exit is taken out as. */
export function wellFormedTarget(value: unknown): value is PlanTarget {
  const target = obj(value)
  if (!target) return false
  if (target.action === 'create' || target.action === 'increase') return Array.isArray(target.inputs) && target.inputs.length > 0 && wellFormedInputs(target.inputs)
  if (target.action === 'changeRange') return true
  if (target.action !== 'exit') return false
  if (target.receive === 'both') return true
  const receive = obj(target.receive)
  return !!receive && addr(receive.convertTo)
}

/** The quote typed: an integer expiry, one row per leg with bigint amounts, a simulation verdict. */
export function wellFormedQuote(value: unknown): value is ZapQuote {
  const quote = obj(value)
  const simulation = obj(quote?.simulation)
  if (!quote || !simulation || !int(quote.requestedAt, 0, Number.MAX_SAFE_INTEGER) || !int(quote.expiresAt, 0, Number.MAX_SAFE_INTEGER) || !Array.isArray(quote.legs)) return false
  if (quote.ranks !== undefined && !(Array.isArray(quote.ranks) && quote.ranks.every((entry) => { const r = obj(entry); return !!r && addr(r.token) && int(r.rank, 0, 255) }))) return false
  if (typeof simulation.ok !== 'boolean' || !big(simulation.block, MAX_UINT64) || (simulation.error !== null && typeof simulation.error !== 'string')) return false
  if (quote.expectedRemoved !== undefined && !(Array.isArray(quote.expectedRemoved) && quote.expectedRemoved.length === 2 && quote.expectedRemoved.every((v) => big(v, MAX_UINT256)))) return false
  if (!wellFormedBasis(quote.basis)) return false
  return quote.legs.every((entry) => {
    const leg = obj(entry)
    return !!leg && big(leg.expectedOut, MAX_UINT256) && big(leg.minAmountOut, MAX_UINT256) && Array.isArray(leg.pools)
      && leg.pools.every((p) => { const pool = obj(p); return !!pool && (pool.dex === 3 || pool.dex === 4) && int(pool.fee, 0, 16_777_215) && addr(pool.hooks) })
  })
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}

/** A deep, frozen copy of plain data; anything that is not plain data (a function, a symbol) is no plan at all. */
function frozenCopy(value: unknown): unknown {
  try {
    return deepFreeze(structuredClone(value))
  } catch {
    return null
  }
}

const inputsOf = (zapPlan: ZapPlan): readonly TokenAmount[] => (zapPlan.action === 'create' || zapPlan.action === 'increase' ? zapPlan.plan.inputs : [])

/** The Permit2 batch a plan's signature covers: exactly its inputs, the intent's nonce and deadline (spec §2.5.2). */
export function permitOf(zapPlan: ZapPlan): PermitBatch {
  const intent = zapPlan.plan.intent
  return { permitted: inputsOf(zapPlan).map((input) => ({ token: input.token, amount: input.amount })), nonce: intent.nonce, deadline: intent.deadline }
}

/** The zap entry point a plan goes to on a consent. */
export function actionFunction(action: ActionName, consent: ZapConsent): ZapActionFunction {
  if (consent === 'permit2') {
    if (action === 'create') return 'createWithPermit'
    if (action === 'increase') return 'increaseWithPermit'
    return fail('plan_consent')
  }
  return action
}

/** A random 248-bit Permit2/zap nonce word, from the platform's CSPRNG. */
function randomWord(): bigint {
  const bytes = new Uint8Array(31)
  globalThis.crypto.getRandomValues(bytes)
  let word = 0n
  for (const byte of bytes) word = (word << 8n) | BigInt(byte)
  return word
}

/**
 * The S1 client for one wallet on one chain, with that chain's Domino contracts (from its pinned manifest only).
 * `randomWord` is the nonce word source (a CSPRNG by default). `unsettled` is the page's record of actions handed to
 * the wallet with no known outcome yet (./zapUnsettled.ts, F3; the browser's one store by default).
 */
export function createZapClient(wallet: V2Wallet, chain: V2Chain, supplied: V2Contracts, now: () => number = () => Date.now() / 1000, random: () => bigint = randomWord, unsettled: UnsettledActions = browserUnsettledActions()) {
  const contracts: V2Contracts = deepFreeze(structuredClone(supplied))
  const guard = () => {
    if (contracts.chainId !== chain.chainId) fail('deployment_wrong_chain')
    if (contracts.fixture !== false && DEPLOYABLE) fail('deployment_fixture_refused')
  }
  guard()
  // The app's own chain profile, and in a deployable build exactly the chain's PINNED manifest set (./deployment.ts).
  admitV2Contracts(chain, contracts)
  for (const [name, address] of Object.entries(contracts.addresses)) if (!ADDRESS.test(address) || !/^0x[0-9a-fA-F]{64}$/.test(contracts.codeHashes[name as V2Component] ?? '')) fail('deployment_invalid')
  if (chain.permit2 !== PERMIT2) fail('invalid_chain_profile')

  // Changed on purpose (data) 2026-10-02 (Domino V2 integration): every step this client sends, approvals included, only
  // with live contracts (./liveLock.ts); its signatures and batch below say so first too.
  const t = createTransactor(wallet, chain, now, () => refuseUnlessLive(chain.chainId, contracts))
  const owner = t.owner
  const reviews = new WeakMap<ZapReview, ReviewState>()
  const preparedFor = new WeakMap<PreparedV2, ZapReview>()
  const verified = new Map<Dex, { hookedPoolsAllowed: boolean }>()
  /** The prepared steps that are a plan's action (not an approval). */
  const actionPrepared = new WeakSet<PreparedV2>()
  /** The intentHash of every plan whose action this client handed to the wallet, as a transaction or in a batch (fix F1). */
  const handedOver = new Set<Hex>()
  const issuedBatches = new WeakSet<ZapBatch>()
  const batchReviews = new WeakMap<ZapBatch, ZapReview>()
  const offeredBatches = new Map<string, { batch: ZapBatch; review: ZapReview; inclusion?: { hash: Hex; blockNumber: bigint; blockHash: Hex } }>()

  const zapOf = (dex: Dex): Address => (dex === 3 ? contracts.addresses.zapV3 : contracts.addresses.zapV4).toLowerCase() as Address
  const managerOf = (dex: Dex): Address => (dex === 3 ? chain.uniswap.v3.positionManager : chain.uniswap.v4.positionManager)
  const managerAbi = (dex: Dex): Abi => (dex === 3 ? V3_POSITION_MANAGER_ABI : V4_POSITION_MANAGER_ABI)
  const registry = () => contracts.addresses.registry.toLowerCase() as Address
  const expiring = (deadline: bigint) => deadline - BigInt(Math.floor(now())) < BigInt(MIN_DEADLINE_LEFT_S)
  const entryOf = (space: 'permit2' | 'zap', verifier: Address, nonce: bigint): SignedNonce => ({ chainId: chain.chainId, owner, space, verifier, nonce })

  async function read<T>(rpc: Rpc, to: Address, abi: Abi, functionName: string, args: readonly unknown[], block: Hex | 'latest'): Promise<T> {
    const data = encodeFunctionData({ abi, functionName, args })
    return decodeFunctionResult({ abi, functionName, data: await t.call(rpc, to, data, block) }) as T
  }
  const allowanceOf = (rpc: Rpc, token: Address, spender: Address, block: Hex | 'latest') => read<bigint>(rpc, token, ERC20_ABI, 'allowance', [owner, spender], block)
  async function bitUsed(rpc: Rpc, verifier: Address, abi: Abi, nonce: bigint, block: Hex | 'latest'): Promise<boolean> {
    const bitmap = await read<bigint>(rpc, verifier, abi, 'nonceBitmap', [owner, nonce >> 8n], block)
    return ((bitmap >> (nonce & 255n)) & 1n) === 1n
  }

  /**
   * Before the first write: the registry's and this DEX's zap's code against the manifest, the zap's position manager
   * against the chain profile's, and its hooks policy (spec §1.4, §2.1, §7.3), through the one shared check
   * (./deployment.ts, once per session per chain and component; a failed check is never remembered).
   */
  async function verifyDeployment(rpc: Rpc, dex: Dex, block: Hex | 'latest'): Promise<{ hookedPoolsAllowed: boolean }> {
    const done = verified.get(dex)
    if (done) return done
    const zapName: V2Component = dex === 3 ? 'zapV3' : 'zapV4'
    await verifyV2Code((address) => rpc('eth_getCode', [address, block]), contracts, ['registry', zapName])
    const checks = await checkZapPositionManager((to, data) => t.call(rpc, to, data, block), contracts, chain, [dex])
    const check = checks[dex] ?? fail('deployment_identity_changed')
    const result = Object.freeze({ hookedPoolsAllowed: check.hookedPoolsAllowed })
    verified.set(dex, result)
    return result
  }

  /**
   * Whether `at` is a Domino V2 vault of this chain (review F7, OP5): either factory's `isVault`, read at `block` once
   * their code was checked against the manifest. address(0) is none.
   */
  async function isDominoVault(rpc: Rpc, at: Address, block: Hex | 'latest'): Promise<boolean> {
    if (same(at, ZERO_ADDRESS)) return false
    await verifyV2Code((address) => rpc('eth_getCode', [address, block]), contracts, ['vaultFactoryV3', 'vaultFactoryV4'])
    for (const factory of [contracts.addresses.vaultFactoryV3, contracts.addresses.vaultFactoryV4]) {
      if (await read<boolean>(rpc, factory.toLowerCase() as Address, VAULT_FACTORY_ABI, 'isVault', [at], block)) return true
    }
    return false
  }

  /**
   * Whether `vault` (already known a Domino vault of this chain) holds this position as its root, and whether that root
   * is armed (its own `root()` and `rootArmed()`, read at `block`). Null when its root is another position. Changed on
   * purpose (data) 2026-10-02 (Domino V2 rev2 review, L2): a v4 root disarmed earlier keeps the vault as its subscriber,
   * and a vault's approval or subscription alone said "armed" for good.
   */
  async function rootOf(rpc: Rpc, vault: Address, dex: Dex, tokenId: bigint, block: Hex | 'latest'): Promise<{ armed: boolean } | null> {
    const root = await read<{ dex: number; positionManager: string; tokenId: bigint }>(rpc, vault, VAULT_ABI, 'root', [], block)
    if (root.dex !== dex || !same(root.positionManager, managerOf(dex)) || root.tokenId !== tokenId) return null
    return { armed: await read<boolean>(rpc, vault, VAULT_ABI, 'rootArmed', [], block) }
  }

  /** The vault whose root this position is (its approval, or on v4 its subscriber, is that vault), and whether it is armed. */
  async function vaultRootOf(rpc: Rpc, dex: Dex, tokenId: bigint, approved: Address | null, block: Hex): Promise<{ vault: Address; armed: boolean } | null> {
    const candidates: Address[] = []
    if (approved !== null && !same(approved, zapOf(dex))) candidates.push(approved)
    if (dex === 4) candidates.push(lower(await read<Address>(rpc, managerOf(dex), V4_POSITION_MANAGER_ABI, 'subscriber', [tokenId], block)))
    for (const candidate of candidates) {
      if (!(await isDominoVault(rpc, candidate, block))) continue
      const root = await rootOf(rpc, candidate, dex, tokenId, block)
      if (root) return { vault: candidate, armed: root.armed }
    }
    return null
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Actions handed to the wallet with no known outcome (Domino V2 rev2 review, F3; ./zapUnsettled.ts)
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Whether the chain says a held action can no longer run (its outcome is final, whatever it was): a block past its
   * deadline (a late inclusion reverts with PlanExpired), its step's receipt, the wallet's final status for its batch,
   * its PositionLiquidityChanged (the intentHash is the first indexed topic: it ran), or its step's nonce taken by the
   * chain with no such event (it reverted, or another transaction took the nonce).
   */
  async function settledOnChain(rpc: Rpc, held: UnsettledAction, latest: { number: bigint; timestamp: bigint }): Promise<boolean> {
    if (latest.timestamp > BigInt(held.deadline)) return true
    if (held.hash !== null && (await rpc('eth_getTransactionReceipt', [held.hash])) !== null) return true
    if (held.batchId !== null) {
      const status = await batchCallsStatus((method, params) => rpc(method, params), held.batchId)
      if (status !== null && status >= 200) return true
    }
    const found = await rpc('eth_getLogs', [{ address: held.zap, topics: [RECEIPT_TOPICS.PositionLiquidityChanged, held.intentHash], fromBlock: numberToHex(BigInt(held.fromBlock)), toBlock: 'latest' }])
    if (!Array.isArray(found)) return fail('invalid_wallet_reply')
    if (found.some((entry) => obj(entry) !== null && obj(entry)?.removed !== true)) return true
    if (held.nonce !== null && quantity(await rpc('eth_getTransactionCount', [owner, 'latest'])) > BigInt(held.nonce)) return true
    return false
  }

  /**
   * Before any new zap review, action, or batch on this chain: every action of this owner handed to the wallet with no
   * known outcome is settled by the chain, or the operation is refused (`zap_action_unsettled`: "already sent, check your
   * wallet"; the person may say they rejected it, `forgetUnsettled`). `except` is the plan the operation is about.
   */
  async function settleHeld(rpc: Rpc, except: Hex | null = null): Promise<void> {
    const held = unsettled.list(chain.chainId, owner).filter((entry) => except === null || entry.intentHash !== except.toLowerCase())
    if (held.length === 0) return
    const latest = await t.latestBlock(rpc)
    for (const entry of held) {
      if (await settledOnChain(rpc, entry, latest)) unsettled.drop(chain.chainId, owner, entry.intentHash)
      else fail('zap_action_unsettled')
    }
  }

  /** The record of an action handed to the wallet, as it is put before the wallet is asked. */
  const heldRecord = (review: ZapReview, kind: 'step' | 'batch', nonce: bigint | null): UnsettledAction => ({
    chainId: chain.chainId, zap: review.zap, intentHash: review.intentHash.toLowerCase() as Hex, fromBlock: review.block.toString(10),
    deadline: review.deadline.toString(10), kind, hash: null, batchId: null, nonce: nonce === null ? null : nonce.toString(10), at: Math.floor(now()),
  })
  const heldOf = (intentHash: Hex) => unsettled.list(chain.chainId, owner).find((entry) => entry.intentHash === intentHash.toLowerCase()) ?? null
  const letGo = (intentHash: Hex) => unsettled.drop(chain.chainId, owner, intentHash)

  /**
   * The ActionResult of the app's own simulation of a review's action against its plan (F4): refused, with the reason,
   * when it is not this plan's, falls under its minimum, or is further from what the plan expects than its tolerance.
   */
  function checkSimulated(state: ReviewState, returned: Hex): void {
    const problems = actionResultProblems(state.plan, state.basis, actionResultOf(returned))
    if (problems.length > 0) throw new ZapRefusal(problems)
  }

  /** The NFT's holder and approved address on the chain's position manager; null when it does not exist (burned or never minted). */
  async function nftOf(rpc: Rpc, dex: Dex, tokenId: bigint, block: Hex | 'latest'): Promise<{ holder: Address; approved: Address } | null> {
    try {
      const holder = lower(await read<Address>(rpc, managerOf(dex), managerAbi(dex), 'ownerOf', [tokenId], block))
      const approved = lower(await read<Address>(rpc, managerOf(dex), managerAbi(dex), 'getApproved', [tokenId], block))
      return { holder, approved }
    } catch (error) {
      if (revertIn(error)) return null
      throw error
    }
  }

  /** A position as the chain has it at `block`: v4 from the PositionManager, v3 from the NonfungiblePositionManager. */
  async function positionAt(rpc: Rpc, dex: Dex, tokenId: bigint, block: Hex): Promise<{ position: PositionOnChain; approved: Address } | string> {
    const nft = await nftOf(rpc, dex, tokenId, block)
    if (!nft) return 'position_not_found'
    const manager = managerOf(dex)
    if (dex === 4) {
      const [key, info] = await read<readonly [{ currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }, bigint]>(rpc, manager, V4_POSITION_MANAGER_ABI, 'getPoolAndPositionInfo', [tokenId], block)
      if (key.tickSpacing === 0) return 'position_not_found'
      const pool: PoolRef = { dex: 4, currency0: lower(key.currency0), currency1: lower(key.currency1), fee: key.fee, tickSpacing: key.tickSpacing, hooks: lower(key.hooks) }
      const decoded = positionInfo(info)
      const poolId = keccak256(encodeAbiParameters(POOL_KEY, [{ currency0: pool.currency0, currency1: pool.currency1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks }]))
      if (decoded.poolIdPrefix !== BigInt(poolId) >> 56n || decoded.tickLower >= decoded.tickUpper) return 'position_identity'
      const liquidity = await read<bigint>(rpc, manager, V4_POSITION_MANAGER_ABI, 'getPositionLiquidity', [tokenId], block)
      return { position: { tokenId, owner: nft.holder, pool, tickLower: decoded.tickLower, tickUpper: decoded.tickUpper, liquidity }, approved: nft.approved }
    }
    const row = await read<readonly [bigint, string, string, string, number, number, number, bigint]>(rpc, manager, V3_POSITION_MANAGER_ABI, 'positions', [tokenId], block)
    const [, , token0, token1, fee, tickLower, tickUpper, liquidity] = row
    let spacing = v3TickSpacing(chain, fee)
    // A tier outside the profile's table (spec §1.4): its spacing is the factory's.
    if (spacing === null) spacing = Number(await read<number>(rpc, chain.uniswap.v3.factory, V3_FACTORY_ABI, 'feeAmountTickSpacing', [fee], block))
    if (!spacing || tickLower >= tickUpper) return 'position_identity'
    const pool: PoolRef = { dex: 3, currency0: lower(token0), currency1: lower(token1), fee, tickSpacing: spacing, hooks: ZERO_ADDRESS }
    return { position: { tokenId, owner: nft.holder, pool, tickLower, tickUpper, liquidity }, approved: nft.approved }
  }

  /** Whether the owner can be paid plain ETH: a plain account can; an account with code is probed with one wei, at the review's block. */
  /**
   * A pool as the chain has it at `block`, through the wallet: v3 by the profile's factory (`getPool`, then the pool's
   * `slot0` and `liquidity`; a pool the factory does not know reads as not existing, unpriced), v4 by the profile's
   * StateView (`getSlot0(poolId)`, `getLiquidity(poolId)`; a v4 pool with no price is not initialized). Rev2 §2.6.5:
   * the advanced "Create a new pool" path appears only when this reads unpriced.
   */
  async function poolAt(rpc: Rpc, pool: PoolRef, block: Hex | 'latest', number: bigint): Promise<PoolOnChain> {
    if (pool.dex === 3) {
      const address = lower(await read<Address>(rpc, chain.uniswap.v3.factory, V3_FACTORY_ABI, 'getPool', [pool.currency0, pool.currency1, pool.fee], block))
      if (isNative(address)) return { pool, id: address, exists: false, initialized: false, sqrtPriceX96: 0n, tick: 0, liquidity: 0n, block: number }
      const slot0 = await read<readonly [bigint, number]>(rpc, address, V3_POOL_ABI, 'slot0', [], block)
      const liquidity = await read<bigint>(rpc, address, V3_POOL_ABI, 'liquidity', [], block)
      return { pool, id: address, exists: true, initialized: slot0[0] !== 0n, sqrtPriceX96: slot0[0], tick: Number(slot0[1]), liquidity, block: number }
    }
    const id = keccak256(encodeAbiParameters(POOL_KEY, [{ currency0: pool.currency0, currency1: pool.currency1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks }]))
    const slot0 = await read<readonly [bigint, number, number, number]>(rpc, chain.uniswap.v4.stateView, V4_STATE_VIEW_ABI, 'getSlot0', [id], block)
    const liquidity = await read<bigint>(rpc, chain.uniswap.v4.stateView, V4_STATE_VIEW_ABI, 'getLiquidity', [id], block)
    return { pool, id, exists: slot0[0] !== 0n, initialized: slot0[0] !== 0n, sqrtPriceX96: slot0[0], tick: Number(slot0[1]), liquidity, block: number }
  }

  /** The v3 tick spacing of a fee tier, from the profile's factory (`feeAmountTickSpacing`; 0 means the tier is not enabled). */
  async function v3SpacingOf(rpc: Rpc, fee: number, block: Hex | 'latest'): Promise<number> {
    return Number(await read<number>(rpc, chain.uniswap.v3.factory, V3_FACTORY_ABI, 'feeAmountTickSpacing', [fee], block))
  }

  async function takesEth(rpc: Rpc, account: AccountCode, block: Hex): Promise<boolean> {
    if (account.kind === 'plain') return true
    try {
      await rpc('eth_call', [{ from: owner, to: owner, value: '0x1' }, block])
      return true
    } catch (error) {
      if (revertIn(error)) return false
      throw error
    }
  }

  /**
   * Reviews a plan: every read at one block, every check, the steps. Throws a ZapRefusal (its message is the first
   * failure, `failures` all of them) for any problem; nothing is asked of the wallet but reads.
   */
  async function review(input: ZapReviewInput): Promise<ZapReview> {
    guard()
    if (input.consent === 'relayed') throw new ZapRefusal(['relayed_not_offered'])
    if (input.consent !== 'direct' && input.consent !== 'permit2') throw new ZapRefusal(['plan_consent'])
    if (input.chainId !== chain.chainId) throw new ZapRefusal(['plan_wrong_chain'])
    // Frozen copies, taken once and checked as copied: what is checked is exactly what is hashed, signed and encoded.
    const zapPlan = frozenCopy(input.plan)
    const quote = frozenCopy(input.quote)
    const target = frozenCopy(input.target)
    if (!wellFormedPlan(zapPlan)) throw new ZapRefusal(['plan_shape'])
    if (!wellFormedQuote(quote)) throw new ZapRefusal(['quote_shape'])
    // F1: what the person asked for, to tie the plan's swaps to (the recipient is the connected wallet, always: L5).
    if (!wellFormedTarget(target)) throw new ZapRefusal(['plan_target'])
    const consent: ZapConsent = input.consent
    const { intent, legs } = zapPlan.plan
    const pool = intent.pool
    const dex = pool.dex
    const zap = zapFor(contracts, chain.chainId, pool)
    if (!zap) throw new ZapRefusal(['plan_wrong_chain'])
    const zapAddress = zap.toLowerCase() as Address
    const inputs = inputsOf(zapPlan)

    return t.bounded(async (rpc) => {
      await t.identity(rpc)
      // F3: nothing new is reviewed while an action of this owner handed to the wallet may still run on this chain.
      await settleHeld(rpc)
      const block = await t.latestBlock(rpc)
      const { hookedPoolsAllowed } = await verifyDeployment(rpc, dex, block.tag)
      const failures: string[] = []

      // The account's code on THIS chain (EIP-7702 delegation is per chain): only a plain account signs a Permit2
      // permit; any delegated or contract account is direct only (spec §2.5.4, open point 8).
      const account = await readAccountCode((method, params) => rpc(method, params), owner, block.tag)
      if (consent === 'permit2' && account.kind !== 'plain') failures.push('permit2_account_not_plain')

      // The registry's ranks for every token the legs touch; for the profile's charge currencies they must agree.
      const ranks = new Map<string, number>()
      for (const token of new Set(legs.flatMap((leg) => [leg.tokenIn.toLowerCase(), leg.tokenOut.toLowerCase()]))) {
        const rank = Number(await read<number>(rpc, registry(), REGISTRY_ABI, 'chargeCurrencyRank', [token], block.tag))
        const profile = profileRank(chain, token)
        if (profile !== 0 && rank !== profile) failures.push('registry_rank_mismatch')
        ranks.set(token, rank)
      }
      // Rev2 §2.4 app check 2: the ranks the plan's fee rule used (`fee.ranks`) are the registry's, token for token.
      if (quote.ranks !== undefined) {
        const named = new Map(quote.ranks.map((entry) => [entry.token.toLowerCase(), entry.rank]))
        if (named.size !== quote.ranks.length || named.size !== ranks.size || [...ranks].some(([token, rank]) => named.get(token) !== rank)) failures.push('plan_fee_ranks')
      }
      const versions = new Map<string, number>()
      for (const router of new Set(legs.filter((leg) => leg.kind === 1).map((leg) => leg.router.toLowerCase()))) {
        versions.set(router, Number(await read<number>(rpc, registry(), REGISTRY_ABI, 'routerVersion', [router], block.tag)))
      }

      // The position acted on, and its approval.
      let position: PositionOnChain | undefined
      let approved: Address | null = null
      let pausesAutomation: Address | null = null
      let vaultRoot: Address | null = null
      if (zapPlan.action !== 'create') {
        const found = await positionAt(rpc, dex, intent.tokenId, block.tag)
        if (typeof found === 'string') failures.push(found)
        else ({ position, approved } = found)
        // A position under automation (rev2 §2.13, decision #5). A successor is held by a vault: no zap action (the
        // owner withdraws it from the vault first). A root (its individual approval, or on v4 its subscriber, is a vault
        // of either of this chain's Domino factories, whose `root()` is this position): when that vault reads it ARMED
        // (`rootArmed()`, L2), a change of range is refused and an increase or an exit pauses its automation, allowed only
        // once the person acknowledges it (`acknowledgePause`); a disarmed root pauses nothing.
        if (position) {
          const root = await vaultRootOf(rpc, dex, intent.tokenId, approved, block.tag)
          if (root) {
            vaultRoot = root.vault
            if (root.armed) pausesAutomation = root.vault
          }
          if (pausesAutomation !== null && zapPlan.action === 'changeRange') failures.push('position_vault_root')
          if (!same(position.owner, owner) && (await isDominoVault(rpc, position.owner, block.tag))) failures.push('position_vault_successor')
        }
      }
      // Check 13 (rev2 §2.4, §2.6.5): a plan that initializes a pool does so only on a pool the chain reads unpriced at
      // this block, at exactly the price the app computed from what the person typed.
      let createsPool = false
      if (zapPlan.action === 'create') {
        const init = zapPlan.plan.initSqrtPriceX96
        if (init !== 0n) {
          createsPool = true
          if (input.initSqrtPriceX96 === undefined || input.initSqrtPriceX96 !== init) failures.push('plan_init_price_mismatch')
          if (dex === 3 && (await v3SpacingOf(rpc, pool.fee, block.tag)) !== pool.tickSpacing) failures.push('plan_pool_spacing')
          if ((await poolAt(rpc, pool, block.tag, block.number)).initialized) failures.push('plan_pool_has_price')
        } else if (input.initSqrtPriceX96 !== undefined) failures.push('plan_init_price_mismatch')
      }
      // F4 (Domino V2 rev2 review): the plan's minimums were computed from its own reading of the chain. The pool's price
      // read here, at this block, through the wallet, must be inside the ±s band around the price they used (for a
      // removal, exactly its removal band), and the position's range and liquidity must be the ones its removal minimums
      // used; the action's own simulation is checked against the plan when it is prepared and right before it is sent.
      const poolNow = createsPool ? null : await poolAt(rpc, pool, block.tag, block.number)
      failures.push(...basisProblems(zapPlan, quote.basis, { poolSqrtPriceX96: poolNow && poolNow.initialized ? poolNow.sqrtPriceX96 : null, position: position ?? null }, createsPool))
      const needsNft = (zapPlan.action === 'increase' && dex === 4) || zapPlan.action === 'changeRange' || zapPlan.action === 'exit'
      const manager = managerOf(dex)

      // The allowances each ERC-20 input needs: to the zap (direct), or to Permit2.
      const spender = consent === 'direct' ? zapAddress : chain.permit2
      const allowances: { token: Address; amount: bigint; allowance: bigint }[] = []
      for (const item of inputs) {
        if (isNative(item.token)) continue
        const token = item.token.toLowerCase() as Address
        allowances.push({ token, amount: item.amount, allowance: await allowanceOf(rpc, token, spender, block.tag) })
      }

      // Permit2's nonce: free in its bitmap and not held in this page's journal (spec §2.5.2).
      const permit = consent === 'permit2' && (zapPlan.action === 'create' || zapPlan.action === 'increase') ? permitOf(zapPlan) : null
      if (permit) {
        const used = await bitUsed(rpc, chain.permit2, PERMIT2_ABI, intent.nonce, block.tag)
        if (used || wallet.signatures.held(entryOf('permit2', chain.permit2, intent.nonce))) failures.push('plan_nonce_used')
      }

      // Native ETH paid out to the owner (refunds, a v4 ETH pool's withdrawal): never to an account that refuses it.
      const touchesNative = inputs.some((item) => isNative(item.token)) || isNative(pool.currency0) || legs.some((leg) => isNative(leg.tokenIn) || isNative(leg.tokenOut))
      if (touchesNative && same(intent.recipient, owner) && !(await takesEth(rpc, account, block.tag))) failures.push('native_eth_refused')

      const context: PlanContext = {
        chain, contracts, owner, consent, now: now(), quoteRequestedAt: quote.requestedAt, quoteExpiresAt: quote.expiresAt,
        rankOf: (token) => ranks.get(token.toLowerCase()) ?? fail('rank_unread'),
        routerVersion: (router) => versions.get(router.toLowerCase()) ?? null,
        hookedPoolsAllowed, position, target, permit: permit ?? undefined,
        quotedLegs: quote.legs, simulation: quote.simulation, expectedRemoved: quote.expectedRemoved,
      }
      const verdict = checkPlan(zapPlan, context)
      failures.push(...verdict.failures)
      if (expiring(intent.deadline)) failures.push('plan_expiring')
      const rows = reviewLegs(legs, quote.legs)
      if (failures.length > 0 || !rows) throw new ZapRefusal([...new Set(failures.length ? failures : ['plan_review_legs'])])

      // The steps, in order (spec §2.5.1, §2.5.2, §2.10).
      const steps: ZapStep[] = []
      for (const { token, amount, allowance } of allowances) {
        if (allowance >= amount) continue
        if (allowance > 0n) steps.push({ kind: 'approve-reset', token, spender, amount })
        steps.push({ kind: 'approve', token, spender, amount })
      }
      const nftApproved = approved !== null && same(approved, zapAddress)
      if (needsNft && !nftApproved) steps.push({ kind: 'approve-nft', manager, tokenId: intent.tokenId, spender: zapAddress })
      if (permit) steps.push({ kind: 'sign-permit', nonce: intent.nonce })
      steps.push({ kind: 'action', functionName: actionFunction(zapPlan.action, consent), to: zapAddress, value: verdict.value })

      const rankOf = context.rankOf
      const fee = assistedSwapFee(legs, quote.legs.map((leg) => leg.expectedOut), rankOf)
      const warnings: ZapWarning[] = []
      const adds = zapPlan.action === 'create' || zapPlan.action === 'increase' || zapPlan.action === 'changeRange'
      const weth = chain.wrappedNative.address
      if (dex === 3 && adds && (same(pool.currency0, weth) || same(pool.currency1, weth)) && (inputs.some((item) => isNative(item.token)) || legs.some((leg) => isNative(leg.tokenOut)))) warnings.push('v3_weth_leftovers')
      if (dex === 4 && zapPlan.action === 'increase') warnings.push('v4_increase_sends_fees')
      if (zapPlan.action === 'changeRange') warnings.push('change_range_new_nft')
      if (zapPlan.action === 'exit' && legs.length > 0) warnings.push('exit_conversion_dust')
      const burns = (zapPlan.action === 'changeRange' && zapPlan.plan.burnOld) || (zapPlan.action === 'exit' && zapPlan.plan.burn)
      if (needsNft && !burns) warnings.push('nft_approval_stays')

      const permit2Offered = account.kind === 'plain' && (zapPlan.action === 'create' || zapPlan.action === 'increase') && inputs.length > 0
        && inputs.every((item) => !isNative(item.token)) && same(intent.recipient, owner)

      const result: ZapReview = deepFreeze({
        chainId: chain.chainId,
        owner,
        action: zapPlan.action,
        dex,
        zap: zapAddress,
        consent,
        intentHash: intentHash(chain.chainId, zapAddress, intent),
        block: block.number,
        deadline: intent.deadline,
        quoteExpiresAt: quote.expiresAt,
        plan: zapPlan,
        steps,
        legs: rows,
        fee: fee ? { estimate: true as const, bps: V2_FEES.assistedSwapBps, ...fee } : null,
        warnings,
        account: account.kind,
        permit2Offered,
        value: verdict.value,
        position: position ?? null,
        replacesApproval: needsNft && !nftApproved && approved !== null && !isNative(approved) ? approved : null,
        pausesAutomation,
        vaultRoot,
        createsPool,
      })
      reviews.set(result, { plan: zapPlan, context, basis: quote.basis, permit, manager, needsNft, signature: null, pauseAcknowledged: false })
      return result
    })
  }

  const stateOf = (review: ZapReview): ReviewState => reviews.get(review) ?? fail('review_not_from_this_client')

  /**
   * Whether a review may still be consented to (prepared, signed or sent): not within a minute of its deadline
   * (`plan_expiring`), not at or after its quote's expiry (`plan_quote_expired`, decision #3: a 3-minute quote, re-quoted
   * before any consent), and, on an armed root, only once the pause of its automation was acknowledged (rev2 §2.13).
   */
  function consentable(review: ZapReview, state: ReviewState): void {
    if (expiring(review.deadline)) fail('plan_expiring')
    if (Math.floor(now()) >= Math.floor(review.quoteExpiresAt)) fail('plan_quote_expired')
    if (review.pausesAutomation !== null && !state.pauseAcknowledged) fail('automation_pause_unacknowledged')
  }

  /**
   * The person ticked "This pauses automation for this position. You can turn it back on afterwards." on a review of an
   * armed root's increase or exit (rev2 §2.13, decision #5): its steps may be prepared from now on. A review that pauses
   * nothing needs no acknowledgement.
   */
  function acknowledgePause(review: ZapReview): void {
    const state = stateOf(review)
    if (review.pausesAutomation === null) return
    state.pauseAcknowledged = true
  }

  /** One step as a transaction draft, re-reading that it is still needed and, for the action, that every earlier one is done. */
  async function draftFor(rpc: Rpc, review: ZapReview, state: ReviewState, step: ZapStep): Promise<StepDraft> {
    switch (step.kind) {
      case 'approve-reset': {
        const allowance = await allowanceOf(rpc, step.token, step.spender, 'latest')
        if (allowance === 0n || allowance >= step.amount) fail('step_not_needed')
        return { kind: 'approve-reset', to: step.token, value: 0n, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [step.spender, 0n] }),
          summary: [`Reset the allowance of ${step.token} to ${step.spender} to zero, before setting the exact amount.`] }
      }
      case 'approve': {
        const allowance = await allowanceOf(rpc, step.token, step.spender, 'latest')
        if (allowance >= step.amount) fail('step_not_needed')
        // A short non-zero allowance is reset first: some tokens refuse a non-zero to non-zero change.
        if (allowance !== 0n) fail('step_out_of_order')
        return { kind: 'approve', to: step.token, value: 0n, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [step.spender, step.amount] }),
          summary: [`Approve exactly ${step.amount} smallest units of ${step.token} to ${step.spender}. No unlimited approval.`] }
      }
      case 'approve-nft': {
        const nft = await nftOf(rpc, review.dex, step.tokenId, 'latest')
        if (!nft) return fail('position_not_found')
        if (nft.holder !== owner) fail('position_not_owned')
        if (same(nft.approved, step.spender)) fail('step_not_needed')
        return { kind: 'approve-nft', to: step.manager, value: 0n, data: encodeFunctionData({ abi: managerAbi(review.dex), functionName: 'approve', args: [step.spender, step.tokenId] }),
          summary: [`Approve Domino's zap ${step.spender} for position ${step.tokenId} only, never for all positions.`] }
      }
      case 'sign-permit':
        return fail('step_is_signature')
      case 'action': {
        const zapPlan = state.plan
        const spender = review.consent === 'direct' ? review.zap : chain.permit2
        for (const item of inputsOf(zapPlan)) {
          if (isNative(item.token)) continue
          if (await allowanceOf(rpc, item.token.toLowerCase() as Address, spender, 'latest') < item.amount) fail('approval_missing')
        }
        if (state.needsNft) {
          const nft = await nftOf(rpc, review.dex, zapPlan.plan.intent.tokenId, 'latest')
          if (!nft) return fail('position_not_found')
          if (!same(nft.approved, review.zap)) fail('nft_approval_missing')
        }
        let args: readonly unknown[] = [zapPlan.plan]
        if (review.consent === 'permit2') {
          if (!state.signature || !state.permit) return fail('permit_signature_missing')
          if (await bitUsed(rpc, chain.permit2, PERMIT2_ABI, state.permit.nonce, 'latest')) fail('plan_nonce_used')
          // The permit argument is { permitted, nonce, deadline } only: the zap is the spender, the witness is the plan's intent.
          args = [zapPlan.plan, { permitted: state.permit.permitted, nonce: state.permit.nonce, deadline: state.permit.deadline }, state.signature.signature]
        }
        return { kind: step.functionName, to: step.to, value: step.value, data: encodeFunctionData({ abi: ZAP_ABI, functionName: step.functionName, args }),
          summary: [`${step.functionName} on Domino's zap ${step.to}, plan ${review.intentHash}.`] }
      }
    }
  }

  /** One step of a review, prepared through the shared sender: re-read, simulated from the owner, estimated, frozen. */
  async function prepareStep(review: ZapReview, index: number, gas: V2GasBudget | null = null): Promise<PreparedV2> {
    guard()
    const state = stateOf(review)
    if (!Number.isSafeInteger(index) || index < 0 || index >= review.steps.length) fail('step_unknown')
    const step = review.steps[index]
    consentable(review, state)
    // A plan's action is handed to the wallet once, ever, on either path (review fix F1): on the direct path the zap
    // consumes no nonce, so the same action could otherwise run twice after an unknown outcome.
    if (step.kind === 'action' && handedOver.has(review.intentHash)) fail('review_already_sent')
    return t.bounded(async (rpc) => {
      await t.identity(rpc)
      // F3: an action is not prepared while another of this owner may still run on this chain.
      if (step.kind === 'action') await settleHeld(rpc, review.intentHash)
      await verifyDeployment(rpc, review.dex, 'latest')
      // F4: the action's simulation from the owner returns its ActionResult, checked against the plan.
      const prepared = await t.prepare(rpc, await draftFor(rpc, review, state, step), gas, step.kind === 'action' ? (returned) => checkSimulated(state, returned) : undefined)
      preparedFor.set(prepared, review)
      if (step.kind === 'action') actionPrepared.add(prepared)
      return prepared
    })
  }

  /**
   * Offers a prepared step once (the shared sender's discipline); an action whose plan is about to expire is not sent.
   * An action is marked handed over before the shared sender is called, and the mark is let go only when the wallet was
   * never asked for it, or refused it definitely (the shared sender's `wasOffered` is then false): any other outcome
   * keeps it, and the same plan's action is refused (`review_already_sent`) on both paths from then on.
   *
   * Changed on purpose (data) 2026-10-02 (Domino V2 rev2 review): an action is sent only once every other action of this
   * owner on this chain is settled (F3), and is recorded as held (./zapUnsettled.ts) right before the wallet is asked,
   * its hash added once the wallet answers; the record goes when the wallet refused or was never asked, or once the
   * chain settles it (`receipt`, or the next operation's check). Its last simulation is checked against the plan (F4).
   * The wallet's answer is kept even if the wallet changed after giving it (F2, ./transact.ts).
   */
  async function send(prepared: PreparedV2, acknowledged: boolean): Promise<Hex> {
    guard()
    refuseUnlessLive(chain.chainId, contracts)
    const review = preparedFor.get(prepared)
    const action = review !== undefined && actionPrepared.has(prepared) ? review : null
    if (action) {
      // The very step already offered is the shared sender's refusal (it is never sent twice); another step of the same
      // plan is this one's.
      if (handedOver.has(action.intentHash)) fail(t.wasOffered(prepared) ? 'wallet_review_required' : 'review_already_sent')
      handedOver.add(action.intentHash)
    }
    let recorded = false
    const release = () => {
      if (!action) return
      handedOver.delete(action.intentHash)
      if (recorded) letGo(action.intentHash)
    }
    try {
      const hash = await t.send(prepared, acknowledged, async (rpc) => {
        guard()
        if (review) consentable(review, stateOf(review))
        if (action) {
          await settleHeld(rpc, action.intentHash)
          unsettled.put(owner, heldRecord(action, 'step', BigInt(prepared.transaction.nonce)))
          recorded = true
        }
      }, {
        inspect: action ? (returned) => checkSimulated(stateOf(action), returned) : undefined,
        // A definite refusal that arrives after the operation's window ended: nothing of it can run.
        onRefusal: async () => release(),
      })
      if (action) {
        const held = heldOf(action.intentHash)
        if (held) unsettled.put(owner, { ...held, hash })
      }
      return hash
    } catch (error) {
      if (action && (refused(error) || !t.wasOffered(prepared))) release()
      throw error
    }
  }

  /**
   * Signs the Permit2 batch witness of a permit2 review whose approvals to Permit2 (and, for a v4 increase, the NFT
   * approval) are in place. The nonce is recorded in the signature journal before the prompt and forgotten only when
   * nothing was signed. The signature stays bound to this review for its WithPermit call.
   */
  async function signPermit(review: ZapReview): Promise<SignedTypedData> {
    guard()
    refuseUnlessLive(chain.chainId, contracts)
    const state = stateOf(review)
    if (review.consent !== 'permit2' || !state.permit) return fail('review_not_permit2')
    if (state.signature) fail('permit_already_signed')
    consentable(review, state)
    const permit = state.permit
    const intent = state.plan.plan.intent
    const entry = entryOf('permit2', chain.permit2, permit.nonce)
    return t.bounded(async (rpc) => {
      await t.identity(rpc)
      // F3 (Domino V2 rev2 review): a signed permit can be submitted by anyone, so none is signed for a plan while another
      // action of this owner handed to the wallet may still run on this chain.
      await settleHeld(rpc, review.intentHash)
      await verifyDeployment(rpc, review.dex, 'latest')
      for (const item of permit.permitted) {
        if (await allowanceOf(rpc, item.token.toLowerCase() as Address, chain.permit2, 'latest') < item.amount) fail('permit_allowance_missing')
      }
      if (state.needsNft) {
        const nft = await nftOf(rpc, review.dex, intent.tokenId, 'latest')
        if (!nft || !same(nft.approved, review.zap)) fail('nft_approval_missing')
      }
      if (await bitUsed(rpc, chain.permit2, PERMIT2_ABI, permit.nonce, 'latest') || wallet.signatures.held(entry)) fail('plan_nonce_used')
      const signed = await signHeld(entry, () => signV2TypedData(boundedSigner(rpc), permit2WitnessTypedData(chain.chainId, review.zap, permit, intent), { chainId: chain.chainId, signer: owner, shape: 'ecdsa' }))
      state.signature = signed
      return signed
    }, SIGN_WINDOW_S)
  }

  /**
   * The signer's refusals that come before any prompt: nothing was signed. Not `wallet_wrong_chain` (review fix F3): the
   * prompt goes through the operation's bounded calls, whose connector check can say it AFTER the wallet answered, and a
   * nonce that may have been signed stays held.
   */
  // Changed on purpose (data) 2026-10-02 (Domino V2 integration): the signer's own lock (./liveLock.ts) refuses before any prompt too.
  const BEFORE_PROMPT = new Set(['typed_data_chain_mismatch', 'typed_data_signer_mismatch', 'typed_data_not_signable', CONTRACTS_NOT_LIVE])
  /**
   * The wallet as the typed-data signer sees it, through the operation's bounded calls (review fix F3): the prompt has
   * the operation's deadline and call cap, and the connector's account and chain are checked around it.
   */
  const boundedSigner = (rpc: Rpc) => ({ owner, current: () => wallet.current(), request: (method: string, params: unknown[]) => rpc(method, params) })
  async function signHeld(entry: SignedNonce, sign: () => Promise<SignedTypedData>): Promise<SignedTypedData> {
    await wallet.signatures.record(entry)
    try {
      return await sign()
    } catch (error) {
      // Only a definite "nothing was signed" forgets the nonce; any other outcome keeps it held until settled or cancelled.
      // The bounded port's own refusal before the prompt (review F9: the account or chain changed, the window closed)
      // means the wallet never saw the request; one raised after its answer keeps the nonce held.
      if (refused(error) || error instanceof WalletNotAsked || (error instanceof Error && BEFORE_PROMPT.has(error.message))) await wallet.signatures.forget(entry)
      throw error
    }
  }

  /**
   * The relayed path's signature (RelayedPositionAction, low-s ECDSA, the zap's own nonce) for a change of range or an
   * exit reviewed on this client, so the path is tested; nothing submits it until a relayer exists (open point 4).
   * The plan is checked again as a relayed plan, the NFT must already be approved to the zap, the nonce free in the
   * zap's bitmap and not held.
   */
  async function signRelayed(review: ZapReview): Promise<SignedTypedData> {
    guard()
    refuseUnlessLive(chain.chainId, contracts)
    const state = stateOf(review)
    const zapPlan = state.plan
    if (zapPlan.action !== 'changeRange' && zapPlan.action !== 'exit') return fail('plan_consent')
    if (expiring(review.deadline)) fail('plan_expiring')
    const intent = zapPlan.plan.intent
    const entry = entryOf('zap', review.zap, intent.nonce)
    return t.bounded(async (rpc) => {
      await t.identity(rpc)
      const block = await t.latestBlock(rpc)
      await verifyDeployment(rpc, review.dex, block.tag)
      // The zap recovers the signer with ecrecover and has no EIP-1271: a contract account uses the direct path.
      const account = await readAccountCode((method, params) => rpc(method, params), owner, block.tag)
      if (account.kind === 'contract') fail('relayed_account_not_key')
      const found = await positionAt(rpc, review.dex, intent.tokenId, block.tag)
      if (typeof found === 'string') return fail(found)
      if (!same(found.approved, review.zap)) fail('nft_approval_missing')
      const verdict = checkPlan(zapPlan, { ...state.context, consent: 'relayed', now: now(), position: found.position })
      if (!verdict.ok) throw new ZapRefusal(verdict.failures)
      if (await bitUsed(rpc, review.zap, ZAP_ABI, intent.nonce, block.tag) || wallet.signatures.held(entry)) fail('plan_nonce_used')
      return signHeld(entry, () => signV2TypedData(boundedSigner(rpc), relayedActionTypedData(chain.chainId, review.zap, relayedActionOf(zapPlan)), { chainId: chain.chainId, signer: owner, shape: 'ecdsa-low-s' }))
    }, SIGN_WINDOW_S)
  }

  /**
   * A free signature nonce for a new plan (spec §2.5.2 "Escolha do nonce"): a random word, its lowest bit free in the
   * bitmap (Permit2's, shared with every app that uses SignatureTransfer for this wallet, or the zap's) and not held
   * in this page's journal. It is held only once a signature is asked for.
   */
  async function chooseNonce(space: 'permit2' | 'zap', dex: Dex = 4): Promise<bigint> {
    guard()
    if ((space !== 'permit2' && space !== 'zap') || (dex !== 3 && dex !== 4)) fail('invalid_nonce_space')
    const verifier = space === 'permit2' ? chain.permit2 : zapOf(dex)
    const abi = space === 'permit2' ? PERMIT2_ABI : ZAP_ABI
    return t.bounded(async (rpc) => {
      await t.identity(rpc)
      if (space === 'zap') await verifyDeployment(rpc, dex, 'latest')
      for (let attempt = 0; attempt < 4; attempt++) {
        const word = random() & ((1n << 248n) - 1n)
        const bitmap = await read<bigint>(rpc, verifier, abi, 'nonceBitmap', [owner, word], 'latest')
        for (let bit = 0n; bit < 256n; bit++) {
          const nonce = (word << 8n) | bit
          if (((bitmap >> bit) & 1n) === 0n && !wallet.signatures.held(entryOf(space, verifier, nonce))) return nonce
        }
      }
      return fail('nonce_unavailable')
    })
  }

  /** The position card's fact: whether the zap holds this NFT's individual approval (spec §2.5.1, §8.2). Reads only. */
  async function positionApproval(dex: Dex, tokenId: bigint): Promise<PositionApproval> {
    guard()
    if ((dex !== 3 && dex !== 4) || typeof tokenId !== 'bigint' || tokenId <= 0n || tokenId > MAX_UINT256) fail('invalid_position_id')
    return t.bounded(async (rpc) => {
      await t.identity(rpc)
      const block = await t.latestBlock(rpc)
      await verifyDeployment(rpc, dex, block.tag)
      const nft = await nftOf(rpc, dex, tokenId, block.tag)
      if (!nft) return fail('position_not_found')
      const zapApproved = same(nft.approved, zapOf(dex))
      return Object.freeze({ chainId: chain.chainId, dex, tokenId, manager: managerOf(dex), holder: nft.holder, approved: nft.approved, zapApproved, revocable: zapApproved && nft.holder === owner, block: block.number })
    })
  }

  /** "Revoke": approve(address(0), tokenId) on the chain's position manager, offered only while the zap is the approved one. */
  async function prepareRevoke(dex: Dex, tokenId: bigint, gas: V2GasBudget | null = null): Promise<PreparedV2> {
    guard()
    if ((dex !== 3 && dex !== 4) || typeof tokenId !== 'bigint' || tokenId <= 0n || tokenId > MAX_UINT256) fail('invalid_position_id')
    return t.bounded(async (rpc) => {
      await t.identity(rpc)
      await verifyDeployment(rpc, dex, 'latest')
      const nft = await nftOf(rpc, dex, tokenId, 'latest')
      if (!nft) return fail('position_not_found')
      if (nft.holder !== owner) fail('position_not_owned')
      if (!same(nft.approved, zapOf(dex))) fail('revoke_not_offered')
      return t.prepare(rpc, {
        kind: 'revoke-nft', to: managerOf(dex), value: 0n,
        data: encodeFunctionData({ abi: managerAbi(dex), functionName: 'approve', args: [ZERO_ADDRESS, tokenId] }),
        summary: [`Revoke Domino's approval for position ${tokenId}.`],
      }, gas)
    })
  }

  /** Which contract a held entry's nonce lives in, when it is one of this client's: Permit2 or one of the two zaps. */
  function nonceHome(entry: SignedNonce): { abi: Abi; dex: Dex | null } | null {
    if (entry.chainId !== chain.chainId || entry.owner.toLowerCase() !== owner) return null
    if (entry.space === 'permit2' && same(entry.verifier, chain.permit2)) return { abi: PERMIT2_ABI, dex: null }
    if (entry.space === 'zap' && same(entry.verifier, zapOf(3))) return { abi: ZAP_ABI, dex: 3 }
    if (entry.space === 'zap' && same(entry.verifier, zapOf(4))) return { abi: ZAP_ABI, dex: 4 }
    return null
  }

  /**
   * Cancels a signature nonce held in the journal and not yet used: Permit2's invalidateUnorderedNonces(word, mask) or
   * the zap's invalidateNonces(word, mask), for exactly that one bit (spec §2.10 "Plano velho").
   */
  async function prepareCancelNonce(entry: SignedNonce, gas: V2GasBudget | null = null): Promise<PreparedV2> {
    guard()
    const home = nonceHome(entry)
    if (!home || typeof entry.nonce !== 'bigint' || entry.nonce < 0n || entry.nonce > MAX_UINT256) return fail('nonce_not_this_clients')
    if (!wallet.signatures.held(entry)) fail('nonce_not_held')
    const verifier = entry.verifier.toLowerCase() as Address
    const word = entry.nonce >> 8n
    const mask = 1n << (entry.nonce & 255n)
    return t.bounded(async (rpc) => {
      await t.identity(rpc)
      if (home.dex !== null) await verifyDeployment(rpc, home.dex, 'latest')
      if (await bitUsed(rpc, verifier, home.abi, entry.nonce, 'latest')) fail('nonce_already_settled')
      const data = home.dex === null
        ? encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'invalidateUnorderedNonces', args: [word, mask] })
        : encodeFunctionData({ abi: ZAP_ABI, functionName: 'invalidateNonces', args: [word, mask] })
      return t.prepare(rpc, { kind: 'cancel-nonce', to: verifier, value: 0n, data, summary: [`Cancel the unused signature nonce ${entry.nonce} at ${verifier}.`] }, gas)
    })
  }

  /**
   * Forgets every held Permit2 or zap nonce the chain's FINALIZED block says was used or cancelled; returns what was
   * settled and what is still held. A use only in an unfinalized block keeps the nonce held: that block can be reorged
   * out, and the signature would then still be valid.
   */
  async function settleSignedNonces(): Promise<{ settled: readonly SignedNonce[]; held: readonly SignedNonce[] }> {
    guard()
    return t.bounded(async (rpc) => {
      await t.identity(rpc)
      const block = { tag: 'finalized' as Hex }
      const bitmaps = new Map<string, bigint>()
      const settled: SignedNonce[] = []
      const held: SignedNonce[] = []
      for (const entry of wallet.signatures.list(chain.chainId, owner)) {
        const home = nonceHome(entry)
        if (!home) continue
        const verifier = entry.verifier.toLowerCase() as Address
        const key = `${verifier}|${entry.nonce >> 8n}`
        let bitmap = bitmaps.get(key)
        // At most 32 bitmap words per call, inside the operation's bound: the rest stays held until the next call.
        if (bitmap === undefined && bitmaps.size >= 32) {
          held.push(entry)
          continue
        }
        if (bitmap === undefined) {
          bitmap = await read<bigint>(rpc, verifier, home.abi, 'nonceBitmap', [owner, entry.nonce >> 8n], block.tag)
          bitmaps.set(key, bitmap)
        }
        if (((bitmap >> (entry.nonce & 255n)) & 1n) === 1n) {
          await wallet.signatures.forget(entry)
          settled.push(entry)
        } else held.push(entry)
      }
      return { settled: Object.freeze(settled), held: Object.freeze(held) }
    })
  }

  /**
   * Which way an action is consented to on this chain (spec §2.5.4, src/v2/plan/consent.ts): the wallet's EIP-5792
   * atomic status for THIS chain and the account's code on THIS chain (EIP-7702 delegation is per chain), read through
   * the wallet. Reads only; the plan request carries the result (`planConsent`).
   */
  async function consentFor(action: ActionName, inputs: readonly { token: Address }[]): Promise<ConsentChoice & { atomic: AtomicStatus; account: AccountCode['kind'] }> {
    guard()
    return t.bounded(async (rpc) => {
      await t.identity(rpc)
      const atomic = await atomicStatus({ owner, request: (method, params) => rpc(method, params) }, 5_000, chain.chainId)
      const account = await readAccountCode((method, params) => rpc(method, params), owner, 'latest')
      return Object.freeze({ ...chooseConsent({ action, atomic, account: account.kind, inputs, chosenRecipient: false }), atomic, account: account.kind })
    })
  }

  /** The review's transaction steps still needed now, as one batch's calls, in the steps' order (`action` last). */
  async function batchCalls(rpc: Rpc, review: ZapReview, state: ReviewState): Promise<{ kinds: ZapStep['kind'][]; calls: BatchCall[] }> {
    const kinds: ZapStep['kind'][] = []
    const calls: BatchCall[] = []
    const approveCall = (token: Address, spender: Address, amount: bigint): BatchCall => ({ to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] }), value: '0x0' })
    for (const step of review.steps) {
      if (step.kind === 'approve-reset') {
        const allowance = await allowanceOf(rpc, step.token, step.spender, 'latest')
        if (allowance === 0n || allowance >= step.amount) continue
        kinds.push(step.kind)
        calls.push(approveCall(step.token, step.spender, 0n))
      } else if (step.kind === 'approve') {
        const allowance = await allowanceOf(rpc, step.token, step.spender, 'latest')
        if (allowance >= step.amount) continue
        // A short non-zero allowance is reset first, exactly as the steps would: some tokens refuse a non-zero change.
        if (allowance !== 0n && !(kinds[kinds.length - 1] === 'approve-reset' && calls[calls.length - 1].to === step.token)) fail('step_out_of_order')
        kinds.push(step.kind)
        calls.push(approveCall(step.token, step.spender, step.amount))
      } else if (step.kind === 'approve-nft') {
        const nft = await nftOf(rpc, review.dex, step.tokenId, 'latest')
        if (!nft) return fail('position_not_found')
        if (nft.holder !== owner) fail('position_not_owned')
        if (same(nft.approved, step.spender)) continue
        kinds.push(step.kind)
        calls.push({ to: step.manager, data: encodeFunctionData({ abi: managerAbi(review.dex), functionName: 'approve', args: [step.spender, step.tokenId] }), value: '0x0' })
      } else if (step.kind === 'sign-permit') {
        return fail('batch_not_direct')
      } else {
        kinds.push(step.kind)
        calls.push({ to: step.to, data: encodeFunctionData({ abi: ZAP_ABI, functionName: step.functionName, args: [state.plan.plan] }), value: numberToHex(step.value) })
      }
    }
    return { kinds, calls }
  }

  /**
   * A direct review as ONE EIP-5792 batch (spec §2.5.1 "Lote"): `[approvals…, NFT approval?, action]` exactly as the
   * steps would send them, re-read at this moment, simulated whole through the wallet's eth_simulateV1 only (no other
   * node, OP9: a wallet without it is `batch_simulation_unavailable`, and the steps go one by one), its cost checked
   * against the budget and the owner's ETH. `gas` null (review F8): the budget is read here, through this operation's
   * bounded calls, at this moment; on Base the L1 data fee ceiling of the batch's whole calldata is added to its cost.
   * Reads only.
   */
  async function prepareBatch(review: ZapReview, gas: V2GasBudget | null = null): Promise<ZapBatch> {
    guard()
    const state = stateOf(review)
    if (review.consent !== 'direct') fail('batch_not_direct')
    consentable(review, state)
    if (handedOver.has(review.intentHash)) fail('review_already_sent')
    return t.bounded(async (rpc) => {
      await t.identity(rpc)
      // F3: no batch while an action of this owner handed to the wallet may still run on this chain.
      await settleHeld(rpc, review.intentHash)
      const budget = gas ?? (await suggestV2Gas(rpc, chain))
      if (budget.maxGas < 21_000n || budget.maxGas > 15_000_000n || budget.maxFeePerGas <= 0n || budget.maxPriorityFeePerGas < 0n || budget.maxPriorityFeePerGas > budget.maxFeePerGas || budget.reserveWei < 0n) fail('invalid_gas_budget')
      await verifyDeployment(rpc, review.dex, 'latest')
      const { kinds, calls } = await batchCalls(rpc, review, state)
      if (kinds[kinds.length - 1] !== 'action') fail('step_unknown')
      // F4: the action's own return data in the batch's simulation (its last call) is checked against the plan.
      const gasUsed = await simulateBatch((method, params) => rpc(method, params), owner, calls, undefined, (returned) => checkSimulated(state, returned[returned.length - 1]))
      // The wallet runs the calls in one transaction of its own (its delegate's execute, or a bundler's): room for that frame.
      const limit = ((gasUsed + BATCH_FRAME_GAS) * 120n + 99n) / 100n
      if (limit > budget.maxGas) fail('gas_budget_exceeded')
      const calldata = calls.reduce((sum, call) => sum + BigInt((call.data.length - 2) / 2) + 64n, 0n)
      const networkFeeWei = limit * budget.maxFeePerGas + (await l1FeeCeiling(rpc, chain, calldata))
      if (quantity(await rpc('eth_getBalance', [owner, 'latest'])) < review.value + networkFeeWei + budget.reserveWei) fail('native_gas_reserve_insufficient')
      const batch: ZapBatch = deepFreeze({
        chainId: chain.chainId, owner, key: review.intentHash, intentHash: review.intentHash, kinds, calls,
        gasUsed, networkFeeWei, value: review.value, expiresAt: now() + REVIEW_S,
      })
      issuedBatches.add(batch)
      batchReviews.set(batch, review)
      return batch
    })
  }

  /**
   * Offers a prepared batch to the wallet once (finance/batch.ts offerBatch: version 2.0.0, atomic required, on this
   * chain), behind the page's latch for this plan (keyed by its intentHash, on the latch of THIS chain, review fix F5):
   * simulated again, the chain read right before the wallet, never offered twice. As V1's setup (finance/setup.ts):
   * nothing of this owner may be in flight on this chain (the pending nonce is the latest, and no step of this page holds
   * it), and a latch met again is let go only once older than ZAP_BATCH_LATCH_EXPIRY_S. The plan is marked handed over
   * first (fix F1); the mark and the latch are let go only when the wallet was never asked (the port's own refusal,
   * WalletNotAsked, review F9), refused definitely, or cannot batch. The wallet's id for the batch.
   */
  async function sendBatch(batch: ZapBatch, acknowledged: boolean, latchFor: (chainId: V2ChainId, owner: Address) => ZapBatchLatch = browserBatchLatch): Promise<string> {
    refuseUnlessLive(chain.chainId, contracts)
    guard()
    const review = batchReviews.get(batch)
    if (!acknowledged || !review || !issuedBatches.has(batch) || batch.expiresAt <= now() || batch.owner !== owner || batch.chainId !== chain.chainId) return fail('wallet_review_required')
    consentable(review, stateOf(review))
    if (handedOver.has(review.intentHash)) fail('review_already_sent')
    const latch = latchFor(review.chainId, owner)
    if (latch.batchOffered(batch.key) !== null && !(await latch.expireBatch(batch.key, ZAP_BATCH_LATCH_EXPIRY_S))) fail('batch_already_offered')
    return t.bounded(async (rpc) => {
      await t.identity(rpc)
      // F3: no batch while another action of this owner handed to the wallet may still run on this chain.
      await settleHeld(rpc, review.intentHash)
      await verifyDeployment(rpc, review.dex, 'latest')
      // Nothing of this owner in flight on this chain (V1 setup's rule): the pending nonce is the latest, never offered here.
      const latest = quantity(await rpc('eth_getTransactionCount', [owner, 'latest']))
      const pending = quantity(await rpc('eth_getTransactionCount', [owner, 'pending']))
      if (latest !== pending || wallet.nonceOffered(chain.chainId, pending)) fail('pending_wallet_transaction')
      // The chain may have moved since the review: the exact calls are simulated again before the wallet sees them, and
      // the action's return data checked against the plan (F4).
      await simulateBatch((method, params) => rpc(method, params), owner, batch.calls, undefined, (returned) => checkSimulated(stateOf(review), returned[returned.length - 1]))
      if (batch.expiresAt <= now()) fail('wallet_review_expired')
      // Immediately before the wallet is asked: the same chain, still (spec §1.3).
      if (quantity(await rpc('eth_chainId', [])) !== BigInt(chain.chainId)) fail('wallet_wrong_chain')
      issuedBatches.delete(batch)
      handedOver.add(review.intentHash)
      // F3: held for this owner on this chain from before the wallet is asked until the chain or the wallet settles it.
      unsettled.put(owner, heldRecord(review, 'batch', null))
      const letGoBatch = () => {
        handedOver.delete(review.intentHash)
        letGo(review.intentHash)
      }
      let claim: string | undefined
      let asked = false
      const batchWallet = {
        owner,
        request: (method: string, params: unknown[]) => rpc(method, params),
        batchOffered: (key: Hex) => latch.batchOffered(key),
        claimBatch: async (key: Hex) => { claim = await latch.claimBatch(key); return claim },
        recordBatch: (key: Hex, token: string, id: string) => latch.recordBatch(key, token, id),
        releaseBatch: (key: Hex, token: string) => latch.releaseBatch(key, token),
      }
      // The one request offerBatch makes is the offer itself. The wallet was asked only once the port invoked its
      // provider: a refusal of the port's own (WalletNotAsked: the account or chain changed, the window closed) is not.
      const request = async (method: string, params: unknown[]) => {
        try {
          // The offer's answer (the batch id) is kept even if the wallet changed after giving it (F2).
          const result = await rpc(method, params, async () => {
            // A definite refusal that arrives after the operation's deadline won: only this claim, nothing offered again.
            if (claim !== undefined) await latch.releaseBatch(batch.key, claim)
            letGoBatch()
          }, true)
          asked = true
          return result
        } catch (error) {
          if (!(error instanceof WalletNotAsked)) asked = true
          throw error
        }
      }
      try {
        const id = await offerBatch(request, batchWallet, batch.key, batch.calls, () => wallet.current() && wallet.chainId() === chain.chainId && batch.expiresAt > now() && !expiring(review.deadline) && now() < review.quoteExpiresAt, chain.chainId)
        offeredBatches.set(id, { batch, review })
        const held = heldOf(review.intentHash)
        try {
          if (held) unsettled.put(owner, { ...held, batchId: id })
        } catch {
          // An id this page cannot keep (not plain printable text, or too long): the hold stays without it, settled by
          // the chain (the action's event, or its deadline). The wallet's answer is still returned (F2).
        }
        return id
      } catch (error) {
        const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
        const unsupported = error instanceof Error && (error.message === 'batch_unsupported' || error.message === 'batch_upgrade_declined')
        if (!asked || definiteRefusal(error) || unsupported || code === 5750 || BATCH_UNSUPPORTED.has(code as number)) {
          // Nothing of it can run: the latch (offerBatch keeps it for an outcome it cannot tell), the mark and the hold go.
          if (claim !== undefined) await latch.releaseBatch(batch.key, claim)
          letGoBatch()
        }
        throw error
      }
    }, SIGN_WINDOW_S)
  }

  /** A receipt read from the chain for `hash`, once `holds` says its logs are the plan's: the shared sender's states. */
  async function receiptAt(rpc: Rpc, hash: Hex, holds: (logs: readonly V2Log[]) => boolean): Promise<V2Receipt> {
    const raw = (await rpc('eth_getTransactionReceipt', [hash])) as Record<string, unknown> | null
    if (raw === null) return { state: 'pending' }
    if (!raw || typeof raw !== 'object' || String(raw.transactionHash).toLowerCase() !== hash || typeof raw.blockHash !== 'string'
      || !/^0x[0-9a-fA-F]{64}$/.test(raw.blockHash) || !['0x0', '0x1'].includes(String(raw.status)) || !Array.isArray(raw.logs)) return fail('invalid_receipt')
    const blockNumber = quantity(raw.blockNumber)
    const blockHash = raw.blockHash.toLowerCase() as Hex
    const block = (await rpc('eth_getBlockByNumber', [numberToHex(blockNumber), false])) as { hash?: string; timestamp?: unknown } | null
    // Changed on purpose 2026-10-15 (pack 8, C5): the chain's row in ../../config/receiptSources.ts, not its id (the same
    // chains): where the wallet is the first reader of receipts, a block it does not return is a node behind.
    if (!edgeReadsReceipts(chain.chainId) && (!block || typeof block.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(block.hash))) return { state: 'pending' }
    if (!block || String(block.hash).toLowerCase() !== blockHash) return { state: 'reorged' }
    const logs = (raw.logs as unknown[]).map((entry): V2Log => {
      const log = obj(entry)
      if (!log || typeof log.address !== 'string' || !ADDRESS.test(log.address) || !Array.isArray(log.topics) || typeof log.data !== 'string' || !hex(log.data)) return fail('invalid_receipt')
      const topics = log.topics.map((topic) => (typeof topic === 'string' && /^0x[0-9a-fA-F]{64}$/.test(topic) ? (topic.toLowerCase() as Hex) : fail('invalid_receipt')))
      return Object.freeze({ address: log.address.toLowerCase() as Address, topics: Object.freeze(topics), data: log.data as Hex, logIndex: Number(quantity(log.logIndex)) })
    })
    const costs = {
      transactionHash: hash, blockHash, blockNumber, gasUsed: quantity(raw.gasUsed), effectiveGasPrice: quantity(raw.effectiveGasPrice),
      l1Fee: chain.l1FeeInReceipt && typeof raw.l1Fee === 'string' ? quantity(raw.l1Fee) : null, logs: Object.freeze(logs),
      // (2026-10-15, pack 8): the block's time from the header just read (shown on a session receipt only).
      ...headerTime(block.timestamp),
    }
    if (raw.status === '0x0') return { state: 'reverted', ...costs }
    if (!holds(logs)) return fail('receipt_not_from_this_review')
    const final = (await rpc('eth_getBlockByNumber', ['finalized', false])) as { number?: string } | null
    if (!final?.number || quantity(final.number) < blockNumber) return { state: 'included', ...costs }
    return { state: 'finalized', ...costs }
  }

  /**
   * Where a batch this client offered stands: the wallet's status (finance/batch.ts batchCallsStatus) while it knows the
   * batch, then the chain: the transaction that carries this plan's `PositionLiquidityChanged` (the intentHash is its
   * first indexed topic; every action emits one), found from the review's block through the wallet's provider, and its
   * receipt, "included" then "finalized" (a delay is never a failure). Not included (400) or reverted (500): nothing of it
   * ran, and the latch and the handed-over mark are let go, so a NEW plan may be made. Once the transaction is read back
   * on chain (included, or reverted), the latch is let go too, as V1's setup does; the handed-over mark stays.
   */
  async function batchReceipt(id: string, latchFor: (chainId: V2ChainId, owner: Address) => ZapBatchLatch = browserBatchLatch): Promise<ZapBatchReceipt> {
    guard()
    const known = offeredBatches.get(id)
    if (!known) return fail('receipt_not_from_this_review')
    const { batch, review } = known
    return t.bounded(async (rpc) => {
      await t.identity(rpc)
      let hash: Hex | null = null
      if (known.inclusion) {
        // A vanished event is only a lagging read. The previously checked block must explicitly contradict it.
        const block = await rpc('eth_getBlockByNumber', [numberToHex(known.inclusion.blockNumber), false]) as { hash?: string; number?: string } | null
        if (!block || typeof block.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(block.hash) || typeof block.number !== 'string' || !/^0x[0-9a-f]+$/i.test(block.number) || BigInt(block.number) !== known.inclusion.blockNumber) return { state: 'pending' }
        if (block.hash.toLowerCase() !== known.inclusion.blockHash) { known.inclusion = undefined; return { state: 'reorged' } }
        hash = known.inclusion.hash
      }
      if (hash === null) {
        const status = await batchCallsStatus((method, params) => rpc(method, params), id)
        if (status !== null && status >= 100 && status < 200) return { state: 'pending' }
        if (status === 400 || status === 500) {
          await latchFor(review.chainId, owner).releaseBatch(batch.key, id)
          handedOver.delete(review.intentHash)
          letGo(review.intentHash)
          return status === 400 ? { state: 'not-included' } : { state: 'batch-reverted' }
        }
        const topic0 = RECEIPT_TOPICS.PositionLiquidityChanged
        const found = await rpc('eth_getLogs', [{ address: review.zap, topics: [topic0, review.intentHash], fromBlock: numberToHex(review.block), toBlock: 'latest' }])
        if (!Array.isArray(found)) return fail('invalid_wallet_reply')
        const hashes = new Set<string>()
        for (const entry of found) {
          const log = obj(entry)
          if (!log || log.removed === true) continue
          if (typeof log.transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash)) return fail('invalid_wallet_reply')
          hashes.add(log.transactionHash.toLowerCase())
        }
        if (hashes.size === 0) return { state: 'pending' }
        if (hashes.size > 1) return fail('receipt_duplicate_action')
        hash = [...hashes][0] as Hex
      }
      const topic0 = RECEIPT_TOPICS.PositionLiquidityChanged
      const receipt = await receiptAt(rpc, hash, (logs) => logs.some((log) => log.address === review.zap && log.topics[0] === topic0 && log.topics[1] === review.intentHash.toLowerCase()))
      if (!edgeReadsReceipts(chain.chainId) && (receipt.state === 'included' || receipt.state === 'finalized')) known.inclusion = { hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash }
      if (receipt.state === 'included' || receipt.state === 'finalized' || receipt.state === 'reverted') {
        await latchFor(review.chainId, owner).releaseBatch(batch.key, id)
        // F3: on chain, its outcome is final: the hold goes.
        letGo(review.intentHash)
      }
      return receipt
    })
  }

  /** A pool the person indicates, read through the wallet at the latest block (see `poolAt`); v3 tiers are checked against the factory. */
  async function readPool(pool: PoolRef): Promise<PoolOnChain & { spacingOk: boolean }> {
    guard()
    if (pool.dex !== 3 && pool.dex !== 4) fail('plan_pool_dex')
    if (!addr(pool.currency0) || !addr(pool.currency1) || !addr(pool.hooks) || BigInt(pool.currency0) >= BigInt(pool.currency1)) fail('plan_pool_order')
    return t.bounded(async (rpc) => {
      await t.identity(rpc)
      const block = await t.latestBlock(rpc)
      const found = await poolAt(rpc, { ...pool, currency0: lower(pool.currency0), currency1: lower(pool.currency1), hooks: lower(pool.hooks) }, block.tag, block.number)
      const spacingOk = pool.dex === 3 ? (await v3SpacingOf(rpc, pool.fee, block.tag)) === pool.tickSpacing : true
      return { ...found, spacingOk }
    })
  }

  /**
   * Reads inside one aggregate3, in order: each answer decoded with its own ABI, or null for one that failed or answered
   * something its ABI does not (never a guessed value).
   */
  async function aggregate(rpc: Rpc, asks: readonly Ask[], block: Hex): Promise<(unknown | null)[]> {
    const data = encodeFunctionData({ abi: MULTICALL3_ABI, functionName: 'aggregate3', args: [asks.map((ask) => ({ target: ask.target, allowFailure: true, callData: encodeFunctionData({ abi: ask.abi, functionName: ask.functionName, args: ask.args }) }))] })
    const replies = decodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', data: await t.call(rpc, chain.multicall3, data, block) }) as readonly { success: boolean; returnData: Hex }[]
    if (replies.length !== asks.length) fail('invalid_wallet_reply')
    return replies.map((reply, index) => {
      if (!reply.success || reply.returnData === '0x') return null
      try {
        return decodeFunctionResult({ abi: asks[index].abi, functionName: asks[index].functionName, data: reply.returnData })
      } catch {
        return null
      }
    })
  }

  /**
   * Many pools at one block, in two reads through the wallet. Changed on purpose (data) 2026-10-05 (the owner's New position
   * on Base and Arbitrum One, src/v2in/journey/otherChains.ts): a token's pools there are found by reading every pair and
   * fee tier its network's profile names, about two dozen pools, which one readPool each made a quarter of a minute's
   * wait. The chain profile's Multicall3 asks the v4 StateView and the v3 factory about all of them at once (and the
   * factory for each v3 tier's spacing), then every v3 pool that exists for its slot0 and liquidity. Each answer is what
   * readPool says of that pool, in the order asked; a read that failed reads as no pool, never as a price.
   */
  async function readPools(pools: readonly PoolRef[]): Promise<(PoolOnChain & { spacingOk: boolean })[]> {
    guard()
    for (const pool of pools) {
      if (pool.dex !== 3 && pool.dex !== 4) fail('plan_pool_dex')
      if (!addr(pool.currency0) || !addr(pool.currency1) || !addr(pool.hooks) || BigInt(pool.currency0) >= BigInt(pool.currency1)) fail('plan_pool_order')
    }
    if (pools.length === 0) return []
    return t.bounded(async (rpc) => {
      await t.identity(rpc)
      const block = await t.latestBlock(rpc)
      const refs: PoolRef[] = pools.map((pool) => ({ ...pool, currency0: lower(pool.currency0), currency1: lower(pool.currency1), hooks: lower(pool.hooks) }))
      const ids = refs.map((pool) => (pool.dex === 4 ? keccak256(encodeAbiParameters(POOL_KEY, [{ currency0: pool.currency0, currency1: pool.currency1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks }])) : null))
      const fees = [...new Set(refs.filter((pool) => pool.dex === 3).map((pool) => pool.fee))]
      const first: Ask[] = []
      refs.forEach((pool, index) => {
        if (pool.dex === 4) {
          first.push({ target: chain.uniswap.v4.stateView, abi: V4_STATE_VIEW_ABI, functionName: 'getSlot0', args: [ids[index]] })
          first.push({ target: chain.uniswap.v4.stateView, abi: V4_STATE_VIEW_ABI, functionName: 'getLiquidity', args: [ids[index]] })
        } else {
          first.push({ target: chain.uniswap.v3.factory, abi: V3_FACTORY_ABI, functionName: 'getPool', args: [pool.currency0, pool.currency1, pool.fee] })
        }
      })
      for (const fee of fees) first.push({ target: chain.uniswap.v3.factory, abi: V3_FACTORY_ABI, functionName: 'feeAmountTickSpacing', args: [fee] })
      const answers = await aggregate(rpc, first, block.tag)
      const spacing = new Map(fees.map((fee, index) => {
        const answer = answers[answers.length - fees.length + index]
        return [fee, answer === null ? 0 : Number(answer)] as const
      }))
      let at = 0
      const found = refs.map((pool, index) => {
        if (pool.dex === 4) {
          const slot0 = answers[at++] as readonly [bigint, number, number, number] | null
          const liquidity = answers[at++] as bigint | null
          const sqrt = slot0?.[0] ?? 0n
          return { pool, id: ids[index] as Hex, exists: sqrt !== 0n, initialized: sqrt !== 0n, sqrtPriceX96: sqrt, tick: slot0 ? Number(slot0[1]) : 0, liquidity: liquidity ?? 0n, block: block.number }
        }
        const answer = answers[at++] as string | null
        const address = answer !== null && ADDRESS.test(answer) ? (answer.toLowerCase() as Address) : ZERO_ADDRESS
        return { pool, id: address as Hex, exists: !isNative(address), initialized: false, sqrtPriceX96: 0n, tick: 0, liquidity: 0n, block: block.number }
      })
      // The v3 pools that exist: their slot0 and liquidity, at the same block.
      const live = found.filter((entry) => entry.pool.dex === 3 && entry.exists)
      if (live.length > 0) {
        const second = await aggregate(rpc, live.flatMap((entry): Ask[] => [
          { target: entry.id as Address, abi: V3_POOL_ABI, functionName: 'slot0', args: [] },
          { target: entry.id as Address, abi: V3_POOL_ABI, functionName: 'liquidity', args: [] },
        ]), block.tag)
        live.forEach((entry, index) => {
          const slot0 = second[index * 2] as readonly [bigint, number] | null
          const liquidity = second[index * 2 + 1] as bigint | null
          entry.sqrtPriceX96 = slot0?.[0] ?? 0n
          entry.initialized = entry.sqrtPriceX96 !== 0n
          entry.tick = slot0 ? Number(slot0[1]) : 0
          entry.liquidity = liquidity ?? 0n
        })
      }
      return found.map((entry) => ({ ...entry, spacingOk: entry.pool.dex === 3 ? spacing.get(entry.pool.fee) === entry.pool.tickSpacing : true }))
    })
  }

  /** A token read that reverted, or answered something that is not the ABI's (no such function, a bytes32 symbol): unread, not a failure. */
  const unreadable = (error: unknown) => revertIn(error) || (error instanceof BaseError && /^(Abi|PositionOutOfBounds|InvalidBytes|SizeOverflow|InvalidHex)/.test(error.name))

  /** Tokens' own decimals() and symbol() through the wallet; a read that fails is null (native ETH is 18, "ETH"). */
  async function readTokens(addresses: readonly Address[]): Promise<TokenOnChain[]> {
    guard()
    return t.bounded(async (rpc) => {
      await t.identity(rpc)
      const out: TokenOnChain[] = []
      for (const raw of addresses) {
        const address = lower(raw)
        if (isNative(address)) {
          out.push({ address, decimals: 18, symbol: 'ETH' })
          continue
        }
        let decimals: number | null = null
        let symbol: string | null = null
        try {
          const value = Number(await read<number>(rpc, address, ERC20_META_ABI as unknown as Abi, 'decimals', [], 'latest'))
          decimals = Number.isSafeInteger(value) && value >= 0 && value <= 77 ? value : null
        } catch (error) {
          if (!unreadable(error)) throw error
        }
        try {
          const value = await read<string>(rpc, address, ERC20_META_ABI as unknown as Abi, 'symbol', [], 'latest')
          symbol = typeof value === 'string' ? value : null
        } catch (error) {
          if (!unreadable(error)) throw error
        }
        out.push({ address, decimals, symbol })
      }
      return out
    })
  }

  /**
   * "I rejected it in my wallet" (V1's control, finance/setup.ts forgetOpenRequest; S2's forgetUnsettled), for the
   * actions of this owner held on this chain (F3). Each is first settled by the chain if it can be; what is left is let
   * go only while the chain shows nothing pending for this owner (the pending nonce is the latest, a held step's nonce
   * is that one, and the wallet does not report a held batch pending): then nothing of it was sent, and its nonce latch
   * goes too. Otherwise `pending`. Nothing is sent. `settled` when the chain settled everything, `none` when nothing was
   * held.
   */
  async function forgetUnsettled(): Promise<'forgotten' | 'settled' | 'pending' | 'none'> {
    guard()
    return t.bounded(async (rpc) => {
      await t.identity(rpc)
      const held = unsettled.list(chain.chainId, owner)
      if (held.length === 0) return 'none'
      const latestBlock = await t.latestBlock(rpc)
      const open: UnsettledAction[] = []
      for (const entry of held) {
        if (await settledOnChain(rpc, entry, latestBlock)) unsettled.drop(chain.chainId, owner, entry.intentHash)
        else open.push(entry)
      }
      if (open.length === 0) return 'settled'
      const latest = quantity(await rpc('eth_getTransactionCount', [owner, 'latest']))
      const pending = quantity(await rpc('eth_getTransactionCount', [owner, 'pending']))
      if (latest !== pending) return 'pending'
      for (const entry of open) {
        if (entry.nonce !== null && BigInt(entry.nonce) !== latest) return 'pending'
        if (entry.batchId !== null && (await batchCallsStatus((method, params) => rpc(method, params), entry.batchId)) === 100) return 'pending'
      }
      for (const entry of open) {
        if (entry.nonce !== null && !(await t.forgetOffered(rpc, BigInt(entry.nonce)))) return 'pending'
        unsettled.drop(chain.chainId, owner, entry.intentHash)
      }
      return 'forgotten'
    })
  }

  /** Where a step this client sent stands; an action's hold goes once the chain says it is final (F3). */
  async function stepReceipt(hash: Hex): Promise<V2Receipt> {
    guard()
    const receipt = await t.receipt(hash)
    if (receipt.state === 'included' || receipt.state === 'finalized' || receipt.state === 'reverted') {
      for (const entry of unsettled.list(chain.chainId, owner)) if (entry.hash === hash.toLowerCase()) letGo(entry.intentHash)
    }
    return receipt
  }

  return Object.freeze({
    chain,
    contracts,
    owner,
    review,
    acknowledgePause,
    readPool,
    readPools,
    readTokens,
    /**
     * Whether `vault` (a Domino V2 vault of this chain, as `vaultProbe` says) holds this position as its root, and whether
     * that root is armed (rev2 §2.13, L2), read at `block` through the rpc of the caller's own bounded operation: the
     * direct-exit client's probe, so a disarmed root's exit pauses nothing. Null when its root is another position.
     */
    rootProbe: (rpc: Rpc, vault: Address, dex: Dex, tokenId: bigint, block: Hex | 'latest'): Promise<{ armed: boolean } | null> => rootOf(rpc, vault.toLowerCase() as Address, dex, tokenId, block),
    /** The actions of this owner held on this chain (F3): handed to the wallet with no known outcome yet. Public data only. */
    unsettled: (): readonly UnsettledAction[] => unsettled.list(chain.chainId, owner),
    forgetUnsettled,
    /**
     * Whether an address is a Domino V2 vault of this chain (either factory's `isVault`, their code checked against the
     * manifest first), read at `block` through the rpc of the caller's own bounded operation: the direct-exit client's
     * probe for an armed root or a successor (rev2 §2.13). Reads only.
     */
    vaultProbe: (rpc: Rpc, address: Address, block: Hex | 'latest'): Promise<boolean> => isDominoVault(rpc, address.toLowerCase() as Address, block),
    prepareStep,
    send,
    /** Where a step this client sent stands, with its logs once included (decoded by finance/v2/receipt.ts). */
    receipt: stepReceipt,
    signPermit,
    signRelayed,
    chooseNonce,
    positionApproval,
    prepareRevoke,
    prepareCancelNonce,
    settleSignedNonces,
    consentFor,
    prepareBatch,
    sendBatch,
    batchReceipt,
    /** Whether this client handed the plan's action to the wallet (as a step or in a batch): it is never offered again. */
    handedOver: (review: ZapReview) => handedOver.has(review.intentHash),
    /** Whether a prepared step was handed to the wallet (its nonce held until the chain says). */
    wasOffered: (prepared: PreparedV2) => t.wasOffered(prepared),
  })
}
export type ZapClient = ReturnType<typeof createZapClient>
