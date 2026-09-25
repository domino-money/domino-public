/**
 * The chain behind POST /api/owned/v2/positions, faked for tests/owned.test.mjs
 * and tests/wallet-positions.test.mjs: a table that answers only the calls
 * functions/_lib/walletPositions.ts may make and fails the test on any other,
 * and the Workers cache as a Map. Not a suite of its own.
 *
 * Rewritten on 2026-09-24 with the v2 endpoint: DominoSetupV1's SetupMinted
 * logs replace the PositionManager's Transfer walk, and each position's pool,
 * range, price, fees and tokens are read from StateView and the tokens.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, keccak256, numberToHex, pad, parseAbi } from 'viem';

const require = createRequire(import.meta.url);
export const owned = require('../.test-build/app/functions/_lib/owned.js');
export const wallet = require('../.test-build/app/functions/_lib/walletPositions.js');
const fees = require('../.test-build/app/functions/_lib/fees.js');

export const OWNER = '0xf6184f814543b88dd867c34ce6e9f56ab7d18c0a';
export const ZERO = '0x0000000000000000000000000000000000000000';
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
export const TOKEN = '0xefab538cf3c29237a47c6afb145d50ddf204a0a3';
const PM = owned.POSITION_MANAGER;
const SETUP = owned.SETUP_CONTRACT;
const STATE_VIEW = fees.STATE_VIEW;

export const multicallAbi = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }', 'function aggregate3(Call3[] calls) payable returns (Result[] returnData)']);
export const pmAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'function ownerOf(uint256) view returns (address)',
  'function getPositionLiquidity(uint256) view returns (uint128)',
  'function getPoolAndPositionInfo(uint256) view returns (PoolKey, uint256)',
]);
export const stateViewAbi = parseAbi([
  'function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getFeeGrowthInside(bytes32, int24, int24) view returns (uint256, uint256)',
  'function getPositionInfo(bytes32, address, int24, int24, bytes32) view returns (uint128 liquidity, uint256, uint256)',
]);
export const erc20Abi = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
export const setupAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct Operation { address owner; PoolKey key; uint128 balance0; uint128 balance1; bool swapped; bool closed; uint256 tokenId; }',
  'function ownerNonce(address) view returns (uint64)',
  'function operation(bytes32) view returns (Operation)',
  'function recoveryStarted(bytes32) view returns (bool)',
]);
export const opId = (owner, nonce) => keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint64' }], [4663n, SETUP, owner, nonce]));
export const poolIdOf = (key) =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
/** The PositionManager's packed PositionInfo: 200 bits of pool id | 24 tickUpper | 24 tickLower | 8 hasSubscriber. */
export const packInfo = (poolId, tickLower, tickUpper) => ((BigInt(poolId) >> 56n) << 56n) | (BigInt.asUintN(24, BigInt(tickUpper)) << 32n) | (BigInt.asUintN(24, BigInt(tickLower)) << 8n);

/** The pool of most fixtures: USDG / TOKEN, 0.30%, spacing 60, no hooks. */
export const KEY = { currency0: USDG, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: ZERO };
export const POOL = poolIdOf(KEY);
/** An ETH pool: native ETH is currency0 and is never asked for a symbol. */
export const ETH_KEY = { currency0: ZERO, currency1: TOKEN, fee: 500, tickSpacing: 10, hooks: ZERO };
export const ETH_POOL = poolIdOf(ETH_KEY);

/** An NFT of the fake chain: its holder, pool key, range, liquidity and fee growth at its last settlement. */
export const nft = (patch = {}) => ({ holder: OWNER, key: KEY, tickLower: -600, tickUpper: 600, liquidity: 10n ** 12n, growthLast: [0n, 0n], ...patch });

/**
 * `minted`: [{ block, id, owner? }] SetupMinted events (to OWNER unless said). `nfts`: per id (nft()). `pools`: per pool
 * id { sqrtPriceX96, tick, growthInside: [a, b] }; a pool not in it reverts. `tokens`: per address { symbol, decimals },
 * or null for one whose reads revert. `logLimit`: the most logs one eth_getLogs may match before it is refused as too
 * large. `script`: per method, answers to give first (a Response or { error }). `deps.time` is the clock, in ms.
 */
export function fakeChain({
  owner = OWNER,
  head = 71_700_000,
  minted = [],
  nfts = {},
  pools = { [POOL]: { sqrtPriceX96: 2n ** 96n, tick: 0, growthInside: [0n, 0n] }, [ETH_POOL]: { sqrtPriceX96: 2n ** 96n, tick: 0, growthInside: [0n, 0n] } },
  tokens = { [USDG]: { symbol: 'USDG', decimals: 6 }, [TOKEN]: { symbol: 'UFG', decimals: 18 } },
  nonce = 0n,
  operations = {},
  recovery = {},
  logLimit = Infinity,
  script = {},
} = {}) {
  const log = [];
  const slept = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const ok = (abi, functionName, result) => ({ success: true, returnData: encodeFunctionResult({ abi, functionName, result }) });
  const revert = { success: false, returnData: '0x08c379a0' };
  const nftOf = (id) => nfts[id.toString()];
  const view = (target, data) => {
    if (target === PM) {
      const { functionName, args } = decodeFunctionData({ abi: pmAbi, data });
      const position = nftOf(args[0]);
      if (!position) return revert;
      if (functionName === 'ownerOf') return position.burned ? revert : ok(pmAbi, functionName, position.holder);
      if (functionName === 'getPositionLiquidity') return ok(pmAbi, functionName, position.liquidity);
      return ok(pmAbi, functionName, [position.key, position.info ?? packInfo(poolIdOf(position.key), position.tickLower, position.tickUpper)]);
    }
    if (target === STATE_VIEW) {
      const { functionName, args } = decodeFunctionData({ abi: stateViewAbi, data });
      const pool = pools[args[0]];
      if (!pool) return revert;
      if (functionName === 'getSlot0') return ok(stateViewAbi, functionName, [pool.sqrtPriceX96, pool.tick, 0, 3000]);
      if (functionName === 'getFeeGrowthInside') return ok(stateViewAbi, functionName, pool.growthInside);
      assert.equal(args[1].toLowerCase(), PM, 'the PositionManager’s position');
      const id = BigInt(args[4]);
      const position = nftOf(id);
      assert.ok(position, `a position read for an id never asked: ${id}`);
      assert.deepEqual([args[2], args[3]], [position.tickLower, position.tickUpper], 'its own range');
      return ok(stateViewAbi, functionName, [position.coreLiquidity ?? position.liquidity, position.growthLast[0], position.growthLast[1]]);
    }
    if (target === SETUP) {
      const { functionName, args } = decodeFunctionData({ abi: setupAbi, data });
      if (functionName === 'ownerNonce') {
        assert.equal(args[0].toLowerCase(), owner);
        return ok(setupAbi, functionName, nonce);
      }
      if (functionName === 'recoveryStarted') return ok(setupAbi, functionName, recovery[args[0]] ?? false);
      const op = operations[args[0]] ?? { owner: ZERO, key: { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO }, balance0: 0n, balance1: 0n, swapped: false, closed: false, tokenId: 0n };
      return ok(setupAbi, functionName, op);
    }
    assert.ok(target in tokens, `a call to ${target} (${data.slice(0, 10)})`);
    const { functionName } = decodeFunctionData({ abi: erc20Abi, data });
    const token = tokens[target];
    if (!token) return revert;
    return ok(erc20Abi, functionName, functionName === 'symbol' ? token.symbol : token.decimals);
  };
  const answer = (method, params) => {
    if (method === 'eth_blockNumber') {
      assert.deepEqual(params, []);
      return { result: numberToHex(head) };
    }
    if (method === 'eth_getLogs') {
      const [filter] = params;
      assert.deepEqual(Object.keys(filter).sort(), ['address', 'fromBlock', 'toBlock', 'topics']);
      assert.equal(filter.address, SETUP);
      assert.deepEqual(filter.topics, [owned.SETUP_MINTED_TOPIC, null, pad(owner)]);
      const from = Number(filter.fromBlock);
      const to = Number(filter.toBlock);
      assert.ok(from >= owned.SETUP_DEPLOY_BLOCK && to <= head && from <= to, `range ${from}..${to}`);
      const hits = minted.filter(({ block, owner: recipient = owner }) => block >= from && block <= to && recipient === owner);
      if (hits.length > logLimit) return { error: { code: -32602, message: `query exceeds limit of ${logLimit}` } };
      return {
        result: hits.map(({ block, id }) => ({
          address: SETUP,
          blockNumber: numberToHex(block),
          topics: [owned.SETUP_MINTED_TOPIC, pad(numberToHex(BigInt(id) * 7n + 1n)), pad(owner), pad(numberToHex(BigInt(id)))],
          data: encodeAbiParameters([{ type: 'uint128' }, { type: 'uint128' }, { type: 'uint128' }], [1n, 2n, 3n]),
          removed: false,
        })),
      };
    }
    assert.equal(method, 'eth_call', `the function asked ${method}`);
    const [call, block] = params;
    assert.deepEqual(Object.keys(call).sort(), ['data', 'to']);
    assert.equal(call.to, owned.MULTICALL3);
    assert.equal(block, numberToHex(head), 'every read is pinned to the head the logs end at');
    const { args } = decodeFunctionData({ abi: multicallAbi, data: call.data });
    for (const sub of args[0]) assert.equal(sub.allowFailure, true);
    return { result: encodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', result: args[0].map((sub) => view(sub.target.toLowerCase(), sub.callData)) }) };
  };
  const deps = {
    time: 0,
    now: () => deps.time,
    sleep: async (ms) => {
      slept.push(ms);
    },
    fetch: async (url, init) => {
      assert.equal(url, owned.RPC_URL);
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body);
      assert.deepEqual(Object.keys(body).sort(), ['id', 'jsonrpc', 'method', 'params']);
      log.push({ method: body.method, params: body.params });
      const scripted = script[body.method]?.shift();
      if (scripted instanceof Response) return scripted;
      if (scripted) return json({ jsonrpc: '2.0', id: body.id, ...scripted });
      return json({ jsonrpc: '2.0', id: body.id, ...answer(body.method, body.params) });
    },
  };
  return { deps, log, slept };
}

/** The Workers cache as a Map: what was put, served back as it was stored (its max-age is the code's to honour). */
export function memoryCache() {
  const stored = new Map();
  return { stored, cache: { match: async (request) => stored.get(request.url)?.clone(), put: async (request, response) => void stored.set(request.url, response) } };
}
