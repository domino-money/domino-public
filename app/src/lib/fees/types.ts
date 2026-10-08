/**
 * The fees of one position NFT: the types the position screens code against, and the wire format of the two
 * same-origin Functions they read, POST /api/fees/v1/state (one block's state) and POST /api/fees/v2/ledger (the
 * position's own settlements). Types only: nothing here runs, so any module may import it, the Functions and the Node
 * tests included.
 *
 * Changed on purpose 2026-10-02 (rugged97's rules for the site's token, RUGGED_RPC_SITE_2026-10-02.md, rule 2: never a
 * pool's whole history per request; the fees history comes from eth_call and our own events). The history is no longer
 * rebuilt hour by hour from the pool's Swap and ModifyLiquidity logs in a worker: it is the position's ledger
 * (functions/_lib/feesLedger.ts), each settlement found from the NFT's own events and its fees known exactly (an
 * automatic compound's from the engine's FeesRealized, an owner's collect from the transfers it paid him), plus the
 * chain's unclaimed figure now (/state). Fees earned = settled + unclaimed, exact, or not shown. Its chart has measured
 * points only (lib/fees/ledger.ts).
 *
 * Every token amount is a raw integer in the token's smallest unit: a bigint in the client, a decimal string on the wire.
 * Nothing here is valued in USD or in a quote token; valuation belongs to the screens (visual/value.ts).
 */
import type { PositionAutomation } from '../automationState'

// ---------------------------------------------------------------------------
// What the screens read
// ---------------------------------------------------------------------------

/**
 * Why the history is not drawn. A closed set: it goes into data-fees-reason, never into visible text.
 * - rpc_unavailable: it could not be read just now (the page asks again by itself);
 * - not_exact: this position's fees earned cannot be told apart from its deposits and withdrawals with the events Domino
 *   reads (an owner's add, withdrawal or close, a collect in ETH, a position opened before Domino's release): the card
 *   shows Fees ready to collect only (`why` says which, for Details);
 * - hooked_pool, not_found: as the state read says.
 */
export type FeesReason = 'rpc_unavailable' | 'not_exact' | 'hooked_pool' | 'not_found'

/**
 * One position's fees, as the hooks give them.
 *
 * - `idle`: nothing asked (no id, or a build with no relay).
 * - `loading`: the on-chain state or the ledger is on its way; `state` is set once `/state` answered.
 * - `unclaimed-only`: only the on-chain unclaimed figure (`state.unclaimed`) may be shown (`reason`); `events`, the
 *   settlements the ledger found, when it found them (Activity lists them, with no figure where it has none).
 * - `verified`: the ledger is exact and agrees with the chain's state: Fees earned and its measured points may be drawn.
 * - `cached`: a previous visit's verified history, presentation only; never an authoritative current state.
 * - `unavailable`: nothing may be shown, not even an unclaimed figure.
 */
export type FeeHistoryView =
  | { phase: 'idle' }
  | { phase: 'loading'; state: PositionState | null; mintedAt?: PositionMint }
  | { phase: 'unclaimed-only'; state: PositionState; reason: FeesReason; why?: LedgerWhy; events?: ReadonlyArray<FeeEvent>; mintedAt?: PositionMint }
  | { phase: 'verified'; state: PositionState; history: FeeHistory }
  /** A previous visit's public history, presentation only; never an authoritative current state. */
  | CachedFeeHistory
  | { phase: 'unavailable'; reason: FeesReason }

/** Public figures only: no NFT owner, connected wallet, session or action authority. */
export type FeeDisplayState = Omit<PositionState, 'owner'>
export interface CachedFeeHistory {
  phase: 'cached'
  state: FeeDisplayState
  history: FeeHistory
  savedAt: number
  source: 'public-chain-ledger'
}

/** One currency of the pool. `symbol` is untrusted text from the token contract (render it as text only); null when unreadable. */
export interface StateCurrency {
  address: string
  symbol: string | null
  decimals: number | null
}

/**
 * A position read at one block, all figures from that block. `unclaimed` is exactly what v4 computes:
 * L × ((feeGrowthInside − feeGrowthInsideLast) mod 2^256) / 2^128.
 */
export interface PositionState {
  block: number
  /** Unix seconds of `block`. */
  timestamp: number
  unclaimed: readonly [bigint, bigint]
  sqrtPriceX96: bigint
  tick: number
  tickLower: number
  tickUpper: number
  liquidity: bigint
  /** The pool's protocol fee now, as slot0 packs it (StatePositionOk.protocolFee); absent when not read. */
  protocolFee?: number
  /** 0x + 64 lowercase hex. */
  poolId: string
  /** 0x + 40 lowercase hex. */
  owner: string
  currencies: readonly [StateCurrency, StateCurrency]
}

/** One settlement of the NFT's fees: its mint, a collect (a decrease of 0), an increase, a decrease, or the close (liquidity to 0). */
export interface FeeEvent {
  kind: 'mint' | 'collect' | 'increase' | 'decrease' | 'close'
  block: number
  /** Unix seconds of `block` (its header). */
  timestamp: number
  /** 0x + 64 hex. */
  tx: string
  /**
   * The fees this event settled (0 for the mint); null when they cannot be told apart from the principal it moved (an
   * owner's add or withdrawal). A verified history has none null.
   */
  fees: readonly [bigint, bigint] | null
  liquidityDelta: bigint
  /** Settled by Domino's automation (the engine's FeesRealized names it). */
  auto?: true
  /** The service fee the automation took in this transaction, per currency (the engine's BudgetApplied), when it did. */
  service?: readonly [bigint, bigint]
}

/**
 * One measured point of Fees earned: at the mint (nothing), right after each settlement (the position owes nothing then,
 * so the fees settled so far are everything it earned), when this browser read the position (settled + unclaimed then),
 * and now. Cumulative since the mint.
 */
export interface FeePoint {
  block: number
  /** Unix seconds. */
  t: number
  earned: readonly [bigint, bigint]
  collected: readonly [bigint, bigint]
  kind: 'opened' | 'settlement' | 'reading' | 'now'
}

/** The verified history of one position NFT since its mint: its ledger, folded with the chain's state now (lib/fees/ledger.ts). */
export interface PositionMint {
  block: number
  timestamp: number
  /** Pool price at the end of the verified creation block, when the archive read answered. */
  sqrtPriceX96?: string
}

export interface FeeHistory {
  mintedAt: PositionMint
  /** Collected + unclaimed since the mint (unclaimed = the chain's figure now). */
  earned: readonly [bigint, bigint]
  /** Settled since the mint: every settlement's fees, exactly. */
  collected: readonly [bigint, bigint]
  /** Measured points only, oldest first; the line between two is a guide, not a measurement. */
  points: ReadonlyArray<FeePoint>
  /** Every settlement since the mint, oldest first. */
  events: ReadonlyArray<FeeEvent>
  /** The ledger's block: every settlement up to it is in `events`, and the state agrees with it. */
  through: number
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/** 0x-prefixed hex of any even length. */
export type Hex = string
/** 0x + 40 lowercase hex (an address). */
export type Hex20 = string
/** 0x + 64 lowercase hex (a pool id, a topic, a transaction hash). */
export type Hex32 = string

export interface StatePoolKey {
  currency0: Hex20
  currency1: Hex20
  fee: number
  tickSpacing: number
  hooks: Hex20
}

export type StatePositionOk = {
  tokenId: string
  ok: true
  owner: Hex20
  poolId: Hex32
  poolKey: StatePoolKey
  /** symbol: untrusted text. */
  currencies: [StateCurrency, StateCurrency]
  tickLower: number
  tickUpper: number
  liquidity: string
  sqrtPriceX96: string
  tick: number
  feeGrowthInside0X128: string
  feeGrowthInside1X128: string
  feeGrowthInside0LastX128: string
  feeGrowthInside1LastX128: string
  /** L × ((inside − last) mod 2^256) / 2^128, exact, as decimal strings. */
  unclaimed0: string
  unclaimed1: string
  /** The pool's protocol fee now (slot0: the lower 12 bits zeroForOne, the upper 12 bits oneForZero). */
  protocolFee?: number
}

export type StatePositionFailed = { tokenId: string; ok: false; reason: 'not_found' | 'rpc_unavailable' | 'hooked_pool' }

export type StatePosition = StatePositionOk | StatePositionFailed

/** POST /api/fees/v1/state with { tokenIds: string[] } (1..8 decimal ids). */
export interface StateRequest {
  tokenIds: string[]
}

export interface StateResponse {
  v: 1
  block: number
  timestamp: number
  positions: StatePosition[]
  /** 2026-10-01 (item D5): PositionManager.nextTokenId at `block` (decimal): an id at or above it was never minted. */
  nextTokenId?: string
  /** 2026-09-28 (speed wave B, item 17): the page's own read only, each answered id's feature (functions/_lib/automation.ts). */
  automation?: PositionAutomation[]
}

/**
 * Why a ledger is not exact (functions/_lib/feesLedger.ts), for Details only:
 * - reading: it is read in steps and has more to read (the page asks again in a moment);
 * - before_floor: the NFT was minted before Domino's release (block 69,249,061), below which nothing is read;
 * - manual: an owner's add or withdrawal (or close) settled fees that cannot be told apart from the principal it moved;
 * - shared: a collect's transaction did more than collect this position (its transfers mix other things);
 * - native: a collect paid out ETH, whose moves leave no log;
 * - liquidity: the settlements found do not add up to the position's liquidity now (one was not seen);
 * - unseen: something settled this position that Domino's reads cannot see;
 * - too_many: more settlements or owners than one ledger keeps.
 */
export type LedgerWhy = 'reading' | 'before_floor' | 'manual' | 'shared' | 'native' | 'liquidity' | 'unseen' | 'too_many'

/** One own ModifyLiquidity of the NFT, as the ledger found it (decimal strings). */
export interface LedgerEntry {
  block: number
  /** Its log index in the block. */
  index: number
  tx: Hex32
  /** Unix seconds of `block`. */
  t: number
  kind: FeeEvent['kind']
  /** The liquidity it added (positive) or removed (negative). */
  delta: string
  /** The fees it settled; null when they cannot be told apart (`why`). */
  fees: [string, string] | null
  /** An automatic compound: its fees are the engine's FeesRealized. */
  auto?: true
  /** The engine's service fee for this NFT in this transaction (BudgetApplied), per currency. */
  service?: [string, string]
  why?: LedgerWhy
}

/**
 * One position's ledger: `state` at the answer's block (the read's own, so `through`, entries and state agree when
 * `through` is that block), its mint, its settlements oldest first, and whether every one is known exactly.
 */
export type LedgerPosition =
  | {
      tokenId: string
      ok: true
      /** Every settlement up to this block is in `entries`. */
      through: number
      state: StatePositionOk
      /** Optional price is the pool's measured state at the end of this verified mint block. */
      mint: { block: number; tx: Hex32; t: number; sqrtPriceX96?: string } | null
      entries: LedgerEntry[]
      exact: boolean
      why?: LedgerWhy
      /** The automation vault that holds the NFT now, when one does. */
      vault?: Hex20
    }
  | { tokenId: string; ok: false; reason: 'not_found' | 'hooked_pool' | 'rpc_unavailable' }

/** POST /api/fees/v2/ledger with { tokenIds: string[] (1..8), fresh?: true }. */
export interface LedgerResponse {
  v: 1
  /** The block every position's state was read at (the node's head then). */
  block: number
  timestamp: number
  positions: LedgerPosition[]
}

/** A relay answer as client.ts hands it on: its value and its decoded size, or why there is none. */
export type RelayAnswer<T> =
  | { ok: true; value: T; bytes: number }
  | { ok: false; failure: 'unavailable' | 'rate_limited' | 'too_large' | 'bad_request'; retryAfterMs: number }

/** A mint block from elsewhere (the wallet's SetupMinted log): a hint for reads that start at a position's mint. */
export interface MintHint {
  block: number
  /** The mint's transaction, when the hint's source had it. */
  tx?: string
}

/** Indexed mint evidence, verified against the NFT's on-chain Transfer before bounding a ledger read. */
export interface LedgerMintHint {
  tokenId: string
  block: number
  tx: string
}

/** How much of the store one subscriber asks: a position page (state and ledger), or the Positions list (the ledger alone). */
export type FeesScope = 'page' | 'list'
