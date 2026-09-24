/**
 * The chain behind POST /api/owned/v1/positions, faked for tests/owned.test.mjs
 * and tests/owned-positions.test.mjs: a table that answers only the calls
 * functions/_lib/owned.ts may make and fails the test on any other, and the
 * Workers cache as a Map. Not a suite of its own.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, keccak256, numberToHex, pad, parseAbi } from 'viem';

const require = createRequire(import.meta.url);
export const owned = require('../.test-build/app/functions/_lib/owned.js');

export const OWNER = '0xf6184f814543b88dd867c34ce6e9f56ab7d18c0a';
const PM = owned.POSITION_MANAGER;
const SETUP = owned.SETUP_CONTRACT;

export const multicallAbi = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }', 'function aggregate3(Call3[] calls) payable returns (Result[] returnData)']);
export const pmAbi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function ownerOf(uint256) view returns (address)', 'function getPositionLiquidity(uint256) view returns (uint128)']);
export const setupAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct Operation { address owner; PoolKey key; uint128 balance0; uint128 balance1; bool swapped; bool closed; uint256 tokenId; }',
  'function ownerNonce(address) view returns (uint64)',
  'function operation(bytes32) view returns (Operation)',
  'function recoveryStarted(bytes32) view returns (bool)',
]);
export const opId = (owner, nonce) => keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint64' }], [4663n, SETUP, owner, nonce]));

/**
 * `received`: [{ block, id, bytes? }] Transfer events to the owner, `bytes` of data padding each. `holders`/`liquidity`:
 * per id. `logLimit`: the most logs one eth_getLogs may match before it is refused as too large. `script`: per method,
 * answers to give first (a Response or { error }), before the table answers. `deps.time` is the clock, in ms.
 */
export function fakeRpc({ owner = OWNER, head = 70_900_000, received = [], holders = {}, liquidity = {}, balance, nonce = 0n, operations = {}, recovery = {}, logLimit = Infinity, script = {} } = {}) {
  const log = [];
  const slept = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const view = (target, data) => {
    const selector = data.slice(0, 10);
    if (target === PM) {
      const { functionName, args } = decodeFunctionData({ abi: pmAbi, data });
      if (functionName === 'balanceOf') {
        assert.equal(args[0].toLowerCase(), owner);
        return { success: true, returnData: encodeFunctionResult({ abi: pmAbi, functionName, result: balance ?? BigInt(Object.values(holders).filter((h) => h === owner).length) }) };
      }
      const id = args[0].toString();
      if (functionName === 'ownerOf') return holders[id] ? { success: true, returnData: encodeFunctionResult({ abi: pmAbi, functionName, result: holders[id] }) } : { success: false, returnData: '0x08c379a0' };
      return { success: true, returnData: encodeFunctionResult({ abi: pmAbi, functionName, result: liquidity[id] ?? 0n }) };
    }
    assert.equal(target, SETUP, `a call to ${target} (${selector})`);
    const { functionName, args } = decodeFunctionData({ abi: setupAbi, data });
    if (functionName === 'ownerNonce') return { success: true, returnData: encodeFunctionResult({ abi: setupAbi, functionName, result: nonce }) };
    if (functionName === 'recoveryStarted') return { success: true, returnData: encodeFunctionResult({ abi: setupAbi, functionName, result: recovery[args[0]] ?? false }) };
    const zero = '0x0000000000000000000000000000000000000000';
    const op = operations[args[0]] ?? { owner: zero, key: { currency0: zero, currency1: zero, fee: 0, tickSpacing: 0, hooks: zero }, balance0: 0n, balance1: 0n, swapped: false, closed: false, tokenId: 0n };
    return { success: true, returnData: encodeFunctionResult({ abi: setupAbi, functionName, result: op }) };
  };
  const answer = (method, params) => {
    if (method === 'eth_blockNumber') {
      assert.deepEqual(params, []);
      return { result: numberToHex(head) };
    }
    if (method === 'eth_getLogs') {
      const [filter] = params;
      assert.deepEqual(Object.keys(filter).sort(), ['address', 'fromBlock', 'toBlock', 'topics']);
      assert.equal(filter.address, PM);
      assert.deepEqual(filter.topics, [owned.TRANSFER_TOPIC, null, pad(owner)]);
      const from = Number(filter.fromBlock);
      const to = Number(filter.toBlock);
      assert.ok(from >= 9506 && to <= head && from <= to, `range ${from}..${to}`);
      const hits = received.filter(({ block }) => block >= from && block <= to);
      if (hits.length > logLimit) return { error: { code: -32602, message: `query exceeds limit of ${logLimit}` } };
      return { result: hits.map(({ block, id, to: recipient = owner, bytes = 0 }) => ({ address: PM, blockNumber: numberToHex(block), topics: [owned.TRANSFER_TOPIC, pad('0x01'), pad(recipient), pad(numberToHex(BigInt(id)))], data: `0x${'ab'.repeat(bytes / 2)}`, removed: false })) };
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
