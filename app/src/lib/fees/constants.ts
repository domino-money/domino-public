/**
 * Pins, topics, selectors and sizes for the fees history (DESIGN-V2 §15.4).
 *
 * Every address, topic and selector is a hex literal, checked against viem in
 * tests/fees-topics.test.mjs; the same pins as app/src/finance/pin.ts and the
 * V1 deployment profile (docs/deployments/v1-robinhood-mainnet-2026-09-21).
 * functions/_lib/fees.ts pins its own copies; the same test compares both.
 */

/** Uniswap v4 PositionManager on Robinhood Chain (4663). */
export const POSITION_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7'
/** Uniswap v4 PoolManager: every Initialize, ModifyLiquidity, Swap, Donate and ProtocolFeeUpdated. */
export const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
/** Uniswap v4 StateView: slot0, fee growth inside a range, a position's last fee growth. */
export const STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'
/** Multicall3 at its canonical address. */
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
/** The zero address: the sender of every mint Transfer, and the native currency. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** keccak256 of each event signature (topic0). */
export const TOPIC = {
  /** Transfer(address,address,uint256) */
  Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  /** Initialize(bytes32,address,address,uint24,int24,address,uint160,int24) */
  Initialize: '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438',
  /** ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32) */
  ModifyLiquidity: '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec',
  /** Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24) */
  Swap: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
  /** Donate(bytes32,address,uint256,uint256) */
  Donate: '0x29ef05caaff9404b7cb6d1c0e9bbae9eaa7ab2541feba1a9c4248594c08156cb',
  /** ProtocolFeeUpdated(bytes32,uint24) */
  ProtocolFeeUpdated: '0xe9c42593e71f84403b84352cd168d693e2c9fcd1fdbcc3feb21d92b43e6696f9',
} as const

/** Function selectors (first 4 bytes of keccak256 of the signature), without 0x. */
export const SELECTOR = {
  /** PositionManager.getPoolAndPositionInfo(uint256) */
  getPoolAndPositionInfo: '7ba03aad',
  /** PositionManager.getPositionLiquidity(uint256) */
  getPositionLiquidity: '1efeed33',
  /** ERC721.ownerOf(uint256) */
  ownerOf: '6352211e',
  /** StateView.getSlot0(bytes32) */
  getSlot0: 'c815641c',
  /** StateView.getFeeGrowthInside(bytes32,int24,int24) */
  getFeeGrowthInside: '53e9c1fb',
  /** StateView.getPositionInfo(bytes32,address,int24,int24,bytes32) */
  getPositionInfo: 'dacf1d2f',
  /** ERC20.symbol() */
  symbol: '95d89b41',
  /** ERC20.decimals() */
  decimals: '313ce567',
  /** Multicall3.getCurrentBlockTimestamp() */
  getCurrentBlockTimestamp: '0f28c97d',
  /** Multicall3.aggregate3((address,bool,bytes)[]) */
  aggregate3: '82ad56cb',
} as const

/** The compact log's event codes (types.ts CompactLog). */
export const EVENT = { Initialize: 0, ModifyLiquidity: 1, ProtocolFeeUpdated: 2, Swap: 3, Donate: 4, Transfer: 5 } as const

/** About an hour of blocks (the chain makes about 9.9 blocks a second): the grid of headers and hourly buckets. */
export const HOUR_SPAN = 36_000
/** 24 hours of the grid: one `swaps` unit. */
export const DAY_SPAN = 864_000
/** One `pool` unit (about 4 days). */
export const EPOCH_SPAN = 3_600_000
/** A unit whose last block is at least this far below the head (about 30 minutes) can no longer change. */
export const SAFE_DEPTH = 18_000
/** The most swap days one history replays: an older position shows its on-chain unclaimed figure only. */
export const MAX_SWAP_DAYS = 30
/** Most days one `swaps` request asks for. */
export const MAX_DAYS_PER_REQUEST = 7
/** Most blocks one `headers` request asks for. */
export const MAX_HEADERS_PER_REQUEST = 50
/** Most ids one `/state` request asks for. */
export const MAX_STATE_IDS = 8
/** Decoded answer bytes one history may download: a position page, or the Positions list's aggregate. */
export const BUDGET_BYTES = { page: 24 * 1024 * 1024, list: 6 * 1024 * 1024 } as const
/** Relay requests one history keeps in flight. */
export const CLIENT_CONCURRENCY = 2
/** How often a visible page re-reads `/state`. */
export const STATE_REFRESH_MS = 60_000
/** A relay that lags the state's block is asked once more after this wait. */
export const BEHIND_RETRY_MS = 2_000
