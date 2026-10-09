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
/** How often a visible page re-reads `/state`. */
export const STATE_REFRESH_MS = 5_000
export const LIST_STATE_REFRESH_MS = 30_000
/** A ledger still being read (`reading`) is asked again this soon. */
export const LEDGER_READING_MS = 2_000
