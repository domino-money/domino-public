/**
 * Pins, topics, selectors and sizes for a position's fees (DESIGN-V2 §15.4).
 *
 * Every topic and selector is a hex literal, checked against viem in
 * tests/fees-topics.test.mjs; the addresses are the same pins as
 * app/src/finance/pin.ts and the V1 deployment profile
 * (docs/deployments/v1-robinhood-mainnet-2026-09-21), checked there too.
 * Changed on purpose 2026-10-01 (the chain2 workstream, part B, audit item G3): the four addresses are the chain
 * registry's (config/chainIdentity.ts), read from there under the names this module always gave them; the same values.
 *
 * Changed on purpose 2026-10-02 (RPC-SPEC §11.4, rugged97's rule 2): the fees replay's sizes, budgets and the pool events
 * it read (Initialize, Swap, Donate, ProtocolFeeUpdated) are gone with it; a history is the position's own ledger now
 * (functions/_lib/feesLedger.ts, lib/fees/ledger.ts).
 */
import { MULTICALL3_CANONICAL, ROBINHOOD_POOL_MANAGER, ROBINHOOD_POSITION_MANAGER, ROBINHOOD_STATE_VIEW } from '../../config/chainIdentity'

/** Uniswap v4 PositionManager on Robinhood Chain. */
export const POSITION_MANAGER = ROBINHOOD_POSITION_MANAGER
/** Uniswap v4 PoolManager. */
export const POOL_MANAGER = ROBINHOOD_POOL_MANAGER
/** Uniswap v4 StateView: slot0, fee growth inside a range, a position's last fee growth. */
export const STATE_VIEW = ROBINHOOD_STATE_VIEW
/** Multicall3 at its canonical address. */
export const MULTICALL3 = MULTICALL3_CANONICAL
/** The zero address: the sender of every mint Transfer, and the native currency. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** keccak256 of each event signature (topic0). */
export const TOPIC = {
  /** Transfer(address,address,uint256) */
  Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  /** ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32) */
  ModifyLiquidity: '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec',
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
  /** PositionManager.nextTokenId() (2026-10-01: a page's never-minted id) */
  nextTokenId: '75794a3c',
} as const

/** About an hour of blocks (the chain makes about 9.9 blocks a second). */
export const HOUR_SPAN = 36_000
/** A block at least this far below the head (about 30 minutes) can no longer change. */
export const SAFE_DEPTH = 18_000
/** Most ids one `/state` request asks for, and one ledger request (functions/_lib/feesLedger.ts MAX_LEDGER_IDS). */
export const MAX_STATE_IDS = 8
export const MAX_LEDGER_IDS = 8
/**
 * How often a visible page re-reads `/state`, and a visible Positions list its rows' `/state` (eight rows a request).
 *
 * (2026-10-14, Q1 alone): 5 s and 30 s, as before Q1. Slowing them (a page every 10 s, a list every 60 s) is the owner's
 * to decide, and not yet decided: D8 for the page's read, and D4 for the list's, which ../../v2in/usd.ts
 * USD_CURRENT_SECONDS (120 s) must stay at least two periods of. A list of eight rows costs what it did per read (two or
 * three POSTs: eight rows with their features pass the one POST's 50 calls), twice a minute, and no longer once more at
 * every focus.
 * (2026-10-14, Q1 alone; review finding on the 4 s window): an open position page, alone, polls every 5 s, and the edge
 * serves every second poll the answer it kept (functions/_lib/fees.ts LIVE_STATE_MS, 5 s, as on 918bbd62). So the page
 * costs rugged's node six reads a minute: six POSTs once the edge knows the NFT's facts (Q1's one-POST read; 918bbd62 cost
 * twelve), twelve for an NFT whose facts cannot be learned (two POSTs a read, as on 918bbd62). This note said "12 where it
 * cost 24" before: that held only for reads that take no time. With Q1's 4 s window every poll was a read: twelve POSTs
 * for an ordinary NFT, 24 for the other kind. tests/fees-relay.test.mjs measures it with reads that take time.
 * (2026-10-15, pack 8): the owner's decision D8, a page every 10 s (was 5 s). Six requests a minute where it sent twelve.
 * The edge's window (functions/_lib/fees.ts LIVE_STATE_MS, 5 s) stays shorter than this period, so each poll of a lone
 * viewer is a read and its figure is fresh (it was one poll old on every second 5 s poll): still six reads a minute for a
 * lone viewer, six POSTs for an ordinary NFT. Tied to it: ./freshness.ts HISTORY_CURRENT_MS (two periods, now 20 s) and
 * ../wake.ts WAKE_GAP_MS (10 s, now the page's own period). After the person's own action the page still reads at the
 * receipt and AFTER_ACTION_MS (11 s) later (./store.ts), whatever this period is. The list's 30 s is unchanged (D4 not
 * taken), so ../../v2in/usd.ts USD_CURRENT_SECONDS (120 s) stays at least two periods of the slower read.
 */
export const STATE_REFRESH_MS = 10_000
export const LIST_STATE_REFRESH_MS = 30_000
/** A ledger still being read (`reading`) is asked again this soon. */
export const LEDGER_READING_MS = 2_000
