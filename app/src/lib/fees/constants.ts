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
/**
 * Decoded answer bytes one history may download: a position page, or the Positions list's aggregate (which the list no
 * longer shows: 2026-09-25, no replay runs for the list). The page's was 24 MB; since 2026-09-25 every byte of it is
 * read by the visitor's own browser under the public RPC's per-address limit (one 670 kB reply can draw a refusal, and a
 * refusal stops the page's own reads too), so a history bigger than about 2 MB is shown as its unclaimed figure only.
 * The owner's USDG/UFG position needs 5 kB; the recorded cases 3136705 and 2310187, 0.6 and 1.2 MB, still verify.
 * The list's (6 MB before) stays below the page's, which is how the worker tells a page's run and puts it first.
 */
export const BUDGET_BYTES = { page: 2 * 1024 * 1024, list: 1024 * 1024 } as const
/**
 * The most blocks the probe covers, the relay's own (functions/_lib/fees.ts PROBE_SPAN, compared in
 * tests/fees-topics.test.mjs): the pool's last hour of logs, the page's cheap bound on a history before it
 * reads any of it (pipeline.ts step 3).
 */
export const PROBE_SPAN = 36_000
/**
 * How long one history may take in the replay worker, the same way (2026-09-25). The worker reads the chain itself,
 * paced below the RPC's per-address limit (lib/chain/browser.ts chainLane), so a busy pool's history takes minutes to
 * reach the byte budget (PONS/USDG: 27 MB decoded in 345 s, measured that day, and never verified): past this time the
 * run stops as it does at its byte budget, and the card keeps its unclaimed figure instead of loading for minutes.
 * The page's was 60 s; 20 s since 2026-09-25, with the probe before the pool's history (the owner's USDG/UFG position
 * verifies in about 7 s from Brazil through the paced lane).
 * 2026-09-25, later: the page's is 30 s. One slow scan of the RPC (the NFT's Transfer over an epoch took 2.2 s, measured
 * live that day) makes the lane rest four times as long (lib/chain/browser.ts LANE_PACE.workFactor), and took 11 s of
 * the 20 before the owner's USDG/UFG position could verify. The card shows its exact figures while it waits.
 */
export const BUDGET_MS = { page: 30_000, list: 10_000 } as const
/**
 * Relay requests one history keeps in flight for its pool epochs and headers.
 * 1 since 2026-09-25 (was 2): the replay worker's reads share one paced lane
 * to the RPC (lib/chain/browser.ts chainLane), so a second request only waits
 * in it, and was asked before the budget could see the first one's bytes.
 */
export const CLIENT_CONCURRENCY = 1
/*
 * The price path (2026-09-25, pipeline.ts P1 and P2; replay.ts): a busy pool's position replayed from the Swaps of its
 * own life, sized in the compact bytes the relay's answers take (about 620 bytes a Swap, two thirds of the RPC's JSON).
 * Measured that day on the owner's positions: USDG/DELTA's day of Swaps is 106 kB, PONS/USDG's 2.7 MB (4,395 Swaps).
 */
/** The Swaps of a life read before anything is drawn (about 3 s through the paced lane): past it, an estimate first. */
export const PATH_NOW_BYTES = 384 * 1024
/**
 * How much busier a life may have been than the probe's last minutes (the rate that sizes it before any of it is read):
 * recorded PONS/USDG, 3,600 blocks before block 71,568,000 said 1.6 bytes a block, where 3202568's 4.6 hours up to it
 * averaged 4.8 (2026-09-25).
 */
export const PATH_BURST = 3
/**
 * The price path is for a position that lived a small part of its pool's life: one that lived more than a
 * 1 / PATH_LIFE_SHARE of it, in a pool whose history the probe says fits, keeps the exact replay of that history.
 */
export const PATH_LIFE_SHARE = 4
/** The windows of Swaps an estimate reads, in all (a few seconds through the lane). */
export const SAMPLE_BYTES = 160 * 1024
/**
 * The compact bytes of a span reply at the worker's cap (functions/_lib/feesPath.ts SPAN_BYTES: the RPC's JSON is about
 * 1.6 times them). A reply past it is cut by the worker after the RPC has sent it, which the visitor's address pays for.
 */
export const SPAN_CAP_BYTES = 240 * 1024
/**
 * 2026-09-25 (review): the most compact bytes one request of an estimate's windows is sized for, at PATH_BURST times the
 * Swaps' rate read so far: half the cap. Windows sized from a quiet probe alone were cut at the cap three times live.
 */
export const SAMPLE_BATCH_BYTES = 120 * 1024
/**
 * The windows one request of an estimate reads (one batch): four, not the sixteen a request may carry, so no one reply
 * is a burst of work the lane's pace cannot see (live, 2026-09-25, on an address other runs had kept busy: a batch of
 * sixteen was refused once, and the third batch of eight a second later).
 */
export const SAMPLE_SPANS_PER_REQUEST = 4
/** The shortest window an estimate reads in a slot (two minutes of blocks), and the width of its first request's one. */
export const SAMPLE_MIN_BLOCKS = 1_200
/** The most slots (and windows) an estimate has: an hour each, or a few hours each for an older position. */
export const MAX_SLOTS = 48
/**
 * The exact read after an estimate: at most these many bytes and this long (the worker's deadline runs on to it). A day
 * of PONS/USDG, 2.7 MB, is read in about a minute at the lane's pace; a longer busy life keeps its estimate.
 */
export const PATH_REFINE_BYTES = 6 * 1024 * 1024
export const PATH_REFINE_MS = 150_000
/** About the bytes of one span of the exact read: its length follows the Swaps' rate (a reply the RPC answers at once). */
export const SPAN_TARGET_BYTES = 96 * 1024
/** The shortest span of the exact read (a minute of blocks) and the longest (a day: functions/_lib/feesPath.ts SPAN_BLOCKS). */
export const SPAN_MIN_BLOCKS = 600
export const SPAN_BLOCKS_MAX = 864_000
/** The most windows one span request reads (feesPath.ts MAX_SPANS), and the most owners a settlements request names (MAX_HOLDERS). */
export const MAX_SPANS_PER_REQUEST = 16
export const MAX_HOLDERS = 4
/** How often a visible page re-reads `/state`. */
export const STATE_REFRESH_MS = 60_000
/** A relay that lags the state's block is asked once more after this wait. */
export const BEHIND_RETRY_MS = 2_000
