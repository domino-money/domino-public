/**
 * The chain behind the fees relay (functions/_lib/fees.ts), faked for
 * tests/fees-relay.test.mjs (2026-09-24, P6): it answers only the methods the
 * relay may use (eth_blockNumber, eth_getLogs, eth_call to Multicall3,
 * batched eth_getBlockByNumber) and fails the test on anything else. Not a
 * suite of its own.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { decodeFunctionData, encodeFunctionResult, numberToHex, parseAbi } from 'viem';
import { logLimitError } from '../log-limits.mjs';

const require = createRequire(import.meta.url);
export const fees = require('../../../.test-build/app/functions/_lib/fees.js');
export const owned = require('../../../.test-build/app/functions/_lib/owned.js');

export const multicallAbi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function getCurrentBlockTimestamp() view returns (uint256)',
]);
export const positionManagerAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns (PoolKey poolKey, uint256 info)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)',
  'function ownerOf(uint256 id) view returns (address owner)',
  // 2026-09-25: a position's feature, read by the page (functions/_lib/automation.ts): nothing is subscribed here.
  'function subscriber(uint256 id) view returns (address)',
]);
export const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)',
  'function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)',
]);
export const erc20Abi = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/**
 * `logs`: RPC-shaped logs the chain holds. `headers`: block → timestamp.
 * `views(target, data)`: a sub-call's { success, returnData }. `logLimit`: the
 * most logs one eth_getLogs may match. `script`: per method, answers given
 * first (a Response, or { error }). `deps.time` is the clock in ms.
 */
export function fakeChain({ head = 71_500_000, logs = [], headers = {}, views = () => ({ success: false, returnData: '0x' }), logLimit = Infinity, script = {}, tokens = [] } = {}) {
  const log = [];
  const posts = [];
  const slept = [];
  const answer = (method, params, id) => {
    if (method === 'eth_blockNumber') {
      assert.deepEqual(params, []);
      return { result: numberToHex(chain.head) };
    }
    if (method === 'eth_getLogs') {
      const [filter] = params;
      assert.deepEqual(Object.keys(filter).sort(), ['address', 'fromBlock', 'toBlock', 'topics']);
      // 2026-09-25: the price path's settlements read also asks the pool's ERC-20 currencies (`tokens`), several at once.
      const addresses = Array.isArray(filter.address) ? filter.address : [filter.address];
      assert.ok(addresses.length > 0 && addresses.every((address) => [fees.POOL_MANAGER, owned.POSITION_MANAGER, ...tokens].includes(address)), `logs of ${filter.address}`);
      const from = Number(filter.fromBlock);
      const to = Number(filter.toBlock);
      assert.ok(from <= to && to <= chain.head, `range ${from}..${to} (head ${chain.head})`);
      // 2026-09-28: the RPC's gateway refuses a range past its limits (tests/support/log-limits.mjs), as it does live.
      const limited = logLimitError(filter);
      if (limited) return { error: limited };
      const [topic0, topic1, topic2, topic3] = filter.topics;
      const first = Array.isArray(topic0) ? topic0 : [topic0];
      const match = (want, got) => want == null || (Array.isArray(want) ? want.includes(got) : want === got);
      const hits = chain.logs.filter((entry) => {
        const block = Number(entry.blockNumber);
        return addresses.includes(entry.address) && block >= from && block <= to && first.includes(entry.topics[0])
          && match(topic1, entry.topics[1]) && match(topic2, entry.topics[2]) && match(topic3, entry.topics[3]);
      });
      if (hits.length > logLimit) return { error: { code: -32005, message: `query exceeds limit of ${logLimit}` } };
      return { result: hits };
    }
    if (method === 'eth_getBlockByNumber') {
      const [tag, full] = params;
      assert.equal(full, false);
      const block = Number(tag);
      return { result: block in chain.headers ? { number: tag, timestamp: numberToHex(chain.headers[block]), hash: `0x${'ab'.repeat(32)}` } : null };
    }
    assert.equal(method, 'eth_call', `the relay asked ${method} (${id})`);
    const [call, block] = params;
    assert.deepEqual(Object.keys(call).sort(), ['data', 'to']);
    assert.equal(call.to, owned.MULTICALL3);
    chain.callBlocks.push(Number(block));
    const { args } = decodeFunctionData({ abi: multicallAbi, data: call.data });
    for (const sub of args[0]) assert.equal(sub.allowFailure, true);
    return { result: encodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', result: args[0].map((sub) => chain.views(sub.target.toLowerCase(), sub.callData)) }) };
  };
  const deps = {
    time: 1_000_000,
    now: () => deps.time,
    sleep: async (ms) => {
      slept.push(ms);
      deps.time += ms;
    },
    fetch: async (url, init) => {
      assert.equal(url, owned.RPC_URL);
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body);
      const calls = Array.isArray(body) ? body : [body];
      // 2026-09-28: each POST's methods, a batch's all of them (a relay answer's call cap counts POSTs).
      posts.push(calls.map((one) => one.method));
      for (const one of calls) {
        assert.deepEqual(Object.keys(one).sort(), ['id', 'jsonrpc', 'method', 'params']);
        log.push({ method: one.method, params: one.params });
      }
      const first = calls[0].method;
      const scripted = script[first]?.shift();
      if (scripted instanceof Response) return scripted;
      if (scripted) return json({ jsonrpc: '2.0', id: calls[0].id, ...scripted });
      if (Array.isArray(body)) return json(body.map((one) => ({ jsonrpc: '2.0', id: one.id, ...answer(one.method, one.params, one.id) })));
      return json({ jsonrpc: '2.0', id: body.id, ...answer(body.method, body.params, body.id) });
    },
  };
  const chain = { head, logs, headers, views, deps, log, posts, slept, callBlocks: [] };
  return chain;
}

/** The Workers cache as a Map: what was put, served back as stored. */
export function memoryCache() {
  const stored = new Map();
  return { stored, cache: { match: async (request) => stored.get(request.url)?.clone(), put: async (request, response) => void stored.set(request.url, response) } };
}

export const word = (value) => BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, '0');
export const topicOf = (value) => `0x${word(value)}`;
export const addressTopic = (address) => `0x${address.slice(2).padStart(64, '0')}`;

/** An RPC-shaped log. */
export function rpcLog({ address = fees.POOL_MANAGER, topics, data = '0x', block, index = 0, tx = `0x${'11'.repeat(32)}`, removed = false }) {
  return { address, topics, data, blockNumber: numberToHex(block), logIndex: numberToHex(index), transactionHash: tx, blockHash: `0x${'cd'.repeat(32)}`, transactionIndex: '0x0', blockTimestamp: '0x0', removed };
}

/** A Swap log of `poolId` at `block` (its data words are arbitrary but well-formed). */
export function swapLog(poolId, block, index = 0, pad = 0) {
  const data = `0x${[-5n, 7n, 79228162514264337593543950336n, 10n ** 18n, 0n, 3000n].map(word).join('')}`;
  return rpcLog({ topics: [fees.TOPIC.Swap, poolId, addressTopic('0x1111111111111111111111111111111111111111')], data, block, index, tx: `0x${(block * 1000 + index + pad).toString(16).padStart(64, '0')}` });
}
