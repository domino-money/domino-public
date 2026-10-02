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

// Changed on purpose 2026-10-02 (RPC-SPEC §11.4, rugged97's rule 2): Initialize, Swap, Donate and ProtocolFeeUpdated, which only
// the retired fees replay read, are no pins of the page or the edge any more.
const EVENTS = {
  Transfer: 'Transfer(address indexed from, address indexed to, uint256 indexed id)',
  ModifyLiquidity: 'ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
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
  // 2026-10-01: the point reads' mint search and a page's never-minted id (item D5).
  nextTokenId: 'nextTokenId()',
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

test('the limits the edge and the page share are one set of numbers', () => {
  const ledger = require('../.test-build/app/functions/_lib/feesLedger.js');
  for (const name of ['SAFE_DEPTH', 'MAX_STATE_IDS']) assert.equal(fees[name], constants[name], name);
  assert.equal(ledger.MAX_LEDGER_IDS, constants.MAX_LEDGER_IDS);
  assert.equal(ledger.MAX_LEDGER_IDS, fees.MAX_STATE_IDS, 'one ledger request, one state request: eight ids each');
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
