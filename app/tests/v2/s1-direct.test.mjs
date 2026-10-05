/**
 * The direct exits (src/finance/v2/direct.ts, spec F7 §2.6.4): exit to both tokens and collect without conversion, at
 * Uniswap's own position manager of the position's chain, no zap and no Domino fee, against a fake chain
 * (tests/support/v2-direct-chain.mjs): the exact calldata for v4 (modifyLiquidities DECREASE + TAKE_PAIR) and v3
 * (multicall decreaseLiquidity + collect; collect alone), the minimums on the principal only, the code check against
 * the chain profile's verified hashes, the chain check, and the receipt read from Uniswap's own logs.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { decodeFunctionData, parseAbi } from 'viem';
import { createDirectChain } from '../support/v2-direct-chain.mjs';
import { walletOf } from '../support/v2-chain.mjs';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const direct = require(`${BUILD}finance/v2/direct.js`);
const position = require(`${BUILD}finance/position.js`);
const { V2Revert } = require(`${BUILD}finance/v2/transact.js`);
const chains = require(`${BUILD}v2/chains.js`);

const GAS = { maxGas: 8_000_000n, maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 0n, reserveWei: 0n };
const ZERO = '0x0000000000000000000000000000000000000000';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WETH_ARB = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const USDC_ARB = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const NOW = 1_790_870_000;
const V3_NPM = parseAbi([
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256, uint256)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256, uint256)',
]);
const MAX128 = (1n << 128n) - 1n;

const V4 = { tokenId: 5_000_123n, pool: { currency0: ZERO, currency1: USDG, fee: 3000, tickSpacing: 60 }, tickLower: -201060, tickUpper: -198060, liquidity: 10n ** 15n,
  sqrtPriceX96: position.sqrtPriceAtTick(-199500), tick: -199500, growthLast: [5n << 128n, 7n << 128n], growthNow: [(5n << 128n) + (10n ** 12n << 128n) / 10n ** 15n + 1n, (7n << 128n) + (3_000_000n << 128n) / 10n ** 15n + 1n] };
const V3 = { tokenId: 900_123n, token0: WETH_ARB, token1: USDC_ARB, fee: 500, tickLower: -200000, tickUpper: -190000, liquidity: 10n ** 15n,
  sqrtPriceX96: position.sqrtPriceAtTick(-195000), tick: -195000, owed: [10n ** 12n, 500_000n] };

function setup(options = {}) {
  const chain = createDirectChain({ v4: [V4], v3: [V3], timestamp: NOW, ...options });
  const wallet = walletOf(chain);
  const client = direct.createDirectClient(wallet, chains.v2Chain(chain.chainId), () => NOW, chain.codeHashes);
  return { chain, wallet, client };
}

test('the chain profiles carry the verified code hashes of the Uniswap contracts an owner calls directly (matched by address)', () => {
  const robinhood = chains.v2Chain(4663);
  assert.equal(robinhood.verifiedCode.v4PositionManager, '0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2', 'the same hash V1 pins for this PositionManager');
  assert.equal(robinhood.verifiedCode.v4StateView, '0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6');
  assert.equal(chains.v2Chain(8453).verifiedCode.v3PositionManager, '0x9177a11768996e8f951e0f0013d7165134178b15b21fb9916108f995e6c564bf');
  assert.equal(chains.v2Chain(42161).verifiedCode.v3Factory, '0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69');
  for (const chain of chains.V2_CHAINS) for (const hash of Object.values(chain.verifiedCode)) assert.match(hash, /^0x[0-9a-f]{64}$/);
  assert.equal(direct.v3PoolAddress(chains.v2Chain(8453), '0x4200000000000000000000000000000000000006', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 500), '0xd0b53d9277642d899df5c87a3966a349a798f224', 'the CREATE2 address the Base profile verified for WETH/USDC 0.05%');
});

test('v4 collect: modifyLiquidities(DECREASE 0 + TAKE_PAIR) to the chain’s PositionManager, byte for byte, no value; the receipt reads what Uniswap paid', async () => {
  const { chain, client } = setup();
  const prepared = await client.prepareCollect(4, V4.tokenId, GAS);
  const fees = [0, 1].map((i) => position.feesOwed(V4.growthNow[i], V4.growthLast[i], V4.liquidity));
  assert.deepEqual(prepared.receive, fees);
  assert.deepEqual(prepared.minimum, [0n, 0n]);
  assert.equal(prepared.deadline, BigInt(NOW) + 480n);
  const tx = prepared.step.transaction;
  assert.deepEqual([tx.to, tx.value, tx.chainId, tx.type], [chain.at.v4PositionManager, '0x0', '0x1237', '0x2']);
  assert.equal(tx.data, position.collectData(V4.tokenId, ZERO, USDG, chain.owner, prepared.deadline));
  const hash = await client.send(prepared, true);
  const receipt = await client.receipt(hash);
  assert.equal(receipt.state, 'finalized');
  const read = direct.readDirectReceipt({ chainId: 4663, kind: 'collect', dex: 4, tokenId: V4.tokenId, owner: chain.owner, pool: prepared.state.pool, receipt });
  assert.deepEqual(read.paid, [{ token: ZERO, amount: null }, { token: USDG, amount: fees[1] }], 'native ETH leaves no log: not guessed');
  assert.equal(read.gas.status, 'available');
  assert.equal(chain.v4Position(V4.tokenId).liquidity, V4.liquidity, 'the liquidity stays');
});

test('v4 close: all of the liquidity, minimums on the principal only (V1’s band), principal and fees paid, the NFT kept', async () => {
  const { chain, client } = setup();
  const prepared = await client.prepareClose(4, V4.tokenId, 100, GAS);
  const minimum = position.closeMinimums(V4.sqrtPriceX96, V4.tickLower, V4.tickUpper, V4.liquidity, 100);
  const principal = position.principalAt(V4.sqrtPriceX96, V4.tick, V4.tickLower, V4.tickUpper, V4.liquidity);
  const fees = [0, 1].map((i) => position.feesOwed(V4.growthNow[i], V4.growthLast[i], V4.liquidity));
  assert.deepEqual(prepared.minimum, minimum);
  assert.deepEqual(prepared.receive, [principal[0] + fees[0], principal[1] + fees[1]]);
  assert.deepEqual(prepared.atLeast, [minimum[0] + fees[0], minimum[1] + fees[1]]);
  assert.equal(prepared.step.transaction.data, position.closeData(V4.tokenId, V4.liquidity, minimum[0], minimum[1], ZERO, USDG, chain.owner, prepared.deadline));
  const ethBefore = chain.balanceOf(ZERO);
  const hash = await client.send(prepared, true);
  await assert.rejects(client.prepareClose(4, V4.tokenId, 50, GAS), /review_already_sent/, 'one direct exit per position in flight (F2)');
  assert.equal((await client.receipt(hash)).state, 'finalized');
  assert.equal(client.inFlight(4, V4.tokenId), null, 'read back on chain: the position is free again');
  assert.equal(chain.v4Position(V4.tokenId).liquidity, 0n);
  assert.ok(chain.v4Position(V4.tokenId), 'the NFT stays');
  assert.equal(chain.balanceOf(USDG), principal[1] + fees[1]);
  assert.equal(chain.balanceOf(ZERO) - ethBefore, principal[0] + fees[0], 'ETH paid straight to the owner (gas is not charged by this fake)');
  await assert.rejects(client.prepareClose(4, V4.tokenId, 50, GAS), /position_already_empty/);
});

test('v3 close on Arbitrum: one multicall [decreaseLiquidity(all, min0, min1, deadline), collect(owner, max, max)]; the receipt’s Collect says what was paid', async () => {
  const { chain, client } = setup({ chainId: 42161 });
  const prepared = await client.prepareClose(3, V3.tokenId, 50, GAS);
  const tx = prepared.step.transaction;
  assert.deepEqual([tx.to, tx.value, tx.chainId], [chain.at.v3PositionManager, '0x0', '0xa4b1']);
  const minimum = position.closeMinimums(V3.sqrtPriceX96, V3.tickLower, V3.tickUpper, V3.liquidity, 50);
  assert.equal(tx.data, direct.v3CloseData(V3.tokenId, V3.liquidity, minimum[0], minimum[1], chain.owner, prepared.deadline));
  const { functionName, args: [calls] } = decodeFunctionData({ abi: V3_NPM, data: tx.data });
  assert.equal(functionName, 'multicall');
  const decrease = decodeFunctionData({ abi: V3_NPM, data: calls[0] });
  const collect = decodeFunctionData({ abi: V3_NPM, data: calls[1] });
  assert.equal(decrease.functionName, 'decreaseLiquidity');
  assert.deepEqual(decrease.args[0], { tokenId: V3.tokenId, liquidity: V3.liquidity, amount0Min: minimum[0], amount1Min: minimum[1], deadline: prepared.deadline });
  assert.equal(collect.functionName, 'collect');
  assert.deepEqual({ ...collect.args[0], recipient: collect.args[0].recipient.toLowerCase() }, { tokenId: V3.tokenId, recipient: chain.owner, amount0Max: MAX128, amount1Max: MAX128 });
  const principal = position.principalAt(V3.sqrtPriceX96, V3.tick, V3.tickLower, V3.tickUpper, V3.liquidity);
  assert.deepEqual(prepared.receive, [principal[0] + V3.owed[0], principal[1] + V3.owed[1]], 'the position manager’s own answer to the exact call');
  assert.deepEqual(prepared.state.fees, V3.owed);
  const receipt = await client.receipt(await client.send(prepared, true));
  const read = direct.readDirectReceipt({ chainId: 42161, kind: 'close', dex: 3, tokenId: V3.tokenId, owner: chain.owner, pool: prepared.state.pool, receipt });
  assert.deepEqual(read.paid.map((p) => p.amount), prepared.receive);
  assert.deepEqual(read.paid.map((p) => p.token), [WETH_ARB, USDC_ARB], 'v3 pays WETH, never native');
  assert.equal(chain.v3Position(V3.tokenId).liquidity, 0n);
});

test('v3 collect: collect(owner, max, max) alone, no multicall; Base adds its L1 fee to the gas', async () => {
  const WETH = '0x4200000000000000000000000000000000000006', USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const { chain, client } = setup({ chainId: 8453, v4: [], v3: [{ ...V3, token0: WETH, token1: USDC, fee: 300, tickLower: -199998, tickUpper: -190002 }] });
  const prepared = await client.prepareCollect(3, V3.tokenId, GAS);
  assert.equal(prepared.step.transaction.data, direct.v3CollectData(V3.tokenId, chain.owner));
  assert.equal(decodeFunctionData({ abi: V3_NPM, data: prepared.step.transaction.data }).functionName, 'collect');
  assert.equal(prepared.state.pool.tickSpacing, 6, 'Base’s extra tier');
  assert.deepEqual(prepared.receive, V3.owed);
  const receipt = await client.receipt(await client.send(prepared, true));
  const read = direct.readDirectReceipt({ chainId: 8453, kind: 'collect', dex: 3, tokenId: V3.tokenId, owner: chain.owner, pool: prepared.state.pool, receipt });
  assert.deepEqual(read.paid.map((p) => p.amount), V3.owed);
  assert.equal(read.gas.status, 'available');
  assert.equal(read.gas.l1FeeWei, 42n);
});

test('the code check: another code at the position manager or the state view is refused before any position read; none is missing', async () => {
  const changed = setup();
  changed.chain.setCode(changed.chain.at.v4StateView, '0x6000');
  await assert.rejects(changed.client.prepareCollect(4, V4.tokenId, GAS), /deployment_code_changed/);
  const missing = setup({ chainId: 42161 });
  missing.chain.setCode(missing.chain.at.v3PositionManager, '0x');
  await assert.rejects(missing.client.prepareCollect(3, V3.tokenId, GAS), /deployment_missing/);
  assert.equal(missing.chain.log.filter((m) => m === 'eth_call').length, 0, 'nothing read before the code check');
  // The real profile hashes: this fake's invented code is not Uniswap's, so a client built without a test override refuses it.
  const real = createDirectChain({ v4: [V4] });
  const client = direct.createDirectClient(walletOf(real), chains.v2Chain(4663), () => NOW);
  await assert.rejects(client.prepareCollect(4, V4.tokenId, GAS), /deployment_code_changed/);
  assert.throws(() => direct.createDirectClient(walletOf(real), { ...chains.v2Chain(4663) }, () => NOW), /deployment_chain_mismatch/, 'only the app’s own chain profile');
});

test('the chain, the owner, the hooks and the slippage are checked; a price that moved past the minimums is refused by the re-simulation', async () => {
  const { chain, client } = setup();
  chain.switchTo(8453);
  await assert.rejects(client.prepareCollect(4, V4.tokenId, GAS), /wallet_wrong_chain/);
  chain.switchTo(4663);
  const other = setup({ v4: [{ ...V4, owner: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc' }] });
  await assert.rejects(other.client.prepareClose(4, V4.tokenId, 50, GAS), /position_not_owned/);
  const hooked = setup({ v4: [{ ...V4, pool: { ...V4.pool, hooks: '0x00000000000000000000000000000000000000c0' } }] });
  await assert.rejects(hooked.client.prepareCollect(4, V4.tokenId, GAS), /position_pool_has_hooks/);
  await assert.rejects(client.prepareClose(4, V4.tokenId, 5, GAS), /invalid_slippage/);
  await assert.rejects(client.prepareClose(4, V4.tokenId, 501, GAS), /invalid_slippage/);
  await assert.rejects(client.prepareCollect(4, 77n, GAS), /position_not_found/);
  // The price falls after the review: the exact call is simulated again before the wallet sees it.
  const prepared = await client.prepareClose(4, V4.tokenId, 10, GAS);
  chain.v4Position(V4.tokenId).sqrtPriceX96 = position.sqrtPriceAtTick(-200500);
  chain.v4Position(V4.tokenId).tick = -200500;
  const error = await client.send(prepared, true).catch((e) => e);
  assert.ok(error instanceof V2Revert);
  assert.equal(error.data.slice(0, 10), '0x12816f22', 'MinimumAmountInsufficient');
  assert.equal(chain.sends.length, 0, 'nothing sent');
  await assert.rejects(client.send(prepared, false), /wallet_review_required/);
});

test('a refusal in the wallet sends nothing and keeps nothing; a prepared exit is offered once', async () => {
  const { chain, client } = setup();
  chain.decline();
  const first = await client.prepareCollect(4, V4.tokenId, GAS);
  await assert.rejects(client.send(first, true), /User rejected/);
  assert.equal(chain.sends.length, 0);
  const second = await client.prepareCollect(4, V4.tokenId, GAS);
  await client.send(second, true);
  await assert.rejects(client.send(second, true), /wallet_review_required/);
  await assert.rejects(client.send({ ...second }, true), /wallet_review_required/, 'only an exit this client prepared');
});

test('a partial exit to both tokens: part of the liquidity, minimums for that part, the NFT and the rest stay', async () => {
  const { chain, client } = setup();
  const half = V4.liquidity / 2n;
  const prepared = await client.prepareClose(4, V4.tokenId, 50, GAS, half);
  const minimum = position.closeMinimums(V4.sqrtPriceX96, V4.tickLower, V4.tickUpper, half, 50);
  const principal = position.principalAt(V4.sqrtPriceX96, V4.tick, V4.tickLower, V4.tickUpper, half);
  const fees = [0, 1].map((i) => position.feesOwed(V4.growthNow[i], V4.growthLast[i], V4.liquidity));
  assert.deepEqual(prepared.minimum, minimum);
  assert.deepEqual(prepared.receive, [principal[0] + fees[0], principal[1] + fees[1]], 'the part removed and all of the fees');
  assert.equal(prepared.step.transaction.data, position.closeData(V4.tokenId, half, minimum[0], minimum[1], ZERO, USDG, chain.owner, prepared.deadline));
  await client.receipt(await client.send(prepared, true));
  assert.equal(chain.v4Position(V4.tokenId).liquidity, V4.liquidity - half);
  await assert.rejects(client.prepareClose(4, V4.tokenId, 50, GAS, V4.liquidity), /invalid_liquidity/, 'never more than the position holds');
  await assert.rejects(client.prepareClose(4, V4.tokenId, 50, GAS, 0n), /invalid_liquidity/);
  const v3 = setup({ chainId: 42161 });
  const part = await v3.client.prepareClose(3, V3.tokenId, 50, GAS, V3.liquidity / 4n);
  const { args: [calls] } = decodeFunctionData({ abi: V3_NPM, data: part.step.transaction.data });
  assert.equal(decodeFunctionData({ abi: V3_NPM, data: calls[0] }).args[0].liquidity, V3.liquidity / 4n);
});

test('F2: a direct exit whose outcome is unknown is never offered again; a refusal, or a wallet never asked, frees the position', async () => {
  // Changed on purpose (data) 2026-10-02 (Domino V2 rev2 review, F2): the wallet sends it and answers, then the page loses
  // the connector: the answer (the hash) is KEPT, so the exit is followed to its receipt and never offered again.
  let connected = true;
  const chain = createDirectChain({ v4: [V4], v3: [V3], timestamp: NOW });
  const client = direct.createDirectClient(walletOf(chain, { current: () => connected }), chains.v2Chain(4663), () => NOW, chain.codeHashes);
  const first = await client.prepareCollect(4, V4.tokenId);
  const original = chain.request;
  chain.request = async (method, params) => {
    const reply = await original(method, params);
    if (method === 'eth_sendTransaction') connected = false;
    return reply;
  };
  const kept = await client.send(first, true);
  connected = true;
  chain.request = original;
  assert.match(kept, /^0x[0-9a-f]{64}$/, 'the wallet\'s hash, kept although the connector changed after it answered');
  assert.equal(chain.sends.length, 1, 'it was sent');
  assert.equal(client.inFlight(4, V4.tokenId).hash, kept);
  await assert.rejects(client.prepareCollect(4, V4.tokenId), /review_already_sent/, 'a fresh review cannot slip past it');
  await assert.rejects(client.send(first, true), /wallet_review_required/, 'the same step is the shared sender\'s refusal');

  // The wallet sends it and answers nothing usable: the outcome is unknown.
  const lost = createDirectChain({ v4: [V4], v3: [V3], timestamp: NOW });
  const lostClient = direct.createDirectClient(walletOf(lost), chains.v2Chain(4663), () => NOW, lost.codeHashes);
  const unknown = await lostClient.prepareCollect(4, V4.tokenId);
  const answers = lost.request;
  lost.request = async (method, params) => {
    const reply = await answers(method, params);
    return method === 'eth_sendTransaction' ? { result: '0x' } : reply;
  };
  await assert.rejects(lostClient.send(unknown, true), /wallet_result_unknown/);
  lost.request = answers;
  assert.equal(lost.sends.length, 1, 'it was sent');
  assert.equal(lostClient.wasOffered(unknown), true);
  assert.deepEqual({ ...lostClient.inFlight(4, V4.tokenId) }, { kind: 'collect', liquidity: 0n, block: unknown.state.blockNumber, hash: null });
  await assert.rejects(lostClient.prepareCollect(4, V4.tokenId), /review_already_sent/, 'a fresh review cannot slip past it');
  await assert.rejects(lostClient.prepareClose(4, V4.tokenId, 50), /review_already_sent/, 'whatever the kind');
  await assert.rejects(lostClient.send(unknown, true), /wallet_review_required/, 'the same step is the shared sender\'s refusal');
  // Another position is not held.
  const v3 = setup({ chainId: 42161 });
  assert.equal((await v3.client.prepareCollect(3, V3.tokenId)).kind, 'collect');

  // A definite refusal frees it, and so does a wallet that was never asked (the port's own refusal, WalletNotAsked).
  const refusing = setup();
  refusing.chain.decline();
  await assert.rejects(refusing.client.send(await refusing.client.prepareCollect(4, V4.tokenId), true), /User rejected/);
  assert.equal(refusing.client.inFlight(4, V4.tokenId), null);
  let on = true;
  const quiet = createDirectChain({ v4: [V4], timestamp: NOW });
  const quietClient = direct.createDirectClient(walletOf(quiet, { current: () => on }), chains.v2Chain(4663), () => NOW, quiet.codeHashes);
  const step = await quietClient.prepareCollect(4, V4.tokenId);
  // The connector goes away after the last read before the send: the port refuses before the provider is invoked.
  quiet.request = ((original) => async (method, params) => {
    const reply = await original(method, params);
    if (method === 'eth_chainId' && quiet.log.filter((m) => m === 'eth_chainId').length === 3) on = false;
    return reply;
  })(quiet.request);
  await assert.rejects(quietClient.send(step, true));
  on = true;
  assert.equal(quiet.sends.length, 0, 'nothing sent');
  assert.equal(quietClient.inFlight(4, V4.tokenId), null, 'never asked: free');
  assert.equal((await quietClient.prepareCollect(4, V4.tokenId)).kind, 'collect');
  // A reverted exit is known not to have happened: read back, the position is free.
  const reverting = setup();
  const close = await reverting.client.prepareClose(4, V4.tokenId, 10);
  reverting.chain.v4Position(V4.tokenId).sqrtPriceX96 = position.sqrtPriceAtTick(-199500);
  const hash = await reverting.client.send(close, true);
  assert.equal(reverting.client.inFlight(4, V4.tokenId).hash, hash);
  await reverting.client.receipt(hash);
  assert.equal(reverting.client.inFlight(4, V4.tokenId), null);
});

test('F8: a direct exit reads its budget at its own review; on Base its cost carries the L1 data fee ceiling', async () => {
  const WETH = '0x4200000000000000000000000000000000000006', USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const { chain, client } = setup({ chainId: 8453, v4: [], v3: [{ ...V3, token0: WETH, token1: USDC, fee: 300, tickLower: -199998, tickUpper: -190002 }] });
  const prepared = await client.prepareCollect(3, V3.tokenId);
  const limit = (0x3a980n * 120n + 99n) / 100n;
  assert.equal(prepared.step.networkFeeWei, limit * 200_000_000n + 7_000_000_000n, 'twice the gas price at the limit, plus the oracle\'s L1 ceiling');
  assert.ok(chain.log.includes('eth_gasPrice') && chain.log.includes('eth_maxPriorityFeePerGas'), 'read through the client\'s own calls');
});

test('rev2 §2.13: a direct exit of a vault’s armed root waits for the pause warning; a successor held by a vault is refused', async () => {
  const VAULT = '0x00000000000000000000000000000000000000aa';
  const probe = async (_rpc, address) => address.toLowerCase() === VAULT;
  // v4: the vault is the position's subscriber (an armed root).
  const chain = createDirectChain({ v4: [{ ...V4, subscriber: VAULT }], v3: [{ ...V3, approved: VAULT }], timestamp: NOW });
  const client = direct.createDirectClient(walletOf(chain), chains.v2Chain(chain.chainId), () => NOW, chain.codeHashes, probe);
  const exit = await client.prepareClose(4, V4.tokenId, 50, GAS);
  assert.equal(exit.pausesAutomation, VAULT);
  await assert.rejects(client.send(exit, true), /automation_pause_unacknowledged/);
  assert.equal(chain.sends.length, 0, 'nothing reached the wallet');
  client.acknowledgePause(exit);
  await client.send(exit, true);
  assert.equal(chain.sends.length, 1);
  // v3 on Arbitrum: the vault holds the individual approval (an armed root).
  const arbitrum = createDirectChain({ chainId: 42161, v3: [{ ...V3, approved: VAULT }], timestamp: NOW });
  const arbClient = direct.createDirectClient(walletOf(arbitrum), chains.v2Chain(42161), () => NOW, arbitrum.codeHashes, probe);
  const collect = await arbClient.prepareCollect(3, V3.tokenId, GAS);
  assert.equal(collect.pausesAutomation, VAULT);
  // A plain position pauses nothing; without a probe nothing is asked.
  const plain = setup();
  assert.equal((await plain.client.prepareCollect(4, V4.tokenId, GAS)).pausesAutomation, null);
  // A successor: the vault holds the NFT.
  const held = createDirectChain({ v4: [{ ...V4, owner: VAULT }], timestamp: NOW });
  const heldClient = direct.createDirectClient(walletOf(held), chains.v2Chain(held.chainId), () => NOW, held.codeHashes, probe);
  await assert.rejects(heldClient.prepareClose(4, V4.tokenId, 50, GAS), /position_vault_successor/);
});

// Added 2026-10-02 (Domino V2 rev2 review, L2): only a root its vault reads ARMED pauses automation.
test('L2: a direct exit of a root its vault reads disarmed pauses nothing, and still names the vault for its reserves; an armed root still waits', async () => {
  const VAULT = '0x00000000000000000000000000000000000000aa';
  const probe = async (_rpc, address) => address.toLowerCase() === VAULT;
  const asked = [];
  const rootProbe = (armed, tokenId = V4.tokenId) => async (_rpc, vault, dex, id) => {
    asked.push([vault, dex, id]);
    return id === tokenId ? { armed } : null;
  };
  // v4: a root disarmed earlier keeps the vault as its subscriber.
  const chain = createDirectChain({ v4: [{ ...V4, subscriber: VAULT }], timestamp: NOW });
  const disarmed = direct.createDirectClient(walletOf(chain), chains.v2Chain(chain.chainId), () => NOW, chain.codeHashes, probe, rootProbe(false));
  const exit = await disarmed.prepareClose(4, V4.tokenId, 50, GAS);
  assert.deepEqual([exit.pausesAutomation, exit.vaultRoot], [null, VAULT]);
  assert.deepEqual(asked.at(-1), [VAULT, 4, V4.tokenId], 'the vault itself was asked about this position');
  await disarmed.send(exit, true);
  assert.equal(chain.sends.length, 1, 'sent with nothing to acknowledge');
  // The same subscription, armed: the warning first.
  const armedChain = createDirectChain({ v4: [{ ...V4, subscriber: VAULT }], timestamp: NOW });
  const armed = direct.createDirectClient(walletOf(armedChain), chains.v2Chain(armedChain.chainId), () => NOW, armedChain.codeHashes, probe, rootProbe(true));
  const armedExit = await armed.prepareClose(4, V4.tokenId, 50, GAS);
  assert.deepEqual([armedExit.pausesAutomation, armedExit.vaultRoot], [VAULT, VAULT]);
  await assert.rejects(armed.send(armedExit, true), /automation_pause_unacknowledged/);
  // A vault whose root is another position: no root here, no warning, no reserves.
  const otherChain = createDirectChain({ v4: [{ ...V4, subscriber: VAULT }], timestamp: NOW });
  const other = direct.createDirectClient(walletOf(otherChain), chains.v2Chain(otherChain.chainId), () => NOW, otherChain.codeHashes, probe, rootProbe(true, 1n));
  const plain = await other.prepareCollect(4, V4.tokenId, GAS);
  assert.deepEqual([plain.pausesAutomation, plain.vaultRoot], [null, null]);
  // No root probe handed in: a vault's subscription counts as an armed root (the cautious reading, as before).
  const cautiousChain = createDirectChain({ v4: [{ ...V4, subscriber: VAULT }], timestamp: NOW });
  const cautious = direct.createDirectClient(walletOf(cautiousChain), chains.v2Chain(cautiousChain.chainId), () => NOW, cautiousChain.codeHashes, probe);
  assert.equal((await cautious.prepareCollect(4, V4.tokenId, GAS)).pausesAutomation, VAULT);
});
