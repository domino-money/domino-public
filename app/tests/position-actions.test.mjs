/**
 * The owner's position actions (src/finance/position.ts): Collect fees and Close position, sent from the owner's
 * wallet straight to Uniswap's PositionManager on Robinhood Chain.
 *
 * The golden vectors are the ones proven on mainnet with eth_call, eth_estimateGas and eth_simulateV1 on 2026-09-23
 * (NFT 3135288, USDG/UFG, block 70897139; NFT 3172890, ETH/PRIORS, block 70900331): the exact calldata, the packed
 * PositionInfo, the fee formula and the principal and band minimums. Nothing was ever signed or sent. The client
 * is then driven against tests/support/position-chain.mjs, whose PositionManager and StateView carry their real
 * runtime code, so the pinned code hashes are checked against real code.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { decodeAbiParameters, decodeFunctionData, keccak256, parseAbi, parseAbiParameters, toFunctionSelector } from 'viem';
import { CODE, POSITION_MANAGER, REVERTS, STATE_VIEW, createPositionChain, walletOf } from './support/position-chain.mjs';

const require = createRequire(import.meta.url);
const position = require('../.test-build/app/src/finance/position.js');
const pin = require('../.test-build/app/src/finance/pin.js');
const pairAmount = require('../.test-build/app/src/lib/create/pairAmount.js');
const poolRange = require('../.test-build/app/src/lib/read/screens/poolRange.js');
const mintPlan = require('../.test-build/app/src/lib/create/mintPlan.js');
const steps = require('../.test-build/app/src/components/positions/walletSteps.js');

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', UFG = '0xEfAb538Cf3C29237A47c6aFB145D50Ddf204A0A3', OWNER = '0xf6184F814543b88Dd867C34cE6E9f56Ab7d18C0a';
const GOLDEN_DEADLINE = 1790205733n;
/** calldata.collect from the mainnet proof run: accepted by eth_call and eth_estimateGas (80,423 gas) from the owner. Selector, then 32-byte words. */
const GOLDEN_COLLECT = '0xdd46508f' + [
  '0000000000000000000000000000000000000000000000000000000000000040',
  '000000000000000000000000000000000000000000000000000000006ab45f25',
  '0000000000000000000000000000000000000000000000000000000000000240',
  '0000000000000000000000000000000000000000000000000000000000000040',
  '0000000000000000000000000000000000000000000000000000000000000080',
  '0000000000000000000000000000000000000000000000000000000000000002',
  '0111000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000002',
  '0000000000000000000000000000000000000000000000000000000000000040',
  '0000000000000000000000000000000000000000000000000000000000000120',
  '00000000000000000000000000000000000000000000000000000000000000c0',
  '00000000000000000000000000000000000000000000000000000000002fd738',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '00000000000000000000000000000000000000000000000000000000000000a0',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000060',
  '0000000000000000000000005fc5360d0400a0fd4f2af552add042d716f1d168',
  '000000000000000000000000efab538cf3c29237a47c6afb145d50ddf204a0a3',
  '000000000000000000000000f6184f814543b88dd867c34ce6e9f56ab7d18c0a',
].join('');
/** calldata.closeDecrease from the same run: accepted by eth_call and eth_estimateGas (161,479 gas), paying 994039 USDG and 325205393406295768765 UFG raw. */
const GOLDEN_CLOSE = '0xdd46508f' + [
  '0000000000000000000000000000000000000000000000000000000000000040',
  '000000000000000000000000000000000000000000000000000000006ab45f25',
  '0000000000000000000000000000000000000000000000000000000000000240',
  '0000000000000000000000000000000000000000000000000000000000000040',
  '0000000000000000000000000000000000000000000000000000000000000080',
  '0000000000000000000000000000000000000000000000000000000000000002',
  '0111000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000002',
  '0000000000000000000000000000000000000000000000000000000000000040',
  '0000000000000000000000000000000000000000000000000000000000000120',
  '00000000000000000000000000000000000000000000000000000000000000c0',
  '00000000000000000000000000000000000000000000000000000000002fd738',
  '00000000000000000000000000000000000000000000000000002f85f11d0a9e',
  '00000000000000000000000000000000000000000000000000000000000f178c',
  '0000000000000000000000000000000000000000000000118a90d7612a4d8481',
  '00000000000000000000000000000000000000000000000000000000000000a0',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000060',
  '0000000000000000000000005fc5360d0400a0fd4f2af552add042d716f1d168',
  '000000000000000000000000efab538cf3c29237a47c6afb145d50ddf204a0a3',
  '000000000000000000000000f6184f814543b88dd867c34ce6e9f56ab7d18c0a',
].join('');

/** NFT 3135288 as read at block 70897139. */
const NFT = { tokenId: 3135288n, tickLower: 334908, tickUpper: 353514, liquidity: 52252322368158n, sqrtPriceX96: 1975446435897848877405867861624282655n, tick: 340651 };
const USDG_UFG = { currency0: USDG, currency1: UFG, fee: 792831, tickSpacing: 9303, hooks: '0x0000000000000000000000000000000000000000' };
const gas = { maxGas: 8_000_000n, maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 0n, reserveWei: 0n };

test('the closed ABIs ship as JSON and equal what viem parses from the signatures written beside them', () => {
  const text = readFileSync(new URL('../src/finance/position.ts', import.meta.url), 'utf8');
  const signatures = (name) => {
    const lines = text.split('\n'), at = lines.indexOf(` * ${name} signatures:`), listed = [];
    assert.ok(at >= 0, `${name} lists its signatures`);
    for (const line of lines.slice(at + 1)) { const match = /^ \* {3}(.+)$/.exec(line); if (!match) break; listed.push(match[1]); }
    return listed;
  };
  const parameters = (name) => { const match = new RegExp(`^/\\*\\* ${name} signature: (.+) \\*/$`, 'm').exec(text); assert.ok(match, `${name} names its signature`); return match[1]; };
  assert.deepEqual(position.positionManagerAbi, parseAbi(signatures('positionManagerAbi')));
  assert.deepEqual(position.stateViewAbi, parseAbi(signatures('stateViewAbi')));
  for (const name of ['decreaseParameters', 'takePairParameters', 'unlockParameters', 'poolIdParameters']) assert.deepEqual(position[name], parseAbiParameters(parameters(name)), name);
  assert.doesNotMatch(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''), /\bparseAbi(Parameters)?\b|\bapprove\b|\bburn/i, 'no ABI parser in the page, no approval and no burn');
  assert.equal(toFunctionSelector(position.positionManagerAbi[0]), '0xdd46508f', 'modifyLiquidities(bytes,uint256)');
});

test('the contracts are the pinned ones, with the code hashes the published setup profile names, and the code fixture is that code', () => {
  const profile = JSON.parse(readFileSync(new URL('../../docs/deployments/v1-robinhood-mainnet-2026-09-21/setup-release.json', import.meta.url), 'utf8')).deployment;
  assert.equal(pin.STATE_VIEW, '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b');
  assert.deepEqual({ ...position.POSITION_DEPLOYMENT }, { positionManager: pin.POSITION_MANAGER, stateView: pin.STATE_VIEW, positionManagerCodeHash: profile.positionManagerCodeHash, stateViewCodeHash: profile.stateViewCodeHash });
  assert.deepEqual([profile.positionManager, profile.stateView], [pin.POSITION_MANAGER, pin.STATE_VIEW]);
  assert.equal(Object.isFrozen(position.POSITION_DEPLOYMENT), true);
  assert.deepEqual([keccak256(CODE.positionManager), keccak256(CODE.stateView)], [profile.positionManagerCodeHash, profile.stateViewCodeHash]);
  assert.deepEqual([POSITION_MANAGER, STATE_VIEW], [pin.POSITION_MANAGER, pin.STATE_VIEW]);
});

test('collect and close calldata are byte for byte what mainnet accepted for NFT 3135288, with actions 0x0111', () => {
  assert.equal(position.collectData(3135288n, USDG, UFG, OWNER, GOLDEN_DEADLINE), GOLDEN_COLLECT);
  // The close that eth_call and eth_estimateGas accepted (161,479 gas): all of the liquidity, minimums 989068 / 323579366439264289921.
  assert.equal(position.closeData(3135288n, NFT.liquidity, 989068n, 323579366439264289921n, USDG, UFG, OWNER, GOLDEN_DEADLINE), GOLDEN_CLOSE);
  for (const [data, liquidity, minimums] of [[GOLDEN_COLLECT, 0n, [0n, 0n]], [GOLDEN_CLOSE, NFT.liquidity, [989068n, 323579366439264289921n]]]) {
    const { functionName, args: [unlockData, deadline] } = decodeFunctionData({ abi: position.positionManagerAbi, data });
    assert.deepEqual([functionName, deadline], ['modifyLiquidities', GOLDEN_DEADLINE]);
    const [actions, params] = decodeAbiParameters(position.unlockParameters, unlockData);
    assert.equal(actions, '0x0111', 'DECREASE_LIQUIDITY then TAKE_PAIR, never a burn');
    assert.deepEqual(decodeAbiParameters(position.decreaseParameters, params[0]), [3135288n, liquidity, ...minimums, '0x']);
    assert.deepEqual(decodeAbiParameters(position.takePairParameters, params[1]), [USDG, UFG, OWNER], 'both currencies straight to the owner');
  }
});

test('PositionInfo decodes as the periphery packs it: ticks, subscriber bit and the pool id prefix', () => {
  const golden = position.decodePositionInfo(0x82c1f7019df0a66065cb17b70451940117865f8bd464c5966a0564ea051c3c00n);
  assert.deepEqual([golden.tickLower, golden.tickUpper, golden.hasSubscriber], [334908, 353514, false]);
  assert.equal(golden.poolIdPrefix, 0x82c1f7019df0a66065cb17b70451940117865f8bd464c5966a491a767e1a9a8fn >> 56n, 'the top 25 bytes are the pool id’s');
  const native = position.decodePositionInfo(0xbaa387d326f03d5baf9a23f2e065d1d5d14beb7a7c181e9e8e0256a202124600n);
  assert.deepEqual([native.tickLower, native.tickUpper, native.hasSubscriber], [135750, 153250, false]);
  const pack = (prefix, lower, upper, sub) => (prefix << 56n) | (BigInt.asUintN(24, BigInt(upper)) << 32n) | (BigInt.asUintN(24, BigInt(lower)) << 8n) | sub;
  for (const [lower, upper] of [[-887220, 887220], [-600, -60], [-1, 1], [-887272, -887271]]) {
    const decoded = position.decodePositionInfo(pack(0xabcn, lower, upper, 1n));
    assert.deepEqual([decoded.tickLower, decoded.tickUpper, decoded.hasSubscriber, decoded.poolIdPrefix], [lower, upper, true, 0xabcn], `${lower}..${upper}`);
  }
  assert.equal(position.decodePositionInfo(pack(1n, 0, 60, 0n)).hasSubscriber, false);
});

test('unclaimed fees follow v4-core: growth difference mod 2^256, times liquidity, over 2^128', () => {
  const L = 1289801707668422679479n;
  assert.equal(position.feesOwed(11908131393112804032043729837989596n, 10874978012334885242562198607635835n, L), 3916050681287205n, 'wei of ETH, as the simulated collect paid');
  assert.equal(position.feesOwed(37895437522324593351017393600242723662711n, 34820769009847638481510695715191161116683n, L), 11654182183435037951794n, 'PRIORS, as the simulated collect paid');
  assert.equal(position.feesOwed(0n, 0n, NFT.liquidity), 0n);
  // Growth counters wrap: a newer value below the last one is a small increase, never a negative fee.
  const max = (1n << 256n) - 1n;
  assert.equal(position.feesOwed(5n, max - 4n, 1n << 128n), 10n);
  assert.equal(position.feesOwed(0n, max, 3n << 128n), 3n);
});

test('principal at the price now branches on the pool tick as Pool.modifyLiquidity does', () => {
  assert.deepEqual(position.principalAt(NFT.sqrtPriceX96, NFT.tick, NFT.tickLower, NFT.tickUpper, NFT.liquidity), [994039n, 325205393406295768765n], 'what the simulated close paid');
  const lower = position.sqrtPriceAtTick(NFT.tickLower), upper = position.sqrtPriceAtTick(NFT.tickUpper);
  const below = position.principalAt(lower - 1n, NFT.tickLower - 1, NFT.tickLower, NFT.tickUpper, NFT.liquidity);
  assert.deepEqual(below, [position.amount0ForLiquidity(lower, upper, NFT.liquidity), 0n], 'below the range: currency0 only');
  const above = position.principalAt(upper + 1n, NFT.tickUpper + 5, NFT.tickLower, NFT.tickUpper, NFT.liquidity);
  assert.deepEqual(above, [0n, position.amount1ForLiquidity(lower, upper, NFT.liquidity)], 'above the range: currency1 only');
  assert.deepEqual(position.principalAt(upper, NFT.tickUpper, NFT.tickLower, NFT.tickUpper, NFT.liquidity), above, 'a tick equal to tickUpper is above the range');
  const atLower = position.principalAt(lower, NFT.tickLower, NFT.tickLower, NFT.tickUpper, NFT.liquidity);
  assert.deepEqual(atLower, [position.amount0ForLiquidity(lower, upper, NFT.liquidity), 0n], 'a tick equal to tickLower is inside, holding currency0 only');
  assert.deepEqual(position.principalAt(NFT.sqrtPriceX96, NFT.tick, NFT.tickLower, NFT.tickUpper, 0n), [0n, 0n]);
});

test('close minimums are the principal at the slippage band’s worst end, fees left out', () => {
  assert.deepEqual(position.closeMinimums(NFT.sqrtPriceX96, NFT.tickLower, NFT.tickUpper, NFT.liquidity, 50), [988813n, 321948291994566732075n], 'the band minimums proven with a simulated close at 50 bps');
  // The band is the one a mint is sized in (lib/create/mintPlan.ts bandFor), at every limit offered.
  for (const bps of [10, 50, 100, 250, 500]) {
    const band = mintPlan.bandFor(NFT.sqrtPriceX96, NFT.tickLower, NFT.tickUpper, bps);
    const [min0, min1] = position.closeMinimums(NFT.sqrtPriceX96, NFT.tickLower, NFT.tickUpper, NFT.liquidity, bps);
    assert.deepEqual([min0, min1], [position.amount0ForLiquidity(band.high, band.sqrtUpper, NFT.liquidity), position.amount1ForLiquidity(band.sqrtLower, band.low, NFT.liquidity)], `${bps} bps`);
    const [p0, p1] = position.principalAt(NFT.sqrtPriceX96, NFT.tick, NFT.tickLower, NFT.tickUpper, NFT.liquidity);
    assert.ok(min0 < p0 && min1 < p1, 'a minimum is below what the price now pays');
  }
  // Out of range, the side the position does not hold has no minimum; the side it holds stays whole across the band.
  const lower = position.sqrtPriceAtTick(NFT.tickLower), upper = position.sqrtPriceAtTick(NFT.tickUpper);
  assert.deepEqual(position.closeMinimums(lower / 2n, NFT.tickLower, NFT.tickUpper, NFT.liquidity, 50), [position.amount0ForLiquidity(lower, upper, NFT.liquidity), 0n]);
  assert.deepEqual(position.closeMinimums(upper * 2n, NFT.tickLower, NFT.tickUpper, NFT.liquidity, 50), [0n, position.amount1ForLiquidity(lower, upper, NFT.liquidity)]);
  for (const bps of [0, 9, 501, 12.5, NaN]) assert.throws(() => position.closeMinimums(NFT.sqrtPriceX96, NFT.tickLower, NFT.tickUpper, NFT.liquidity, bps), /invalid_slippage/, String(bps));
});

test('the tick and amount math is pinned to lib/read and lib/create across the whole tick range', () => {
  // finance/ may not import lib/ (finance/slippage.ts says why), so the copies are held to the originals here.
  const ticks = [position.MIN_TICK, position.MAX_TICK, 0, 1, -1];
  for (let tick = position.MIN_TICK; tick <= position.MAX_TICK; tick += 7919) ticks.push(tick, -tick);
  for (const tick of ticks) assert.equal(position.sqrtPriceAtTick(tick), poolRange.sqrtPriceAtTick(tick), `tick ${tick}`);
  assert.deepEqual([position.MIN_TICK, position.MAX_TICK], [poolRange.MIN_TICK, poolRange.MAX_TICK]);
  assert.throws(() => position.sqrtPriceAtTick(position.MAX_TICK + 1), RangeError);
  for (let i = 0; i + 1 < ticks.length; i += 3) {
    const a = position.sqrtPriceAtTick(ticks[i]), b = position.sqrtPriceAtTick(ticks[i + 1]);
    for (const L of [1n, NFT.liquidity, 10n ** 30n]) {
      assert.equal(position.amount0ForLiquidity(a, b, L), pairAmount.amount0ForLiquidity(a, b, L));
      assert.equal(position.amount1ForLiquidity(a, b, L), pairAmount.amount1ForLiquidity(a, b, L));
      assert.equal(position.amount0ForLiquidity(b, a, L), pairAmount.amount0ForLiquidity(b, a, L), 'either order');
    }
  }
});

test('a wallet’s refusal is said by the contract’s selector, whatever the wallet wraps it in', () => {
  const data = REVERTS.minimum(994040n, 994039n);
  assert.equal(position.revertCode({ code: 3, message: 'execution reverted', data }), 'position_price_moved');
  assert.equal(position.revertCode({ code: -32603, message: 'Internal JSON-RPC error.', data: { code: 3, message: 'execution reverted', data } }), 'position_price_moved', 'MetaMask’s wrapping');
  assert.equal(position.revertCode({ code: -32603, data: { originalError: { code: 3, data: REVERTS.deadlinePassed(1n) } } }), 'position_deadline_passed');
  assert.equal(position.revertCode({ message: 'execution reverted', data: REVERTS.notApproved(OWNER) }), 'position_not_owned');
  assert.equal(position.revertCode({ code: 3, data: REVERTS.empty() }), 'position_already_empty');
  assert.equal(position.revertCode({ code: 3, message: 'execution reverted', data: REVERTS.notMinted() }), 'position_simulation_reverted', 'any other revert');
  assert.equal(position.revertCode({ code: 3, message: 'execution reverted' }), 'position_simulation_reverted');
  for (const error of [{ code: 4001, message: 'User rejected the request.' }, new Error('wallet_timeout'), { code: -32000, message: 'header not found' }, null])
    assert.equal(position.revertCode(error), null, 'not a contract refusal');
  assert.deepEqual(Object.keys(position.REVERT_CODES), ['MinimumAmountInsufficient(uint128,uint128)', 'DeadlinePassed(uint256)', 'NotApproved(address)', 'CannotUpdateEmptyPosition()'].map((e) => toFunctionSelector(e)));
});

test('an NFT id is a canonical decimal', () => {
  assert.equal(position.positionTokenId('3135288'), 3135288n);
  for (const text of ['', '0', '01', '-1', '1.0', ' 1', '0x10', `${1n << 256n}`]) assert.throws(() => position.positionTokenId(text), /invalid_position_id/, text);
});

// ---- the client, against a chain with the real Uniswap code ---------------------------------------------------

const TOKEN_ID = 3135288n;
/** NFT 3135288's pool and range, owned by the fake chain's wallet, with fees earned since its last update. */
function setupChain(options = {}) {
  const growthLast = [5n << 128n, 7n << 128n];
  const growthNow = [growthLast[0] + (1234n << 128n) / NFT.liquidity + 1n, growthLast[1] + (5n * 10n ** 17n << 128n) / NFT.liquidity + 1n];
  const chain = createPositionChain(OWNER, { connected: true, timestamp: 1_790_000_000, ...options, positions: [{ tokenId: TOKEN_ID, key: USDG_UFG, tickLower: NFT.tickLower, tickUpper: NFT.tickUpper,
    liquidity: NFT.liquidity, sqrtPriceX96: NFT.sqrtPriceX96, tick: NFT.tick, growthLast, growthNow, ...options.position }] });
  const claims = [];
  const wallet = walletOf(chain, { claims });
  let clock = 1000;
  const client = position.createPositionClient(wallet, position.POSITION_DEPLOYMENT, () => clock);
  return { chain, client, claims, fees: [position.feesOwed(growthNow[0], growthLast[0], NFT.liquidity), position.feesOwed(growthNow[1], growthLast[1], NFT.liquidity)], tick: (s) => { clock += s; } };
}

test('inspect reads the position through the wallet at one block and checks the code once per client', async () => {
  const { chain, client, fees } = setupChain();
  const state = await client.inspect(TOKEN_ID);
  assert.deepEqual([state.tickLower, state.tickUpper, state.liquidity, state.hasSubscriber], [NFT.tickLower, NFT.tickUpper, NFT.liquidity, false]);
  assert.deepEqual(state.principal, [994039n, 325205393406295768765n]);
  assert.deepEqual(state.fees, fees);
  assert.ok(fees[0] > 0n && fees[1] > 0n);
  assert.equal(state.poolId, '0x82c1f7019df0a66065cb17b70451940117865f8bd464c5966a491a767e1a9a8f', 'the real pool id of USDG/UFG');
  assert.deepEqual(state.key, { ...USDG_UFG, currency0: USDG.toLowerCase(), currency1: UFG.toLowerCase() });
  await client.inspect(TOKEN_ID);
  assert.equal(chain.log.filter((m) => m === 'eth_getCode').length, 2, 'PositionManager and StateView code, once for the client');
  assert.equal(chain.log.filter((m) => m === 'eth_chainId').length, 2, 'the wallet’s account and network, every time');
  assert.deepEqual(chain.calls.slice(0, 6), ['ownerOf', 'getPoolAndPositionInfo', 'getPositionLiquidity', 'getSlot0', 'getPositionInfo', 'getFeeGrowthInside']);
  assert.deepEqual(chain.sends, []);
});

test('reads refuse other code, another owner, hooks, a burned NFT and another network before anything is prepared', async () => {
  const other = setupChain({ positionManagerCode: '0x6000' });
  await assert.rejects(other.client.inspect(TOKEN_ID), /deployment_code_changed/);
  assert.equal(other.chain.log.includes('eth_call'), false);
  const foreign = setupChain({ position: { owner: '0x000000000000000000000000000000000000dead' } });
  await assert.rejects(foreign.client.prepareCollect(TOKEN_ID, gas), /position_not_owned/);
  assert.equal(foreign.chain.log.includes('eth_estimateGas'), false);
  const hooked = setupChain({ position: { key: { ...USDG_UFG, hooks: '0x00000000000000000000000000000000000000c0' } } });
  await assert.rejects(hooked.client.prepareClose(TOKEN_ID, 50, gas), /position_pool_has_hooks/);
  assert.equal(hooked.chain.log.includes('eth_estimateGas'), false);
  const s = setupChain();
  await assert.rejects(s.client.inspect(99n), /position_not_found/, 'ownerOf reverts NOT_MINTED');
  const empty = setupChain({ position: { liquidity: 0n } });
  await assert.rejects(empty.client.prepareCollect(TOKEN_ID, gas), /position_already_empty/, 'a collect on an empty NFT would revert on chain');
  await assert.rejects(empty.client.prepareClose(TOKEN_ID, 50, gas), /position_already_empty/);
  const wrongChain = setupChain();
  const request = wrongChain.chain.request;
  const wallet = walletOf({ ...wrongChain.chain, request: async (method, params) => (method === 'eth_chainId' ? { result: '0x1' } : request(method, params)) });
  await assert.rejects(position.createPositionClient(wallet).inspect(TOKEN_ID), /wallet_identity_changed/);
  await assert.rejects(s.client.prepareClose(TOKEN_ID, 9, gas), /invalid_slippage/);
});

test('prepareCollect simulates DECREASE 0 + TAKE_PAIR from the owner, deadline from the block, gas estimate plus a fifth', async () => {
  const { chain, client, fees } = setupChain();
  const prepared = await client.prepareCollect(TOKEN_ID, gas);
  const deadline = BigInt(chain.latest().timestamp) + 480n;
  assert.equal(prepared.deadline, deadline, 'the latest block’s time plus the signing window and inclusion room');
  assert.deepEqual({ ...prepared.transaction }, { from: OWNER.toLowerCase(), to: POSITION_MANAGER, data: position.collectData(TOKEN_ID, USDG.toLowerCase(), UFG.toLowerCase(), OWNER.toLowerCase(), deadline), value: '0x0',
    chainId: '0x1237', type: '0x2', nonce: '0x0', gas: '0x3a980', maxFeePerGas: '0xbebc200', maxPriorityFeePerGas: '0x0' });
  assert.deepEqual([prepared.receive, prepared.atLeast, prepared.minimum], [fees, fees, [0n, 0n]]);
  assert.equal(prepared.networkFeeWei, 240_000n * gas.maxFeePerGas);
  const simulated = chain.log.indexOf('eth_estimateGas');
  assert.ok(chain.log.lastIndexOf('eth_call', simulated) > chain.log.indexOf('eth_getTransactionCount'), 'simulated, then estimated');
  assert.deepEqual(chain.sends, []);
});

test('prepareClose removes all of the liquidity with the band minimums and pays principal and fees', async () => {
  const { chain, client, fees } = setupChain();
  const prepared = await client.prepareClose(TOKEN_ID, 50, gas);
  const minimum = [988813n, 321948291994566732075n];
  assert.deepEqual(prepared.minimum, minimum);
  assert.equal(prepared.transaction.data, position.closeData(TOKEN_ID, NFT.liquidity, ...minimum, USDG.toLowerCase(), UFG.toLowerCase(), OWNER.toLowerCase(), prepared.deadline));
  assert.deepEqual(prepared.receive, [994039n + fees[0], 325205393406295768765n + fees[1]]);
  assert.deepEqual(prepared.atLeast, [minimum[0] + fees[0], minimum[1] + fees[1]]);
  assert.deepEqual(chain.sends, []);
});

test('a price that moves past the band is refused by the simulation, in words, and nothing is sent', async () => {
  const { chain, client } = setupChain();
  const prepared = await client.prepareClose(TOKEN_ID, 10, gas);
  // The pool moves down 1% before the press: less currency1 comes out than the minimum allows.
  chain.move(TOKEN_ID, (NFT.sqrtPriceX96 * 99n) / 100n, NFT.tick - 201);
  await assert.rejects(client.send(prepared, true), /position_price_moved/);
  assert.deepEqual([chain.sends, chain.declined], [[], []], 'refused before the wallet was asked to sign');
});

test('send simulates again, claims the nonce, offers the step once; the receipt says included, reverted or reorganized', async () => {
  const { chain, client, claims, fees } = setupChain();
  const prepared = await client.prepareCollect(TOKEN_ID, gas);
  await assert.rejects(client.send(prepared, false), /wallet_review_required/, 'never without the press');
  const hash = await client.send(prepared, true);
  const at = chain.log.indexOf('eth_sendTransaction');
  assert.equal(chain.log[chain.log.lastIndexOf('eth_call', at)], 'eth_call', 'the exact step simulated right before the wallet');
  assert.deepEqual(claims, [['claim', 0n]]);
  assert.deepEqual(chain.sends.map((tx) => [tx.to, tx.value, tx.data]), [[POSITION_MANAGER, '0x0', prepared.transaction.data]]);
  assert.deepEqual(chain.paid, [{ to: OWNER.toLowerCase(), currencies: [USDG.toLowerCase(), UFG.toLowerCase()], amounts: fees }], 'the fees, to the owner');
  assert.equal(chain.nft(TOKEN_ID).liquidity, NFT.liquidity, 'a collect leaves the liquidity');
  assert.deepEqual(await client.receipt(hash), { state: 'finalized', blockHash: `0x${'b0'.repeat(32)}` });
  await assert.rejects(client.send(prepared, true), /wallet_review_required/, 'a prepared step is offered once');
  await assert.rejects(client.receipt(`0x${'99'.repeat(32)}`), /receipt_not_from_this_review/);

  const lagging = setupChain({ finality: 'lagging' });
  const closing = await lagging.client.prepareClose(TOKEN_ID, 50, gas);
  const closed = await lagging.client.send(closing, true);
  assert.equal((await lagging.client.receipt(closed)).state, 'included', 'in a block the finalized one has not reached');
  assert.equal(lagging.chain.nft(TOKEN_ID).liquidity, 0n, 'the NFT stays, empty');

  const failing = setupChain();
  failing.chain.revert();
  const step = await failing.client.prepareCollect(TOKEN_ID, gas);
  assert.equal((await failing.client.receipt(await failing.client.send(step, true))).state, 'reverted', 'said as soon as its block is canonical');
});

test('a rejection in the wallet releases the nonce claim and sends nothing more', async () => {
  const { chain, client, claims } = setupChain();
  const prepared = await client.prepareClose(TOKEN_ID, 50, gas);
  chain.decline();
  await assert.rejects(client.send(prepared, true), (error) => error.code === 4001);
  assert.deepEqual(claims, [['claim', 0n], ['release', 0n, 'claim-0']]);
  const after = chain.log.length;
  assert.equal(chain.log.at(-1), 'eth_sendTransaction');
  assert.deepEqual([chain.sends.length, chain.declined.length], [0, 1]);
  await assert.rejects(client.send(prepared, true), /wallet_review_required/, 'the declined step is not offered again');
  assert.equal(chain.log.length, after, 'nothing more reached the wallet');
});

test('a subscribed position is read as subscribed, so the page can say automation stops', async () => {
  const { client } = setupChain({ position: { hasSubscriber: true } });
  assert.equal((await client.inspect(TOKEN_ID)).hasSubscriber, true);
});

test('the receipt watch reads again through a passing read failure and concludes when the receipt confirms', async () => {
  const { chain, client } = setupChain();
  const hash = await client.send(await client.prepareCollect(TOKEN_ID, gas), true);
  // The wallet's node fails the first receipt read once (-32603), as MetaMask does now and then.
  chain.failNext('eth_getTransactionReceipt');
  const reads = [];
  const read = () => client.receipt(hash).then((receipt) => { reads.push(receipt.state); return receipt; }, (error) => { reads.push(`failed ${error.code ?? error.message}`); throw error; });
  assert.equal(await steps.watchReceipt(read, () => true, { everyMs: 1, waitMs: 5_000 }), 'included');
  assert.deepEqual(reads, ['failed -32603', 'finalized'], 'the failed read is read again, and the watch ends on the receipt');
});

test('the receipt watch ends early only on a receipt that is not the one reviewed; failures to the end are an unknown outcome', async () => {
  const fast = { everyMs: 1, waitMs: 30 };
  const node = () => Promise.reject(Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603 }));
  assert.equal(await steps.watchReceipt(node, () => true, fast), 'unknown', 'every read failed: not a failure of the step, its outcome unknown');
  let asks = 0;
  const busy = () => (++asks === 1 ? Promise.reject(new Error('wallet_action_busy')) : Promise.resolve({ state: 'pending' }));
  assert.equal(await steps.watchReceipt(busy, () => true, fast), 'waiting', 'the last read answered: still waiting');
  assert.ok(asks > 1);
  for (const code of ['transaction_does_not_match_review', 'invalid_receipt', 'receipt_not_from_this_review']) {
    let calls = 0;
    await assert.rejects(steps.watchReceipt(() => { calls++; return Promise.reject(new Error(code)); }, () => true, fast), new RegExp(code));
    assert.equal(calls, 1, `${code} ends the watch at once`);
  }
  let alive = true;
  const stopping = () => { alive = false; return Promise.reject(new Error('wallet_timeout')); };
  assert.equal(await steps.watchReceipt(stopping, () => alive, fast), 'stopped', 'a page that left is told nothing');
  assert.match(steps.outcomeUnknown('refund'), /^The refund was sent, but its outcome could not be read\. Check your wallet activity/);
});

test('amounts are written to six significant digits, cut rather than rounded, and a token is named', () => {
  assert.deepEqual(steps.amountText(994039n, 6), { text: '0.994039', exact: '0.994039' });
  assert.deepEqual(steps.amountText(325205393406295768765n, 18), { text: '325.205', exact: '325.205393406295768765' });
  assert.deepEqual(steps.amountText(1999999n, 6), { text: '1.99999', exact: '1.999999' }, 'never rounded up');
  assert.deepEqual(steps.amountText(1234567890000n, 6), { text: '1,234,567', exact: '1,234,567.89' });
  assert.deepEqual(steps.amountText(3916050681287205n, 18), { text: '0.00391605', exact: '0.003916050681287205' });
  assert.deepEqual(steps.amountText(0n, 18), { text: '0', exact: '0' });
  assert.deepEqual(steps.amountText('100000', 6), { text: '0.1', exact: '0.1' });
  assert.equal(steps.amountText(5n, null), null, 'decimals unknown: no figure');
  assert.equal(steps.currencyName({ address: USDG, symbol: 'USDG' }), 'USDG');
  assert.equal(steps.currencyName({ address: '0x0000000000000000000000000000000000000000', symbol: null }), 'ETH');
  assert.equal(steps.currencyName({ address: UFG.toLowerCase(), symbol: null }), '0xefab…a0a3');
  assert.equal(steps.isRejection({ code: 4001 }), true);
  assert.equal(steps.isRejection(new Error('4001')), false);
});
