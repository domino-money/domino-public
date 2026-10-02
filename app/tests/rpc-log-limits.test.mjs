/**
 * The chain RPC's eth_getLogs limits (2026-09-28, hotfix). The owner: from that morning, for everyone, a position's Fees
 * earned chart and Your APR stopped showing. Live that evening, the chain's own RPC answered at its gateway, at once, a
 * log read over more than 10,000,000 blocks, or over more than 100,000 when one place of its filter held several values,
 * with -32602 "query spans N blocks (a to b), but only 100000 are allowed for this request; narrow the block range, or send
 * one value per position" (C:/dwt/hotfix/traces/pipeline-3325113-1.json).
 *
 * Here: the refusal's words read as a range; the tests' fake chains answer the same refusal (tests/support/log-limits.mjs)
 * where they stand for the chain's public RPC (a wallet's own), and the wallet scan's chain code keeps inside it.
 *
 * Changed on purpose 2026-10-02 (RPC-SPEC §11.4; rugged97's rules for the site's token): the site reads only Domino's own
 * node, which has no block ceiling; what the routes' transport must never send it (a log below block 69,249,061, a window
 * past 1,000,000 blocks, the PoolManager's logs over more than one block) fails the tests' node fakes (nodeLogError). The
 * fees replay's reads, which this suite held inside the public limits, are gone.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { numberToHex } from 'viem';
import { LOG_BLOCKS_MANY, LOG_BLOCKS_ONE, NODE_LOG_BLOCKS, NODE_LOG_FLOOR, logLimitError, nodeLogError } from './support/log-limits.mjs';
import { fees, owned } from './support/fees/fake-chain.mjs';
import { factoryCall, isFactoryCall } from './support/vault-factory.mjs';

const require = createRequire(import.meta.url);
const local = require('../.test-build/app/functions/_lib/localRpc.js');

/** The refusals as the chain's RPC sent them, word for word (live, 2026-09-28, 21:20 UTC). */
const LIVE = {
  many: 'query spans 1884736 blocks (73233307 to 75118042), but only 100000 are allowed for this request; narrow the block range, or send one value per position',
  one: 'query spans 75118035 blocks (0 to 75118034), but only 10000000 are allowed for this request; narrow the block range',
};
const POOL = '0x031fe000f185cdf1b8850821d22bdf4ed1e337909be7caa00c2b68594da83f03';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const UFG = '0xefab538cf3c29237a47c6afb145d50ddf204a0a3';
/** Every eth_getLogs filter a fake chain was asked, and whether the RPC's gateway would have refused it. */
const logFilters = (chain) => chain.log.filter((call) => call.method === 'eth_getLogs').map((call) => call.params[0]);
const refusedAny = (filters) => filters.filter((filter) => logLimitError(filter) !== null);

test('the gateway’s refusals read as a range to split, and the tests’ fake chains answer them word for word', () => {
  assert.equal(owned.LOG_BLOCKS_ONE, LOG_BLOCKS_ONE);
  assert.equal(owned.LOG_BLOCKS_MANY, LOG_BLOCKS_MANY);
  for (const message of Object.values(LIVE)) assert.equal(owned.classifyRpcError(-32602, message), 'range', message);
  assert.deepEqual(logLimitError({ address: [USDG, UFG], fromBlock: numberToHex(73_233_307), toBlock: numberToHex(75_118_042), topics: [fees.TOPIC.Transfer] }), { code: -32602, message: LIVE.many });
  assert.deepEqual(logLimitError({ address: fees.POOL_MANAGER, fromBlock: '0x0', toBlock: numberToHex(75_118_034), topics: [fees.TOPIC.Initialize, POOL] }), { code: -32602, message: LIVE.one });
  // A list of one value counts as one (measured the same evening: such a filter over 237,864 blocks reached the node).
  assert.equal(logLimitError({ address: [USDG], fromBlock: numberToHex(73_235_611), toBlock: numberToHex(73_473_474), topics: [[fees.TOPIC.Transfer], null] }), null);
  assert.equal(logLimitError({ address: fees.POOL_MANAGER, fromBlock: '0x0', toBlock: numberToHex(LOG_BLOCKS_ONE - 1), topics: [fees.TOPIC.Initialize, POOL] }), null);
  assert.equal(logLimitError({ address: fees.POOL_MANAGER, fromBlock: '0x0', toBlock: numberToHex(LOG_BLOCKS_MANY - 1), topics: [[fees.TOPIC.ModifyLiquidity, fees.TOPIC.Transfer], POOL] }), null);
});

// 2026-09-28, speed wave B merged after the hotfix: the reads wave B adds or changes keep inside the RPC's limits too.
// The wallet scan (its head from ArbSys and the owner's nonce in its first call, each position's feature in its own
// aggregates) walks DominoSetupV1's SetupMinted logs from the contract's deployment: once the chain is more than
// LOG_BLOCKS_ONE blocks past it, the walk is asked in windows of that width, newest first, never refused first and
// halved (tests/owned-chain.mjs answers the gateway's refusal too).
test('speed wave B’s wallet scan keeps inside the limits: its SetupMinted walk in windows, newest first, nothing refused', async () => {
  const ownedChain = await import('./owned-chain.mjs');
  const start = owned.SETUP_DEPLOY_BLOCK;
  const head = start + LOG_BLOCKS_ONE + 5_000_000;
  const chain = ownedChain.fakeChain({ head, minted: [{ block: start + 1_000, id: 7 }, { block: head - 1_000, id: 9 }], nfts: { 7: ownedChain.nft(), 9: ownedChain.nft() } });
  const scan = await ownedChain.wallet.scanWallet(chain.deps, ownedChain.OWNER, null, true);
  assert.deepEqual(scan.body.positions.map((position) => position.tokenId), ['9', '7'], 'both, the newest first');
  assert.deepEqual(scan.automation.positions.map((position) => [position.tokenId, position.automation]), [['9', 'plain'], ['7', 'plain']], 'each position’s feature, from the same reads');
  const filters = logFilters(chain);
  assert.deepEqual(refusedAny(filters), [], 'nothing the RPC refuses');
  assert.deepEqual(filters.map((filter) => [Number(filter.fromBlock), Number(filter.toBlock)]), [[head - LOG_BLOCKS_ONE + 1, head], [start, head - LOG_BLOCKS_ONE]], 'two windows, newest first');
  // A later scan of the same wallet reads only the blocks since (the page's memory of it): one small window.
  chain.log.length = 0;
  const again = await ownedChain.wallet.scanWallet(chain.deps, ownedChain.OWNER, scan.minted, true);
  assert.deepEqual(again.body.positions.map((position) => position.tokenId), ['9', '7']);
  assert.deepEqual(logFilters(chain).map((filter) => [Number(filter.fromBlock), Number(filter.toBlock)]), [[head - ownedChain.wallet.REREAD_BLOCKS + 1, head]]);
});

// Item 26: an automated position's vault record is read as soon as the page's own read names the vault, from the
// factory's first block (lib/automationImpact.ts warmVault, VAULT_FIRST_BLOCK) to that read's block. Changed on purpose
// 2026-10-02 (rugged97's rules 1 and 3): the route reads Domino's own node from block 69,249,061 on, never below, in
// windows of at most 1,000,000 blocks; none of its reads breaks the node's rules (nodeLogError).
test('speed wave B’s early vault record, from the factory’s first block, keeps to the node’s rules through the site’s route', async () => {
  const impact = require('../.test-build/app/src/lib/automationImpact.js');
  const flags = [globalThis.__DOMINO_DEPLOYABLE__, globalThis.__DOMINO_TEST_HOOKS__];
  globalThis.__DOMINO_DEPLOYABLE__ = true;
  globalThis.__DOMINO_TEST_HOOKS__ = false;
  const VAULT = '0x5290e7d1a3cb728cc497b455e2397b3ec31eab69';
  const TOKEN = '3325113';
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  const first = impact.VAULT_FIRST_BLOCK;
  const head = first + LOG_BLOCKS_ONE + 2_000_000;
  const executed = (tx, block) => ({ address: VAULT, topics: [impact.EXECUTION_COMPLETED, `0x${'a3'.repeat(32)}`, `0x${'d8'.repeat(32)}`], data: `0x${word(0)}${word(TOKEN)}${word(TOKEN)}${word(3)}`, blockNumber: `0x${block.toString(16)}`, transactionHash: tx, logIndex: '0x8', removed: false });
  const EXECUTIONS = [executed(`0x${'01'.repeat(32)}`, first + 500_000), executed(`0x${'02'.repeat(32)}`, head - 500_000)];
  // Changed on purpose (RPC-SPEC §2.5.5, 2026-10-01): the page asks the site's route for the whole span in one POST, and
  // the route reads the node in windows of its own (tests/support/edge-routes.mjs over this fake node, which answers one
  // call or a batch). Every read inside both limits still; which windows the route chooses is its own (tests of the edge).
  const { edgeFetch } = await import('./support/edge-routes.mjs');
  const routes = require('../.test-build/app/src/lib/edge/chainRoutes.js');
  const asked = [];
  const answer = (call) => {
    if (call.method === 'eth_chainId') return { result: '0x1237' };
    if (call.method === 'eth_blockNumber') return { result: `0x${head.toString(16)}` };
    // 2026-10-02 (review of the rules, finding 16): the route asks the factory whether it made the vault first.
    if (isFactoryCall(call)) return factoryCall(call);
    const filter = call.params[0];
    asked.push(filter);
    const limited = nodeLogError(filter);
    const inside = (log) => Number(log.blockNumber) >= Number(filter.fromBlock) && Number(log.blockNumber) <= Number(filter.toBlock);
    return limited ? { error: limited } : { result: filter.topics[0] === impact.EXECUTION_COMPLETED ? EXECUTIONS.filter(inside) : [] };
  };
  const deps = {
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      const reply = Array.isArray(body) ? body.map((call) => ({ jsonrpc: '2.0', id: call.id, ...answer(call) })) : { jsonrpc: '2.0', id: body.id, ...answer(body) };
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    sleep: async () => undefined,
    now: () => Date.now(),
  };
  const sent = [];
  const fetch = edgeFetch(deps);
  const post = (request, options = {}) => routes.postVaultRecord(request, { ...options, fetch: (path, init) => (sent.push(JSON.parse(init.body)), fetch(path, init)) });
  try {
    const record = await impact.readVault(VAULT, TOKEN, [USDG, UFG], first, head, post);
    assert.ok(record, 'the record is read');
    assert.deepEqual(record.executions.map((execution) => execution.block), [first + 500_000, head - 500_000]);
    assert.deepEqual(sent, [{ vault: VAULT, tokenId: TOKEN, currencies: [USDG, UFG], from: first, to: head }], 'one POST of the whole span');
    assert.deepEqual(asked.filter((filter) => nodeLogError(filter) !== null), [], 'nothing the node’s rules refuse');
    assert.ok(asked.every((filter) => Number(filter.fromBlock) >= NODE_LOG_FLOOR), 'nothing below block 69,249,061');
    assert.ok(asked.some((filter) => filter.address === VAULT) && asked.some((filter) => [filter.address].flat().includes(USDG)) && asked.some((filter) => [filter.address].flat().includes(UFG)), 'the executions, and the fees paid in both currencies');
  } finally {
    [globalThis.__DOMINO_DEPLOYABLE__, globalThis.__DOMINO_TEST_HOOKS__] = flags;
  }
});

test('the tests’ node fakes refuse what the routes’ transport must never send Domino’s node, and the transport’s limits are the same numbers', () => {
  assert.equal(NODE_LOG_BLOCKS, local.LOCAL_RPC_LOG_BLOCKS);
  assert.equal(NODE_LOG_FLOOR, local.LOCAL_RPC_LOG_FLOOR);
  const filter = (from, to, address = USDG) => ({ address, fromBlock: numberToHex(from), toBlock: numberToHex(to), topics: [fees.TOPIC.Transfer] });
  assert.equal(nodeLogError(filter(NODE_LOG_FLOOR, NODE_LOG_FLOOR + NODE_LOG_BLOCKS - 1)), null);
  assert.equal(nodeLogError(filter(NODE_LOG_FLOOR, NODE_LOG_FLOOR + NODE_LOG_BLOCKS)).code, -32099, 'a window too wide');
  assert.equal(nodeLogError(filter(NODE_LOG_FLOOR - 1, NODE_LOG_FLOOR)).code, -32099, 'below the floor');
  assert.equal(nodeLogError(filter(NODE_LOG_FLOOR + 5, NODE_LOG_FLOOR + 5, fees.POOL_MANAGER)), null, 'one block of the PoolManager');
  assert.equal(nodeLogError(filter(NODE_LOG_FLOOR + 5, NODE_LOG_FLOOR + 6, [USDG, fees.POOL_MANAGER])).code, -32099, 'two blocks of the PoolManager');
  assert.equal(nodeLogError(filter(NODE_LOG_FLOOR, NODE_LOG_FLOOR + 600_000, [USDG, UFG])), null, 'several values over a wide range: the node has no such limit');
});
