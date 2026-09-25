/**
 * POST /api/owned/v2/positions (functions/_lib/walletPositions.ts over the
 * chain helpers of functions/_lib/owned.ts): the positions a wallet created
 * through DominoSetupV1 and its held deposits, read from the chain's public
 * RPC with a fixed set of calls.
 *
 * Rewritten on 2026-09-24 with v2 (the owner: Positions lists only what the
 * wallet created in our protocol, from chain, nothing typed and nothing kept
 * in the browser). The hand-written ABI and Keccak are checked against viem;
 * the scan runs on a fake RPC that answers only the calls the function is
 * allowed to make, and fails the test on any other; the route is checked
 * through the real beta gate; and Pages' own route order is read from
 * wrangler 4.130.0's build of functions/, so the catch-all forwarder can never
 * shadow this route.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, keccak256 as viemKeccak, numberToHex, pad, toEventSelector, toFunctionSelector } from 'viem';
import { ETH_KEY, ETH_POOL, KEY, OWNER, POOL, TOKEN, USDG, ZERO, fakeChain, memoryCache, multicallAbi, nft, opId, owned, packInfo, setupAbi, wallet } from './owned-chain.mjs';

const require = createRequire(import.meta.url);
const route = require('../.test-build/app/functions/api/owned/v2/positions.js');
const { onRequest: gate, LOGIN_PATH, API_CSP } = require('../.test-build/app/functions/_middleware.js');
const { forward } = require('../.test-build/app/functions/_lib/bridge.js');
const poolRange = require('../.test-build/app/src/lib/read/screens/poolRange.js');

const ORIGIN = 'https://domino.money';
const OTHER = '0x3333333333333333333333333333333333333333';
const PM = owned.POSITION_MANAGER;
const SETUP = owned.SETUP_CONTRACT;
const HEAD = 71_700_000;

test('the selectors, the pins, the SetupMinted topic and the deployment block are the ones viem, the contract and the app name', () => {
  const signatures = {
    ownerOf: 'ownerOf(uint256)',
    getPositionLiquidity: 'getPositionLiquidity(uint256)',
    getPoolAndPositionInfo: 'getPoolAndPositionInfo(uint256)',
    aggregate3: 'aggregate3((address,bool,bytes)[])',
    ownerNonce: 'ownerNonce(address)',
    operation: 'operation(bytes32)',
    recoveryStarted: 'recoveryStarted(bytes32)',
  };
  assert.deepEqual(Object.keys(owned.SELECTOR).sort(), Object.keys(signatures).sort());
  for (const [name, signature] of Object.entries(signatures)) assert.equal(`0x${owned.SELECTOR[name]}`, toFunctionSelector(signature), name);
  // The event as the contract declares it, read from its source so the two cannot drift apart.
  const source = readFileSync(new URL('../../contracts/src/DominoSetup.sol', import.meta.url), 'utf8');
  assert.match(source, /event SetupMinted\(bytes32 indexed operationId, address indexed owner, uint256 indexed tokenId, uint128 liquidity, uint128 amount0, uint128 amount1\);/);
  assert.equal(owned.SETUP_MINTED_TOPIC, toEventSelector('SetupMinted(bytes32,address,uint256,uint128,uint128,uint128)'));
  assert.equal(owned.TRANSFER_TOPIC, viemKeccak(new TextEncoder().encode('Transfer(address,address,uint256)')));
  // The deployment block, as the deployment profile records the setup contract's own transaction (read from chain on 2026-09-24).
  const deployment = JSON.parse(readFileSync(new URL('../../docs/deployments/v1-robinhood-mainnet-2026-09-21/deployment.json', import.meta.url), 'utf8'));
  assert.equal(deployment.contracts.setup, SETUP);
  assert.equal(deployment.receipts.find((receipt) => receipt.component === 'setup').blockNumber, owned.SETUP_DEPLOY_BLOCK);
  // The same contracts the app's finance lane pins (src/finance/pin.ts), read from its source so they cannot drift apart.
  const pin = readFileSync(new URL('../src/finance/pin.ts', import.meta.url), 'utf8');
  assert.match(pin, new RegExp(`export const SETUP_CONTRACT: Pin = '${SETUP}'`));
  assert.match(pin, new RegExp(`export const POSITION_MANAGER = '${PM}'`));
  assert.equal(owned.RPC_URL, 'https://rpc.mainnet.chain.robinhood.com');
  assert.equal(owned.MULTICALL3, '0xca11bde05977b3631167028862be2a173976ca11');
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
    { target: SETUP, data: owned.SELECTOR.ownerNonce + OWNER.slice(2).padStart(64, '0') },
    { target: PM, data: owned.SELECTOR.ownerOf + (3135288).toString(16).padStart(64, '0') },
    { target: PM, data: owned.SELECTOR.getPoolAndPositionInfo + (3135288).toString(16).padStart(64, '0') },
    { target: SETUP, data: 'abcdef' },
  ];
  const expected = encodeFunctionData({ abi: multicallAbi, functionName: 'aggregate3', args: [calls.map(({ target, data }) => ({ target, allowFailure: true, callData: `0x${data}` }))] });
  assert.equal(owned.encodeAggregate3(calls), expected);
  assert.equal(owned.encodeAggregate3([]), encodeFunctionData({ abi: multicallAbi, functionName: 'aggregate3', args: [[]] }));

  const results = [{ success: true, returnData: pad('0x0c') }, { success: false, returnData: '0x08c379a0' }, { success: true, returnData: '0x' }, { success: true, returnData: `0x${'ab'.repeat(40)}` }];
  const data = encodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', result: results });
  assert.deepEqual(owned.decodeAggregate3(data), results.map(({ success, returnData }) => ({ success, data: returnData.slice(2) })));
  assert.throws(() => owned.decodeAggregate3(data.slice(0, -64)), /invalid_return_data/, 'a short reply is refused, never read past its end');

  const op = { owner: OWNER, key: { currency0: USDG, currency1: '0xca9c78dd337a67f6e0077f65f5e9218719d30edf', fee: 80000, tickSpacing: -800, hooks: ZERO }, balance0: 100000n, balance1: 2n ** 128n - 1n, swapped: false, closed: true, tokenId: 7n };
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

test('the principal is v4’s: sqrtPriceAtTick equals the app’s over a tick sweep, and the amounts follow the price across the range', () => {
  for (let tick = -887272; tick <= 887272; tick += 7919) assert.equal(wallet.sqrtPriceAtTick(tick), poolRange.sqrtPriceAtTick(tick), `tick ${tick}`);
  for (const tick of [-887272, -1, 0, 1, 887272]) assert.equal(wallet.sqrtPriceAtTick(tick), poolRange.sqrtPriceAtTick(tick));
  assert.equal(wallet.sqrtPriceAtTick(0), 2n ** 96n);
  const L = 10n ** 18n;
  const [a, b] = [wallet.sqrtPriceAtTick(-600), wallet.sqrtPriceAtTick(600)];
  const Q96 = 2n ** 96n;
  // Below the range: all currency0; above it: all currency1; inside: both, rounded down, as a removal pays.
  assert.deepEqual(wallet.principalAt(wallet.sqrtPriceAtTick(-700), -700, -600, 600, L), [(L * Q96 * (b - a)) / b / a, 0n]);
  assert.deepEqual(wallet.principalAt(wallet.sqrtPriceAtTick(600), 600, -600, 600, L), [0n, (L * (b - a)) / Q96], 'a tick equal to tickUpper is above the range');
  assert.deepEqual(wallet.principalAt(Q96, 0, -600, 600, L), [(L * Q96 * (b - Q96)) / b / Q96, (L * (Q96 - a)) / Q96]);
  assert.deepEqual(wallet.principalAt(Q96, 0, -600, 600, 0n), [0n, 0n]);
});

// ---------------------------------------------------------------------------
// The scan, on the fake chain of tests/owned-chain.mjs: the calls the function may make and nothing else
// ---------------------------------------------------------------------------

const minted = (...ids) => ids.map((id, i) => ({ block: owned.SETUP_DEPLOY_BLOCK + 1_000 + i * 10_000, id }));

test('only what DominoSetupV1 minted to the wallet is listed: held with liquidity is open, without it closed; burned and sent-away ids are dropped', async () => {
  const chain = fakeChain({
    minted: minted(11, 12, 13, 14, 15),
    nfts: {
      11: nft(),
      12: nft({ liquidity: 0n }),
      13: nft({ holder: OTHER }),
      14: nft({ burned: true }),
      15: nft({ key: ETH_KEY, tickLower: -100, tickUpper: 100 }),
      // Held by the wallet, but minted elsewhere: no SetupMinted names it, so it is never asked about.
      99: nft(),
    },
  });
  const { body, capped } = await wallet.scanWallet(chain.deps, OWNER);
  assert.equal(capped, false);
  assert.deepEqual(Object.keys(body), ['owner', 'block', 'positions', 'deposits']);
  assert.deepEqual([body.owner, body.block], [OWNER, HEAD]);
  assert.deepEqual(body.positions.map((p) => [p.tokenId, p.status]), [['15', 'open'], ['11', 'open'], ['12', 'closed']]);
  assert.deepEqual(body.deposits, []);
  assert.deepEqual(chain.log.map(({ method }) => method), ['eth_blockNumber', 'eth_getLogs', 'eth_call', 'eth_call'], 'the head, the logs, and two aggregate3 reads');
  assert.equal(chain.log[1].params[0].fromBlock, numberToHex(owned.SETUP_DEPLOY_BLOCK), 'from the block DominoSetupV1 was deployed in');
  const asked = chain.log.filter(({ method }) => method === 'eth_call').flatMap(({ params }) => decodeFunctionData({ abi: multicallAbi, data: params[0].data }).args[0].map((call) => call.callData));
  assert.ok(!asked.some((data) => data.endsWith((99).toString(16).padStart(64, '0'))), 'the NFT minted elsewhere is never read');

  const [eth, usdg] = [body.positions[0], body.positions[1]];
  assert.deepEqual(eth.currencies, [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: TOKEN, symbol: 'UFG', decimals: 18 }], 'native ETH is ETH, 18, never asked');
  assert.deepEqual(usdg, {
    tokenId: '11',
    status: 'open',
    poolId: POOL,
    currencies: [{ address: USDG, symbol: 'USDG', decimals: 6 }, { address: TOKEN, symbol: 'UFG', decimals: 18 }],
    fee: 3000,
    tickSpacing: 60,
    hooks: ZERO,
    tickLower: -600,
    tickUpper: 600,
    liquidity: String(10n ** 12n),
    sqrtPriceX96: String(2n ** 96n),
    tick: 0,
    unclaimedFees: ['0', '0'],
    principal: wallet.principalAt(2n ** 96n, 0, -600, 600, 10n ** 12n).map(String),
  });
  assert.deepEqual(body.positions[2].principal, ['0', '0'], 'a closed position holds nothing');
});

test('the fees are v4’s own figure, mod 2^256; a pool whose price is not read, a core position that disagrees, a token that does not answer: null, never a guess', async () => {
  const U256 = 2n ** 256n;
  const L = 3n * 10n ** 15n;
  const chain = fakeChain({
    minted: minted(1, 2, 3),
    nfts: {
      1: nft({ liquidity: L, growthLast: [U256 - 5n * 2n ** 128n, 7n * 2n ** 128n] }),
      2: nft({ key: { ...KEY, fee: 500, tickSpacing: 10 }, tickLower: -10, tickUpper: 10 }),
      3: nft({ key: ETH_KEY, tickLower: -100, tickUpper: 100, coreLiquidity: 1n }),
    },
    pools: { [POOL]: { sqrtPriceX96: 2n ** 96n, tick: 0, growthInside: [3n * 2n ** 128n, 9n * 2n ** 128n] }, [ETH_POOL]: { sqrtPriceX96: 2n ** 96n, tick: 0, growthInside: [0n, 0n] } },
    tokens: { [USDG]: { symbol: 'USDG', decimals: 6 }, [TOKEN]: null },
  });
  const { body } = await wallet.scanWallet(chain.deps, OWNER);
  const byId = Object.fromEntries(body.positions.map((p) => [p.tokenId, p]));
  // (3 − (2^256 − 5)) mod 2^256 = 8 units of growth; (9 − 7) = 2.
  assert.deepEqual(byId[1].unclaimedFees, [String(8n * L), String(2n * L)]);
  assert.deepEqual([byId[2].sqrtPriceX96, byId[2].tick, byId[2].principal], [null, null, null], 'the 0.05% pool is not in the fake chain: its slot0 reverts');
  assert.equal(byId[3].unclaimedFees, null, 'the core position’s liquidity disagrees with the PositionManager’s: a misread');
  assert.deepEqual(byId[1].currencies[1], { address: TOKEN, symbol: null, decimals: null });
});

test('a position whose packed info names another pool than its key fails the answer rather than list it', async () => {
  const chain = fakeChain({ minted: minted(1), nfts: { 1: nft({ info: packInfo(ETH_POOL, -600, 600) }) } });
  await assert.rejects(wallet.scanWallet(chain.deps, OWNER), /pool_mismatch/);
  const unread = fakeChain({ minted: minted(1), nfts: { 1: nft() } });
  const answer = await wallet.answerWalletPositions(post({ owner: OWNER }), fakeChain({ minted: minted(1), nfts: { 1: nft({ info: packInfo(ETH_POOL, -600, 600) }) } }).deps);
  assert.deepEqual([answer.status, await answer.json()], [502, { error: 'chain_unavailable' }]);
  assert.equal((await wallet.scanWallet(unread.deps, OWNER)).body.positions.length, 1);
});

test('a log the RPC was not asked for fails the answer; a removed log names nothing', async () => {
  const other = fakeChain({ minted: minted(1), nfts: { 1: nft() }, script: { eth_getLogs: [{ result: [{ address: PM, topics: [owned.SETUP_MINTED_TOPIC, pad('0x01'), pad(OWNER), pad('0x01')], data: `0x${'00'.repeat(96)}` }] }] } });
  await assert.rejects(wallet.scanWallet(other.deps, OWNER), /invalid_log/);
  const someoneElse = fakeChain({ script: { eth_getLogs: [{ result: [{ address: SETUP, topics: [owned.SETUP_MINTED_TOPIC, pad('0x01'), pad(OTHER), pad('0x01')], data: `0x${'00'.repeat(96)}` }] }] } });
  await assert.rejects(wallet.scanWallet(someoneElse.deps, OWNER), /invalid_log/);
  const removed = fakeChain({ nfts: { 1: nft() }, script: { eth_getLogs: [{ result: [{ address: SETUP, topics: [owned.SETUP_MINTED_TOPIC, pad('0x01'), pad(OWNER), pad('0x01')], data: `0x${'00'.repeat(96)}`, removed: true }] }] } });
  assert.deepEqual((await wallet.scanWallet(removed.deps, OWNER)).body.positions, []);
});

const logRanges = (chain) => chain.log.filter(({ method }) => method === 'eth_getLogs').map(({ params }) => [Number(params[0].fromBlock), Number(params[0].toBlock)]);

test('a range the RPC refuses as too large is split in halves, the newer half asked first; past 100 ids the walk stops at the most recent', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ block: owned.SETUP_DEPLOY_BLOCK + 50_000 + i * 80_000, id: 100 + i }));
  const nfts = Object.fromEntries(many.map(({ id }) => [id, nft()]));
  const chain = fakeChain({ minted: many, nfts, logLimit: 8 });
  const { body, capped } = await wallet.scanWallet(chain.deps, OWNER);
  assert.equal(body.positions.length, 30);
  assert.equal(capped, false);
  const ranges = logRanges(chain);
  assert.deepEqual(ranges[0], [owned.SETUP_DEPLOY_BLOCK, HEAD], 'the whole history is asked first, in one query');
  const answered = ranges.filter(([from, to]) => many.filter(({ block }) => block >= from && block <= to).length <= 8);
  assert.equal(answered[0][1], HEAD, 'the range ending at the head is read first');
  assert.equal(answered.at(-1)[0], owned.SETUP_DEPLOY_BLOCK);
  for (let i = 1; i < answered.length; i++) assert.equal(answered[i][1], answered[i - 1][0] - 1, `range ${i} ends just before the one read before it`);

  // A log query that times out is split the same way.
  const timeout = fakeChain({ minted: minted(9), nfts: { 9: nft() }, script: { eth_getLogs: [{ error: { code: -32000, message: 'log query timed out' } }] } });
  assert.deepEqual((await wallet.scanWallet(timeout.deps, OWNER)).body.positions.map((p) => p.tokenId), ['9']);
  assert.equal(timeout.log.filter(({ method }) => method === 'eth_getLogs').length, 3, 'the whole range, then its two halves');

  // 130 mints: the 100 most recent are listed, the walk says it stopped, and the reads come in chunks of 50 ids.
  const lots = Array.from({ length: 130 }, (_, i) => ({ block: owned.SETUP_DEPLOY_BLOCK + 1_000 + i * 1_000, id: 1000 + i }));
  const big = fakeChain({ minted: lots, nfts: Object.fromEntries(lots.map(({ id }) => [id, nft()])) });
  const stopped = await wallet.scanWallet(big.deps, OWNER);
  assert.equal(stopped.capped, true);
  assert.deepEqual(stopped.body.positions.map((p) => p.tokenId), Array.from({ length: 100 }, (_, i) => String(1129 - i)));
  assert.equal(big.log.filter(({ method }) => method === 'eth_call').length, 2 + Math.ceil((1 + 100 * 2 + 2) / wallet.CALLS_PER_AGGREGATE), 'two first reads of 50 ids, then the second read in chunks');
});

test('a range that cannot be split small enough, or a scan past the call cap, fails rather than answering a partial list', async () => {
  const dense = Array.from({ length: 50 }, (_, i) => ({ block: owned.SETUP_DEPLOY_BLOCK + 20_000 + i, id: i + 1 }));
  await assert.rejects(wallet.scanWallet(fakeChain({ minted: dense, logLimit: 3 }).deps, OWNER), (error) => error instanceof owned.ChainError && error.kind === 'range');
  const sparse = Array.from({ length: 90 }, (_, i) => ({ block: owned.SETUP_DEPLOY_BLOCK + 10_000 + i * 27_000, id: i + 1 }));
  const capped = fakeChain({ minted: sparse, logLimit: 1 });
  await assert.rejects(wallet.scanWallet(capped.deps, OWNER), /rpc_call_cap/);
  assert.equal(capped.log.length, owned.MAX_RPC_CALLS, 'no call beyond the cap was made');
});

test('a 429 is waited out with a growing pause, a few times, and then the scan gives up', async () => {
  const busy = () => new Response('Too Many Requests', { status: 429 });
  const chain = fakeChain({ minted: minted(1), nfts: { 1: nft() }, script: { eth_getLogs: [busy(), { error: { code: -32005, message: 'rate limit exceeded' } }] } });
  assert.deepEqual((await wallet.scanWallet(chain.deps, OWNER)).body.positions.map((p) => p.tokenId), ['1']);
  assert.deepEqual(chain.slept, [1500, 3000]);
  const stuck = fakeChain({ script: { eth_blockNumber: [busy(), busy(), busy(), busy(), busy()] } });
  await assert.rejects(wallet.scanWallet(stuck.deps, OWNER), (error) => error.kind === 'rate');
  assert.deepEqual(stuck.slept, [1500, 3000, 4500]);
  assert.equal(stuck.log.length, owned.RATE_ATTEMPTS);
});

test('held setup deposits: the last 8 operations by nonce, listed only while held, this owner’s, with a balance and no recovery started, their tokens read at the same block', async () => {
  const owner = '0x19ea136f23151d681da6d20a7a39d36e784ea792';
  const NET = '0xca9c78dd337a67f6e0077f65f5e9218719d30edf';
  const key = { currency0: USDG, currency1: NET, fee: 80000, tickSpacing: 800, hooks: ZERO };
  const op = (patch) => ({ owner, key, balance0: 100000n, balance1: 0n, swapped: false, closed: false, tokenId: 0n, ...patch });
  const operations = {
    [opId(owner, 9n)]: op({}),
    [opId(owner, 8n)]: op({ closed: true, tokenId: 5n }),
    [opId(owner, 7n)]: op({ balance0: 0n }),
    [opId(owner, 6n)]: op({ balance1: 3n, balance0: 0n, swapped: true, key: { ...key, currency0: ZERO } }),
    [opId(owner, 5n)]: op({ owner: OTHER }),
    [opId(owner, 4n)]: op({}),
    [opId(owner, 1n)]: op({}), // older than the last 8: not read
  };
  const chain = fakeChain({ owner, nonce: 10n, operations, recovery: { [opId(owner, 4n)]: true }, tokens: { [USDG]: { symbol: 'USDG', decimals: 6 }, [NET]: { symbol: 'NET', decimals: 9 } } });
  const { body } = await wallet.scanWallet(chain.deps, owner);
  assert.deepEqual(body.positions, []);
  const usdg = { address: USDG, symbol: 'USDG', decimals: 6 };
  const net = { address: NET, symbol: 'NET', decimals: 9 };
  assert.deepEqual(body.deposits, [
    { operationId: opId(owner, 9n), ...key, balance0: '100000', balance1: '0', currencies: [usdg, net] },
    { operationId: opId(owner, 6n), ...key, currency0: ZERO, balance0: '0', balance1: '3', currencies: [{ address: ZERO, symbol: 'ETH', decimals: 18 }, net] },
  ]);
  const reads = chain.log.filter(({ method }) => method === 'eth_call').map(({ params }) => decodeFunctionData({ abi: multicallAbi, data: params[0].data }).args[0]);
  assert.equal(reads.length, 3, 'the first read, the second, and one for the deposits’ tokens no position named');
  assert.equal(reads[1].length, 16, 'operation and recoveryStarted for nonces 9 down to 2');
  assert.equal(reads[1][0].callData, encodeFunctionData({ abi: setupAbi, functionName: 'operation', args: [opId(owner, 9n)] }));
  assert.equal(reads[1].at(-1).callData, encodeFunctionData({ abi: setupAbi, functionName: 'recoveryStarted', args: [opId(owner, 2n)] }));
  assert.deepEqual(reads[2].map((call) => call.target.toLowerCase()), [USDG, USDG, NET, NET]);
});

// ---------------------------------------------------------------------------
// The request: strict input, JSON errors, per owner an answer kept 30 seconds and a failure 12
// ---------------------------------------------------------------------------

const PATH = '/api/owned/v2/positions';
function post(body, headers = {}) {
  return new Request(`${ORIGIN}${PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
const ask = (request, deps, cache = null) => wallet.answerWalletPositions(request, deps, cache);

test('the request is exactly a same-origin JSON POST of {owner}; anything else is a JSON refusal and reads nothing', async () => {
  const chain = fakeChain({});
  const refusals = [
    [new Request(`${ORIGIN}${PATH}?owner=${OWNER}`), 405, 'method_not_allowed'],
    [post({ owner: OWNER }, { 'Content-Type': 'text/plain' }), 415, 'json_required'],
    [post({ owner: OWNER }, { Origin: 'https://evil.test' }), 403, 'origin_not_allowed'],
    [post({ owner: OWNER }, { 'Sec-Fetch-Site': 'cross-site' }), 403, 'origin_not_allowed'],
    [post('{"owner":'), 400, 'invalid_request'],
    [post([OWNER]), 400, 'invalid_request'],
    [post({ owner: OWNER, method: 'eth_call' }), 400, 'invalid_request'],
    [post({ owner: OWNER, tokenId: '1' }), 400, 'invalid_request'],
    [post({ owner: OWNER, fresh: 'yes' }), 400, 'invalid_request'],
    [post({ owner: OWNER, fresh: false }), 400, 'invalid_request'],
    [post({ address: OWNER }), 400, 'invalid_request'],
    [post({ owner: OWNER.slice(0, 40) }), 400, 'invalid_owner'],
    [post({ owner: ` ${OWNER}` }), 400, 'invalid_owner'],
    [post({ owner: 42 }), 400, 'invalid_owner'],
    [post({ owner: `0x${'0'.repeat(40)}` }), 400, 'invalid_owner'],
    [post(JSON.stringify({ owner: OWNER, pad: 'x'.repeat(600) })), 413, 'request_too_large'],
  ];
  for (const [request, status, error] of refusals) {
    const response = await ask(request, chain.deps);
    assert.equal(response.status, status, error);
    assert.match(response.headers.get('Content-Type'), /^application\/json/);
    assert.deepEqual(await response.json(), { error });
  }
  assert.equal(chain.log.length, 0, 'nothing was read for a refused request');
  const ok = await ask(post({ owner: OWNER.toUpperCase().replace('0X', '0x') }), chain.deps);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { owner: OWNER, block: HEAD, positions: [], deposits: [] }, 'a checksummed or upper-case address is the same owner, answered lowercase');
});

test('an answer whose walk stopped early says so in X-Owned-Capped, from the chain and from the cache', async () => {
  const lots = Array.from({ length: 101 }, (_, i) => ({ block: owned.SETUP_DEPLOY_BLOCK + 1_000 + i * 1_000, id: 1 + i }));
  const chain = fakeChain({ minted: lots, nfts: { 101: nft() } });
  const { cache } = memoryCache();
  for (const response of [await ask(post({ owner: OWNER }), chain.deps, cache), await ask(post({ owner: OWNER }), chain.deps, cache)]) {
    assert.equal(response.headers.get('X-Owned-Capped'), 'true');
    assert.deepEqual((await response.json()).positions.map((p) => p.tokenId), ['101']);
  }
  const whole = await ask(post({ owner: OWNER }), fakeChain({ minted: lots.slice(1) }).deps);
  assert.equal(whole.headers.get('X-Owned-Capped'), null, 'exactly 100 ids, all read');
});

test('a chain that cannot be read is a 502 with a code, never a partial list; the failure is kept 12 seconds for every question, fresh or not, then the chain is asked again', async () => {
  const failing = fakeChain({ script: { eth_blockNumber: [{ error: { code: -32601, message: 'method not found' } }] } });
  const down = await ask(post({ owner: OWNER }), failing.deps);
  assert.equal(down.status, 502);
  assert.deepEqual(await down.json(), { error: 'chain_unavailable' });

  const { cache, stored } = memoryCache();
  const busy = fakeChain({ minted: minted(1), nfts: { 1: nft() }, script: { eth_blockNumber: Array.from({ length: 4 }, () => new Response('', { status: 429 })) } });
  const first = await ask(post({ owner: OWNER }), busy.deps, cache);
  assert.deepEqual([first.status, await first.json(), first.headers.get('Retry-After')], [502, { error: 'chain_busy' }, '12']);
  assert.equal(busy.log.length, owned.RATE_ATTEMPTS);
  const [key] = stored.keys();
  assert.match(key, /\/api\/owned\/v2\/cache\/[0-9a-f]{64}$/);
  assert.match(stored.get(key).headers.get('Cache-Control'), /^max-age=12$/);
  for (const [time, body, retry] of [[3_000, { owner: OWNER }, '9'], [3_000, { owner: OWNER, fresh: true }, '9'], [11_999, { owner: OWNER }, '1']]) {
    busy.deps.time = time;
    const again = await ask(post(body), busy.deps, cache);
    assert.deepEqual([again.status, await again.json(), again.headers.get('Retry-After'), again.headers.get('Cache-Control')], [502, { error: 'chain_busy' }, retry, 'no-store'], `at ${time} ms`);
  }
  assert.equal(busy.log.length, owned.RATE_ATTEMPTS, 'the kept failure read nothing');
  busy.deps.time = 12_000;
  const recovered = await ask(post({ owner: OWNER }), busy.deps, cache);
  assert.equal(recovered.status, 200);
  assert.deepEqual((await recovered.json()).positions.map((p) => [p.tokenId, p.status]), [['1', 'open']]);
  assert.match(stored.get(key).headers.get('Cache-Control'), /^max-age=30$/);
});

test('an answer is kept per owner for 30 seconds under a digest, and a fresh question within 5 seconds of it gets it rather than a new scan', async () => {
  const { cache, stored } = memoryCache();
  const chain = fakeChain({ minted: minted(1), nfts: { 1: nft() } });
  const body = await (await ask(post({ owner: OWNER }), chain.deps, cache)).json();
  const calls = chain.log.length;
  const again = async (time, fresh) => {
    chain.deps.time = time;
    const response = await ask(post(fresh ? { owner: OWNER, fresh: true } : { owner: OWNER }), chain.deps, cache);
    assert.deepEqual([response.status, response.headers.get('Cache-Control'), await response.json()], [200, 'no-store', body]);
    return chain.log.length / calls;
  };
  assert.equal(await again(4_999, true), 1, 'a fresh question 4.999 s after the answer gets it');
  assert.equal(await again(5_000, true), 2, 'from 5 s on, a fresh question reads the chain again');
  assert.equal(await again(5_000 + 29_999, false), 2, 'a plain question within 30 s of that answer gets it');
  assert.equal(await again(35_000, false), 3, 'at 30 s it is read again');
  const [key] = stored.keys();
  assert.doesNotMatch(key, new RegExp(OWNER.slice(2), 'i'), 'the address is not part of the cache key');
  stored.set(key, new Response(JSON.stringify(body), { headers: { 'Cache-Control': 'max-age=30' } }));
  assert.equal(await again(35_001, false), 4, 'an entry without its stored-at and outcome headers is not served');
  await ask(post({ owner: OTHER }), fakeChain({ owner: OTHER }).deps, cache);
  assert.equal(stored.size, 2, 'another owner is another key');
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

test('wrangler 4.130.0 routes /api/owned/v2/positions to its own function, ahead of the catch-all forwarder, and v1 is gone', () => {
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
    // 2026-09-24 (P6, DESIGN-V2 §15.1, R-14): the fees relay's two routes join, ahead of the catch-all like owned's.
    // 2026-09-24: owned v1 (every NFT the wallet held) is replaced by v2 (what DominoSetupV1 minted to it).
    assert.deepEqual(handlers, [
      ['/api/fees/v1/logs', 'api/fees/v1/logs.ts:onRequest'],
      ['/api/fees/v1/state', 'api/fees/v1/state.ts:onRequest'],
      ['/api/owned/v2/positions', 'api/owned/v2/positions.ts:onRequest'],
      ['/api/:path*', 'api/[[path]].ts:onRequest'],
    ], 'Pages takes the first route that matches, after the root middleware');
    assert.deepEqual(routes.filter((entry) => entry.middleware).map((entry) => [entry.routePath, entry.middleware.join()]), [['/', '_middleware.ts:onRequest']], 'the beta gate still runs before every route');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
