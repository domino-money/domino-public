// The setup client's reads before a one-token deposit (src/finance/setup.ts): the pool's state from the
// deployment's StateView, Uniswap's V4Quoter anchored to its pinned code and PoolManager, and what counts as a
// contract refusing a call (a revert) rather than a wallet or network failure. Reads only: nothing here is sent.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { createSetupClient, isRevert, quoterAbi, revertOf } = require('../.test-build/app/src/finance/setup.js');
const { V4_QUOTER, V4_QUOTER_CODE_HASH } = require('../.test-build/app/src/finance/pin.js');
const { concatHex, decodeFunctionData, encodeAbiParameters, encodeFunctionResult, keccak256, parseAbi, toFunctionSelector } = require('viem');

const QUOTER_CODE = JSON.parse(readFileSync(new URL('./support/v4-quoter.code.json', import.meta.url), 'utf8'));
const stateViewAbi = parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)', 'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)']);
const address = n => '0x' + n.toString(16).padStart(40, '0');
const KEY = { currency0: address(0x5fc5), currency1: address(0xca9c), fee: 80000, tickSpacing: 800, hooks: address(0) };
const POOL_ID = keccak256(encodeAbiParameters([{ type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] }], [KEY]));
/** V4Quoter's revert: UnexpectedRevertBytes(bytes) around the pool's own error. */
const wrapped = inner => concatHex(['0x6190b2b0', encodeAbiParameters([{ type: 'bytes' }], [inner])]);
const NOT_ENOUGH = wrapped(concatHex(['0x7a5ed734', POOL_ID]));
const NOT_INITIALIZED = wrapped('0x486aa307');
/** The reply the Robinhood RPC gave for the owner's USDG/NET pool on 2026-09-23 (investigate/s1_quoter.mjs), verbatim. */
const OBSERVED = '0x6190b2b0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000247a5ed7340012bb2e4548a9c602269431c48d7792e55ff0fe0e39e0e0165fdd326541f90900000000000000000000000000000000000000000000000000000000';

/**
 * A wallet on Robinhood Chain in front of a StateView and the pinned V4Quoter. `quote(amount, zeroForOne, block)` answers
 * quoteExactInputSingle at that block: a bigint, or an object to throw as the wallet would. The chain's head is block
 * 0x10 and moves on by `blocksPerRequest` with every request, as Robinhood Chain's does (several blocks a second);
 * 'latest' is the head at the moment a call arrives.
 */
function chain({ slot0 = [91475816417046462998559025046n, 2875, 4097000, 80000], liquidity = 0n, timestamp = 1_790_000_000, code = QUOTER_CODE.code, manager, quote = () => 1n, blocksPerRequest = 0 } = {}) {
  const owner = address(1), calls = [];
  let head = 0x10;
  const blockAt = tag => (tag === 'latest' ? head : Number(BigInt(tag)));
  const deployment = { setup: address(2), poolManager: address(3), positionManager: address(4), stateView: address(5), feeRecipient: address(6),
    setupCodeHash: keccak256('0x6000'), poolManagerCodeHash: keccak256('0x6000'), positionManagerCodeHash: keccak256('0x6000'), stateViewCodeHash: keccak256('0x6000'),
    feeBps: 65, tariffVersion: '1', expiresAt: 4_000_000_000 };
  const wallet = { owner, current: () => true, nonceOffered: () => false, claimNonce: async () => 'claim', releaseRejectedNonce: async () => {},
    request: async (method, params) => {
      head += blocksPerRequest;
      calls.push({ method, params, head });
      if (method === 'eth_accounts') return [owner];
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_getCode') return params[0] === V4_QUOTER ? code : '0x';
      if (method === 'eth_blockNumber') return '0x' + head.toString(16);
      if (method === 'eth_getBlockByNumber') return { number: '0x' + blockAt(params[0]).toString(16), hash: '0x' + 'ab'.repeat(32), timestamp: '0x' + timestamp.toString(16) };
      if (method === 'eth_call') {
        const [{ to, data }, tag] = params;
        if (to === deployment.stateView) {
          const { functionName, args } = decodeFunctionData({ abi: stateViewAbi, data });
          assert.equal(args[0], POOL_ID, 'the pool id of this key');
          return encodeFunctionResult({ abi: stateViewAbi, functionName, result: functionName === 'getSlot0' ? slot0 : liquidity });
        }
        if (to === V4_QUOTER) {
          const { functionName, args } = decodeFunctionData({ abi: quoterAbi, data });
          if (functionName === 'poolManager') return encodeFunctionResult({ abi: quoterAbi, functionName, result: manager ?? deployment.poolManager });
          const [params] = args;
          assert.deepEqual([params.poolKey.currency0.toLowerCase(), params.poolKey.currency1.toLowerCase(), params.poolKey.fee, params.poolKey.tickSpacing, params.hookData], [KEY.currency0, KEY.currency1, 80000, 800, '0x']);
          const answer = quote(params.exactAmount, params.zeroForOne, blockAt(tag));
          if (typeof answer !== 'bigint') throw answer;
          return encodeFunctionResult({ abi: quoterAbi, functionName, result: [answer, 90_000n] });
        }
      }
      throw new Error('unexpected fixture request: ' + method);
    } };
  return { client: createSetupClient(wallet, deployment, () => 100, async () => deployment), calls, deployment };
}
const methods = calls => calls.map(call => call.method);

test('the V4Quoter pin is the address and runtime code read on chain, and its ABI is the one quoteExactInputSingle is called with', () => {
  assert.equal(V4_QUOTER, '0x8dc178efb8111bb0973dd9d722ebeff267c98f94');
  assert.equal(V4_QUOTER, QUOTER_CODE.address);
  assert.equal(keccak256(QUOTER_CODE.code), V4_QUOTER_CODE_HASH, 'the fixture is the pinned code');
  assert.equal((QUOTER_CODE.code.length - 2) / 2, 6118);
  assert.deepEqual(quoterAbi.map(entry => toFunctionSelector(entry)), ['0xaa9d21cb', '0xdc4c90d3']);
});

test('a revert is found however the wallet wraps it; a declined request, a rate limit and our own failures never are', () => {
  const shapes = [
    // [label, error, revert?, data]
    ['the Robinhood RPC’s reply, passed through', { code: 3, message: 'execution reverted', data: OBSERVED }, true, OBSERVED],
    ['-32603 with data {code 3}', { code: -32603, message: 'Internal JSON-RPC error.', data: { code: 3, message: 'execution reverted', data: NOT_ENOUGH } }, true, NOT_ENOUGH],
    ['-32603 with data.originalError {code 3}', { code: -32603, message: 'Internal JSON-RPC error.', data: { originalError: { code: 3, message: 'execution reverted', data: NOT_ENOUGH } } }, true, NOT_ENOUGH],
    ['-32603 with data.cause {code 3}', { code: -32603, message: 'Internal JSON-RPC error.', data: { cause: { code: 3, message: 'execution reverted', data: NOT_ENOUGH } } }, true, NOT_ENOUGH],
    ['an Error with .cause {code 3}', Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603, cause: { code: 3, message: 'execution reverted', data: NOT_ENOUGH } }), true, NOT_ENOUGH],
    ['.error {code 3}', { code: -32603, message: 'failed', error: { code: 3, data: NOT_INITIALIZED } }, true, NOT_INITIALIZED],
    ['geth’s -32000 "execution reverted"', { code: -32000, message: 'execution reverted' }, true, null],
    ['the browser fake’s thrown Error with a revert message', Object.assign(new Error('execution reverted: a partial fill'), { code: -32000 }), true, null],
    ['hex data alone', { code: -32603, message: 'Internal error', data: '0x30070737' }, true, '0x30070737'],
    ['bounded()’s timeout', new Error('wallet_timeout'), false],
    ['the client’s own failure', new Error('invalid_swap_budget'), false],
    ['a rate limit', { code: 429, message: 'Too Many Requests' }, false],
    ['a request declined in the wallet', { code: 4001, message: 'User rejected the request.' }, false],
    ['a declined request that carries data', { code: 4001, message: 'User rejected the request.', data: '0x1234' }, false],
    ['a rate limit wrapped', { code: -32603, message: 'Internal JSON-RPC error.', data: { code: 429, message: 'execution reverted?' } }, false],
    ['empty data is not a revert by itself', { code: -32603, message: 'Internal error', data: '0x' }, false],
  ];
  for (const [label, error, revert, data] of shapes) {
    assert.equal(isRevert(error), revert, label);
    assert.deepEqual(revertOf(error), revert ? { data } : null, label);
  }
  for (const value of [null, undefined, 'execution reverted', 3]) assert.equal(isRevert(value), false, String(value));
  // Deeper than four levels is not followed.
  let deep = { code: 3 };
  for (let i = 0; i < 5; i++) deep = { code: -32603, message: 'x', cause: deep };
  assert.equal(isRevert(deep), false);
});

test('poolState reads slot0, in-range liquidity and the chain’s time through the wallet, and nothing else', async () => {
  const c = chain({ liquidity: 0n, timestamp: 1_790_000_123 });
  assert.deepEqual(await c.client.poolState(KEY), { sqrtPriceX96: 91475816417046462998559025046n, tick: 2875, protocolFee: 4097000, lpFee: 80000, liquidity: 0n, chainTime: 1_790_000_123 },
    'the owner’s USDG/NET pool on 2026-09-23: a price, and nothing in range');
  // Changed on purpose (review, 2026-09-24): the latest block is read first, then slot0 and the liquidity at its number.
  assert.deepEqual(methods(c.calls), ['eth_accounts', 'eth_chainId', 'eth_getBlockByNumber', 'eth_call', 'eth_call']);
  assert.deepEqual(c.calls[2].params, ['latest', false]);
  assert.deepEqual([c.calls[3].params[1], c.calls[4].params[1]], ['0x10', '0x10']);
  const liquid = chain({ liquidity: 5n * 10n ** 17n });
  assert.equal((await liquid.client.poolState(KEY)).liquidity, 5n * 10n ** 17n);
  await assert.rejects(chain({ slot0: [0n, 0, 0, 0] }).client.poolState(KEY), /pool_not_initialized/);
  await assert.rejects(chain().client.poolState({ ...KEY, hooks: address(9) }), /invalid_pool_key/);
});

test('poolState reads slot0 and the liquidity at the block whose time it returns, while the chain moves on', async () => {
  const c = chain({ liquidity: 7n, blocksPerRequest: 1 });
  await c.client.poolState(KEY);
  const [block, slot, held] = c.calls.slice(2);
  assert.equal(block.method, 'eth_getBlockByNumber');
  const at = '0x' + block.head.toString(16);
  assert.deepEqual([slot.method, slot.params[1], held.method, held.params[1]], ['eth_call', at, 'eth_call', at], 'both at the block read first, not at a later head');
  assert.ok(held.head > block.head, 'the head moved on while they were asked');
});

test('quotePool anchors the quoter once per client, then asks two sizes of it', async () => {
  const asked = [];
  const c = chain({ quote: (amount, zeroForOne) => { asked.push([amount, zeroForOne]); return amount * 2n; } });
  assert.deepEqual(await c.client.quotePool(KEY, true, 1_000_000n, 1_000n), { kind: 'quote', out: 2_000_000n, outNext: 2_002_000n });
  // Changed on purpose (review, 2026-09-24): the block both sizes are asked at is read once, before them.
  assert.deepEqual(methods(c.calls), ['eth_accounts', 'eth_chainId', 'eth_getCode', 'eth_call', 'eth_blockNumber', 'eth_call', 'eth_call'], 'the code and poolManager() first');
  assert.deepEqual(c.calls[2].params, [V4_QUOTER, 'latest']);
  c.calls.length = 0;
  assert.deepEqual(await c.client.quotePool(KEY, false, 5n, 1_000n), { kind: 'quote', out: 10n, outNext: 2_010n });
  assert.deepEqual(methods(c.calls), ['eth_accounts', 'eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_call'], 'not read again by the same client');
  assert.deepEqual(asked, [[1_000_000n, true], [1_001_000n, true], [5n, false], [1_005n, false]]);
  assert.ok(c.calls.every(call => call.method !== 'eth_sendTransaction' && call.method !== 'eth_estimateGas'));
});

test('quotePool asks both sizes at one block, read once: a pool that moves between the two calls cannot skew the end rate', async () => {
  // Every request lands in a new block, and the pool pays 1,000 more out per block, as a busy pool's price moves; the
  // rate itself is 2 out per 1 in. At one block the difference of the two quotes is the rate alone.
  const c = chain({ blocksPerRequest: 1, quote: (amount, _, block) => amount * 2n + BigInt(block) * 1_000n });
  const quoted = () => c.calls.filter(call => call.method === 'eth_call' && call.params[0].to === V4_QUOTER && call.params[0].data.startsWith('0xaa9d21cb'));
  const answer = await c.client.quotePool(KEY, true, 1_000_000n, 1_000n);
  assert.equal(answer.outNext - answer.out, 2_000n, 'the pool’s rate over the step, and nothing of its move between the calls');
  const read = c.calls.filter(call => call.method === 'eth_blockNumber');
  assert.equal(read.length, 1, 'the block is read once');
  const at = '0x' + read[0].head.toString(16);
  assert.deepEqual(quoted().map(call => call.params[1]), [at, at], 'both sizes carry that block, never latest');
  assert.ok(quoted()[1].head > quoted()[0].head, 'the head moved on between them');
  // The next question reads the block again: each pair is one state of the pool, the newest when it is asked.
  c.calls.length = 0;
  const next = await c.client.quotePool(KEY, true, 2_000_000n, 1_000n);
  assert.equal(next.outNext - next.out, 2_000n);
  const again = c.calls.find(call => call.method === 'eth_blockNumber');
  assert.ok(again.head > read[0].head);
  assert.deepEqual(quoted().map(call => call.params[1]), ['0x' + again.head.toString(16), '0x' + again.head.toString(16)]);
});

test('quotePool refuses a quoter whose code or PoolManager is not the pinned one, before any quote', async () => {
  for (const change of [{ code: '0x6000' }, { code: '0x' }, { manager: address(0x99) }]) {
    const c = chain(change);
    await assert.rejects(c.client.quotePool(KEY, true, 1_000n, 1_000n), /quoter_identity_changed/, JSON.stringify(change));
    assert.equal(c.calls.filter(call => call.method === 'eth_call' && call.params[0].to === V4_QUOTER).length, 'manager' in change ? 1 : 0, 'no quote was asked');
  }
});

test('quotePool says why the quoter refused, and lets any other failure through', async () => {
  const refusal = async (thrown) => chain({ quote: () => thrown }).client.quotePool(KEY, true, 100_000n, 1_000n);
  assert.deepEqual(await refusal({ code: 3, message: 'execution reverted', data: OBSERVED }), { kind: 'refused', reason: 'not_enough_liquidity' }, 'the owner’s pool, as observed');
  assert.deepEqual(await refusal({ code: -32603, message: 'Internal JSON-RPC error.', data: { originalError: { code: 3, data: NOT_ENOUGH } } }), { kind: 'refused', reason: 'not_enough_liquidity' });
  assert.deepEqual(await refusal({ code: 3, message: 'execution reverted', data: NOT_INITIALIZED }), { kind: 'refused', reason: 'pool_not_initialized' });
  assert.deepEqual(await refusal({ code: 3, message: 'execution reverted', data: wrapped('0xbe8b8507') }), { kind: 'refused', reason: 'reverted' }, 'SwapAmountCannotBeZero, or any other');
  assert.deepEqual(await refusal({ code: 3, message: 'execution reverted', data: '0x30070737' }), { kind: 'refused', reason: 'reverted' });
  assert.deepEqual(await refusal({ code: -32000, message: 'execution reverted' }), { kind: 'refused', reason: 'reverted' });
  // The second size refused: the pool fills one and not the other, so it cannot say where the swap ends.
  const edge = chain({ quote: amount => (amount > 100_000n ? { code: 3, message: 'execution reverted', data: NOT_ENOUGH } : 7n) });
  assert.deepEqual(await edge.client.quotePool(KEY, true, 100_000n, 1_000n), { kind: 'refused', reason: 'not_enough_liquidity' });
  for (const thrown of [{ code: 4001, message: 'User rejected the request.' }, { code: 429, message: 'Too Many Requests' }, new Error('wallet_disconnected')]) {
    await assert.rejects(refusal(thrown), (error) => error === thrown, 'not a revert: it propagates, and the caller deposits nothing');
  }
  for (const [net, step] of [[0n, 1_000n], [1_000n, 0n], [2n ** 128n - 1n, 1n], [-1n, 1_000n]]) {
    await assert.rejects(chain().client.quotePool(KEY, true, net, step), /invalid_swap_budget/);
  }
});
