/**
 * The second chain's chain code (functions/_lib/uniswap-v3/abi.ts and reads.ts, 2026-10-01, the chain2 workstream):
 * every selector and topic against viem, every decoder against viem's encoding, and every read against a small v3
 * chain (tests/support/v3-chain.mjs) through the chain-parameterized client, as the page will read Elysium Testnet.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { encodeAbiParameters, encodeFunctionResult, keccak256, parseAbi, toEventSelector, toFunctionSelector } from 'viem';
import { MULTICALL3, TOPIC, addr, fakeRuntime, fakeV3Chain, poolCreatedData, swapData, topicAddress, topicUint } from './support/v3-chain.mjs';

const require = createRequire(import.meta.url);
const abi = require('../.test-build/app/functions/_lib/uniswap-v3/abi.js');
const reads = require('../.test-build/app/functions/_lib/uniswap-v3/reads.js');
const { createChainClient } = require('../.test-build/app/src/lib/chain/client.js');
const { ELYSIUM } = require('../.test-build/app/src/config/chains.js');

const SIGNATURES = {
  slot0: 'slot0()', liquidity: 'liquidity()', token0: 'token0()', token1: 'token1()', fee: 'fee()', tickSpacing: 'tickSpacing()', factory: 'factory()',
  feeGrowthGlobal0X128: 'feeGrowthGlobal0X128()', feeGrowthGlobal1X128: 'feeGrowthGlobal1X128()', ticks: 'ticks(int24)', positions: 'positions(uint256)',
  balanceOf: 'balanceOf(address)', tokenOfOwnerByIndex: 'tokenOfOwnerByIndex(address,uint256)', ownerOf: 'ownerOf(uint256)', getPool: 'getPool(address,address,uint24)',
  symbol: 'symbol()', decimals: 'decimals()', owner: 'owner()', pool: 'pool()', poolFee: 'poolFee()', paused: 'paused()', operator: 'operator()',
  positionCount: 'positionCount()', positionIds: 'positionIds(uint256)', activePositions: 'activePositions()', capital: 'capital(address)', policy: 'policy()',
  policyVersion: 'policyVersion()', deployment: 'deployment()', getCurrentBlockTimestamp: 'getCurrentBlockTimestamp()', arbBlockNumber: 'arbBlockNumber()',
};

test('the word helpers copied from functions/_lib/owned.ts behave as the originals', () => {
  const owned = require('../.test-build/app/functions/_lib/owned.js');
  const words = require('../.test-build/app/functions/_lib/uniswap-v3/words.js');
  assert.equal(words.AGGREGATE3, owned.SELECTOR.aggregate3);
  for (const n of [0n, 1n, 2n ** 255n, -1n, -(2n ** 23n)]) assert.equal(words.word(n), owned.word(n));
  assert.equal(words.hex(255n), owned.hex(255n));
  assert.equal(words.addressWord('0xAbCd000000000000000000000000000000000001'), owned.addressWord('0xAbCd000000000000000000000000000000000001'));
  const calls = [{ target: addr(1), data: abi.V3_SELECTOR.slot0 }, { target: addr(2), data: `${abi.V3_SELECTOR.ticks}${'f'.repeat(58)}c4` }, { target: addr(3), data: '' }];
  assert.equal(words.encodeAggregate3(calls), owned.encodeAggregate3(calls));
  const returned = encodeFunctionResult({ abi: parseAbi(['struct R { bool success; bytes returnData; }', 'function aggregate3() returns (R[])']), functionName: 'aggregate3', result: [{ success: true, returnData: '0x1234' }, { success: false, returnData: '0x' }] });
  assert.deepEqual(words.decodeAggregate3(returned), owned.decodeAggregate3(returned));
  for (const value of [0n, (1n << 160n) - 1n, 1n << 160n]) {
    const mine = (() => { try { return words.asAddress(value); } catch { return 'throws'; } })();
    const theirs = (() => { try { return owned.asAddress(value); } catch { return 'throws'; } })();
    assert.equal(mine, theirs);
  }
  for (const value of [0n, (1n << 23n) - 1n, 1n << 23n, (1n << 256n) - 1n, (1n << 256n) - (1n << 23n), (1n << 256n) - (1n << 23n) - 1n]) {
    const mine = (() => { try { return words.asInt24(value); } catch { return 'throws'; } })();
    const theirs = (() => { try { return owned.asInt24(value); } catch { return 'throws'; } })();
    assert.equal(mine, theirs, value.toString());
  }
  assert.throws(() => words.reader('0x123'), /invalid_return_data/);
  // Keccak-256: owned.ts's and viem's, on empty input, one block, and inputs across the 136-byte rate.
  for (const input of ['0x', '0x00', `0x${'ab'.repeat(135)}`, `0x${'cd'.repeat(136)}`, `0x${'ef'.repeat(1000)}`]) {
    assert.equal(words.keccak256(input), owned.keccak256(input));
    assert.equal(words.keccak256(input), keccak256(input));
  }
});

test('every selector is viem\'s for its signature, and none is missing', () => {
  assert.deepEqual(Object.keys(abi.V3_SELECTOR).sort(), Object.keys(SIGNATURES).sort());
  for (const [name, signature] of Object.entries(SIGNATURES)) assert.equal(`0x${abi.V3_SELECTOR[name]}`, toFunctionSelector(signature), name);
});

test('every topic is viem\'s for its event', () => {
  assert.equal(abi.V3_TOPIC.PoolCreated, toEventSelector('PoolCreated(address,address,uint24,int24,address)'));
  assert.equal(abi.V3_TOPIC.Swap, toEventSelector('Swap(address,address,int256,int256,uint160,uint128,int24)'));
  assert.equal(abi.V3_TOPIC.Transfer, toEventSelector('Transfer(address,address,uint256)'));
  const vault = {
    PositionOpened: 'PositionOpened(uint256,uint256,bytes32,uint128,uint256,uint256)', FeesCollected: 'FeesCollected(uint256,bytes32,bytes32,uint128,uint128)',
    FeesConsumed: 'FeesConsumed(bytes32,bytes32,address,uint128,uint128,uint128)', Converted: 'Converted(bytes32,bytes32,address,uint256,uint128)',
    Compounded: 'Compounded(bytes32,bytes32,uint256,uint128,uint256,uint256)', PositionReleased: 'PositionReleased(uint256)',
    CapitalReduced: 'CapitalReduced(uint256,uint128,uint256,uint256,bool)', PolicyChanged: 'PolicyChanged(uint64,uint64,address,uint16)', Paused: 'Paused(bool)',
    ReserveWithdrawn: 'ReserveWithdrawn(bytes32,address,uint128,uint128)', CapitalWithdrawn: 'CapitalWithdrawn(address,uint256)',
    SurplusRecovered: 'SurplusRecovered(address,uint256)', UnmanagedNFTRecovered: 'UnmanagedNFTRecovered(uint256)',
  };
  assert.deepEqual(Object.keys(abi.VAULT_TOPIC).sort(), Object.keys(vault).sort());
  for (const [name, signature] of Object.entries(vault)) assert.equal(abi.VAULT_TOPIC[name], toEventSelector(signature), name);
  assert.equal(abi.vaultEventOf(abi.VAULT_TOPIC.Compounded.toUpperCase().replace('0X', '0x')), 'Compounded');
  assert.equal(abi.vaultEventOf(`0x${'0'.repeat(64)}`), null);
});

test('decoders read exactly what viem encodes, signed values included, and refuse anything else', () => {
  const POOL = parseAbi(['function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)', 'function ticks(int24) view returns (uint128, int128, uint256, uint256, int56, uint160, uint32, bool)']);
  const slot0 = encodeFunctionResult({ abi: POOL, functionName: 'slot0', result: [79228162514264337593543950336n, -887220, 3, 7, 9, 0x44, true] });
  assert.deepEqual(abi.decodeSlot0(slot0), { sqrtPriceX96: 79228162514264337593543950336n, tick: -887220, feeProtocol: 0x44, unlocked: true });
  const tick = encodeFunctionResult({ abi: POOL, functionName: 'ticks', result: [5n, -5n, 2n ** 255n + 7n, 11n, -3n, 0n, 0, true] });
  assert.deepEqual(abi.decodeTick(tick), { liquidityGross: 5n, liquidityNet: -5n, feeGrowthOutside0X128: 2n ** 255n + 7n, feeGrowthOutside1X128: 11n, initialized: true });
  const NFPM = parseAbi(['function positions(uint256) view returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)']);
  const position = encodeFunctionResult({ abi: NFPM, functionName: 'positions', result: [1n, addr(9), addr(1), addr(2), 3000, -600, 600, 10n ** 20n, 2n ** 200n, 3n, 4n, 5n] });
  assert.deepEqual(abi.decodeNfpmPosition(position), { operator: addr(9), token0: addr(1), token1: addr(2), fee: 3000, tickLower: -600, tickUpper: 600, liquidity: 10n ** 20n, feeGrowthInside0LastX128: 2n ** 200n, feeGrowthInside1LastX128: 3n, tokensOwed0: 4n, tokensOwed1: 5n });
  const reversed = encodeFunctionResult({ abi: NFPM, functionName: 'positions', result: [1n, addr(9), addr(1), addr(2), 3000, 600, -600, 1n, 0n, 0n, 0n, 0n] });
  assert.throws(() => abi.decodeNfpmPosition(reversed), /invalid_return_data/);
  // A word past its type's bits: a uint8 decimals of 256, an address with bits above 160.
  assert.throws(() => abi.decodeUint(`0x${'0'.repeat(61)}100`, 8));
  assert.throws(() => abi.decodeAddress(`0x1${'0'.repeat(63)}`));
  assert.throws(() => abi.decodeSlot0('0x00'), 'a short reply');
  assert.equal(abi.decodeDecimals(encodeAbiParameters([{ type: 'uint8' }], [37])), null, 'more than 36 decimals is no token of these contracts');
  assert.equal(abi.decodeDecimals(encodeAbiParameters([{ type: 'uint8' }], [6])), 6);
});

test('a symbol is the token\'s text, or null: an ABI string, a bytes32, never a control or direction character', () => {
  const text = (s) => encodeAbiParameters([{ type: 'string' }], [s]);
  assert.equal(abi.decodeSymbol(text('USDC')), 'USDC');
  assert.equal(abi.decodeSymbol(text('  WHYPE ')), 'WHYPE');
  assert.equal(abi.decodeSymbol(`0x${Buffer.from('MKR').toString('hex').padEnd(64, '0')}`), 'MKR');
  assert.equal(abi.decodeSymbol(text('A‮B')), null);
  assert.equal(abi.decodeSymbol(text('A\u0007')), null);
  assert.equal(abi.decodeSymbol(text('X'.repeat(33))), null);
  assert.equal(abi.decodeSymbol(text('')), null);
  assert.equal(abi.decodeSymbol('0x'), null);
});

test('the vault\'s structs decode as its getters return them', () => {
  const V = parseAbi([
    'function positions(uint256) view returns (bool, bool, uint64, uint256, int24, int24, uint128, bytes32, bytes32, bytes32)',
    'function policy() view returns (uint16, uint16, uint16, uint16, uint32, uint32, uint64, bool, bool, int24, int24)',
    'function deployment() view returns (address, address, address, address, address, address, bytes32, bytes32, bytes32, bytes32, bytes32, bytes32, bytes32, bytes32, uint8, uint8)',
  ]);
  const z = `0x${'0'.repeat(64)}`;
  assert.deepEqual(abi.decodeVaultPosition(encodeFunctionResult({ abi: V, functionName: 'positions', result: [true, false, 2n, 0n, -600, 600, 77n, z, z, z] })), { known: true, active: false, generation: 2n, parent: 0n, tickLower: -600, tickUpper: 600, liquidity: 77n });
  assert.deepEqual(abi.decodeVaultPolicy(encodeFunctionResult({ abi: V, functionName: 'policy', result: [400, 2, 50, 100, 120, 3600, 1790689192n, true, true, -600, 600] })), { serviceFeeBps: 400, maxPositions: 2, validUntil: 1790689192, allowSwap: true, allowSuccessor: true });
  const d = abi.decodeVaultDeployment(encodeFunctionResult({ abi: V, functionName: 'deployment', result: [addr(1), addr(2), addr(3), addr(4), addr(5), addr(6), z, z, z, z, z, z, z, z, 18, 6] }));
  assert.deepEqual(d, { factory: addr(1), manager: addr(2), router: addr(3), wrappedNative: addr(5), feeRecipient: addr(6), decimals0: 18, decimals1: 6 });
});

test('a PoolCreated and a Swap log decode, and a log of another event does not', () => {
  const created = { topics: [TOPIC.PoolCreated, topicAddress(addr(1)), topicAddress(addr(2)), topicUint(3000)], data: poolCreatedData(60, addr(3)) };
  assert.deepEqual(abi.decodePoolCreated(created), { token0: addr(1), token1: addr(2), fee: 3000, tickSpacing: 60, pool: addr(3) });
  const swap = { topics: [TOPIC.Swap, topicAddress(addr(7)), topicAddress(addr(8))], data: swapData(-5, 10, 2n ** 96n, 99, -1) };
  assert.deepEqual(abi.decodeSwap(swap), { amount0: -5n, amount1: 10n, sqrtPriceX96: 2n ** 96n, liquidity: 99n, tick: -1 });
  assert.throws(() => abi.decodeSwap(created));
  assert.throws(() => abi.decodePoolCreated({ ...created, topics: created.topics.slice(0, 3) }));
});

// --- Reads over a small chain ------------------------------------------------------------------------------------

const FACTORY = addr(0xfac);
const OTHER_FACTORY = addr(0xbad);
const NFPM = addr(0x9f);
const T0 = addr(0x10);
const T1 = addr(0x20);
const POOL = addr(0x4b);
const STRAY = addr(0x4c);
const OWNER = addr(0x0123);
const VAULT = addr(0x385);

function world() {
  const chain = fakeV3Chain({ head: 1_500_000, timestamp: 1_790_100_000 });
  chain.factory(FACTORY);
  chain.factory(OTHER_FACTORY);
  chain.token(T0, 'TKA', 18);
  chain.token(T1, 'USDC', 6);
  chain.pool(POOL, { factory: FACTORY, token0: T0, token1: T1, fee: 3000, tickSpacing: 60, sqrtPriceX96: 79228162514264337593543950336n, tick: 0, liquidity: 10n ** 18n, feeGrowthGlobal0X128: 5n, feeGrowthGlobal1X128: 6n, feeProtocol: 0 });
  chain.pool(STRAY, { factory: OTHER_FACTORY, token0: T0, token1: T1, fee: 500, tickSpacing: 10, sqrtPriceX96: 2n ** 96n, tick: 0 });
  chain.setBalance(T0, POOL, 1234n * 10n ** 18n);
  chain.setBalance(T1, POOL, 5678n * 10n ** 6n);
  chain.manager(NFPM, FACTORY);
  chain.position(NFPM, 3, VAULT, { token0: T0, token1: T1, fee: 3000, tickLower: -600, tickUpper: 600, liquidity: 10n ** 15n });
  chain.position(NFPM, 7, OWNER, { token0: T0, token1: T1, fee: 3000, tickLower: -120, tickUpper: 120, liquidity: 0n });
  chain.vault(VAULT, { owner: OWNER, pool: POOL, token0: T0, token1: T1, fee: 3000, tickSpacing: 60, paused: false, operator: addr(0x0e), policy: { serviceFeeBps: 200, maxPositions: 1, validUntil: 1790689192, allowSwap: true, allowSuccessor: false }, policyVersion: 1n, deployment: { factory: FACTORY, manager: NFPM, decimals0: 18, decimals1: 6 }, positionIds: [3], positions: new Map([[3n, { known: true, active: true, generation: 0n, parent: 0n, lower: -600, upper: 600, liquidity: 10n ** 15n }]]), capital: new Map([[T1, 25n]]) });
  chain.vault(addr(0x386), { owner: addr(0x9999), pool: POOL, token0: T0, token1: T1, fee: 3000, tickSpacing: 60, deployment: { factory: FACTORY, manager: NFPM } });
  chain.log({ address: FACTORY, blockNumber: 1_000_000, topics: [TOPIC.PoolCreated, topicAddress(T0), topicAddress(T1), topicUint(3000)], data: poolCreatedData(60, POOL) });
  return chain;
}

const clientOver = (chain) => createChainClient(ELYSIUM, fakeRuntime(chain));

test('a pool\'s state, balances and tokens come from one block, with that block and its time', async () => {
  const chain = world();
  const [pool] = await reads.readPools(clientOver(chain), ELYSIUM, [POOL]);
  assert.equal(pool.address, POOL);
  assert.equal(pool.factory, FACTORY);
  assert.deepEqual(pool.token0, { address: T0, symbol: 'TKA', decimals: 18 });
  assert.deepEqual(pool.token1, { address: T1, symbol: 'USDC', decimals: 6 });
  assert.equal(pool.fee, 3000);
  assert.equal(pool.slot0.sqrtPriceX96, 79228162514264337593543950336n);
  assert.equal(pool.liquidity, 10n ** 18n);
  assert.equal(pool.balance0, 1234n * 10n ** 18n);
  assert.equal(pool.balance1, 5678n * 10n ** 6n);
  assert.deepEqual(pool.stamp, { block: 1_500_000, timestamp: 1_790_100_000 });
  // The first read was one aggregate3 to Multicall3 with ArbSys and the timestamp among its sub-calls.
  const calls = chain.calls.flat().filter((call) => call.method === 'eth_call');
  assert.equal(calls[0].params[0].to, MULTICALL3);
});

test('a pool whose tokens are out of order, or that does not answer as a pool, is refused, not shown', async () => {
  const chain = world();
  chain.pool(addr(0x50), { factory: FACTORY, token0: T1, token1: T0, fee: 3000, tickSpacing: 60, sqrtPriceX96: 2n ** 96n, tick: 0 });
  await assert.rejects(reads.readPools(clientOver(chain), ELYSIUM, [addr(0x50)]), /invalid_pool/);
  await assert.rejects(reads.readPools(clientOver(chain), ELYSIUM, [addr(0x51)]), /invalid_pool/, 'an address with no code');
  await assert.rejects(reads.readPools(clientOver(chain), ELYSIUM, ['0x0000000000000000000000000000000000000000']), /invalid_pool/);
});

test('a factory\'s pools come from its PoolCreated logs', async () => {
  const created = await reads.discoverPools(clientOver(world()), FACTORY, 900_000);
  assert.deepEqual(created, [{ token0: T0, token1: T1, fee: 3000, tickSpacing: 60, pool: POOL }]);
});

test('a pool\'s activity counts its swaps and what was paid in of each token', async () => {
  const chain = world();
  const swap = (block, a0, a1) => chain.log({ address: POOL, blockNumber: block, topics: [TOPIC.Swap, topicAddress(addr(1)), topicAddress(addr(2))], data: swapData(a0, a1, 2n ** 96n, 1, 0) });
  swap(1_400_000, 100, -98);
  swap(1_450_000, -50, 52);
  swap(1_200_000, 999, -1);
  const activity = await reads.poolActivity(clientOver(chain), POOL, 1_300_000, 1_500_000);
  assert.deepEqual(activity, { swaps: 2, in0: 100n, in1: 52n, fromBlock: 1_300_000, toBlock: 1_500_000, first: 1_400_000, last: 1_450_000 });
});

test('a position: its manager record, owner, pool, both ticks and the pool\'s fee growth, at one block', async () => {
  const chain = world();
  chain.tick(POOL, -600, { feeGrowthOutside0X128: 1n, feeGrowthOutside1X128: 2n });
  chain.tick(POOL, 600, { feeGrowthOutside0X128: 3n, feeGrowthOutside1X128: 4n });
  const read = await reads.readPosition(clientOver(chain), ELYSIUM, NFPM, 3n);
  assert.equal(read.owner, VAULT);
  assert.equal(read.pool, POOL);
  assert.equal(read.position.tickLower, -600);
  assert.equal(read.lower.feeGrowthOutside0X128, 1n);
  assert.equal(read.upper.feeGrowthOutside1X128, 4n);
  assert.equal(read.feeGrowthGlobal0X128, 5n);
  assert.deepEqual(read.stamp, { block: 1_500_000, timestamp: 1_790_100_000 });
  await assert.rejects(reads.readPosition(clientOver(chain), ELYSIUM, NFPM, 99n), /invalid_position/, 'an NFT that does not exist');
});

test('a wallet\'s own position NFTs, and the vaults it owns among those known', async () => {
  const chain = world();
  assert.deepEqual(await reads.walletTokenIds(clientOver(chain), ELYSIUM, NFPM, OWNER), [7n]);
  assert.deepEqual(await reads.walletTokenIds(clientOver(chain), ELYSIUM, NFPM, addr(0x7777)), []);
  assert.deepEqual(await reads.vaultsOwnedBy(clientOver(chain), ELYSIUM, [VAULT, addr(0x386), addr(0x387)], OWNER.toUpperCase().replace('0X', '0x')), [VAULT]);
  assert.deepEqual(await reads.vaultsOwnedBy(clientOver(chain), ELYSIUM, [VAULT, VAULT], addr(0x9999)), []);
});

test('a vault: its settings, positions and capital at one block; one whose pool is not its tokens\' is refused', async () => {
  const chain = world();
  const vault = await reads.readVault(clientOver(chain), ELYSIUM, VAULT);
  assert.equal(vault.owner, OWNER);
  assert.equal(vault.pool, POOL);
  assert.equal(vault.paused, false);
  assert.deepEqual(vault.policy, { serviceFeeBps: 200, maxPositions: 1, validUntil: 1790689192, allowSwap: true, allowSuccessor: false });
  assert.equal(vault.deployment.manager, NFPM);
  assert.deepEqual(vault.positions.map((p) => [p.tokenId, p.state.active, p.state.liquidity]), [[3n, true, 10n ** 15n]]);
  assert.equal(vault.capital1, 25n);
  assert.equal(vault.capital0, 0n);
  chain.vault(addr(0x388), { owner: OWNER, pool: STRAY, token0: T0, token1: T1, fee: 3000, tickSpacing: 60, deployment: { factory: FACTORY, manager: NFPM } });
  await assert.rejects(reads.readVault(clientOver(chain), ELYSIUM, addr(0x388)), /invalid_vault_pool/);
  await assert.rejects(reads.readVault(clientOver(chain), ELYSIUM, OWNER), /invalid_vault/, 'an account that is no vault');
});

test('a vault\'s events, each with its block and the position it names', async () => {
  const chain = world();
  chain.log({ address: VAULT, blockNumber: 1_100_000, topics: [abi.VAULT_TOPIC.PositionOpened, topicUint(3), topicUint(0)], data: '0x' });
  chain.log({ address: VAULT, blockNumber: 1_200_000, topics: [abi.VAULT_TOPIC.Compounded, topicUint(1), topicUint(2), topicUint(3)], data: '0x' });
  chain.log({ address: VAULT, blockNumber: 1_300_000, topics: [abi.VAULT_TOPIC.Paused], data: '0x' });
  const events = await reads.vaultEvents(clientOver(chain), VAULT, 1_000_000, 'latest');
  assert.deepEqual(events.map((e) => [e.kind, e.block, e.tokenId]), [['PositionOpened', 1_100_000, 3n], ['Compounded', 1_200_000, 3n], ['Paused', 1_300_000, null]]);
});

test('the reads refuse what is not an address, and a read too large for one call', async () => {
  const client = clientOver(world());
  await assert.rejects(reads.readTokens(client, ELYSIUM, ['nope']), /invalid_token/);
  await assert.rejects(reads.vaultsOwnedBy(client, ELYSIUM, [], '0x0000000000000000000000000000000000000000'), /invalid_owner/);
  await assert.rejects(reads.aggregate(client, ELYSIUM, Array.from({ length: reads.MAX_SUBCALLS + 1 }, () => ({ target: T0, data: abi.V3_SELECTOR.decimals })), 'latest'), /invalid_call_count/);
  await assert.rejects(reads.readPools(client, ELYSIUM, Array.from({ length: 14 }, (_, i) => addr(0x1000 + i))), /invalid_pool_count/);
});
