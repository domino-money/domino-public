/**
 * The on-chain checks before the session's first V2 write (spec F7 §7.3 point 4, §2.1), against a fake chain: each
 * component's runtime code against the manifest's code hash (`deployment_missing`, `deployment_code_changed`), once per
 * session per chain and component; each zap's position manager against the chain profile (`deployment_identity_changed`),
 * and its hook policy. The reads are injected, and the module names no wallet method.
 *
 * Changed on purpose (data) 2026-10-02 (Domino V2 rev2 §7): the CREATE3 prediction (`predict()` of backend/v2_manifest.py)
 * against the spec's §7.2 table and #302's manifests; checkV2Prediction's refusals; admitV2Contracts in a test build and,
 * with a stand-in pinned map, in a deployable one; the code check of the contracts a set reaches through its facts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { encodeAbiParameters, keccak256, toFunctionSelector } from 'viem';

const require = createRequire(import.meta.url);
const DEPLOYMENT = '../../.test-build/app/src/finance/v2/deployment.js';
const MANIFEST = '../../.test-build/app/src/v2/manifest.js';
const deployment = require(DEPLOYMENT);
const manifest = require(MANIFEST);
const fixtures = require('../../.test-build/app/src/v2/manifestFixtures.js');
const chains = require('../../.test-build/app/src/v2/chains.js');
const ZAP = JSON.parse(readFileSync(new URL('../../../api-contracts/v2/abi/IDominoZap.json', import.meta.url), 'utf8'));

const code = (expected) => (error) => {
  assert.equal(error.code, expected);
  assert.equal(error.message, expected);
  assert.ok(deployment.DEPLOYMENT_ERRORS.includes(expected));
  return true;
};

/** Runtime code whose keccak256 is what a contracts object can be built to expect. */
const RUNTIME = { zapV3: '0x6080604052600a', zapV4: '0x6080604052600b', registry: '0x6080604052600c', autoExit: '0x6080604052600d', vaultFactoryV3: '0x6080604052600e', vaultFactoryV4: '0x6080604052600f', priceAnchor: '0x60806040526010' };

/** The fixture contracts of a chain, with code hashes that RUNTIME satisfies (a test chain's deployment). */
function contractsOn(chainId) {
  const fixture = fixtures.fixtureContracts(chainId);
  const codeHashes = Object.fromEntries(Object.keys(fixture.codeHashes).map((name) => [name, keccak256(RUNTIME[name])]));
  return { ...fixture, codeHashes };
}

/** A fake chain's getCode: what each address holds, and every read it was asked. */
function chainCode(holdings) {
  const asked = [];
  const getCode = async (address) => {
    asked.push(address);
    return holdings[address] ?? '0x';
  };
  return { asked, getCode };
}
const holdingsOf = (contracts, overrides = {}) => ({ ...Object.fromEntries(Object.entries(contracts.addresses).map(([name, address]) => [address, RUNTIME[name]])), ...overrides });

test('the code of each component asked for must hash to the manifest\'s code hash, one read at a time', async () => {
  deployment.forgetV2DeploymentChecks();
  const contracts = contractsOn(8453);
  const chain = chainCode(holdingsOf(contracts));
  await deployment.verifyV2Code(chain.getCode, contracts, ['zapV4', 'registry']);
  assert.deepEqual(chain.asked, [contracts.addresses.zapV4, contracts.addresses.registry]);

  deployment.forgetV2DeploymentChecks();
  const empty = chainCode(holdingsOf(contracts, { [contracts.addresses.zapV3]: '0x' }));
  await assert.rejects(deployment.verifyV2Code(empty.getCode, contracts, ['zapV3']), code('deployment_missing'));
  const other = chainCode(holdingsOf(contracts, { [contracts.addresses.zapV3]: RUNTIME.zapV4 }));
  await assert.rejects(deployment.verifyV2Code(other.getCode, contracts, ['zapV3']), code('deployment_code_changed'));
  const upper = chainCode(holdingsOf(contracts, { [contracts.addresses.zapV3]: RUNTIME.zapV3.toUpperCase().replace('0X', '0x') }));
  await deployment.verifyV2Code(upper.getCode, contracts, ['zapV3']);
  // The first refusal stops the check: nothing after it is read.
  deployment.forgetV2DeploymentChecks();
  const first = chainCode(holdingsOf(contracts, { [contracts.addresses.autoExit]: '0x' }));
  await assert.rejects(deployment.verifyV2Code(first.getCode, contracts, ['autoExit', 'registry']), code('deployment_missing'));
  assert.deepEqual(first.asked, [contracts.addresses.autoExit]);
});

test('an unreadable reply, an unknown component or a failed read refuses, and none of them is remembered', async () => {
  deployment.forgetV2DeploymentChecks();
  const contracts = contractsOn(4663);
  for (const reply of [undefined, null, 42, '0x0', 'deadbeef', '0xzz']) {
    await assert.rejects(deployment.verifyV2Code(async () => reply, contracts, ['registry']), code('deployment_read_invalid'), String(reply));
  }
  await assert.rejects(deployment.verifyV2Code(async () => RUNTIME.registry, contracts, ['vault']), code('deployment_component_unknown'));
  await assert.rejects(deployment.verifyV2Code(async () => RUNTIME.registry, contracts, []), code('deployment_component_unknown'), 'nothing to check is never a pass');
  await assert.rejects(deployment.verifyV2Code(async () => { throw new Error('wallet_rpc_unavailable'); }, contracts, ['registry']), /wallet_rpc_unavailable/);
  const chain = chainCode(holdingsOf(contracts));
  await deployment.verifyV2Code(chain.getCode, contracts, ['registry']);
  assert.equal(chain.asked.length, 1, 'after the failures, the check reads again');
});

test('once per session per chain and component: the same check again is free, another chain is checked again', async () => {
  deployment.forgetV2DeploymentChecks();
  const robinhood = contractsOn(4663);
  const base = contractsOn(8453);
  assert.equal(base.addresses.zapV4, robinhood.addresses.zapV4, 'the same address on both chains (CREATE3)');
  const onRobinhood = chainCode(holdingsOf(robinhood));
  await deployment.verifyV2Code(onRobinhood.getCode, robinhood, ['zapV4']);
  await deployment.verifyV2Code(onRobinhood.getCode, robinhood, ['zapV4']);
  await Promise.all([deployment.verifyV2Code(onRobinhood.getCode, robinhood, ['zapV4', 'registry']), deployment.verifyV2Code(onRobinhood.getCode, robinhood, ['registry'])]);
  assert.deepEqual(onRobinhood.asked, [robinhood.addresses.zapV4, robinhood.addresses.registry], 'one read per component, even asked twice at once');
  const onBase = chainCode(holdingsOf(base));
  await deployment.verifyV2Code(onBase.getCode, base, ['zapV4']);
  assert.deepEqual(onBase.asked, [base.addresses.zapV4], 'the same address on another chain is another check');
  // A different expected hash for the same chain and component (another manifest) is another check too.
  const changed = { ...robinhood, codeHashes: { ...robinhood.codeHashes, zapV4: keccak256(RUNTIME.zapV3) } };
  await assert.rejects(deployment.verifyV2Code(onRobinhood.getCode, changed, ['zapV4']), code('deployment_code_changed'));
});

test('a fixture\'s contracts never pass in a build that says it is deployable', async () => {
  globalThis.__DOMINO_DEPLOYABLE__ = true;
  try {
    delete require.cache[require.resolve(DEPLOYMENT)];
    const deployable = require(DEPLOYMENT);
    const contracts = contractsOn(42161);
    assert.equal(contracts.fixture, true);
    await assert.rejects(deployable.verifyV2Code(chainCode(holdingsOf(contracts)).getCode, contracts, ['zapV3']), code('deployment_fixture_refused'));
    await assert.rejects(deployable.checkZapPositionManager(async () => '0x', contracts, chains.v2Chain(42161)), code('deployment_fixture_refused'));
    // A deployment's contracts are checked as usual there.
    await deployable.verifyV2Code(chainCode(holdingsOf(contracts)).getCode, { ...contracts, fixture: false }, ['zapV3']);
  } finally {
    delete globalThis.__DOMINO_DEPLOYABLE__;
    delete require.cache[require.resolve(DEPLOYMENT)];
  }
});

test('the zap\'s views are encoded from IDominoZap.json: positionManager() 0x791b98bc, hookedPoolsAllowed() 0x4c70f1f2', () => {
  assert.deepEqual({ ...deployment.ZAP_CALLS }, { positionManager: '0x791b98bc', hookedPoolsAllowed: '0x4c70f1f2' });
  assert.equal(ZAP.functions['positionManager()'], '0x791b98bc');
  assert.equal(ZAP.functions['hookedPoolsAllowed()'], '0x4c70f1f2');
  assert.equal(toFunctionSelector('positionManager()'), '0x791b98bc');
  assert.equal(toFunctionSelector('hookedPoolsAllowed()'), '0x4c70f1f2');
});

/** A fake chain's eth_call for the two zaps: each answers its own position manager and hook policy. */
function zapCalls(contracts, chain, { v3PositionManager, v4PositionManager, hooked = false } = {}) {
  const asked = [];
  const answers = {
    [contracts.addresses.zapV3]: { pm: v3PositionManager ?? chain.uniswap.v3.positionManager, hooked },
    [contracts.addresses.zapV4]: { pm: v4PositionManager ?? chain.uniswap.v4.positionManager, hooked },
  };
  const call = async (to, data) => {
    asked.push([to, data]);
    const zap = answers[to];
    if (!zap) return '0x';
    if (data === '0x791b98bc') return encodeAbiParameters([{ type: 'address' }], [zap.pm]);
    if (data === '0x4c70f1f2') return encodeAbiParameters([{ type: 'bool' }], [zap.hooked]);
    throw new Error(`unexpected call ${data}`);
  };
  return { asked, call };
}

test('each zap names the chain\'s own position manager: v3 NonfungiblePositionManager on zap.v3, v4 PositionManager on zap.v4', async () => {
  deployment.forgetV2DeploymentChecks();
  for (const chainId of [4663, 8453, 42161]) {
    const contracts = contractsOn(chainId);
    const chain = chains.v2Chain(chainId);
    const fake = zapCalls(contracts, chain);
    const result = await deployment.checkZapPositionManager(fake.call, contracts, chain);
    assert.deepEqual({ ...result[3] }, { dex: 3, zap: contracts.addresses.zapV3, positionManager: chain.uniswap.v3.positionManager, hookedPoolsAllowed: false });
    assert.deepEqual({ ...result[4] }, { dex: 4, zap: contracts.addresses.zapV4, positionManager: chain.uniswap.v4.positionManager, hookedPoolsAllowed: false });
    assert.deepEqual(fake.asked, [[contracts.addresses.zapV3, '0x791b98bc'], [contracts.addresses.zapV3, '0x4c70f1f2'], [contracts.addresses.zapV4, '0x791b98bc'], [contracts.addresses.zapV4, '0x4c70f1f2']]);
    // Once per session: asked again, nothing is read.
    await deployment.checkZapPositionManager(fake.call, contracts, chain);
    assert.equal(fake.asked.length, 4);
  }
});

test('a zap naming another position manager, an empty or unreadable reply, or another chain is refused; hooks are read as they are', async () => {
  const contracts = contractsOn(8453);
  const base = chains.v2Chain(8453);
  deployment.forgetV2DeploymentChecks();
  // zap.v3 naming the v4 PositionManager, zap.v4 naming another chain's.
  await assert.rejects(deployment.checkZapPositionManager(zapCalls(contracts, base, { v3PositionManager: base.uniswap.v4.positionManager }).call, contracts, base, [3]), code('deployment_identity_changed'));
  await assert.rejects(deployment.checkZapPositionManager(zapCalls(contracts, base, { v4PositionManager: chains.v2Chain(42161).uniswap.v4.positionManager }).call, contracts, base, [4]), code('deployment_identity_changed'));
  await assert.rejects(deployment.checkZapPositionManager(async () => '0x', contracts, base, [4]), code('deployment_missing'));
  await assert.rejects(deployment.checkZapPositionManager(async () => '0x1234', contracts, base, [4]), code('deployment_read_invalid'));
  await assert.rejects(deployment.checkZapPositionManager(async () => 7, contracts, base, [4]), code('deployment_read_invalid'));
  await assert.rejects(deployment.checkZapPositionManager(zapCalls(contracts, base).call, contracts, chains.v2Chain(4663)), code('deployment_chain_mismatch'));
  // None of those was remembered; the owner turning hooked pools on is read as it is.
  const hooked = await deployment.checkZapPositionManager(zapCalls(contracts, base, { hooked: true }).call, contracts, base, [4]);
  assert.equal(hooked[4].hookedPoolsAllowed, true);
  assert.equal(hooked[3], undefined, 'only the zaps asked for');
});

// ---------------------------------------------------------------------------
// The CREATE3 prediction and the manifest's facts (Changed on purpose (data) 2026-10-02, Domino V2 rev2 §7)
// ---------------------------------------------------------------------------

/** Spec rev2 §7.2: the addresses predicted for the owner's deployer, the same on 4663, 8453 and 42161. */
const PRODUCTION_DEPLOYER = '0x706627E3E75b0603c4B6f9a1eBBfc635dA712747';
// Changed on purpose (data) 2026-10-03 (#302 merged): the rehearsal fixtures carry the owner's deployer, so their
// addresses ARE the spec's table; "other" facts come from another deployer (the old rehearsal's test one).
const OTHER_DEPLOYER = '0x0149af4613aa457765d23a38d62685a9623aef35';
const SPEC_TABLE = {
  registry: '0x25d4f013ecff3790e384e16ca9951bba6cd715fa',
  priceAnchor: '0x8c1edc4280d9533f6336f760380ba329e1f81f43',
  autoExit: '0x6109fc514a88a8e85e6e5c863238ddba9a98be36',
  vaultSwap: '0xbf22a36bbb419846e073cf0c6c729f669d7f348a',
  'vault.v3': '0xd55c0f5ff8ad1ded828edb36be77e0f3677ad4a4',
  'vault.v4': '0xa3ff8d74e4ec4a19f35d92b7eec852ba6f7e2bbb',
  'vaultFactory.v3': '0xa7dfb61a6597d09742cb7f9a8780c9c74ebc34f4',
  'vaultFactory.v4': '0xc71a561853514efc2271f1d10c13ec95834792ba',
  'zap.v4.steps': '0x355b0997d5e04392862a8e8d21d911851b2eefbe',
  'zap.v3': '0xe30d7e07a67198c45d4c7b67d8423cbb6c7ea5a0',
  'zap.v4': '0x376b92929bbe778c6dd64e8d73f8688686288e8a',
  'vaultExecutor.v3': '0xd8d3bf832b234855fee2ac36ac4803aa7f9adca9',
  'vaultExecutor.v4': '0xf3f68d8461c2071e2b8d88a60ce64f527f1d6639',
};
const fixtureRaw = (chainId = 4663) => structuredClone(fixtures.FIXTURE_MANIFESTS[chainId]);
const local302 = () => JSON.parse(readFileSync(new URL('./support/manifest-302-local-test.json', import.meta.url), 'utf8'));
/** A fixture set's facts with one field replaced (facts are frozen: a new object). */
const withFacts = (contracts, change) => ({ ...contracts, deployment: { ...contracts.deployment, ...change(contracts.deployment) } });

test('the CREATE3 prediction for the owner\'s deployer is the spec\'s §7.2 table, address for address, in any case of the input', () => {
  for (const deployer of [PRODUCTION_DEPLOYER, PRODUCTION_DEPLOYER.toLowerCase()]) {
    const predicted = deployment.predictV2Deployment(deployer);
    assert.deepEqual({ ...predicted.contracts }, SPEC_TABLE);
    assert.deepEqual(Object.keys(predicted.salts), [...manifest.DEPLOY_ORDER]);
    for (const [component, salt] of Object.entries(predicted.salts)) {
      assert.equal(salt, `${PRODUCTION_DEPLOYER.toLowerCase()}00${keccak256(`0x${Buffer.from(`domino.v2.${component}`).toString('hex')}`).slice(2, 24)}`);
      assert.equal(predicted.guardedSalts[component], keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [PRODUCTION_DEPLOYER.toLowerCase(), salt])));
    }
  }
  assert.equal(deployment.componentSalt(PRODUCTION_DEPLOYER, 'registry').length, 66);
});

const otherTable = () => deployment.predictV2Deployment(OTHER_DEPLOYER).contracts;

test('the prediction for #302\'s deployers is their manifests\' own: the rehearsal\'s test deployer and Anvil #0 of the local run', () => {
  for (const raw of [fixtureRaw(4663), fixtureRaw(8453), fixtureRaw(42161), local302()]) {
    const predicted = deployment.predictV2Deployment(raw.roles.deployer);
    assert.deepEqual({ ...predicted.contracts }, raw.contracts);
    assert.deepEqual({ ...predicted.salts }, raw.createx.salts);
    assert.deepEqual({ ...predicted.guardedSalts }, raw.createx.guardedSalts);
    deployment.checkV2Prediction(manifest.manifestFacts(manifest.checkV2Manifest(raw), 'local-test'));
  }
  assert.deepEqual({ ...deployment.predictV2Deployment(fixtureRaw().roles.deployer).contracts }, SPEC_TABLE, "the merged rehearsal's deployer is the owner's: the production addresses (spec §7.2)");
  assert.notDeepEqual({ ...otherTable() }, SPEC_TABLE, 'another deployer never yields them');
});

test('checkV2Prediction refuses facts that are not the prediction: an address, an executor, a salt, CreateX, the source tree', () => {
  const set = fixtures.fixtureContracts(4663);
  deployment.checkV2Prediction(set.deployment);
  const refusedWith = (change, expected) => assert.throws(() => deployment.checkV2Prediction(withFacts(set, change).deployment), code(expected));
  refusedWith((f) => ({ contracts: { ...f.contracts, 'zap.v3': otherTable()['zap.v3'] } }), 'deployment_addresses_changed');
  refusedWith((f) => ({ contracts: { ...f.contracts, 'vaultExecutor.v3': f.contracts['vaultExecutor.v4'], 'vaultExecutor.v4': f.contracts['vaultExecutor.v3'] } }), 'deployment_addresses_changed');
  refusedWith(() => ({ deployer: OTHER_DEPLOYER }), 'deployment_addresses_changed');
  refusedWith(() => ({ deployer: `0x${OTHER_DEPLOYER.slice(2).toUpperCase()}` }), 'deployment_addresses_changed');
  refusedWith(() => ({ createx: '0x4e59b44847b379578588920ca78fbf26c0b4956c' }), 'deployment_addresses_changed');
  refusedWith((f) => ({ salts: { ...f.salts, registry: f.salts.priceAnchor } }), 'deployment_salts_changed');
  refusedWith((f) => ({ guardedSalts: { ...f.guardedSalts, 'zap.v4': f.salts['zap.v4'] } }), 'deployment_salts_changed');
  refusedWith((f) => ({ sourceHashes: { ...f.sourceHashes, 'src/v2/Extra.sol': 'a'.repeat(64) } }), 'deployment_source_tree_changed');
  refusedWith(() => ({ sourceTreeSha256: '0'.repeat(64) }), 'deployment_source_tree_changed');
  refusedWith((f) => ({ codeHashes: { ...f.codeHashes, 'vault.v4': '0x12' } }), 'deployment_addresses_changed');
  assert.throws(() => deployment.checkV2Prediction(undefined), code('deployment_addresses_changed'));
});

test('admitV2Contracts in a test build: a fixture set passes the prediction; a set whose facts or components were changed does not; a hand-built set is taken', () => {
  for (const chainId of [4663, 8453, 42161]) deployment.admitV2Contracts(chains.v2Chain(chainId), fixtures.fixtureContracts(chainId));
  const set = fixtures.fixtureContracts(8453);
  const base = chains.v2Chain(8453);
  assert.throws(() => deployment.admitV2Contracts(base, withFacts(set, (f) => ({ contracts: { ...f.contracts, autoExit: otherTable().autoExit } }))), code('deployment_addresses_changed'));
  assert.throws(() => deployment.admitV2Contracts(base, { ...set, addresses: { ...set.addresses, zapV4: set.addresses.zapV3 } }), code('deployment_addresses_changed'));
  assert.throws(() => deployment.admitV2Contracts(base, { ...set, codeHashes: { ...set.codeHashes, priceAnchor: set.codeHashes.registry } }), code('deployment_addresses_changed'));
  assert.throws(() => deployment.admitV2Contracts(base, fixtures.fixtureContracts(4663)), code('deployment_chain_mismatch'));
  const { deployment: _facts, ...handBuilt } = set;
  void _facts;
  deployment.admitV2Contracts(base, handBuilt);
});

test('the code check reaches priceAnchor and, through a set\'s facts, the executors, the vault implementations, the swap module and the v4 steps', async () => {
  deployment.forgetV2DeploymentChecks();
  const set = fixtures.fixtureContracts(42161);
  const EXTRA = { 'vaultExecutor.v3': '0x60806040526011', 'vault.v3': '0x60806040526012', vaultSwap: '0x60806040526013', 'zap.v4.steps': '0x60806040526014' };
  const tested = withFacts({ ...set, codeHashes: { ...set.codeHashes, priceAnchor: keccak256(RUNTIME.priceAnchor) } }, (f) => ({ codeHashes: { ...f.codeHashes, ...Object.fromEntries(Object.entries(EXTRA).map(([name, bytes]) => [name, keccak256(bytes)])) } }));
  const holdings = { [set.addresses.priceAnchor]: RUNTIME.priceAnchor, ...Object.fromEntries(Object.entries(EXTRA).map(([name, bytes]) => [set.deployment.contracts[name], bytes])) };
  const chain = chainCode(holdings);
  await deployment.verifyV2Code(chain.getCode, tested, ['priceAnchor', 'vaultExecutorV3', 'vaultV3', 'vaultSwap', 'zapV4Steps']);
  assert.deepEqual(chain.asked, [set.addresses.priceAnchor, set.deployment.contracts['vaultExecutor.v3'], set.deployment.contracts['vault.v3'], set.deployment.contracts.vaultSwap, set.deployment.contracts['zap.v4.steps']]);
  // Another executor's code at the v3 executor's address is refused; so is a component with nothing deployed.
  deployment.forgetV2DeploymentChecks();
  await assert.rejects(deployment.verifyV2Code(chainCode({ ...holdings, [set.deployment.contracts['vaultExecutor.v3']]: EXTRA['vault.v3'] }).getCode, tested, ['vaultExecutorV3']), code('deployment_code_changed'));
  await assert.rejects(deployment.verifyV2Code(chainCode(holdings).getCode, tested, ['vaultExecutorV4']), code('deployment_missing'), 'nothing at the v4 executor');
  // Facts that are not the prediction are refused before anything is read; a set without facts has no such contract.
  const forged = withFacts(tested, (f) => ({ contracts: { ...f.contracts, 'vaultExecutor.v3': set.addresses.zapV3 } }));
  const nothing = chainCode(holdings);
  await assert.rejects(deployment.verifyV2Code(nothing.getCode, forged, ['vaultExecutorV3']), code('deployment_addresses_changed'));
  assert.equal(nothing.asked.length, 0);
  const { deployment: _facts, ...handBuilt } = tested;
  void _facts;
  await assert.rejects(deployment.verifyV2Code(nothing.getCode, handBuilt, ['vaultExecutorV3']), code('deployment_component_unknown'));
  await assert.rejects(deployment.verifyV2Code(nothing.getCode, handBuilt, ['vault.v3']), code('deployment_component_unknown'), 'the app\'s names only');
});

test('a deployable build takes exactly the pinned production set (a stand-in pinned map), re-runs its prediction, and reaches other contracts through the PINNED facts only', async () => {
  const MANIFEST_PATH = require.resolve(MANIFEST);
  const DEPLOYMENT_PATH = require.resolve(DEPLOYMENT);
  const robinhood = chains.v2Chain(4663);
  globalThis.__DOMINO_DEPLOYABLE__ = true;
  delete require.cache[MANIFEST_PATH];
  delete require.cache[DEPLOYMENT_PATH];
  try {
    const deployable = require(DEPLOYMENT);
    const pinnedManifest = require(MANIFEST);
    // The fixture shaped as a production deployment (public chain, finalized, roles off the public mnemonic).
    const raw = fixtureRaw(4663);
    raw.environment = 'public-chain-preparation';
    raw.verification.blockTag = 'finalized';
    Object.assign(raw.roles, { governance: '0x0000000000000000000000000000000000100001', guardian: '0x0000000000000000000000000000000000100002', operator: '0x0000000000000000000000000000000000100003', publisher: '0x0000000000000000000000000000000000100004' });
    const pinned = pinnedManifest.parseV2Manifest(raw, 4663);
    assert.equal(pinned.fixture, false);
    // Nothing pinned: no client at all.
    assert.throws(() => deployable.admitV2Contracts(robinhood, pinned), code('deployment_not_pinned'));
    let current = pinned;
    pinnedManifest.v2Availability = (chainId) => (chainId === 4663 ? { available: true, contracts: current } : { available: false, copy: '', reason: 'not_deployed' });
    deployable.admitV2Contracts(robinhood, pinned);
    deployable.admitV2Contracts(robinhood, structuredClone(pinned));
    const { deployment: _facts, ...withoutFacts } = pinned;
    void _facts;
    deployable.admitV2Contracts(robinhood, withoutFacts);
    assert.throws(() => deployable.admitV2Contracts(robinhood, { ...pinned, addresses: { ...pinned.addresses, zapV3: otherTable()['zap.v3'] } }), code('deployment_not_pinned'));
    assert.throws(() => deployable.admitV2Contracts(robinhood, withFacts(pinned, (f) => ({ releaseTag: `${f.releaseTag}-2` }))), code('deployment_not_pinned'), 'other facts');
    assert.throws(() => deployable.admitV2Contracts(robinhood, fixtures.fixtureContracts(4663)), code('deployment_fixture_refused'));
    assert.throws(() => deployable.admitV2Contracts(chains.v2Chain(8453), { ...pinned, chainId: 8453 }), code('deployment_not_pinned'));
    // The pinned manifest itself is held to the prediction before a set is taken.
    current = withFacts(pinned, (f) => ({ contracts: { ...f.contracts, 'vaultExecutor.v3': otherTable()['vaultExecutor.v3'] } }));
    assert.throws(() => deployable.admitV2Contracts(robinhood, current), code('deployment_addresses_changed'));
    current = pinned;
    // A set that brings its own (forged) facts: the code check reads the PINNED executor's address.
    const forged = withFacts(pinned, (f) => ({ contracts: { ...f.contracts, 'vaultExecutor.v3': otherTable()['vaultExecutor.v3'] } }));
    const asked = [];
    await assert.rejects(deployable.verifyV2Code(async (address) => { asked.push(address); return '0x'; }, forged, ['vaultExecutorV3']), code('deployment_missing'));
    assert.deepEqual(asked, [pinned.deployment.contracts['vaultExecutor.v3']]);
  } finally {
    delete globalThis.__DOMINO_DEPLOYABLE__;
    delete require.cache[MANIFEST_PATH];
    delete require.cache[DEPLOYMENT_PATH];
  }
});

test('deployment.ts names no wallet method and no URL, and its reads are injected', () => {
  const source = readFileSync(new URL('../../src/finance/v2/deployment.ts', import.meta.url), 'utf8');
  const body = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(body, /['"`](eth_|wallet_|personal_)\w*['"`]/, 'no wallet method');
  assert.doesNotMatch(source, /eth_sendTransaction|eth_sendRawTransaction|writeContract|sendCalls|eth_signTypedData|\.approve\(|127\.0\.0\.1/);
  assert.doesNotMatch(source, /https?:\/\//);
  assert.doesNotMatch(body, /\b(request|fetch|createPublicClient|http)\s*\(/, 'it asks nothing itself');
});
