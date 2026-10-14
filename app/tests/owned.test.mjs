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
import { ARB_SYS, ETH_KEY, ETH_POOL, KEY, OWNER, PARENT_BLOCK, POOL, TOKEN, USDG, ZERO, fakeChain, memoryCache, multicallAbi, nft, opId, owned, packInfo, setupAbi, wallet } from './owned-chain.mjs';
import { browserChain } from './support/browser-chain.mjs';

const require = createRequire(import.meta.url);
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
    // Changed on purpose 2026-09-28 (speed wave B, item 23): the scan's first read asks ArbSys for its (L2) block.
    arbBlockNumber: 'arbBlockNumber()',
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
  // Changed on purpose 2026-10-01 (RPC-SPEC §7.3): a sentinel, not a URL; only the edge's transport (localRpc.ts) answers it.
  assert.equal(owned.RPC_URL, 'local-rpc:robinhood');
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
  for (const message of ['query exceeds limit of 10000', 'logs matched by query exceeds limit of 10000', 'block range is too wide', 'query returned more than 10000 results']) {
    assert.equal(owned.classifyRpcError(-32000, message), 'range', message);
  }
  // Changed on purpose 2026-10-02 (rugged97's rule 7): a time-out (the node's -32002 after 30 s) stops; it is never split.
  for (const [code, message] of [[-32000, 'log query timed out'], [-32000, 'request timeout'], [-32002, 'request timed out'], [-32002, '']]) assert.equal(owned.classifyRpcError(code, message), 'fatal', message);
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
  // Changed on purpose 2026-09-28 (speed wave B, item 23): the head and the owner's nonce come in one aggregate3 at
  // 'latest', which ends the scan of a wallet that never opened an operation.
  assert.deepEqual(chain.log.map(({ method }) => method), ['eth_call', 'eth_getLogs', 'eth_call', 'eth_call'], 'the head and the nonce, the logs, and two aggregate3 reads');
  assert.equal(chain.log[0].params[1], 'latest');
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
  // Changed on purpose 2026-09-28 (speed wave B, item 23): a nonce of 0 lists nothing without a log read; these wallets have one.
  const someoneElse = fakeChain({ nonce: 1n, script: { eth_getLogs: [{ result: [{ address: SETUP, topics: [owned.SETUP_MINTED_TOPIC, pad('0x01'), pad(OTHER), pad('0x01')], data: `0x${'00'.repeat(96)}` }] }] } });
  await assert.rejects(wallet.scanWallet(someoneElse.deps, OWNER), /invalid_log/);
  const removed = fakeChain({ nonce: 1n, nfts: { 1: nft() }, script: { eth_getLogs: [{ result: [{ address: SETUP, topics: [owned.SETUP_MINTED_TOPIC, pad('0x01'), pad(OWNER), pad('0x01')], data: `0x${'00'.repeat(96)}`, removed: true }] }] } });
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

  // Changed on purpose 2026-10-02 (rugged97's rule 7): a log query that times out stops the scan; it is never split and
  // asked again, at the node's cost each time.
  const timeout = fakeChain({ minted: minted(9), nfts: { 9: nft() }, script: { eth_getLogs: [{ error: { code: -32000, message: 'log query timed out' } }] } });
  await assert.rejects(wallet.scanWallet(timeout.deps, OWNER), (error) => error.kind === 'fatal');
  assert.equal(timeout.log.filter(({ method }) => method === 'eth_getLogs').length, 1, 'asked once');

  // 130 mints: the 100 most recent are listed, the walk says it stopped, and the reads come in chunks of 50 ids.
  const lots = Array.from({ length: 130 }, (_, i) => ({ block: owned.SETUP_DEPLOY_BLOCK + 1_000 + i * 1_000, id: 1000 + i }));
  const big = fakeChain({ minted: lots, nfts: Object.fromEntries(lots.map(({ id }) => [id, nft()])) });
  const stopped = await wallet.scanWallet(big.deps, OWNER);
  assert.equal(stopped.capped, true);
  assert.deepEqual(stopped.body.positions.map((p) => p.tokenId), Array.from({ length: 100 }, (_, i) => String(1129 - i)));
  // Changed on purpose 2026-09-28 (speed wave B, item 23): the head and the nonce read first, and (the fake's nonce now
  // counts its 130 mints) its 128 most recent operations read.
  // Changed on purpose 2026-10-02 (rugged97's rule 5: at most 50 calls a multicall): first reads of 12 ids, then chunks of 50.
  assert.equal(wallet.IDS_PER_CALL, 12);
  assert.equal(wallet.CALLS_PER_AGGREGATE, 50);
  assert.equal(big.log.filter(({ method }) => method === 'eth_call').length, 1 + Math.ceil(100 / wallet.IDS_PER_CALL) + Math.ceil((1 + 100 * 2 + 4 + 128 * 2) / wallet.CALLS_PER_AGGREGATE), 'the head and the nonce, first reads of 12 ids, then the second read in chunks');
});

// 2026-09-28 (speed wave B, item 23: a wallet that never used Domino paid the whole scan, three calls in a row, before "No
// positions yet"): DominoSetupV1 counts every operation an owner opens (open() takes ownerNonce), and SetupMinted names
// only an operation's owner, so a nonce of 0 at a block at or past the head is no position and no deposit.
test('a wallet whose setup nonce is 0 is answered empty in one call: the head and the nonce at it, and the runtime told the head', async () => {
  const chain = fakeChain();
  const heads = [];
  const scan = await wallet.scanWallet({ ...chain.deps, head: (block) => heads.push(block) }, OWNER, null, true);
  assert.deepEqual(scan.body, { owner: OWNER, block: HEAD, positions: [], deposits: [] });
  assert.deepEqual([scan.capped, scan.minted, scan.automation], [false, { block: HEAD, ids: [] }, { block: HEAD, positions: [] }]);
  assert.deepEqual(chain.log.map(({ method, params }) => [method, params[1]]), [['eth_call', 'latest']], 'the head and the nonce: no log, no other read');
  assert.deepEqual(heads, [HEAD], 'the page’s router learns the head from it (its fallbacks’ numbered reads)');
  // The route's answer is the same.
  const route = await ask(post({ owner: OWNER }), fakeChain().deps);
  assert.deepEqual(await route.json(), scan.body);
  // A wallet with a position: every later read at that head.
  const one = fakeChain({ minted: minted(1), nfts: { 1: nft() } });
  assert.deepEqual((await wallet.scanWallet(one.deps, OWNER)).body.positions.map((p) => p.tokenId), ['1']);
  assert.ok(one.log.slice(1).every(({ method, params }) => (method === 'eth_getLogs' ? params[0].toBlock : params[1]) === numberToHex(HEAD)));
});

// 2026-09-28 (speed wave B review, item 23): on Robinhood Chain (Arbitrum Nitro) Multicall3.getBlockNumber() is
// block.number, the parent chain's block (26,079,411 when eth_blockNumber and ArbSys.arbBlockNumber() both said
// 75,212,459, read live 2026-09-28; contracts/src/DominoL2Block.sol). A scan that took its head from it read no log (the
// head was before DominoSetupV1's deployment) and pinned every read to a block before the contracts existed: the live
// list came back empty. The fakes answer both as Nitro does, so every scan test fails on that regression.
test('the scan’s head is the L2 block ArbSys names, never Multicall3’s parent-chain block; a head before DominoSetupV1 is refused', async () => {
  const chain = fakeChain({ minted: minted(1), nfts: { 1: nft() } });
  const heads = [];
  const scan = await wallet.scanWallet({ ...chain.deps, head: (block) => heads.push(block) }, OWNER, null, true);
  const first = decodeFunctionData({ abi: multicallAbi, data: chain.log[0].params[0].data }).args[0];
  assert.deepEqual(first.map((call) => [call.target.toLowerCase(), call.callData.slice(0, 10)]), [[ARB_SYS, `0x${owned.SELECTOR.arbBlockNumber}`], [SETUP, `0x${owned.SELECTOR.ownerNonce}`]], 'ArbSys.arbBlockNumber beside the nonce');
  assert.ok(!first.some((call) => call.callData.startsWith('0x42cbb15c')), 'never Multicall3.getBlockNumber');
  assert.deepEqual([scan.body.block, heads], [HEAD, [HEAD]], 'the head, as the page’s router learns it');
  assert.deepEqual(scan.body.positions.map((p) => p.tokenId), ['1']);
  // A head before the contract existed (a parent-chain number) is no head: the scan fails, nothing listed, the router not told.
  const behind = fakeChain({ minted: minted(1), nfts: { 1: nft() }, arbHead: Number(PARENT_BLOCK) });
  const told = [];
  await assert.rejects(wallet.scanWallet({ ...behind.deps, head: (block) => told.push(block) }, OWNER), (error) => error instanceof owned.ChainError && error.message === 'nonce_unread');
  assert.deepEqual([behind.log.length, told], [1, []]);
  // ArbSys unread: the same refusal.
  const unread = fakeChain({ arbHead: -1 });
  await assert.rejects(wallet.scanWallet(unread.deps, OWNER), /nonce_unread/);
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
  // Changed on purpose 2026-09-28 (speed wave B, item 23): the first call is the head and the nonce's aggregate3.
  const stuck = fakeChain({ script: { eth_call: [busy(), busy(), busy(), busy(), busy()] } });
  await assert.rejects(wallet.scanWallet(stuck.deps, OWNER), (error) => error.kind === 'rate');
  assert.deepEqual(stuck.slept, [1500, 3000, 4500]);
  assert.equal(stuck.log.length, owned.RATE_ATTEMPTS);
});

// Changed on purpose (2026-09-25, audit of 754014c): every setup operation is read (the 128 most recent at most), not the
// last 8: a deposit older than those was left out, with its Refund to wallet, while its funds stayed held.
test('held setup deposits: every operation by nonce, listed only while held, this owner’s, with a balance and no recovery started, their tokens read at the same block', async () => {
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
    [opId(owner, 1n)]: op({}), // older than the last 8: read too since 2026-09-25, and still held
  };
  const chain = fakeChain({ owner, nonce: 10n, operations, recovery: { [opId(owner, 4n)]: true }, tokens: { [USDG]: { symbol: 'USDG', decimals: 6 }, [NET]: { symbol: 'NET', decimals: 9 } } });
  const { body } = await wallet.scanWallet(chain.deps, owner);
  assert.deepEqual(body.positions, []);
  const usdg = { address: USDG, symbol: 'USDG', decimals: 6 };
  const net = { address: NET, symbol: 'NET', decimals: 9 };
  assert.deepEqual(body.deposits, [
    { operationId: opId(owner, 9n), ...key, balance0: '100000', balance1: '0', currencies: [usdg, net] },
    { operationId: opId(owner, 6n), ...key, currency0: ZERO, balance0: '0', balance1: '3', currencies: [{ address: ZERO, symbol: 'ETH', decimals: 18 }, net] },
    { operationId: opId(owner, 1n), ...key, balance0: '100000', balance1: '0', currencies: [usdg, net] },
  ]);
  // Changed on purpose 2026-09-28 (speed wave B, item 23): the nonce comes with the head (at 'latest'), so a wallet with no
  // position has no first read of its own: the second read, and one for the deposits' tokens no position named.
  const [nonce, ...reads] = chain.log.filter(({ method }) => method === 'eth_call').map(({ params }) => [params[1], decodeFunctionData({ abi: multicallAbi, data: params[0].data }).args[0]]);
  assert.deepEqual([nonce[0], nonce[1].length], ['latest', 2], 'the head and the nonce');
  assert.equal(reads.length, 2, 'the second read, and one for the deposits’ tokens no position named');
  assert.equal(reads[0][1].length, 20, 'operation and recoveryStarted for nonces 9 down to 0');
  assert.equal(reads[0][1][0].callData, encodeFunctionData({ abi: setupAbi, functionName: 'operation', args: [opId(owner, 9n)] }));
  assert.equal(reads[0][1].at(-1).callData, encodeFunctionData({ abi: setupAbi, functionName: 'recoveryStarted', args: [opId(owner, 0n)] }));
  assert.deepEqual(reads[1][1].map((call) => call.target.toLowerCase()), [USDG, USDG, NET, NET]);
});

// 2026-09-25 (audit of 754014c): a wallet with many setup operations. Its 128 most recent are read, two sub-calls each,
// batched into Multicall3 calls of at most CALLS_PER_AGGREGATE; a held deposit among them is listed however old, and one
// older than the 128 is not read.
test('held setup deposits: the 128 most recent operations are read in Multicall3 batches, an old held deposit among them listed', async () => {
  const owner = '0x19ea136f23151d681da6d20a7a39d36e784ea792';
  const key = { currency0: ZERO, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: ZERO };
  const op = (patch) => ({ owner, key, balance0: 0n, balance1: 100000n, swapped: false, closed: false, tokenId: 0n, ...patch });
  const operations = { [opId(owner, 20n)]: op({}), [opId(owner, 139n)]: op({ closed: true, tokenId: 9n }), [opId(owner, 11n)]: op({}) };
  const chain = fakeChain({ owner, nonce: 140n, operations, tokens: { [USDG]: { symbol: 'USDG', decimals: 6 } } });
  const { body } = await wallet.scanWallet(chain.deps, owner);
  assert.deepEqual(body.deposits.map((d) => d.operationId), [opId(owner, 20n)], 'nonce 20 of 140 is listed; 11 is older than the 128 most recent');
  const reads = chain.log.filter(({ method }) => method === 'eth_call').map(({ params }) => decodeFunctionData({ abi: multicallAbi, data: params[0].data }).args[0]);
  const opCalls = reads.flat().filter((call) => call.target.toLowerCase() === owned.SETUP_CONTRACT && call.callData.startsWith(encodeFunctionData({ abi: setupAbi, functionName: 'operation', args: [opId(owner, 0n)] }).slice(0, 10)));
  assert.equal(opCalls.length, 128, 'operation() for nonces 139 down to 12');
  assert.ok(reads.every((calls) => calls.length <= wallet.CALLS_PER_AGGREGATE), 'no Multicall3 call over its batch size');
  // The page's parser takes an answer with that many deposits.
  const client = require('../.test-build/app/src/lib/walletPositions.js');
  const many = { owner, block: 1, positions: [], deposits: Array.from({ length: 128 }, (_, i) => ({ operationId: opId(owner, BigInt(i)), currency0: ZERO, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: ZERO, balance0: '0', balance1: '1', currencies: [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: USDG, symbol: 'USDG', decimals: 6 }] })) };
  assert.notEqual(client.parseWalletAnswer(many, owner), null);
  assert.equal(client.parseWalletAnswer({ ...many, deposits: [...many.deposits, many.deposits[0]] }, owner), null, 'beyond the scan’s own cap: refused');
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
  // Changed on purpose 2026-09-28 (speed wave B, item 23): the first call is the head and the nonce's aggregate3.
  const failing = fakeChain({ script: { eth_call: [{ error: { code: -32601, message: 'method not found' } }] } });
  const down = await ask(post({ owner: OWNER }), failing.deps);
  assert.equal(down.status, 502);
  assert.deepEqual(await down.json(), { error: 'chain_unavailable' });

  const { cache, stored } = memoryCache();
  const busy = fakeChain({ minted: minted(1), nfts: { 1: nft() }, script: { eth_call: Array.from({ length: 4 }, () => new Response('', { status: 429 })) } });
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
  // Changed on purpose 2026-10-02 (RPC fix round 2): an answer is kept 25 s, a little less than the list's own 30 s refresh
  // (src/lib/walletPositions.ts REFRESH_MS), so each refresh of an open list reads figures at most one refresh old (the
  // review's finding 14 had made it 40 s, figures up to a minute old); every tab of the owner shares the one entry.
  assert.match(stored.get(key).headers.get('Cache-Control'), /^max-age=25$/);
});

test('an answer is kept per owner for 25 seconds under a digest, and a fresh question within 5 seconds of it gets it rather than a new scan', async () => {
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
  assert.equal(await again(5_000 + 24_999, false), 2, 'a plain question within 25 s of that answer gets it');
  assert.equal(await again(30_000, false), 3, 'at 25 s it is read again');
  const [key] = stored.keys();
  assert.doesNotMatch(key, new RegExp(OWNER.slice(2), 'i'), 'the address is not part of the cache key');
  stored.set(key, new Response(JSON.stringify(body), { headers: { 'Cache-Control': 'max-age=25' } }));
  assert.equal(await again(30_001, false), 4, 'an entry without its stored-at and outcome headers is not served');
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

// Changed on purpose (2026-10-01, platform workstream, D8): the route was retired (the page read the chain itself since
// 2026-09-25). Changed on purpose again the same day (RPC-SPEC §2.5.1, the owner's rule: the site reads nothing from a
// public RPC): it is back, answered from Domino's own node (functions/_lib/chainRoutes.ts, tests/chain-routes.test.mjs),
// behind the gate, with no cookie past it. Never the catch-all forwarder's.
test('the route answers behind the gate, from Domino’s own node: no cookie goes on, and without the node’s secret a calm 503 reads nothing', async () => {
  const route = require('../.test-build/app/functions/api/owned/v2/positions.js');
  const original = globalThis.fetch;
  const log = console.log;
  globalThis.fetch = async () => assert.fail('nothing may reach the chain from the edge without its secret');
  console.log = () => {};
  try {
    const refused = await gate({ request: post({ owner: OWNER }), env: GATE, next: async () => assert.fail('the gate let an unauthenticated request through') });
    assert.equal(refused.status, 401);
    assert.deepEqual(await refused.json(), { error: 'beta_access_required' });
    const cookie = await betaCookie();
    const request = post({ owner: OWNER }, { Cookie: `${cookie}; __Host-domino-session=v1.sessiontoken` });
    const handed = [];
    const answered = await gate({ request, env: GATE, next: async (passed) => (handed.push(passed), route.onRequest({ request: passed ?? request, env: {} })) });
    assert.ok(handed[0] instanceof Request, 'the gate hands on a request of its own');
    assert.equal(handed[0].headers.get('Cookie'), null, 'no cookie of any kind goes past the gate');
    assert.equal(answered.status, 503);
    assert.equal(answered.headers.get('Retry-After'), '300');
    assert.equal(answered.headers.get('Cache-Control'), 'no-store');
    assert.equal(answered.headers.get('Content-Security-Policy'), API_CSP);
    assert.deepEqual(await answered.json(), { error: 'source_unavailable' });
    // Its path is no bridge family's: the forwarder alone still answers it with a 404.
    assert.equal((await forward(post({ owner: OWNER }), {})).status, 404);
  } finally {
    globalThis.fetch = original;
    console.log = log;
  }
});

test('wrangler 4.130.0 routes the edge-cached reads and Domino’s own chain routes to their own functions, ahead of the catch-all forwarder', () => {
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
    // 2026-09-24 (the three features joined up): a position's feature (functions/api/automation/v1/state.ts) joins, ahead of it too.
    // 2026-09-26 (featured-pools v1 §10.6): the featured pools list's edge cache (functions/api/read/v5/featured-pools.ts)
    // takes its one path ahead of the catch-all; it hands the request to forward() itself, and every other /api/read/v5/ path
    // still reaches the catch-all.
    // 2026-09-28 (speed wave, item 45): a pool's stored history keeps its built answers at the edge too
    // (functions/api/read/v3/history.ts), ahead of the catch-all the same way; every other /api/read/v3/ path still
    // reaches the catch-all.
    // 2026-10-01 (platform workstream, D8): the four chain routes (automation/v1/state, fees/v1/logs, fees/v1/state,
    // owned/v2/positions) were retired: the page read the chain itself.
    // 2026-10-01 (RPC-SPEC §2.1, the owner's rule: the site reads nothing from a public RPC): the four are back, with
    // automation/v1/record and chain/v1/simulate, answered from Domino's own node (functions/_lib/chainRoutes.ts), each
    // ahead of the catch-all.
    // 2026-10-02 (RPC-SPEC §11.4, rugged97's rule 2): fees/v1/logs is gone with the fees replay; fees/v2/ledger in its place.
    assert.deepEqual(handlers, [
      ['/api/automation/v1/record', 'api/automation/v1/record.ts:onRequest'],
      ['/api/automation/v1/state', 'api/automation/v1/state.ts:onRequest'],
      ['/api/chain/v1/confirmation', 'api/chain/v1/confirmation.ts:onRequest'],
      ['/api/chain/v1/simulate', 'api/chain/v1/simulate.ts:onRequest'],
      ['/api/fees/v1/state', 'api/fees/v1/state.ts:onRequest'],
      ['/api/fees/v2/ledger', 'api/fees/v2/ledger.ts:onRequest'],
      ['/api/owned/v2/positions', 'api/owned/v2/positions.ts:onRequest'],
      ['/api/read/v3/history', 'api/read/v3/history.ts:onRequest'],
      // 2026-10-01 (audit A7 b, A14): the stored overview's settled answers at the edge, the same way.
      ['/api/read/v3/overview', 'api/read/v3/overview.ts:onRequest'],
      ['/api/read/v5/featured-pools', 'api/read/v5/featured-pools.ts:onRequest'],
      // 2026-10-01 (audit I3): DEX Screener through our own edge; no read family owns /api/read/dex/, and its route comes
      // before the catch-all, so it never reaches a Worker.
      ['/api/read/dex/:path*', 'api/read/dex/[[path]].ts:onRequest'],
      // 2026-10-14 (incident of 2026-10-13, package D1): the same asks answered per token, always as a 200, on a path of
      // their own (tabs opened before the deploy keep the one above and its shape); ahead of the catch-all the same way.
      ['/api/read/dex2/:path*', 'api/read/dex2/[[path]].ts:onRequest'],
      ['/api/:path*', 'api/[[path]].ts:onRequest'],
      // 2026-10-01 (the chain2 workstream, part B, audit G9): rugged97's Uniswap v3 services for the second chain's
      // section, through this site's edge (functions/_lib/uniswap-v3/handler.ts); outside /api/, so no forwarder family
      // can ever answer for it, and nothing here can shadow it.
      ['/uniswap-v3/:path*', 'uniswap-v3/[[path]].ts:onRequest'],
    ], 'Pages takes the first route that matches, after the root middleware');
    assert.deepEqual(routes.filter((entry) => entry.middleware).map((entry) => [entry.routePath, entry.middleware.join()]), [['/', '_middleware.ts:onRequest']], 'the beta gate still runs before every route');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// 2026-09-28 (the owner's phone, a wallet's in-app browser): a WebView whose fetch gives a reply, or a request, with no
// body stream still has its text, read whole and then measured; before, such a reply read as '' and then as invalid
// JSON. The fees relay reads through the same function (functions/_lib/fees.ts). Review of 2026-09-28: tested here.
test('a reply or a request with no body stream is read whole, and refused past the limit', async () => {
  const streamless = (message) => Object.defineProperty(message, 'body', { value: null });
  const text = '{"jsonrpc":"2.0","id":1,"result":"0x1"}';
  const reply = streamless(new Response(text));
  assert.equal(reply.body, null, 'no body stream, as such a WebView gives');
  assert.deepEqual(await owned.bodyWithin(reply, 1_000), { text, bytes: text.length });
  assert.deepEqual(await owned.bodyWithin(streamless(new Response(text)), text.length - 1), { text: null, bytes: text.length }, 'past the limit: no text');
  const request = streamless(new Request('https://domino.money/api/fees/v1/state', { method: 'POST', body: text }));
  assert.deepEqual(await owned.bodyWithin(request, 1_000), { text, bytes: text.length }, 'a request too');
  assert.deepEqual(await owned.bodyWithin(streamless(new Response(null)), 1_000), { text: '', bytes: 0 }, 'an empty one is empty');
  // With a stream, as every browser but those gives: the same text, and the same refusal past the limit.
  assert.deepEqual(await owned.bodyWithin(new Response(text), 1_000), { text, bytes: text.length });
  assert.deepEqual(await owned.bodyWithin(new Response(text), 10), { text: null, bytes: text.length });
});

// 2026-09-28 (speed wave B, item 17: the badges and a position's chip came 0.6 s after the rows and the header, from a read
// of three calls of their own): the page's list read and a position's state read carry each position's feature in the
// calls they already make (its subscriber in the first aggregate3, its vault's reads in the second), the same answer the
// automation's own scan gives; the route's reads carry none of it.
test('the list’s and a position’s state reads carry each position’s feature, as the automation’s own scan answers it, in no call of their own', async () => {
  const automation = require('../.test-build/app/functions/_lib/automation.js');
  const fees = require('../.test-build/app/functions/_lib/fees.js');
  const VAULT = `0x${'5a'.repeat(20)}`;
  const make = () =>
    browserChain({
      // The chain code run directly, with the chain RPC's own windows.
      nodeRules: false,
      positions: [
        { tokenId: 11, holder: OWNER, key: KEY, tickLower: -600, tickUpper: 600, liquidity: 10n ** 12n, unclaimed: [5n, 7n], subscriber: VAULT },
        { tokenId: 12, holder: OWNER, key: KEY, tickLower: -600, tickUpper: 600, liquidity: 10n ** 12n, unclaimed: [0n, 0n] },
      ],
      tokens: { [USDG]: { symbol: 'USDG', decimals: 6 }, [TOKEN]: { symbol: 'UFG', decimals: 18 } },
      vaults: { [VAULT]: { root: 11, feeBps: 200, paused: false } },
    });
  const runtime = (chain) => ({ fetch: (url, init) => chain.fetch(url, init), sleep: async () => {}, now: () => 0 });
  const listChain = make();
  const list = await wallet.scanWallet(runtime(listChain), OWNER, null, true);
  // The automation's own scan, of the same chain (whose NFTs its list read has named).
  const expected = (await automation.scanAutomation(runtime(listChain), [11n, 12n])).positions;
  assert.deepEqual(expected, [{ tokenId: '11', automation: 'compound', paused: false, active: true, vault: VAULT }, { tokenId: '12', automation: 'plain' }]);
  listChain.log.length = 4;
  assert.deepEqual([...list.automation.positions].sort((a, b) => Number(a.tokenId) - Number(b.tokenId)), expected);
  assert.equal(list.automation.block, list.body.block);
  const listCalls = listChain.log.map((call) => call.method);
  assert.deepEqual(listCalls, ['eth_call', 'eth_getLogs', 'eth_call', 'eth_call'], 'the list’s own four calls, no more');
  const route = await wallet.scanWallet(runtime(make()), OWNER);
  assert.equal(route.automation, undefined, 'the route’s scan reads none of it');
  assert.deepEqual(route.body, list.body, 'the same list');

  fees.resetRelayMemory();
  const stateChain = make();
  const budget = (rt) => fees.newBudget(rt);
  const rt = { deps: runtime(stateChain), cache: null };
  const state = await fees.readState(rt, budget(rt), [11n, 12n], true);
  assert.deepEqual(state.automation, expected);
  // Changed on purpose 2026-10-01 (fees item A21): two calls, the first at 'latest' naming its block.
  assert.deepEqual(stateChain.log.map((call) => call.method), ['eth_call', 'eth_call'], 'the state read’s own two calls');
  fees.resetRelayMemory();
  const bareRt = { deps: runtime(make()), cache: null };
  const bare = await fees.readState(bareRt, budget(bareRt), [11n, 12n]);
  assert.equal(bare.automation, undefined, 'the route’s read carries none');
});
