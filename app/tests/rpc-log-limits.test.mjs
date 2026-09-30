/**
 * The chain RPC's eth_getLogs limits (2026-09-28, hotfix). The owner: from that morning, for everyone, a position's Fees
 * earned chart and Your APR stopped showing. Live that evening, the chain's own RPC answered at its gateway, at once, a
 * log read over more than 10,000,000 blocks, or over more than 100,000 when one place of its filter held several values,
 * with -32602 "query spans N blocks (a to b), but only 100000 are allowed for this request; narrow the block range, or send
 * one value per position" (C:/dwt/hotfix/traces/pipeline-3325113-1.json). The fees history OR-ed several values over
 * wider ranges (a settlements read's currencies, a span's Swaps and Donates, a pool epoch's three events): each such read
 * was halved to its floor and given up as too large, and every history older than a few hours ended as too_much_history
 * (the card's unclaimed figure only, Your APR a dash), on round 5 as on round 6.
 *
 * Here: the refusal's words read as a range; the tests' fake chains answer the same refusal (tests/support/log-limits.mjs);
 * the relay's and the price path's reads keep inside both limits (one filter per value, in one batch; windows of the
 * widest range); and the owner's own 3325113, through the page's own chain reads against its recorded chain behind those
 * limits, verifies with no read refused.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { numberToHex } from 'viem';
import { LOG_BLOCKS_MANY, LOG_BLOCKS_ONE, logLimitError } from './support/log-limits.mjs';
import { addressTopic, fakeChain, fees, owned, rpcLog, swapLog } from './support/fees/fake-chain.mjs';

const require = createRequire(import.meta.url);
const feesPath = require('../.test-build/app/functions/_lib/feesPath.js');
const { runPipeline } = require('../.test-build/app/src/lib/fees/pipeline.js');

/** The refusals as the chain's RPC sent them, word for word (live, 2026-09-28, 21:20 UTC). */
const LIVE = {
  many: 'query spans 1884736 blocks (73233307 to 75118042), but only 100000 are allowed for this request; narrow the block range, or send one value per position',
  one: 'query spans 75118035 blocks (0 to 75118034), but only 10000000 are allowed for this request; narrow the block range',
};
const POOL = '0x031fe000f185cdf1b8850821d22bdf4ed1e337909be7caa00c2b68594da83f03';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const UFG = '0xefab538cf3c29237a47c6afb145d50ddf204a0a3';
const OWNER = '0xf6184f814543b88dd867c34ce6e9f56ab7d18c0a';
const runtime = (chain) => ({ deps: chain.deps, cache: null });
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
  assert.equal(logLimitError({ address: fees.POOL_MANAGER, fromBlock: '0x0', toBlock: numberToHex(LOG_BLOCKS_MANY - 1), topics: [[fees.TOPIC.Swap, fees.TOPIC.Donate], POOL] }), null);
});

test('the relay’s reads keep inside both limits: several events over a wide range are one filter each in one batch, and the widest range in windows', async () => {
  fees.resetRelayMemory();
  const head = 71_500_000;
  const init = rpcLog({ topics: [fees.TOPIC.Initialize, POOL, addressTopic(USDG), addressTopic(UFG)], data: `0x${[40000n, 400n, 0n, 1n << 96n, 0n].map((n) => n.toString(16).padStart(64, '0')).join('')}`, block: 57_898_668 });
  const chain = fakeChain({ head, logs: [init, swapLog(POOL, 70_000_100), swapLog(POOL, 70_000_200, 1)] });
  const ask = async (request) => {
    const answer = await fees.logsOnChain(runtime(chain), 'memory:', request);
    assert.equal(answer.ok, true, `${request.kind}: ${JSON.stringify(answer)}`);
    return answer.value;
  };
  const initialized = await ask({ kind: 'initialize', poolId: POOL });
  assert.equal(initialized.units[0].logs[0][0], 57_898_668, 'the pool’s Initialize, found across the windows');
  const day = await ask({ kind: 'swaps', poolId: POOL, day: 81, count: 1 });
  assert.deepEqual(day.units[0].logs.map((log) => [log[0], log[1]]), [[70_000_100, 0], [70_000_200, 1]], 'in chain order, merged');
  await ask({ kind: 'pool', poolId: POOL, epoch: 19, until: head });
  await ask({ kind: 'transfer', tokenId: '3325113' });
  const filters = logFilters(chain);
  assert.deepEqual(refusedAny(filters), [], 'nothing the RPC refuses');
  // A pool is initialized once: its windows newest first, and none after the one that holds it.
  const inits = filters.filter((filter) => filter.topics[0] === fees.TOPIC.Initialize && filter.topics[1] === POOL && Number(filter.toBlock) - Number(filter.fromBlock) + 1 === LOG_BLOCKS_ONE);
  assert.deepEqual(inits.map((filter) => [Number(filter.fromBlock), Number(filter.toBlock)]), [[head - LOG_BLOCKS_ONE + 1, head], [head - 2 * LOG_BLOCKS_ONE + 1, head - LOG_BLOCKS_ONE]]);
  assert.ok(filters.some((filter) => Number(filter.toBlock) - Number(filter.fromBlock) + 1 > LOG_BLOCKS_MANY && typeof filter.topics[0] === 'string'), 'wide reads with one event a filter');
  assert.ok(chain.posts.some((post) => post.length === 3 && post.every((method) => method === 'eth_getLogs')), 'a pool epoch’s three events in one batch');
});

test('the price path’s reads keep inside both limits: a settlements read names one currency and one owner a filter, a wide span one event a filter', async () => {
  fees.resetRelayMemory();
  const head = 75_200_000;
  const chain = fakeChain({ head, tokens: [USDG, UFG], logs: [swapLog(POOL, 74_000_000), swapLog(POOL, 74_500_000, 1)] });
  const settle = await feesPath.pathLogsOnChain(runtime(chain), { kind: 'settlements', poolId: POOL, tokenId: '3325113', holders: [OWNER, '0x1111111111111111111111111111111111111111'], currencies: [USDG, UFG], from: 73_233_307, to: 75_118_042 });
  assert.equal(settle.ok, true, JSON.stringify(settle));
  const span = await feesPath.pathLogsOnChain(runtime(chain), { kind: 'span', poolId: POOL, spans: [[73_814_721, 74_678_720], [74_678_721, 75_118_042]] });
  assert.equal(span.ok, true, JSON.stringify(span));
  assert.deepEqual(span.value.units.map((unit) => unit.logs.map((log) => log[0])), [[74_000_000, 74_500_000], []]);
  const filters = logFilters(chain);
  assert.deepEqual(refusedAny(filters), [], 'nothing the RPC refuses');
  const transfers = filters.filter((filter) => filter.topics[0] === fees.TOPIC.Transfer);
  // Two currencies, two owners, both ways, in one window of the life: eight filters, one value in each place.
  assert.equal(transfers.length, 8);
  assert.ok(transfers.every((filter) => typeof filter.address === 'string' && filter.topics.every((topic) => !Array.isArray(topic))));
});

// The owner's own Auto-compound position, recorded read-only on 2026-09-27 (tests/support/fees/3325113.json.gz), behind the
// RPC's limits: through the page's own chain reads (the relay's and the price path's code, as the replay worker runs
// them), its history verifies, and no read the RPC would refuse is asked. Before the fix (5d8051bf, this test run on
// it): 206 reads the RPC refuses (the Initialize over the whole chain, the settlements over its day of life, its pool's
// epochs and Swaps, each halved again and again); this fake answers every half, where live each refusal is a round trip
// under the visitor's limit and a capped part is not halved: 3325113 ended as too_much_history (the live traces).
test('NFT 3325113 behind the RPC’s limits: its history verifies through the page’s own chain reads, and no read is refused', async () => {
  const client = require('../.test-build/app/src/lib/fees/client.js');
  const { caseChain } = await import('./support/fees/case-chain.mjs');
  const { stateOf } = require('../.test-build/app/src/lib/fees/store.js');
  const { logsWith } = require('../.test-build/app/src/lib/fees/logs.js');
  const { chainDeps, memoryCache } = require('../.test-build/app/src/lib/chain/browser.js');
  const { BUDGET_BYTES } = require('../.test-build/app/src/lib/fees/constants.js');
  const original = globalThis.fetch;
  const flags = globalThis.__DOMINO_DEPLOYABLE__;
  globalThis.__DOMINO_DEPLOYABLE__ = true;
  const code = { chainDeps, logsOnChain: fees.logsOnChain, pathLogsOnChain: feesPath.pathLogsOnChain };
  try {
    fees.resetRelayMemory();
    client.forgetChainMemory();
    const chain = caseChain('3325113');
    globalThis.fetch = (url, init) => chain.fetch(url, init);
    const answer = await client.chainState(['3325113']);
    assert.equal(answer.ok, true);
    const { state, growth } = stateOf(answer.value.positions[0], answer.value.block, answer.value.timestamp);
    const cache = memoryCache();
    const result = await runPipeline({ logs: (request) => logsWith(code, cache, request), sleep: async () => {} }, { id: '3325113', state, growth, budgetBytes: BUDGET_BYTES.page, checkpoint: null });
    assert.equal(result?.ok, true, result?.reason);
    const filters = chain.log.filter((call) => call.method === 'eth_getLogs').map((call) => call.params[0]);
    assert.deepEqual(refusedAny(filters), [], 'no read the RPC refuses');
    assert.ok(filters.some((filter) => filter.topics[0] === fees.TOPIC.Transfer && typeof filter.address === 'string' && Number(filter.toBlock) - Number(filter.fromBlock) + 1 > LOG_BLOCKS_MANY), 'its settlements, one currency a filter over its life');
    assert.deepEqual(chain.refused, []);
  } finally {
    globalThis.fetch = original;
    globalThis.__DOMINO_DEPLOYABLE__ = flags;
  }
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
// factory's first block (lib/automationImpact.ts warmVault, VAULT_FIRST_BLOCK) to that read's block. That span grows with
// the chain: past LOG_BLOCKS_ONE it is asked in windows, oldest first, and the fees paid over executions more than
// LOG_BLOCKS_MANY blocks apart one currency at a time; every read inside both limits, none refused.
test('speed wave B’s early vault record, from the factory’s first block, keeps inside both limits', async () => {
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
  const asked = [];
  const deps = {
    async fetch(url, init) {
      const call = JSON.parse(init.body);
      const filter = call.params[0];
      asked.push(filter);
      const limited = logLimitError(filter);
      const inside = (log) => Number(log.blockNumber) >= Number(filter.fromBlock) && Number(log.blockNumber) <= Number(filter.toBlock);
      const reply = limited ? { error: limited } : { result: filter.topics[0] === impact.EXECUTION_COMPLETED ? EXECUTIONS.filter(inside) : [] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, ...reply }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    sleep: async () => undefined,
    now: () => Date.now(),
  };
  try {
    const record = await impact.readVault(VAULT, TOKEN, [USDG, UFG], first, head, deps);
    assert.ok(record, 'the record is read');
    assert.deepEqual(record.executions.map((execution) => execution.block), [first + 500_000, head - 500_000]);
    assert.deepEqual(refusedAny(asked), [], 'nothing the RPC refuses');
    assert.deepEqual(asked.map((filter) => [filter.address, Number(filter.fromBlock), Number(filter.toBlock)]), [
      [VAULT, first, first + LOG_BLOCKS_ONE - 1],
      [VAULT, first + LOG_BLOCKS_ONE, head],
      [USDG, first + 500_000, first + 500_000 + LOG_BLOCKS_ONE - 1],
      [USDG, first + 500_000 + LOG_BLOCKS_ONE, head - 500_000],
      [UFG, first + 500_000, first + 500_000 + LOG_BLOCKS_ONE - 1],
      [UFG, first + 500_000 + LOG_BLOCKS_ONE, head - 500_000],
    ], 'the executions in windows, oldest first; the fees paid one currency at a time, each in windows too');
  } finally {
    [globalThis.__DOMINO_DEPLOYABLE__, globalThis.__DOMINO_TEST_HOOKS__] = flags;
  }
});
