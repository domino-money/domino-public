/**
 * The fees history's pins (src/lib/fees/constants.ts and its copies in
 * functions/_lib/fees.ts; DESIGN-V2 §15.1, §15.4, R-12): every event topic,
 * selector and address against viem, the app's finance pins and the V1
 * deployment profile, so no copy can drift.
 *
 * Added 2026-09-24 (P6, fees data).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { encodeAbiParameters, keccak256, toEventSelector, toFunctionSelector } from 'viem';
import { loadCase } from './support/fees/relay-fixture.mjs';

const require = createRequire(import.meta.url);
const constants = require('../.test-build/app/src/lib/fees/constants.js');
const fees = require('../.test-build/app/functions/_lib/fees.js');
const owned = require('../.test-build/app/functions/_lib/owned.js');

const EVENTS = {
  Transfer: 'Transfer(address indexed from, address indexed to, uint256 indexed id)',
  Initialize: 'Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
  ModifyLiquidity: 'ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
  Swap: 'Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
  Donate: 'Donate(bytes32 indexed id, address indexed sender, uint256 amount0, uint256 amount1)',
  ProtocolFeeUpdated: 'ProtocolFeeUpdated(bytes32 indexed id, uint24 protocolFee)',
};

const FUNCTIONS = {
  getPoolAndPositionInfo: 'getPoolAndPositionInfo(uint256)',
  getPositionLiquidity: 'getPositionLiquidity(uint256)',
  ownerOf: 'ownerOf(uint256)',
  getSlot0: 'getSlot0(bytes32)',
  getFeeGrowthInside: 'getFeeGrowthInside(bytes32,int24,int24)',
  getPositionInfo: 'getPositionInfo(bytes32,address,int24,int24,bytes32)',
  symbol: 'symbol()',
  decimals: 'decimals()',
  getCurrentBlockTimestamp: 'getCurrentBlockTimestamp()',
  aggregate3: 'aggregate3((address,bool,bytes)[])',
};

test('every event topic is keccak256 of its v4 / ERC-721 signature, in both copies', () => {
  assert.deepEqual(Object.keys(constants.TOPIC).sort(), Object.keys(EVENTS).sort());
  for (const [name, signature] of Object.entries(EVENTS)) {
    assert.equal(constants.TOPIC[name], toEventSelector(`event ${signature}`), name);
    assert.equal(fees.TOPIC[name], constants.TOPIC[name], `functions/_lib/fees.ts ${name}`);
  }
  assert.equal(constants.TOPIC.Transfer, owned.TRANSFER_TOPIC);
});

test('every selector is the one viem computes, in both copies', () => {
  assert.deepEqual(Object.keys(constants.SELECTOR).sort(), Object.keys(FUNCTIONS).sort());
  for (const [name, signature] of Object.entries(FUNCTIONS)) {
    assert.equal(`0x${constants.SELECTOR[name]}`, toFunctionSelector(signature), name);
    if (name in fees.SELECTOR) assert.equal(fees.SELECTOR[name], constants.SELECTOR[name], `functions/_lib/fees.ts ${name}`);
  }
  assert.equal(constants.SELECTOR.aggregate3, owned.SELECTOR.aggregate3);
  assert.deepEqual(Object.keys(fees.SELECTOR).sort(), Object.keys(FUNCTIONS).filter((name) => name !== 'aggregate3').sort());
});

test('the contracts are the V1 deployment profile’s and the finance pins, in every copy', () => {
  const deployment = JSON.parse(readFileSync(new URL('../../docs/deployments/v1-robinhood-mainnet-2026-09-21/deployment.json', import.meta.url), 'utf8'));
  const text = JSON.stringify(deployment);
  for (const address of [constants.POOL_MANAGER, constants.POSITION_MANAGER, constants.STATE_VIEW]) assert.ok(text.includes(`"${address}"`), address);
  const pin = readFileSync(new URL('../src/finance/pin.ts', import.meta.url), 'utf8');
  assert.match(pin, new RegExp(`export const STATE_VIEW = '${constants.STATE_VIEW}'`));
  assert.match(pin, new RegExp(`export const POSITION_MANAGER = '${constants.POSITION_MANAGER}'`));
  assert.equal(fees.POOL_MANAGER, constants.POOL_MANAGER);
  assert.equal(fees.STATE_VIEW, constants.STATE_VIEW);
  assert.equal(owned.POSITION_MANAGER, constants.POSITION_MANAGER);
  assert.equal(owned.MULTICALL3, constants.MULTICALL3);
  for (const address of [constants.POOL_MANAGER, constants.POSITION_MANAGER, constants.STATE_VIEW, constants.MULTICALL3]) assert.match(address, /^0x[0-9a-f]{40}$/);
});

test('the grid and the limits the relay and the client share are one set of numbers', () => {
  assert.equal(constants.DAY_SPAN, 24 * constants.HOUR_SPAN);
  assert.equal(constants.EPOCH_SPAN % constants.HOUR_SPAN, 0);
  // 2026-09-25: and the probe's span, the page's cheap bound before a history.
  for (const name of ['HOUR_SPAN', 'DAY_SPAN', 'EPOCH_SPAN', 'SAFE_DEPTH', 'PROBE_SPAN']) assert.equal(fees[name], constants[name], name);
  assert.equal(fees.MAX_STATE_IDS, constants.MAX_STATE_IDS);
  assert.equal(fees.MAX_DAYS, constants.MAX_DAYS_PER_REQUEST);
  assert.equal(fees.MAX_HEADERS, constants.MAX_HEADERS_PER_REQUEST);
  // Changed on purpose (2026-09-25): every byte is read by the visitor's own browser under the RPC's per-address limit.
  assert.deepEqual(constants.BUDGET_BYTES, { page: 2 * 1024 * 1024, list: 1024 * 1024 });
  assert.deepEqual(constants.BUDGET_MS, { page: 20_000, list: 10_000 });
  assert.equal(constants.MAX_SWAP_DAYS, 30);
});

test('a pool id is keccak256(abi.encode(PoolKey)), as viem encodes it', () => {
  // The recorded USDG/UFG 4 % pool of NFTs 3136705 and 2310187, and its id on chain.
  const [position] = loadCase('3136705').state.positions;
  const key = position.poolKey;
  assert.equal(fees.poolIdOf(key), position.poolId);
  const expected = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
  assert.equal(fees.poolIdOf(key), expected);
  const negative = { ...key, tickSpacing: 1, fee: 0 };
  assert.equal(fees.poolIdOf(negative), keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [negative.currency0, negative.currency1, 0, 1, negative.hooks])));
});
