/**
 * The fees history of one position NFT, rebuilt from public chain logs and
 * checked against the chain's own state (DESIGN-V2 §15, fees-evolution.md §3).
 *
 * These are the types the position screens code against (§15.6), the wire
 * format of the two same-origin Functions (POST /api/fees/v1/state and
 * /api/fees/v1/logs, §15.2 and §15.3) and the message protocol of the replay
 * worker (§15.5). Types only: nothing here runs, so any module may import it,
 * the Functions and the Node tests included.
 *
 * Every token amount is a raw integer in the token's smallest unit: a bigint
 * in the client, a decimal string on the wire. Nothing here is valued in USD
 * or in a quote token; valuation belongs to the screens (visual/value.ts).
 */

// ---------------------------------------------------------------------------
// What the screens read (§15.6)
// ---------------------------------------------------------------------------

/** Why the history is not drawn. A closed set: it goes into data-fees-reason, never into visible text. */
export type FeesReason = 'rpc_unavailable' | 'too_much_history' | 'replay_mismatch' | 'hooked_pool' | 'not_found' | 'worker_failed'

/**
 * One position's fees, as the hooks give them.
 *
 * - `idle`: nothing asked (no id, or a build with no relay).
 * - `loading`: the on-chain state or the history is on its way; `state` is set once `/state` answered.
 * - `unclaimed-only`: only the on-chain unclaimed figure (`state.unclaimed`) may be shown; the history
 *   could not be rebuilt or did not verify (`reason`). `prices` are the hourly closes read so far, if any.
 * - `verified`: the replay equals the chain bit for bit (§15.5-8); the history may be drawn.
 * - `unavailable`: nothing may be shown, not even an unclaimed figure.
 */
export type FeeHistoryView =
  | { phase: 'idle' }
  | { phase: 'loading'; state: PositionState | null }
  | { phase: 'unclaimed-only'; state: PositionState; reason: FeesReason; prices: HourlyPrices | null }
  | { phase: 'verified'; state: PositionState; history: FeeHistory; prices: HourlyPrices }
  | { phase: 'unavailable'; reason: FeesReason }

/** One currency of the pool. `symbol` is untrusted text from the token contract (render it as text only); null when unreadable. */
export interface StateCurrency {
  address: string
  symbol: string | null
  decimals: number | null
}

/**
 * A position read at one block (`block` = the relay's head − 2), all figures
 * from that block. `unclaimed` is exactly what v4 computes:
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
  /** 0x + 64 lowercase hex. */
  poolId: string
  /** 0x + 40 lowercase hex. */
  owner: string
  currencies: readonly [StateCurrency, StateCurrency]
}

/**
 * The pool's price at the end of each hour that had a Swap, from the Swap
 * events themselves, from the mint's hour on (`t` as in FeeHour). An hour
 * with no Swap is absent: the price did not move in it.
 */
export interface HourlyPrices {
  hours: ReadonlyArray<{ anchor: number; t: number; sqrtPriceX96Close: bigint; tickClose: number }>
}

/** One settlement of the NFT's fees: its mint, a collect (a decrease of 0), an increase, a decrease, or the close (liquidity to 0). */
export interface FeeEvent {
  kind: 'mint' | 'collect' | 'increase' | 'decrease' | 'close'
  block: number
  /** Unix seconds, interpolated between hourly headers (at most minutes off). */
  timestamp: number
  /** 0x + 64 hex. */
  tx: string
  /** The fees this event settled (0 for the mint). */
  fees: readonly [bigint, bigint]
  liquidityDelta: bigint
}

/** One hour of the history, cumulative since the mint. */
export interface FeeHour {
  /** floor(block / 36_000): the same anchor for every position, so series align across positions. */
  anchor: number
  /** Unix seconds at the hour's end: the next hour's first block (a header), or the state block for the last, open hour. */
  t: number
  /** Collected + unclaimed since the mint, at the end of this hour. */
  earned: readonly [bigint, bigint]
  /** Settled since the mint, at the end of this hour. */
  collected: readonly [bigint, bigint]
  /** Seconds of this hour with the pool's tick inside the range while the position held liquidity. */
  inRangeSeconds: number
  sqrtPriceX96Close: bigint
  tickClose: number
}

/** The verified history of one position NFT since its mint. */
export interface FeeHistory {
  mintedAt: { block: number; timestamp: number }
  /** Collected + unclaimed since the mint (unclaimed = the chain's figure, which the replay equals). */
  earned: readonly [bigint, bigint]
  collected: readonly [bigint, bigint]
  timeInRange: { inSeconds: number; totalSeconds: number }
  /** One entry per hour from the mint hour to the state block's hour, every hour present. */
  hourly: ReadonlyArray<FeeHour>
  events: ReadonlyArray<FeeEvent>
  checks: { swaps: number; steps: number; tickMismatch: number; liquidityMismatch: number; swapFeeMismatch: number; inconsistentLastStep: number }
}

// ---------------------------------------------------------------------------
// The wire (§15.2, §15.3)
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
}

/**
 * One log as the relay sends it: about 40 % of the RPC's JSON.
 * event: 0 Initialize · 1 ModifyLiquidity · 2 ProtocolFeeUpdated · 3 Swap · 4 Donate · 5 Transfer.
 * topics: topic1 onwards, as the chain gave them (topic0 is implied by `event`).
 */
export type CompactLog = [block: number, logIndex: number, event: CompactEvent, tx: Hex32, topics: Hex32[], data: Hex]

/** 0 Initialize · 1 ModifyLiquidity · 2 ProtocolFeeUpdated · 3 Swap · 4 Donate · 5 Transfer. */
export type CompactEvent = 0 | 1 | 2 | 3 | 4 | 5

/** POST /api/fees/v1/logs. The caller chooses the kind and a pool id or token id; every contract, topic and method is fixed by the relay. */
export type LogsRequest =
  /** PositionManager Transfer, topic3 = tokenId, from the first Transfer ever to the head, one call. */
  | { kind: 'transfer'; tokenId: string }
  /** PoolManager Initialize, topic1 = poolId, whole chain, one call; final once found. */
  | { kind: 'initialize'; poolId: Hex32 }
  /** Initialize, ModifyLiquidity and ProtocolFeeUpdated for the pool, blocks [epoch × 3_600_000, (epoch + 1) × 3_600_000 − 1]. */
  | { kind: 'pool'; poolId: Hex32; epoch: number; until?: number }
  /** Swap and Donate for the pool, `count` day units (864_000 blocks each) from `day`; count 1..7. */
  | { kind: 'swaps'; poolId: Hex32; day: number; count: number; until?: number }
  /** The last Swap of the pool strictly before `block`. */
  | { kind: 'swapBefore'; poolId: Hex32; block: number }
  /** Block timestamps; 1..50 blocks, each a multiple of 36_000 or exactly a request's `until`. */
  | { kind: 'headers'; blocks: number[] }

export type LogsKind = LogsRequest['kind']

/** One unit of a range answer: an epoch, a day, the whole chain (unit null), or the part of a unit up to the head. */
export interface LogsUnit {
  unit: number | null
  from: number
  to: number
  /** `to` is at least SAFE_DEPTH blocks below the head: this unit's logs can no longer change. */
  final: boolean
  logs: CompactLog[]
}

export type LogsResponse =
  | { v: 1; kind: 'transfer' | 'initialize' | 'pool' | 'swaps'; head: number; units: LogsUnit[]; next: number | null }
  | { v: 1; kind: 'swapBefore'; head: number; log: CompactLog | null }
  | { v: 1; kind: 'headers'; head: number; headers: Array<[block: number, timestamp: number]> }
  | { v: 1; kind: LogsKind; behind: true }

/** A relay answer as client.ts hands it on: its value and its decoded size, or why there is none. */
export type RelayAnswer<T> =
  | { ok: true; value: T; bytes: number }
  | { ok: false; failure: 'unavailable' | 'rate_limited' | 'too_large' | 'bad_request'; retryAfterMs: number }

/** An error answer from either Function. */
export interface FeesErrorResponse {
  v: 1
  error: 'bad_request' | 'rate_limited' | 'rpc_unavailable' | 'too_large'
}

// ---------------------------------------------------------------------------
// The replay worker's protocol (§15.5)
// ---------------------------------------------------------------------------

declare const checkpointBrand: unique symbol

/**
 * Where a replay stopped, so a later run resumes from it instead of starting
 * again: only the worker reads it. The main thread keeps it and hands it back.
 */
export type Checkpoint = { readonly [checkpointBrand]: 'Checkpoint' }

/**
 * `growth` is the chain's (feeGrowthInside − feeGrowthInsideLast) mod 2^256 per
 * token at `state.block`, from the same /state answer: the replay's accrued
 * growth must equal it bit for bit (§15.5-8). It rides beside the state
 * because the screens never need it.
 */
export type ToWorker =
  | { type: 'run'; id: string; state: PositionState; growth: readonly [bigint, bigint]; budgetBytes: number; checkpoint: Checkpoint | null }
  | { type: 'cancel'; id: string }

export type WorkerResult =
  | { ok: true; history: FeeHistory; prices: HourlyPrices; checkpoint: Checkpoint }
  | { ok: false; reason: FeesReason; prices: HourlyPrices | null; checkpoint: Checkpoint | null; bytes: number }

export type FromWorker =
  | { type: 'progress'; id: string; bytes: number; daysDone: number; daysTotal: number }
  | { type: 'done'; id: string; result: WorkerResult }

/** How much the history of one subscriber may download: the position page, or the Positions list's aggregate. */
export type FeesScope = 'page' | 'list'
