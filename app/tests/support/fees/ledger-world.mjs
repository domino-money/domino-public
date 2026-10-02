/**
 * One position and its own events on a fake Robinhood Chain (tests/support/browser-chain.mjs), for the fees ledger's tests
 * (2026-10-02, RPC-SPEC §11.4): the edge's (tests/fees-ledger.test.mjs), the page's and the browser suites'.
 *
 * The default is the owner's main position as recorded on 2026-09-27 (NFT 3325113, USDG/UFG 4 %, held by an Auto-compound
 * vault): its mint at block 73,233,307, a NET compound and two collect-and-re-add compounds, with the fees each settled
 * (the recording's own, tests/support/fees/3325113.json.gz expect.events), its liquidity and unclaimed fees at block
 * 74,118,377. Its holder is a test wallet's address, never the owner's, and its vault a test address. Each compound's
 * service fee is 2 % of the fees it used. Not a suite of its own.
 */
import { browserChain, poolIdOf } from '../browser-chain.mjs';
import { PM, logsAnswer, positionLogs, steadyTimes, word } from './ledger-chain.mjs';

export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
export const UFG = '0xefab538cf3c29237a47c6afb145d50ddf204a0a3';
const ZERO = '0x0000000000000000000000000000000000000000';
export const KEY = { currency0: USDG, currency1: UFG, fee: 40_000, tickSpacing: 400, hooks: ZERO };
export const TOKENS = { [USDG]: { symbol: 'USDG', decimals: 6 }, [UFG]: { symbol: 'UFG', decimals: 18 } };
export const VAULT = '0x7a17c0de00000000000000000000000000c0de02';
export const HOLDER = '0xa11ce00000000000000000000000000000000001';
export const HEAD = 74_118_377;
export const NOW = 1_790_530_202;
/** 2 % of what a compound used, as its service fee. */
const fee2 = ([a, b]) => [(a * 2n) / 100n, (b * 2n) / 100n];
/** The recording's settlements (expect.events): the NET compound, then two collect-and-re-add compounds. */
export const OWNER_STEPS = [
  { block: 73_468_040, kind: 'net', delta: 330_426_593_119_223n, fees: [13_102_257n, 1_126_639_544_530_725_964_113n] },
  { block: 73_564_797, kind: 'compound', delta: 377_765_874_452_623n, fees: [4_902_099n, 1_304_189_670_377_567_194_270n] },
  { block: 73_705_363, kind: 'compound', delta: 258_607_619_495_802n, fees: [4_425_004n, 836_433_380_491_496_904_379n] },
].map((step) => ({ ...step, service: fee2(step.fees) }));
export const OWNER_MINT = { block: 73_233_307, liquidity: 36_560_795_792_617_752n };
/** The recording's unclaimed fees at its state block, its price and its range. */
export const OWNER_STATE = { unclaimed: [93_800n, 3_668_139_036_711_116_832_109n], sqrtPriceX96: 1_444_395_114_968_365_204_920_726_338_179_518_260n, tick: 334_389, tickLower: 327_200, tickUpper: 339_200 };

/**
 * A chain holding one position (`tokenId`) and its events. `steps` and `mint` as ledger-chain.mjs positionLogs takes
 * them; `vault`: the Auto-compound vault that holds it (null: a plain position); `checkpoint`: 'stale' for a vault whose
 * checkpoint predates an unseen settlement; `liquidity`: the state's own, when it should not be the events' sum; `key`,
 * `range`, `price` as the pool and the position are; `head`, `now` the chain's head and its time; `extraPositions` more of
 * browserChain's positions (a wallet's other rows, say), whose own events the chain does not hold. `setup: false`: no
 * SetupMinted for it (minted elsewhere, or by a vault); `mintTo`: the address its mint went to (the owner otherwise);
 * `transfers`: [{ block, to }], the NFT sent on (2026-10-02, review of the rules, finding 1); `vaultOwner`: the vault's
 * owner() (the holder otherwise). Returns { chain, spec,
 * events, asked, poolId, logs, liquidityAt, unclaimedAt, timeAt, pastAnswer } (asked: every log filter the chain answered;
 * logs: what it holds, for a test to add to; the last four: the position at a past block, below).
 */
export function ledgerWorld({
  tokenId = 3_325_113n,
  holder = HOLDER,
  vault = VAULT,
  feeBps = 200,
  checkpoint = null,
  key = KEY,
  tokens = TOKENS,
  mint = OWNER_MINT,
  steps = OWNER_STEPS,
  unclaimed = OWNER_STATE.unclaimed,
  liquidity = null,
  range = [OWNER_STATE.tickLower, OWNER_STATE.tickUpper],
  price = { sqrtPriceX96: OWNER_STATE.sqrtPriceX96, tick: OWNER_STATE.tick },
  head = HEAD,
  now = NOW,
  extraLogs = [],
  extraPositions = [],
  setup = true,
  mintTo = null,
  transfers = [],
  vaultOwner = holder,
} = {}) {
  const poolId = poolIdOf(key);
  const spec = { tokenId, owner: holder, key, poolId, tickLower: range[0], tickUpper: range[1], vault, mint, steps, setup, mintTo, transfers };
  const events = positionLogs(spec);
  const asked = [];
  const logs = [...events.logs, ...extraLogs];
  const answer = logsAnswer(logs, asked);
  const chain = browserChain({
    head,
    timestamp: now,
    times: steadyTimes(head, now),
    positions: [{ tokenId, holder: transfers.at(-1)?.to ?? mintTo ?? holder, minter: holder, key, tickLower: range[0], tickUpper: range[1], liquidity: liquidity ?? events.liquidity, unclaimed, subscriber: vault ?? undefined, mintBlock: mint.block }, ...extraPositions],
    pools: { [poolId]: price },
    tokens,
    vaults: vault ? { [vault.toLowerCase()]: { root: tokenId, feeBps, owner: vaultOwner, ...(checkpoint ? { checkpoint } : {}) } } : {},
    history: (filter, from, to) => answer(filter, from, to),
  });
  const timeAt = steadyTimes(head, now);
  /** Its liquidity at `block`: the mint's and every step's up to it. */
  const liquidityAt = (block) => [mint, ...steps].filter((one) => one.block <= block).reduce((sum, one) => sum + BigInt(one.liquidity ?? (one.kind === 'decrease' ? -BigInt(one.delta ?? 0n) : ['increase', 'net', 'compound'].includes(one.kind) ? BigInt(one.delta ?? 0n) : 0n)), 0n);
  /**
   * 2026-10-02 (the chart's periods back, lib/fees/pastReads.ts): its fees ready to collect at `block`, growing evenly
   * between two settlements to what the next one settled (to the state's own figure after the last one), so a read there
   * is a point its ledger agrees with.
   */
  const settling = steps.filter((one) => one.fees && ['net', 'compound', 'domino', 'collect'].includes(one.kind));
  const unclaimedAt = (block) => {
    const before = [mint, ...settling].filter((one) => one.block <= block).at(-1);
    const next = settling.find((one) => one.block > block);
    const [to, share] = next ? [next.block, next.fees] : [head, unclaimed];
    const span = BigInt(Math.max(1, to - before.block));
    const done = BigInt(Math.max(0, Math.min(block, to) - before.block));
    return [(BigInt(share[0]) * done) / span, (BigInt(share[1]) * done) / span];
  };
  /** read-v1 nft-positions for this one NFT at `block`, as rugged97's read gateway answers it (its JSON text). */
  const pastAnswer = (block) => {
    const t = timeAt(block);
    const liquidity = liquidityAt(block);
    return JSON.stringify({
      chainId: 4663, executionAvailable: false, freshness: { ageSeconds: Math.max(0, now - t), status: 'stale' }, mode: 'public_nft_positions_read_only', ownershipScope: 'owner_at_snapshot', requestedIdsOnly: true, schemaVersion: 1,
      snapshot: { hash: `0x${block.toString(16).padStart(64, '0')}`, number: block, timestamp: t }, walletControlVerified: false,
      items: [{
        amountScope: 'current_core_principal_and_unsettled_fees_only', coreOwner: PM, corePositionId: `0x${'5e'.repeat(32)}`, executionAvailable: false, hasLiquidity: liquidity > 0n, inRange: true, isWithdrawalQuote: false,
        liquidityRaw: String(liquidity), nftOwnershipResolved: true, owner: (vault ?? holder).toLowerCase(), ownershipBasis: 'ownerOf_at_pinned_block', pastSettledFeesAttributedToCurrentOwner: false, poolId,
        poolKey: { currency0: key.currency0, currency1: key.currency1, feeMode: 'fixed', fee_pips: key.fee, hooks: key.hooks, tick_spacing: key.tickSpacing },
        positionManager: PM, principalRaw: ['1000000', '1000000000000000000'], salt: word(tokenId), status: 'owner_verified_at_snapshot', tickLower: range[0], tickUpper: range[1], tokenCompatibilityQualified: false,
        tokenId: String(tokenId), unsettledFeesRaw: unclaimedAt(block).map(String), walletControlVerified: false,
      }],
    });
  };
  return { chain, spec, events, asked, poolId, logs, liquidityAt, unclaimedAt, timeAt, pastAnswer };
}
