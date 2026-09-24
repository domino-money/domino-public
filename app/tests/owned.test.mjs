/**
 * POST /api/owned/v1/positions (functions/_lib/owned.ts): the list behind
 * Positions, read from the chain's public RPC with a fixed set of calls.
 *
 * The hand-written ABI and Keccak are checked against viem; the scan runs on a
 * fake RPC that answers only the calls the function is allowed to make, and
 * fails the test on any other; the route is checked through the real beta
 * gate; and Pages' own route order is read from wrangler 4.130.0's build of
 * functions/, so the catch-all forwarder can never shadow this route.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, keccak256 as viemKeccak, numberToHex, pad, toFunctionSelector } from 'viem';
import { OWNER, fakeRpc, memoryCache, multicallAbi, opId, owned, setupAbi } from './owned-chain.mjs';

const require = createRequire(import.meta.url);
const route = require('../.test-build/app/functions/api/owned/v1/positions.js');
const { onRequest: gate, LOGIN_PATH, API_CSP } = require('../.test-build/app/functions/_middleware.js');
const { forward } = require('../.test-build/app/functions/_lib/bridge.js');

const ORIGIN = 'https://domino.money';
const OTHER = '0x3333333333333333333333333333333333333333';
const PM = owned.POSITION_MANAGER;
const SETUP = owned.SETUP_CONTRACT;

test('the selectors, the pins and the Transfer topic are the ones viem and the app name', () => {
  const signatures = {
    balanceOf: 'balanceOf(address)',
    ownerOf: 'ownerOf(uint256)',
    getPositionLiquidity: 'getPositionLiquidity(uint256)',
    aggregate3: 'aggregate3((address,bool,bytes)[])',
    ownerNonce: 'ownerNonce(address)',
    operation: 'operation(bytes32)',
    recoveryStarted: 'recoveryStarted(bytes32)',
  };
  assert.deepEqual(Object.keys(owned.SELECTOR).sort(), Object.keys(signatures).sort());
  for (const [name, signature] of Object.entries(signatures)) assert.equal(`0x${owned.SELECTOR[name]}`, toFunctionSelector(signature), name);
  assert.equal(owned.TRANSFER_TOPIC, viemKeccak(new TextEncoder().encode('Transfer(address,address,uint256)')));
  // The same contracts the app's finance lane pins (src/finance/pin.ts), read from its source so they cannot drift apart.
  const pin = readFileSync(new URL('../src/finance/pin.ts', import.meta.url), 'utf8');
  assert.match(pin, new RegExp(`export const SETUP_CONTRACT: Pin = '${SETUP}'`));
  assert.match(pin, new RegExp(`export const POSITION_MANAGER = '${PM}'`));
  assert.equal(owned.RPC_URL, 'https://rpc.mainnet.chain.robinhood.com');
  assert.equal(owned.MULTICALL3, '0xca11bde05977b3631167028862be2a173976ca11');
  assert.equal(owned.FIRST_TRANSFER_BLOCK, 9506);
});

test('Keccak-256 and the setup operation id agree with viem', () => {
  for (const length of [0, 1, 31, 32, 55, 64, 128, 135, 136, 137, 271, 272, 300]) {
    const bytes = Array.from({ length }, (_, i) => ((i * 131 + length) % 256).toString(16).padStart(2, '0')).join('');
    assert.equal(owned.keccak256(`0x${bytes}`), viemKeccak(`0x${bytes}`), `${length} bytes`);
  }
  // The live deposit of 0x19ea…a792 on 2026-09-23: its first operation.
  assert.equal(owned.operationId('0x19ea136f23151d681da6d20a7a39d36e784ea792', 0n), '0x336239417f316789f8c3f88159622ecb6cba1da16a9bd46296de05732d26e887');
  for (const nonce of [0n, 1n, 7n, 2n ** 64n - 1n]) assert.equal(owned.operationId(OWNER, nonce), opId(OWNER, nonce));
});

test('aggregate3 is encoded as viem encodes it, and its results and an Operation decode as viem encodes them', () => {
  const calls = [
    { target: PM, data: owned.SELECTOR.balanceOf + OWNER.slice(2).padStart(64, '0') },
    { target: SETUP, data: owned.SELECTOR.ownerNonce + OWNER.slice(2).padStart(64, '0') },
    { target: PM, data: owned.SELECTOR.ownerOf + (3135288).toString(16).padStart(64, '0') },
    { target: SETUP, data: 'abcdef' },
  ];
  const expected = encodeFunctionData({ abi: multicallAbi, functionName: 'aggregate3', args: [calls.map(({ target, data }) => ({ target, allowFailure: true, callData: `0x${data}` }))] });
  assert.equal(owned.encodeAggregate3(calls), expected);
  assert.equal(owned.encodeAggregate3([]), encodeFunctionData({ abi: multicallAbi, functionName: 'aggregate3', args: [[]] }));

  const results = [{ success: true, returnData: pad('0x0c') }, { success: false, returnData: '0x08c379a0' }, { success: true, returnData: '0x' }, { success: true, returnData: `0x${'ab'.repeat(40)}` }];
  const data = encodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', result: results });
  assert.deepEqual(owned.decodeAggregate3(data), results.map(({ success, returnData }) => ({ success, data: returnData.slice(2) })));
  assert.throws(() => owned.decodeAggregate3(data.slice(0, -64)), /invalid_return_data/, 'a short reply is refused, never read past its end');

  const op = { owner: OWNER, key: { currency0: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', currency1: '0xca9c78dd337a67f6e0077f65f5e9218719d30edf', fee: 80000, tickSpacing: -800, hooks: '0x0000000000000000000000000000000000000000' }, balance0: 100000n, balance1: 2n ** 128n - 1n, swapped: false, closed: true, tokenId: 7n };
  const encoded = encodeFunctionResult({ abi: setupAbi, functionName: 'operation', result: op });
  assert.deepEqual(owned.decodeOperation(encoded), { owner: OWNER, ...op.key, balance0: op.balance0, balance1: op.balance1, swapped: false, closed: true, tokenId: 7n });
});

test('RPC errors are sorted into split the range, wait and ask again, or stop', () => {
  for (const message of ['query exceeds limit of 10000', 'logs matched by query exceeds limit of 10000', 'log query timed out', 'block range is too wide', 'query returned more than 10000 results', 'request timeout']) {
    assert.equal(owned.classifyRpcError(-32000, message), 'range', message);
  }
  for (const [code, message] of [[429, ''], [-32005, 'limit'], [-32000, 'Too Many Requests'], [-32603, 'rate limited']]) assert.equal(owned.classifyRpcError(code, message), 'rate', message);
  for (const message of ['method not found', 'execution reverted', '']) assert.equal(owned.classifyRpcError(-32601, message), 'fatal', message);
});

// ---------------------------------------------------------------------------
// The scan, on the fake chain of tests/owned-chain.mjs: the calls the function may make and nothing else
// ---------------------------------------------------------------------------

test('held with liquidity is open, held without is closed; burned and sent-away ids are dropped; complete means the count matches balanceOf', async () => {
  const received = [
    { block: 10_000, id: 1 },
    { block: 20_000, id: 2 },
    { block: 30_000, id: 3 },
    { block: 40_000, id: 4 },
    { block: 50_000, id: 5 },
    { block: 60_000, id: 2 }, // received again later: listed once
  ];
  const holders = { 1: OWNER, 2: OWNER, 4: OTHER, 5: OWNER };
  const chain = fakeRpc({ received, holders, liquidity: { 1: 10n, 5: 7n } });
  const answer = await owned.scanOwner(chain.deps, OWNER);
  assert.deepEqual(answer, {
    owner: OWNER,
    block: 70_900_000,
    positions: [
      { tokenId: '5', status: 'open' },
      { tokenId: '1', status: 'open' },
      { tokenId: '2', status: 'closed' },
    ],
    complete: true,
    deposits: [],
    capped: false,
  });
  assert.deepEqual(chain.log.map(({ method }) => method), ['eth_blockNumber', 'eth_getLogs', 'eth_call'], 'no deposits to read at nonce 0');
  assert.deepEqual(chain.log[1].params[0].fromBlock, numberToHex(9506), 'from the first Transfer the PositionManager ever emitted');

  const short = fakeRpc({ received, holders, liquidity: { 1: 10n }, balance: 4n });
  assert.equal((await owned.scanOwner(short.deps, OWNER)).complete, false, 'a held NFT the logs did not name leaves the list incomplete');
  const empty = fakeRpc({});
  assert.deepEqual(await owned.scanOwner(empty.deps, OWNER), { owner: OWNER, block: 70_900_000, positions: [], complete: true, deposits: [], capped: false });
});

const logRanges = (chain) => chain.log.filter(({ method }) => method === 'eth_getLogs').map(({ params }) => [Number(params[0].fromBlock), Number(params[0].toBlock)]);

test('a range the RPC refuses as too large is split in halves, the newer half asked first, until it answers; the ids come back most recent first', async () => {
  const received = Array.from({ length: 30 }, (_, i) => ({ block: 1_000_000 + i * 2_000_000, id: 100 + i }));
  const holders = Object.fromEntries(received.map(({ id }) => [id, OWNER]));
  const chain = fakeRpc({ received, holders, liquidity: Object.fromEntries(received.map(({ id }) => [id, 1n])), logLimit: 8 });
  const answer = await owned.scanOwner(chain.deps, OWNER);
  assert.equal(answer.positions.length, 30);
  assert.equal(answer.complete, true);
  assert.equal(answer.capped, false, 'every range was read');
  const ranges = logRanges(chain);
  assert.ok(ranges.length > 1, 'split');
  assert.deepEqual(ranges[0], [9506, 70_900_000], 'the whole history is asked first, in one query');
  // The answered ranges tile [9506, head] exactly, newest first.
  const answered = ranges.filter(([from, to]) => received.filter(({ block }) => block >= from && block <= to).length <= 8);
  assert.equal(answered[0][1], 70_900_000, 'the range ending at the head is read first');
  assert.equal(answered.at(-1)[0], 9506, 'the range starting at the first Transfer is read last');
  for (let i = 1; i < answered.length; i++) assert.equal(answered[i][1], answered[i - 1][0] - 1, `range ${i} ends just before the one read before it`);
  assert.ok(chain.log.length <= owned.MAX_RPC_CALLS);

  // A log query that times out is split the same way.
  const timeout = fakeRpc({ received: [{ block: 5_000_000, id: 9 }], holders: { 9: OWNER }, liquidity: { 9: 1n }, script: { eth_getLogs: [{ error: { code: -32000, message: 'log query timed out' } }] } });
  assert.deepEqual((await owned.scanOwner(timeout.deps, OWNER)).positions, [{ tokenId: '9', status: 'open' }]);
  assert.equal(timeout.log.filter(({ method }) => method === 'eth_getLogs').length, 3, 'the whole range, then its two halves');
});

test('a range that cannot be split small enough, or a scan past the call cap, fails rather than answering a partial list', async () => {
  const dense = Array.from({ length: 50 }, (_, i) => ({ block: 20_000 + i, id: i + 1 }));
  const chain = fakeRpc({ received: dense, logLimit: 3 });
  await assert.rejects(owned.scanOwner(chain.deps, OWNER), (error) => error instanceof owned.ChainError && error.kind === 'range');
  const sparse = Array.from({ length: 400 }, (_, i) => ({ block: 10_000 + i * 170_000, id: i + 1 }));
  const capped = fakeRpc({ received: sparse, logLimit: 1 });
  await assert.rejects(owned.scanOwner(capped.deps, OWNER), /rpc_call_cap/);
  assert.equal(capped.log.length, owned.MAX_RPC_CALLS, 'no call beyond the cap was made');
});

test('past 300 ids the walk stops at the 300 most recently received and never asks the older ranges; complete still means the count matches balanceOf', async () => {
  // 700 ids, one every 99,000 blocks; the RPC answers at most 200 logs a query.
  const received = Array.from({ length: 700 }, (_, i) => ({ block: 1_000_000 + i * 99_000, id: 1000 + i }));
  const liquidity = Object.fromEntries(received.map(({ id }) => [id, 1n]));
  const chain = fakeRpc({ received, holders: Object.fromEntries(received.map(({ id }) => [id, OWNER])), liquidity, logLimit: 200 });
  const answer = await owned.scanOwner(chain.deps, OWNER);
  assert.deepEqual(answer.positions.map(({ tokenId }) => tokenId), Array.from({ length: 300 }, (_, i) => String(1699 - i)), 'ids 1699 down to 1400');
  assert.deepEqual([answer.capped, answer.complete], [true, false], 'the walk stopped early, and balanceOf is 700 with 300 listed');
  // The whole range, its newer half (351 logs), that half's newer half (172 logs, read), then the quarter before it (179 logs, read down to id 1400).
  assert.deepEqual(logRanges(chain), [[9506, 70_900_000], [35_454_754, 70_900_000], [53_177_378, 70_900_000], [35_454_754, 53_177_377]]);
  assert.equal(chain.log.length, 1 + 4 + 3, 'the head, four log queries, three aggregate3 calls of 100 ids; the older half of the history is never asked');

  // The same history with only the 50 most recent still held: the walk stopped early, and the list is whole.
  const recent = await owned.scanOwner(fakeRpc({ received, holders: Object.fromEntries(received.slice(-50).map(({ id }) => [id, OWNER])), liquidity, logLimit: 200 }).deps, OWNER);
  assert.equal(recent.positions.length, 50);
  assert.deepEqual([recent.capped, recent.complete], [true, true], 'complete: the count matches balanceOf, although the older transfers were never read');

  // Exactly 300 ids in one reply: all read, nothing left, not capped. The same 300 over split ranges, with an older range never asked, is capped.
  const budget = () => ({ calls: 0, started: 0, logBytes: 0 });
  const exact = await owned.receivedIds(fakeRpc({ received: received.slice(-300) }).deps, budget(), OWNER, 70_900_000);
  assert.deepEqual([exact.ids.length, exact.ids[0], exact.ids.at(-1), exact.capped], [300, 1699n, 1400n, false]);
  const unasked = await owned.receivedIds(fakeRpc({ received: received.slice(-300), logLimit: 200 }).deps, budget(), OWNER, 70_900_000);
  assert.deepEqual([unasked.ids.length, unasked.capped], [300, true]);
});

test('an answer reads at most 8 MiB of logs: past it the walk stops with the newer ids it has; any other reply past 1 MiB is refused', async () => {
  const MiB = 1024 * 1024;
  assert.deepEqual([owned.MAX_LOG_BYTES, owned.MAX_REPLY_BYTES], [8 * MiB, MiB]);
  // Ten old transfers of about 1 MiB each, then three small ones near the head; the RPC answers at most 5 logs a query.
  const received = [...Array.from({ length: 10 }, (_, i) => ({ block: (i + 1) * 1_000_000, id: i + 1, bytes: MiB })), ...[101, 102, 103].map((id, i) => ({ block: 60_000_000 + i * 1_000_000, id }))];
  const holders = Object.fromEntries(received.map(({ id }) => [id, OWNER]));
  const liquidity = Object.fromEntries(received.map(({ id }) => [id, 1n]));
  const chain = fakeRpc({ received, holders, liquidity, logLimit: 5 });
  const answer = await owned.scanOwner(chain.deps, OWNER);
  assert.deepEqual(answer.positions.map(({ tokenId }) => tokenId), ['103', '102', '101', '10', '9', '8', '7', '6', '5']);
  assert.deepEqual([answer.capped, answer.complete], [true, false], 'transfers 1 to 4 were not read: 9 listed, 13 held');
  // About 6 MiB read (ids 10 to 5, after one refusal); the next reply, 4 MiB, would pass 8 MiB and is not read to its end.
  assert.deepEqual(logRanges(chain).slice(-4), [[8_870_818, 17_732_129], [9506, 8_870_817], [4_440_162, 8_870_817], [9506, 4_440_161]]);
  assert.equal(chain.log.at(-1).method, 'eth_call', 'nothing after it but the aggregate3 read');
  // A first reply past 8 MiB: nothing read, an answer that says so rather than a failure.
  const dense = await owned.scanOwner(fakeRpc({ received: received.slice(0, 10), holders, liquidity }).deps, OWNER);
  assert.deepEqual([dense.positions, dense.capped, dense.complete], [[], true, false]);

  const huge = fakeRpc({ script: { eth_blockNumber: [{ result: `0x1${'0'.repeat(MiB)}` }] } });
  await assert.rejects(owned.scanOwner(huge.deps, OWNER), (error) => error instanceof owned.ChainError && error.kind === 'fatal' && error.message === 'reply_too_large');
});

test('a 429 is waited out with a growing pause, a few times, and then the scan gives up', async () => {
  const busy = () => new Response('Too Many Requests', { status: 429 });
  const chain = fakeRpc({ received: [{ block: 10_000, id: 1 }], holders: { 1: OWNER }, liquidity: { 1: 1n }, script: { eth_getLogs: [busy(), { error: { code: -32005, message: 'rate limit exceeded' } }] } });
  assert.deepEqual((await owned.scanOwner(chain.deps, OWNER)).positions, [{ tokenId: '1', status: 'open' }]);
  assert.deepEqual(chain.slept, [1500, 3000]);
  const stuck = fakeRpc({ script: { eth_blockNumber: [busy(), busy(), busy(), busy(), busy()] } });
  await assert.rejects(owned.scanOwner(stuck.deps, OWNER), (error) => error.kind === 'rate');
  assert.deepEqual(stuck.slept, [1500, 3000, 4500]);
  assert.equal(stuck.log.length, owned.RATE_ATTEMPTS);
});

test('held setup deposits: the last 8 operations by nonce, listed only while held, this owner’s, with a balance and no recovery started', async () => {
  const owner = '0x19ea136f23151d681da6d20a7a39d36e784ea792';
  const key = { currency0: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', currency1: '0xca9c78dd337a67f6e0077f65f5e9218719d30edf', fee: 80000, tickSpacing: 800, hooks: '0x0000000000000000000000000000000000000000' };
  const op = (patch) => ({ owner, key, balance0: 100000n, balance1: 0n, swapped: false, closed: false, tokenId: 0n, ...patch });
  const operations = {
    [opId(owner, 9n)]: op({}),
    [opId(owner, 8n)]: op({ closed: true, tokenId: 5n }),
    [opId(owner, 7n)]: op({ balance0: 0n }),
    [opId(owner, 6n)]: op({ balance1: 3n, balance0: 0n, swapped: true }),
    [opId(owner, 5n)]: op({ owner: OTHER }),
    [opId(owner, 4n)]: op({}),
    [opId(owner, 1n)]: op({}), // older than the last 8: not read
  };
  const chain = fakeRpc({ owner, nonce: 10n, operations, recovery: { [opId(owner, 4n)]: true } });
  const answer = await owned.scanOwner(chain.deps, owner);
  assert.deepEqual(answer.deposits, [
    { operationId: opId(owner, 9n), ...key, balance0: '100000', balance1: '0' },
    { operationId: opId(owner, 6n), ...key, balance0: '0', balance1: '3' },
  ]);
  const read = decodeFunctionData({ abi: multicallAbi, data: chain.log.at(-1).params[0].data }).args[0];
  assert.equal(read.length, 16, 'operation and recoveryStarted for nonces 9 down to 2');
  assert.equal(read[0].callData, encodeFunctionData({ abi: setupAbi, functionName: 'operation', args: [opId(owner, 9n)] }));
  assert.equal(read.at(-1).callData, encodeFunctionData({ abi: setupAbi, functionName: 'recoveryStarted', args: [opId(owner, 2n)] }));
});

// ---------------------------------------------------------------------------
// The request: strict input, JSON errors, per owner an answer kept 30 seconds and a failure 12
// ---------------------------------------------------------------------------

const post = (body, headers = {}) =>
  new Request(`${ORIGIN}/api/owned/v1/positions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('the request is exactly a same-origin JSON POST of {owner}; anything else is a JSON refusal and reads nothing', async () => {
  const chain = fakeRpc({});
  const refusals = [
    [new Request(`${ORIGIN}/api/owned/v1/positions?owner=${OWNER}`), 405, 'method_not_allowed'],
    [post({ owner: OWNER }, { 'Content-Type': 'text/plain' }), 415, 'json_required'],
    [post({ owner: OWNER }, { Origin: 'https://evil.test' }), 403, 'origin_not_allowed'],
    [post({ owner: OWNER }, { 'Sec-Fetch-Site': 'cross-site' }), 403, 'origin_not_allowed'],
    [post('{"owner":'), 400, 'invalid_request'],
    [post([OWNER]), 400, 'invalid_request'],
    [post({ owner: OWNER, method: 'eth_call' }), 400, 'invalid_request'],
    [post({ owner: OWNER, fresh: 'yes' }), 400, 'invalid_request'],
    [post({ owner: OWNER, fresh: false }), 400, 'invalid_request'],
    [post({ address: OWNER }), 400, 'invalid_request'],
    [post({ owner: OWNER.slice(0, 40) }), 400, 'invalid_owner'],
    [post({ owner: ` ${OWNER}` }), 400, 'invalid_owner'],
    [post({ owner: 42 }), 400, 'invalid_owner'],
    // The zero address receives every burn: a scan of it would be the busiest there is, for a wallet nobody holds.
    [post({ owner: `0x${'0'.repeat(40)}` }), 400, 'invalid_owner'],
    [post(JSON.stringify({ owner: OWNER, pad: 'x'.repeat(600) })), 413, 'request_too_large'],
  ];
  for (const [request, status, error] of refusals) {
    const response = await owned.answerOwned(request, chain.deps);
    assert.equal(response.status, status, error);
    assert.match(response.headers.get('Content-Type'), /^application\/json/);
    assert.deepEqual(await response.json(), { error });
  }
  assert.equal(chain.log.length, 0, 'nothing was read for a refused request');
  const ok = await owned.answerOwned(post({ owner: OWNER.toUpperCase().replace('0X', '0x') }), chain.deps);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).owner, OWNER, 'a checksummed or upper-case address is the same owner, answered lowercase');
});

test('an answer whose walk stopped early says so in X-Owned-Capped, from the chain and from the cache; the body stays the five fields the page parses', async () => {
  const received = Array.from({ length: 301 }, (_, i) => ({ block: 1_000_000 + i * 200_000, id: 1 + i }));
  const chain = fakeRpc({ received, holders: { 301: OWNER } });
  const { cache } = memoryCache();
  for (const response of [await owned.answerOwned(post({ owner: OWNER }), chain.deps, cache), await owned.answerOwned(post({ owner: OWNER }), chain.deps, cache)]) {
    assert.equal(response.headers.get('X-Owned-Capped'), 'true');
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['block', 'complete', 'deposits', 'owner', 'positions']);
    assert.deepEqual([body.positions, body.complete], [[{ tokenId: '301', status: 'closed' }], true], 'id 1 was never looked at, and the one NFT held is listed: the list is whole');
  }
  const whole = await owned.answerOwned(post({ owner: OWNER }), fakeRpc({ received: received.slice(1) }).deps);
  assert.equal(whole.headers.get('X-Owned-Capped'), null, 'exactly 300 ids, all read');
});

test('a chain that cannot be read is a 502 with a code, never a partial list; the failure is kept 12 seconds for every question, fresh or not, then the chain is asked again', async () => {
  const failing = fakeRpc({ script: { eth_blockNumber: [{ error: { code: -32601, message: 'method not found' } }] } });
  const down = await owned.answerOwned(post({ owner: OWNER }), failing.deps);
  assert.equal(down.status, 502);
  assert.deepEqual(await down.json(), { error: 'chain_unavailable' });

  const { cache, stored } = memoryCache();
  const busy = fakeRpc({ received: [{ block: 10_000, id: 1 }], holders: { 1: OWNER }, liquidity: { 1: 5n }, script: { eth_blockNumber: Array.from({ length: 4 }, () => new Response('', { status: 429 })) } });
  const first = await owned.answerOwned(post({ owner: OWNER }), busy.deps, cache);
  assert.deepEqual([first.status, await first.json(), first.headers.get('Retry-After')], [502, { error: 'chain_busy' }, '12']);
  assert.equal(busy.log.length, owned.RATE_ATTEMPTS);
  const [key] = stored.keys();
  assert.match(stored.get(key).headers.get('Cache-Control'), /^max-age=12$/);
  // Within 12 seconds, a plain or a fresh question gets the kept failure, and nothing is read.
  for (const [time, body, retry] of [[3_000, { owner: OWNER }, '9'], [3_000, { owner: OWNER, fresh: true }, '9'], [11_999, { owner: OWNER }, '1']]) {
    busy.deps.time = time;
    const again = await owned.answerOwned(post(body), busy.deps, cache);
    assert.deepEqual([again.status, await again.json(), again.headers.get('Retry-After'), again.headers.get('Cache-Control')], [502, { error: 'chain_busy' }, retry, 'no-store'], `at ${time} ms`);
  }
  assert.equal(busy.log.length, owned.RATE_ATTEMPTS, 'the kept failure read nothing');
  // At 12 seconds the chain is asked again, and its answer replaces the failure.
  busy.deps.time = 12_000;
  const recovered = await owned.answerOwned(post({ owner: OWNER }), busy.deps, cache);
  assert.equal(recovered.status, 200);
  assert.deepEqual((await recovered.json()).positions, [{ tokenId: '1', status: 'open' }]);
  assert.match(stored.get(key).headers.get('Cache-Control'), /^max-age=30$/);

  // chain_unavailable is kept the same way.
  const other = memoryCache();
  const broken = fakeRpc({ script: { eth_blockNumber: [{ error: { code: -32601, message: 'method not found' } }] } });
  assert.deepEqual(await (await owned.answerOwned(post({ owner: OWNER }), broken.deps, other.cache)).json(), { error: 'chain_unavailable' });
  broken.deps.time = 11_999;
  assert.deepEqual(await (await owned.answerOwned(post({ owner: OWNER, fresh: true }), broken.deps, other.cache)).json(), { error: 'chain_unavailable' });
  assert.equal(broken.log.length, 1);
});

test('an answer is kept per owner for 30 seconds under a digest, and a fresh question within 5 seconds of it gets it rather than a new scan', async () => {
  const { cache, stored } = memoryCache();
  const chain = fakeRpc({ received: [{ block: 10_000, id: 1 }], holders: { 1: OWNER }, liquidity: { 1: 5n } });
  const body = await (await owned.answerOwned(post({ owner: OWNER }), chain.deps, cache)).json();
  const calls = chain.log.length;
  const ask = async (time, fresh) => {
    chain.deps.time = time;
    const response = await owned.answerOwned(post(fresh ? { owner: OWNER, fresh: true } : { owner: OWNER }), chain.deps, cache);
    assert.deepEqual([response.status, response.headers.get('Cache-Control'), await response.json()], [200, 'no-store', body]);
    return chain.log.length / calls;
  };
  assert.equal(await ask(4_999, true), 1, 'a fresh question 4.999 s after the answer gets it');
  // Right after a refund or a close the page asks fresh: from 5 seconds on, that reads the chain again and replaces what is kept.
  assert.equal(await ask(5_000, true), 2);
  assert.equal(await ask(5_000 + 29_999, false), 2, 'a plain question within 30 s of that answer gets it');
  assert.equal(await ask(35_000, false), 3, 'at 30 s it is read again');
  const [key] = stored.keys();
  assert.doesNotMatch(key, new RegExp(OWNER.slice(2), 'i'), 'the address is not part of the cache key');
  assert.match(stored.get(key).headers.get('Cache-Control'), /^max-age=30$/);
  // An entry without the stored-at and outcome headers (kept before they existed) is not served.
  stored.set(key, new Response(JSON.stringify(body), { headers: { 'Cache-Control': 'max-age=30' } }));
  assert.equal(await ask(35_001, false), 4);
  // Another owner is another key.
  await owned.answerOwned(post({ owner: OTHER }), fakeRpc({ owner: OTHER }).deps, cache);
  assert.equal(stored.size, 2);
});

// ---------------------------------------------------------------------------
// Where the route sits: behind the beta gate, never forwarded to a bridge, first in Pages' order
// ---------------------------------------------------------------------------

const GATE = { BETA_PASSWORD: 'owned-suite-beta-password-0001', BETA_COOKIE_KEY: 'Vb3sQ7mLx2Kp9TcN4dWy8ZhJ1gFa6ReU5oYiXwErTzC' };

async function betaCookie() {
  const response = await gate({
    request: new Request(`${ORIGIN}${LOGIN_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN }, body: `password=${encodeURIComponent(GATE.BETA_PASSWORD)}` }),
    env: GATE,
    next: async () => assert.fail('login reached the app'),
  });
  return response.headers.get('Set-Cookie').split(';')[0];
}

test('the route answers only behind the beta gate, leaves with no-store and the API CSP, and the forwarder never takes its path', async () => {
  let reached = 0;
  const next = (request) => async () => {
    reached += 1;
    return route.onRequest({ request });
  };
  const original = globalThis.fetch;
  globalThis.fetch = async () => assert.fail('the gate let an unauthenticated request reach the chain');
  try {
    const request = post({ owner: OWNER });
    const refused = await gate({ request, env: GATE, next: next(request) });
    assert.equal(refused.status, 401);
    assert.deepEqual(await refused.json(), { error: 'beta_access_required' });
    assert.equal(reached, 0);
  } finally {
    globalThis.fetch = original;
  }

  const cookie = await betaCookie();
  const request = post('{"owner":"nope"}', { Cookie: cookie });
  const answered = await gate({ request, env: GATE, next: next(request) });
  assert.equal(reached, 1);
  assert.equal(answered.status, 400);
  assert.equal(answered.headers.get('Cache-Control'), 'no-store, no-transform');
  assert.equal(answered.headers.get('Content-Security-Policy'), API_CSP);
  assert.deepEqual(await answered.json(), { error: 'invalid_owner' });

  // No bridge family owns /api/owned/: if Pages ever handed the path to the catch-all, it would be a 404, not a proxy.
  const forwarded = await forward(post({ owner: OWNER }), {});
  assert.equal(forwarded.status, 404);
  assert.deepEqual(await forwarded.json(), { error: 'not_found' });
});

test('wrangler 4.130.0 routes /api/owned/v1/positions to its own function, ahead of the catch-all forwarder', () => {
  const web = fileURLToPath(new URL('../../web/node_modules/wrangler/', import.meta.url));
  const out = mkdtempSync(join(tmpdir(), 'owned-routes-'));
  try {
    const run = spawnSync(process.execPath, [join(web, 'bin/wrangler.js'), 'pages', 'functions', 'build', './functions', '--outdir', out, '--output-config-path', join(out, 'config.json'), '--output-routes-path', join(out, '_routes.json')], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', WRANGLER_LOG: 'error' },
      timeout: 120_000,
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const { routes } = JSON.parse(readFileSync(join(out, 'config.json'), 'utf8'));
    const handlers = routes.filter((entry) => entry.module).map((entry) => [entry.routePath, entry.module.join()]);
    assert.deepEqual(handlers, [
      ['/api/owned/v1/positions', 'api/owned/v1/positions.ts:onRequest'],
      ['/api/:path*', 'api/[[path]].ts:onRequest'],
    ], 'Pages takes the first route that matches, after the root middleware');
    assert.deepEqual(routes.filter((entry) => entry.middleware).map((entry) => [entry.routePath, entry.middleware.join()]), [['/', '_middleware.ts:onRequest']], 'the beta gate still runs before every route');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
