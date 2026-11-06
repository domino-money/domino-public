// A chain with one Uniswap version (6 Nov 2026, Elysium: v4 only). The contracts take a zero v3 factory or v4
// PoolManager as that version absent; deploy.mjs deploys the common four and that version's components only, and the
// manifest records only them. Run: node --test scripts/v2/deploy-one-dex.test.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, viem, CONTRACT_NAMES, DEPLOY_ORDER, DEXES, ENABLED_CHAINS, MAX_TRANSACTION_GAS, checkDependencies, componentsFor,
  deployOrderFor, dependenciesFor, dependencyMap, explorerInput, manifestDexes, precomputeAddresses, prepareDeployment, profileDexes } from './deploy.mjs';
import { validateManifest } from './deploy-schema.mjs';
import { deployLocal } from './deploy-local.mjs';
import { startAnvil, installCreateX, stubRuntime } from './deploy-anvil.mjs';
import { compiled, parametersFor, roles } from './deploy-test-support.mjs';

const ZERO = '0x' + '0'.repeat(40), ZERO32 = '0x' + '0'.repeat(64);
const LIVE = ['robinhood-4663', 'base-8453', 'arbitrum-42161'].map(slug => JSON.parse(readFileSync(join(repoRoot, 'api-contracts/v2/chains', slug + '.json'), 'utf8')));
const without = (profile, dex) => ({ ...profile, uniswap: { ...profile.uniswap, [dex]: null } });
const read = async (rpc, to, signature, type) => viem.decodeAbiParameters([{ type }],
  await rpc('eth_call', [{ to, data: viem.toFunctionSelector(signature) }, 'latest']))[0];

test('each version brings its components and dependencies; both make today\'s sets, in their order', () => {
  assert.deepEqual(componentsFor(['v4']), ['registry', 'priceAnchor', 'autoExit', 'vaultSwap', 'vault.v4', 'vaultFactory.v4', 'zap.v4.steps', 'zap.v4', 'vaultExecutor.v4']);
  assert.deepEqual(deployOrderFor(['v4']), ['registry', 'priceAnchor', 'autoExit', 'vaultSwap', 'vault.v4', 'vaultFactory.v4', 'zap.v4.steps', 'zap.v4']);
  assert.deepEqual(dependenciesFor(['v4']), ['v4PoolManager', 'v4PositionManager', 'v4StateView', 'v4Quoter', 'universalRouter', 'permit2', 'wrappedNative']);
  assert.deepEqual(componentsFor(['v3']), ['registry', 'priceAnchor', 'autoExit', 'vaultSwap', 'vault.v3', 'vaultFactory.v3', 'zap.v3', 'vaultExecutor.v3']);
  assert.deepEqual(dependenciesFor(['v3']), ['v3Factory', 'v3PositionManager', 'v3Quoter', 'v3SwapRouter', 'universalRouter', 'permit2', 'wrappedNative']);
  assert.deepEqual(componentsFor(DEXES), Object.keys(CONTRACT_NAMES));
  assert.deepEqual(deployOrderFor(DEXES), [...DEPLOY_ORDER]);
  for (const profile of LIVE) {
    assert.deepEqual(profileDexes(profile), ['v3', 'v4'], profile.slug);
    assert.deepEqual(Object.keys(dependencyMap(profile)), dependenciesFor(DEXES), profile.slug);
  }
  assert.ok(ENABLED_CHAINS.includes(99901), 'Elysium mainnet');
});

test('a profile names each version or null, and one at least', () => {
  const base = LIVE[1];
  assert.deepEqual(profileDexes(without(base, 'v3')), ['v4']);
  assert.deepEqual(profileDexes(without(base, 'v4')), ['v3']);
  assert.throws(() => profileDexes(without(without(base, 'v3'), 'v4')), /profile_has_no_uniswap_version/);
  const { v3, ...noKey } = base.uniswap;
  assert.throws(() => profileDexes({ ...base, uniswap: noKey }), /invalid_profile_uniswap/);
  assert.throws(() => profileDexes({ ...base, uniswap: { ...base.uniswap, v3: [] } }), /invalid_profile_uniswap/);
  assert.throws(() => profileDexes({ ...base, uniswap: null }), /invalid_profile_uniswap/);
  assert.deepEqual(Object.keys(dependencyMap(without(base, 'v3'))), dependenciesFor(['v4']));
});

describe('a v4-only chain on a disposable EVM', () => {
  let anvil, result;
  before(async () => {
    anvil = await startAnvil();
    await installCreateX(anvil.rpc);
    result = await deployLocal({ rpcUrl: anvil.url, mode: 'offline', dexes: ['v4'], artifacts: compiled() });
  });
  after(async () => { await anvil?.stop(); });

  test('deploy.mjs sends the common four and v4\'s four, and verifies them', () => {
    const { bundle, manifest, transactionHashes } = result;
    assert.deepEqual(bundle.steps.map(s => s.component), deployOrderFor(['v4']));
    assert.deepEqual(Object.keys(transactionHashes).sort(), [...deployOrderFor(['v4'])].sort());
    assert.equal(manifest.status, 'verified');
    assert.deepEqual(manifestDexes(manifest), ['v4']);
    assert.deepEqual(Object.keys(manifest.contracts), componentsFor(['v4']));
    assert.deepEqual(Object.keys(manifest.dependencies), dependenciesFor(['v4']));
    assert.deepEqual(Object.keys(manifest.runtimeCodeHashes).sort(), [...componentsFor(['v4']), ...dependenciesFor(['v4'])].sort());
    assert.deepEqual(Object.keys(manifest.createx.salts), deployOrderFor(['v4']));
    assert.deepEqual(Object.keys(manifest.deploymentReceipts).sort(), [...deployOrderFor(['v4'])].sort());
    assert.deepEqual(manifest.contractNames, CONTRACT_NAMES);
    assert.equal(validateManifest(manifest), manifest);
  });

  test('its addresses are the ones every chain gets for the same components', () => {
    const all = precomputeAddresses(roles.deployer).contracts;
    for (const [name, address] of Object.entries(result.manifest.contracts)) assert.equal(address, all[name], name);
  });

  test('the anchor and the route take v3 as absent: zero factory, zero init code hash', async () => {
    const step = component => result.bundle.steps.find(s => s.component === component);
    const [registry, v3Factory, v3Hash, stateView, twap] = step('priceAnchor').constructorArguments;
    assert.deepEqual([registry, v3Factory, v3Hash, stateView, twap],
      [result.manifest.contracts.registry, ZERO, ZERO32, result.manifest.dependencies.v4StateView, 60]);
    for (const component of ['autoExit', 'vaultSwap']) {
      const route = step(component).constructorArguments[0];
      assert.deepEqual([route.v3Factory, route.v3PoolInitCodeHash, route.v4PoolManager], [ZERO, ZERO32, result.manifest.dependencies.v4PoolManager], component);
    }
    const c = result.manifest.contracts, rpc = anvil.rpc;
    assert.equal(await read(rpc, c.priceAnchor, 'v3Factory()', 'address'), ZERO);
    assert.equal(await read(rpc, c.priceAnchor, 'v3PoolInitCodeHash()', 'bytes32'), ZERO32);
    assert.equal((await read(rpc, c.priceAnchor, 'v4StateView()', 'address')).toLowerCase(), result.manifest.dependencies.v4StateView);
    // v3's components were never deployed here.
    const all = precomputeAddresses(roles.deployer);
    for (const name of ['vault.v3', 'vaultFactory.v3', 'zap.v3', 'vaultExecutor.v3']) assert.equal(await rpc('eth_getCode', [all.contracts[name], 'latest']), '0x', name);
  });

  test('a package for it never takes a v3 step, and explorers get its own components', () => {
    const profile = result.bundle.parameters.profile, order = deployOrderFor(['v4']);
    const parameters = parametersFor(profile, { steps: [...order], gasLimits: Object.fromEntries(order.map(c => [c, MAX_TRANSACTION_GAS.toString()])) });
    assert.throws(() => prepareDeployment({ ...parameters, steps: [...order, 'zap.v3'],
      gasLimits: { ...parameters.gasLimits, 'zap.v3': MAX_TRANSACTION_GAS.toString() } }, compiled()), /invalid_step_selection/);
    // First, where the order check lets any step through: only the chain's own set refuses it.
    const first = ['zap.v3', ...order.slice(1)];
    assert.throws(() => prepareDeployment({ ...parameters, steps: first,
      gasLimits: Object.fromEntries(first.map(c => [c, MAX_TRANSACTION_GAS.toString()])) }, compiled()), /invalid_step_selection/);
    assert.throws(() => prepareDeployment({ ...parameters, steps: order.slice(0, -1),
      gasLimits: Object.fromEntries(order.slice(0, -1).map(c => [c, MAX_TRANSACTION_GAS.toString()])) }, compiled()), /invalid_resume_reference/);
    const input = explorerInput(result.bundle, compiled());
    assert.deepEqual(Object.keys(input.components), componentsFor(['v4']));
    assert.equal(input.components['vaultExecutor.v4'].address, result.manifest.contracts['vaultExecutor.v4']);
  });

  test('the wrapped native is checked through v4\'s position manager when there is no v3', async () => {
    const profile = result.bundle.parameters.profile, rpc = anvil.rpc;
    await checkDependencies(profile, rpc);
    // Another address with the same stub code: the code hashes pass, PositionManager.WETH9() does not.
    const other = '0x000000000000000000000000000000000000e7f9';
    await rpc('anvil_setCode', [other, stubRuntime(profile)]);
    const codehash = viem.keccak256(stubRuntime(profile));
    const moved = { ...profile, wrappedNative: { ...profile.wrappedNative, address: viem.getAddress(other) },
      verification: { ...profile.verification, contracts: [...profile.verification.contracts, { name: 'other', address: other, codehash }] } };
    await assert.rejects(checkDependencies(moved, rpc), /wrapped_native_mismatch/);
  });
});

describe('a v3-only chain on a disposable EVM', () => {
  let anvil, result;
  before(async () => {
    anvil = await startAnvil();
    await installCreateX(anvil.rpc);
    result = await deployLocal({ rpcUrl: anvil.url, mode: 'offline', dexes: ['v3'], artifacts: compiled() });
  });
  after(async () => { await anvil?.stop(); });

  test('deploy.mjs sends the common four and v3\'s three; the anchor and the route take v4 as absent', async () => {
    const { bundle, manifest } = result;
    assert.deepEqual(bundle.steps.map(s => s.component), deployOrderFor(['v3']));
    assert.deepEqual(manifestDexes(manifest), ['v3']);
    assert.deepEqual(Object.keys(manifest.contracts), componentsFor(['v3']));
    const anchor = bundle.steps.find(s => s.component === 'priceAnchor').constructorArguments;
    assert.equal(anchor[3], ZERO);
    assert.equal(bundle.steps.find(s => s.component === 'vaultSwap').constructorArguments[0].v4PoolManager, ZERO);
    assert.equal(await read(anvil.rpc, manifest.contracts.priceAnchor, 'v4StateView()', 'address'), ZERO);
    assert.notEqual(await read(anvil.rpc, manifest.contracts.priceAnchor, 'v3PoolInitCodeHash()', 'bytes32'), ZERO32);
  });
});
