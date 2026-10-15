/**
 * Robinhood Chain's network in the chain registry (2026-10-01, the chain2 workstream, part B, audit items G3 and G4): the
 * chain's official RPC (named for the wallet alone), how fast the chain makes blocks, where its contracts' logs begin, and
 * how wide one eth_getLogs of the chain code may be. config/chains.ts builds Robinhood's record from these and from
 * config/chainIdentity.ts; functions/_lib/owned.ts reads the first blocks and the log windows from here.
 *
 * Changed on purpose 2026-10-01 (RPC-SPEC, the owner's rule: nothing is read from a public RPC): the page reads no RPC of
 * this chain any more. The three public fallbacks it read from while the chain's own RPC could not be reached
 * (since 2026-09-28), the order it asked them in and the fees worker's lane pace to them are
 * gone, with the router that used them (lib/chain/browser.ts, failover.ts, endpoints.ts). Every chain read is rugged97's
 * read gateway (/api/read/*) or one of the site's own fixed routes, answered at the edge by Domino's own node
 * (functions/_lib/localRpc.ts, functions/_lib/chainRoutes.ts).
 *
 * A module of its own, apart from config/chainIdentity.ts, because only the registry and the chain code read it: the
 * page every visitor downloads carries the chain's identity, never this.
 *
 * Pure data: Node-safe, no DOM, no build flag, no network.
 */
import type { Endpoint } from './chainKit'
import { ROBINHOOD_RPC_URL } from './chainIdentity'

/**
 * The chain's official RPC, as the registry's record must name one: offered to the wallet in its "add network"
 * (wallet/chain.ts, config/chainKit.ts addChainParameters), never read by this site, so no budget of the page's own goes
 * with it (every one is zero) and no CSP names it (functions/_middleware.ts).
 */
export const PRIMARY: Endpoint = {
  url: ROBINHOOD_RPC_URL,
  stateDepth: 0,
  logWindow: 0,
  logWindows: 0,
  logDepth: 0,
  headers: false,
  simulate: false,
  gapMs: 0,
  perMinute: 0,
  inFlight: 0,
}

/** About how many blocks the chain makes a second (functions/_lib/fees.ts SAFE_DEPTH counts the same). */
export const BLOCKS_PER_SECOND = 9.9

/** The block of the PositionManager's first Transfer (the mint of NFT 1): nothing before it can name an NFT. */
export const FIRST_TRANSFER_BLOCK = 9506
/**
 * The block DominoSetupV1 was deployed in (transaction 0xa5e96b18…a21a8, read from chain on 2026-09-24: its receipt names
 * this contract at this block, and docs/deployments/v1-robinhood-mainnet-2026-09-21 records the same): no SetupMinted can
 * be older.
 */
export const SETUP_DEPLOY_BLOCK = 69_249_061
/**
 * (2026-10-15, pack 7) A time (Unix seconds) at or after SETUP_DEPLOY_BLOCK's own: the timestamp of block 69,250,734,
 * the release's `verifiedBlock` in docs/deployments/v1-robinhood-mainnet-2026-09-21/deployment.json (2026-09-22
 * 01:07:22 UTC). That block is 1,673 blocks later, and a chain's block times never go back, so anything minted before
 * SETUP_DEPLOY_BLOCK was minted at or before this. The block's own time is not recorded; only this bound is used
 * (lib/chart/positionOpened.ts ledgerOpenedBefore), never as an opening time.
 */
export const SETUP_DEPLOYED_BY = 1_790_039_242

/**
 * 2026-09-28 (the owner: from that morning, for everyone, a position's Fees earned chart and Your APR stopped showing):
 * the chain's public RPC refused, at its gateway and at once, an eth_getLogs over more blocks than LOG_BLOCKS_ONE, or
 * than LOG_BLOCKS_MANY when any place of its filter holds several values (functions/_lib/owned.ts says how the reads keep
 * inside them). Since 2026-10-01 (RPC-SPEC) these are only the chain code's default logical windows: at the edge every
 * route hands it its own (functions/_lib/localRpc.ts EDGE_LOG_LIMITS), and the transport cuts each read into the node's
 * windows (LOCAL_RPC_LOG_BLOCKS).
 */
export const LOG_BLOCKS_ONE = 10_000_000
export const LOG_BLOCKS_MANY = 100_000
