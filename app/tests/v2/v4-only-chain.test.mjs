/**
 * A V2 chain with Uniswap v4 alone (added 2026-11-06, Elysium readiness; rugged97's #459 and his "delta 2" of 6 Nov:
 * Elysium mainnet 99901 has Uniswap v4 only, its profile names `uniswap.v3` null and its deployment registers nine
 * contracts instead of 13). Nothing of it is served today: the app's chains stay Robinhood Chain, Base and Arbitrum One.
 * This runs the test-only fixture tests/fixtures/v2-chains/elysium-99901.json (rugged97's backend/tests/v2_hype_chain.py
 * document(dexes=(4,)) on the id 99901) through the app's own parsers, and proves:
 *   - the chain model takes a profile with `uniswap.v3` null only for a row that says v4 alone (Elysium's facts), and
 *     Robinhood Chain, Base and Arbitrum One still require v3 and v4 and load as before;
 *   - a nine-component manifest (no v3 contracts, salts, receipts, dependencies or code hashes; contractNames still the
 *     13) is accepted for that chain, refused for 8453, and every live chain still requires its 13;
 *   - the money clients' code checks never reach a v3 component of such a set.
 * tests/v2/v4-only-screens.test.mjs runs the same chain through the screens' modules.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { encodeAbiParameters, keccak256 } from 'viem';
import { V3_CONTRACTS, V3_DEPENDENCIES, V3_DEPLOYED, v4OnlyManifest, withoutV3 } from './support/v4-only.mjs';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const chains = require(`${BUILD}v2/chains.js`);
const manifest = require(`${BUILD}v2/manifest.js`);
const fixtures = require(`${BUILD}v2/manifestFixtures.js`);
const deployment = require(`${BUILD}finance/v2/deployment.js`);
const vault = require(`${BUILD}finance/v2/vault.js`);
const { ELYSIUM } = require(`${BUILD}v2/elysium.js`);
const identity = require(`${BUILD}config/chainIdentity.js`);

const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const listed = ['robinhood-4663', 'base-8453', 'arbitrum-42161'].map((name) => json(`../../../api-contracts/v2/chains/${name}.json`));
const profile = json('../fixtures/v2-chains/elysium-99901.json');
const both = json('../fixtures/v2-chains/elysium-99801.json');
const FILES = { 4663: 'manifest.robinhood-4663.fixture.json', 8453: 'manifest.base-8453.fixture.json', 42161: 'manifest.arbitrum-42161.fixture.json' };
const fixture = (chainId) => json(`../../src/v2/fixtures/${FILES[chainId]}`);

const ID = 99901;
const ROW = { slug: ELYSIUM.slug, name: ELYSIUM.name, nativeSymbol: ELYSIUM.nativeSymbol, wrappedSymbol: ELYSIUM.wrappedSymbol, finalityMinutes: ELYSIUM.finalityMinutes, dexes: ELYSIUM.dexes };
const FACTS = { ...chains.V2_CHAIN_FACTS, [ID]: ROW };
const IDS = [...identity.V2_CHAIN_IDS, ID];
const SERVED = chains.chainsFrom([...listed, profile], IDS, FACTS);
const v4only = SERVED[3];
const ENABLED = [...manifest.ENABLED_CHAINS, ID];

const NINE = ['registry', 'priceAnchor', 'autoExit', 'vaultSwap', 'vault.v4', 'vaultFactory.v4', 'zap.v4.steps', 'zap.v4', 'vaultExecutor.v4'];

/** Arbitrum One's fork-rehearsal manifest moved to the fixture chain (./support/v4-only.mjs, shared with v4-only-screens). */
const elysiumManifest = () => v4OnlyManifest(fixture(42161), profile, ID);
const code = (expected) => (error) => { assert.equal(error.code ?? error.message, expected, `${error.code ?? error.message} (${error.detail ?? ''})`); return true; };
const bind = (raw, admission = 'fork-rehearsal') => manifest.bindV2Deployment(raw, v4only, profile, admission);
const fullCheck = (raw, enabled = ENABLED) => deployment.checkV2Prediction(manifest.manifestFacts(manifest.checkV2Manifest(raw, enabled), 'local-test'));

// ---------------------------------------------------------------------------
// The chain model
// ---------------------------------------------------------------------------

test('a profile with uniswap.v3 null loads for a row that says v4 alone: HYPE native, v4 only, no bridge', () => {
  assert.deepEqual([v4only.chainId, v4only.slug, v4only.name, v4only.nativeSymbol, v4only.wrappedNative.symbol, v4only.nativeUsd], [ID, 'elysium', 'Elysium', 'HYPE', 'WHYPE', 'pool']);
  assert.deepEqual([...ELYSIUM.dexes], [4], 'Elysium\'s facts say v4 alone');
  assert.deepEqual([...v4only.dexes], [4]);
  assert.equal(v4only.uniswap.v3, null);
  assert.equal(v4only.uniswap.v4.positionManager, profile.uniswap.v4.positionManager.toLowerCase());
  assert.deepEqual([v4only.verifiedCode.v3Factory, v4only.verifiedCode.v3PositionManager], [null, null]);
  assert.match(v4only.verifiedCode.v4PositionManager, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(v4only.bridgeProviders, [], 'no bridge serves it: Bring funds stays off there');
  // The one question, and the helpers that refuse a version the chain lacks.
  assert.deepEqual([chains.hasDex(v4only, 3), chains.hasDex(v4only, 4), chains.hasDex(v4only, 2), chains.hasDex(v4only, '4')], [false, true, false, false]);
  assert.equal(chains.v3TickSpacing(v4only, 500), null);
  assert.throws(() => chains.v3Of(v4only), /dex_not_on_chain/);
  assert.throws(() => chains.positionManagerOf(v4only, 3), /dex_not_on_chain/);
  assert.equal(chains.positionManagerOf(v4only, 4), v4only.uniswap.v4.positionManager);
  assert.deepEqual([chains.positionManagerOrNull(v4only, 3), chains.positionManagerOrNull(v4only, 4)], [null, v4only.uniswap.v4.positionManager]);
  assert.deepEqual({ ...chains.positionManagers(v4only) }, { 4: v4only.uniswap.v4.positionManager });
  // In the app as it is, it is served nowhere.
  assert.deepEqual([chains.isV2ChainId(ID), chains.chainHasDex(ID, 4), chains.chainHasDex(ID, 3)], [false, false, false]);
});

// Added 2026-11-06 (review of the v4-only build, F4): the fixture's HYPE pool is one rugged97's ChainProfile accepts
// (backend/v2_chains.py _checked_native_pool): v4, the native currency against the chain's stable, and its poolId the
// hash of its own hookless key. A hand-typed id would be refused there as native_usd_pool_invalid.
test('the fixture\'s HYPE/USDC pool is the one its key names, as the backend checks it', () => {
  const pool = profile.gasPrice.poolNativeUsd;
  const lower = (address) => address.toLowerCase();
  const stable = profile.chargeCurrencies.filter((currency) => currency.rank === 1).map((currency) => lower(currency.address)).sort()[0];
  assert.equal(pool.dex, 4);
  assert.equal(lower(pool.stable), stable, 'the chain\'s stable');
  assert.ok([lower(profile.wrappedNative.address), '0x0000000000000000000000000000000000000000'].includes(lower(pool.currency)), 'HYPE or WHYPE');
  const [currency0, currency1] = [lower(pool.currency), lower(pool.stable)].sort();
  const key = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [currency0, currency1, pool.fee, pool.tickSpacing, '0x0000000000000000000000000000000000000000']);
  assert.equal(pool.poolId, keccak256(key));
  assert.equal(pool.poolId, '0x8ac5fc556e12075ac9d05b5df79f600b845394459d85dff613d0074478825897');
});

test('Robinhood Chain, Base and Arbitrum One still require v3 and v4, and load as before', () => {
  for (const chain of chains.V2_CHAINS) {
    assert.deepEqual([...chain.dexes], [3, 4], chain.name);
    assert.deepEqual([...chains.V2_CHAIN_FACTS[chain.chainId].dexes], [3, 4], chain.name);
    assert.ok(chain.uniswap.v3 && chain.verifiedCode.v3Factory && chain.verifiedCode.v3PositionManager, chain.name);
    assert.deepEqual([chains.hasDex(chain, 3), chains.hasDex(chain, 4), chains.chainHasDex(chain.chainId, 3), chains.chainHasDex(chain.chainId, 4)], [true, true, true, true]);
    assert.equal(chains.positionManagerOf(chain, 3), chain.uniswap.v3.positionManager);
    assert.deepEqual({ ...chains.positionManagers(chain) }, { 3: chain.uniswap.v3.positionManager, 4: chain.uniswap.v4.positionManager });
  }
  // The same objects as a load of the three profiles alone.
  assert.deepEqual(chains.chainsFrom(listed, identity.V2_CHAIN_IDS, chains.V2_CHAIN_FACTS), chains.V2_CHAINS);
  // Each of them with v3 null, or without its v3 key, or without v4, is refused: a live chain never drops a version.
  for (const [index, raw] of listed.entries()) {
    const at = (change) => listed.map((one, i) => (i === index ? change(structuredClone(one)) : one));
    for (const change of [(p) => ({ ...p, uniswap: { ...p.uniswap, v3: null } }), (p) => { delete p.uniswap.v3; return p; }, (p) => ({ ...p, uniswap: { ...p.uniswap, v4: null } })]) {
      assert.throws(() => chains.chainsFrom(at(change), identity.V2_CHAIN_IDS, chains.V2_CHAIN_FACTS), new RegExp(`${raw.slug} uniswap versions`));
    }
  }
});

test('the versions are the row\'s and the profile\'s together: neither alone drops v3', () => {
  // The v4-only profile under a row without versions (both, as every row but Elysium's) is refused.
  const { dexes: _dexes, ...plain } = ROW;
  assert.throws(() => chains.chainsFrom([...listed, profile], IDS, { ...chains.V2_CHAIN_FACTS, [ID]: plain }), /elysium uniswap versions/);
  // A profile with both versions under Elysium's v4-only row is refused too.
  assert.throws(() => chains.chainsFrom([...listed, { ...both, chainId: ID }], IDS, FACTS), /elysium uniswap versions/);
  // A profile with neither, or v3 alone, is never served.
  assert.throws(() => chains.chainsFrom([...listed, { ...profile, uniswap: { ...profile.uniswap, v4: null } }], IDS, FACTS), /elysium uniswap versions/);
  // Extra v3 tiers on a chain without v3 are refused (Base's row keeps its own).
  assert.throws(() => chains.chainsFrom([...listed, profile], IDS, { ...FACTS, [ID]: { ...ROW, extraV3Tiers: { 200: 4 } } }), /elysium v3 tiers/);
  // The synthetic HYPE chain with both versions still loads under a row without versions (tests/v2/hype-chain.test.mjs).
  assert.deepEqual([...chains.chainsFrom([...listed, both], [...identity.V2_CHAIN_IDS, 99801], { ...chains.V2_CHAIN_FACTS, 99801: plain })[3].dexes], [3, 4]);
});

// ---------------------------------------------------------------------------
// The deployment manifest
// ---------------------------------------------------------------------------

test('the version helpers are the backend\'s: both give today\'s 13, 11 and 11; v4 alone 9, 8 and 7', () => {
  assert.deepEqual([...manifest.componentsFor([3, 4])], [...manifest.MANIFEST_CONTRACTS]);
  assert.deepEqual([...manifest.deployOrderFor([3, 4])], [...manifest.DEPLOY_ORDER]);
  assert.deepEqual([...manifest.dependenciesFor([3, 4])], [...manifest.MANIFEST_DEPENDENCIES]);
  assert.deepEqual([...manifest.componentsFor([4])], NINE);
  assert.deepEqual([...manifest.deployOrderFor([4])], NINE.filter((name) => name !== 'vaultExecutor.v4'));
  assert.deepEqual([...manifest.dependenciesFor([4])], ['v4PoolManager', 'v4PositionManager', 'v4StateView', 'v4Quoter', 'universalRouter', 'permit2', 'wrappedNative']);
  assert.deepEqual([manifest.manifestDexes(fixture(4663)), manifest.manifestDexes(elysiumManifest()), manifest.manifestDexes({}), manifest.manifestDexes(null)], [[3, 4], [4], [], []]);
});

test('a nine-component manifest is accepted for the chain whose profile has no v3: four components, no v3 one', () => {
  const m = elysiumManifest();
  assert.deepEqual(Object.keys(m.contracts).sort(), [...NINE].sort());
  assert.deepEqual(Object.keys(m.contractNames), Object.keys(manifest.CONTRACT_NAMES), 'contractNames still names the 13');
  assert.equal(Object.keys(m.dependencies).length, 7);
  fullCheck(m);
  const set = bind(m);
  assert.deepEqual(Object.keys(set.addresses).sort(), ['autoExit', 'priceAnchor', 'registry', 'vaultFactoryV4', 'zapV4']);
  assert.deepEqual(Object.keys(set.codeHashes).sort(), Object.keys(set.addresses).sort());
  assert.equal(set.fixture, true);
  assert.deepEqual(Object.keys(set.deployment.contracts).sort(), [...NINE].sort());
  assert.equal(Object.keys(set.deployment.salts).length, 8);
  // The same CREATE3 addresses as on the three live chains.
  const live = fixtures.fixtureContracts(42161);
  for (const name of ['registry', 'priceAnchor', 'autoExit', 'zapV4', 'vaultFactoryV4']) assert.equal(set.addresses[name], live.addresses[name], name);
  deployment.checkV2Prediction(set.deployment);
  // Production-shaped, it passes the production admission there too.
  const production = structuredClone(m);
  production.environment = 'public-chain-preparation';
  production.verification.blockTag = 'finalized';
  Object.assign(production.roles, { governance: '0x0000000000000000000000000000000000100001', guardian: '0x0000000000000000000000000000000000100002', operator: '0x0000000000000000000000000000000000100003', publisher: '0x0000000000000000000000000000000000100004' });
  assert.equal(bind(production, 'production').fixture, false);
  // Today's structural check alone (the app's enabled chains) does not take a chain the app does not serve.
  assert.throws(() => manifest.checkV2Manifest(m), code('manifest_chain_not_enabled'));
});

test('the nine-component shape is held as tightly as the 13: no part of v3 left, contractNames still the 13', () => {
  const refusedFor = (edit, expected) => {
    const m = elysiumManifest();
    edit(m);
    assert.throws(() => fullCheck(m), code(expected));
    assert.throws(() => bind(m), code(expected));
  };
  const all = fixture(42161);
  refusedFor((m) => { m.contractNames = Object.fromEntries(Object.entries(m.contractNames).filter(([name]) => !V3_CONTRACTS.includes(name))); }, 'manifest_contracts_or_policy_changed');
  refusedFor((m) => { m.contracts['zap.v3'] = all.contracts['zap.v3']; }, 'manifest_addresses_invalid');
  refusedFor((m) => { delete m.contracts['vaultExecutor.v4']; }, 'manifest_addresses_invalid');
  refusedFor((m) => { m.dependencies.v3Factory = all.dependencies.v3Factory; }, 'manifest_dependencies_invalid');
  refusedFor((m) => { m.createx.salts['zap.v3'] = all.createx.salts['zap.v3']; }, 'manifest_createx_changed');
  refusedFor((m) => { m.runtimeCodeHashes['vault.v3'] = all.runtimeCodeHashes['vault.v3']; }, 'manifest_codehash_keys_invalid');
  refusedFor((m) => { m.runtimeCodeHashes.v3Quoter = all.runtimeCodeHashes.v3Quoter; }, 'manifest_codehash_keys_invalid');
  refusedFor((m) => { m.deploymentReceipts['vault.v3'] = all.deploymentReceipts['vault.v3']; }, 'manifest_receipts_incomplete');
  refusedFor((m) => { delete m.contracts['vault.v4']; delete m.contracts['vaultExecutor.v4']; }, 'manifest_addresses_invalid');
  // Each address is still the CREATE3 prediction (finance/v2/deployment.ts, which every money client runs on a set).
  const moved = elysiumManifest();
  moved.contracts['zap.v4'] = '0x00000000000000000000000000000000000c0ffe';
  assert.throws(() => fullCheck(moved), code('deployment_addresses_changed'));
  assert.throws(() => deployment.checkV2Prediction(bind(moved).deployment), code('deployment_addresses_changed'));
  // Bound to its profile: a dependency of another chain is refused.
  const m = elysiumManifest();
  m.dependencies.v4PoolManager = '0x498581ff718922c3f8e6a244956af099b2652b2b';
  assert.throws(() => bind(m), code('manifest_dependency_mismatch'));
});

test('the chain\'s versions must agree with the manifest\'s: 13 refused for the v4-only chain, nine refused for 8453', () => {
  // A 13-component manifest for the chain without v3.
  const full = elysiumManifest();
  const all = fixture(42161);
  for (const name of V3_CONTRACTS) { full.contracts[name] = all.contracts[name]; full.runtimeCodeHashes[name] = all.runtimeCodeHashes[name]; }
  for (const name of V3_DEPLOYED) { full.createx.salts[name] = all.createx.salts[name]; full.createx.guardedSalts[name] = all.createx.guardedSalts[name]; full.deploymentReceipts[name] = all.deploymentReceipts[name]; }
  for (const name of V3_DEPENDENCIES) { full.dependencies[name] = all.dependencies[name]; full.runtimeCodeHashes[name] = all.runtimeCodeHashes[name]; }
  fullCheck(full);
  assert.throws(() => bind(full), code('manifest_dependency_mismatch'));
  // A well-formed nine-component manifest for each live chain: refused, under the test admission and the production one.
  for (const chainId of [4663, 8453, 42161]) {
    const nine = withoutV3(fixture(chainId));
    fullCheck(nine, manifest.ENABLED_CHAINS);
    assert.throws(() => fixtures.parseFixtureManifest(nine, chainId), code('manifest_dependency_mismatch'), String(chainId));
    const answer = manifest.availabilityOf(chainId, nine);
    assert.deepEqual([answer.available, answer.reason], [false, 'manifest_dependency_mismatch'], 'its versions are refused before its admission');
  }
  // The Elysium manifest asked for Base: a chain the app does not serve, and not Base.
  assert.throws(() => fixtures.parseFixtureManifest(elysiumManifest(), 8453), code('manifest_chain_not_enabled'));
  assert.throws(() => fixtures.parseFixtureManifest(elysiumManifest(), ID), code('manifest_chain_unsupported'));
  // Its production shape for Base, with Base's own dependencies: refused for its versions.
  const base = withoutV3(fixture(8453));
  base.environment = 'public-chain-preparation';
  base.verification.blockTag = 'finalized';
  Object.assign(base.roles, { governance: '0x0000000000000000000000000000000000100001', guardian: '0x0000000000000000000000000000000000100002', operator: '0x0000000000000000000000000000000000100003', publisher: '0x0000000000000000000000000000000000100004' });
  assert.deepEqual([manifest.availabilityOf(8453, base).available, manifest.availabilityOf(8453, base).reason], [false, 'manifest_dependency_mismatch']);
});

test('every live chain still requires all 13: one missing, of either version, fails closed', () => {
  for (const chainId of [4663, 8453, 42161]) {
    for (const name of manifest.MANIFEST_CONTRACTS) {
      const m = fixture(chainId);
      delete m.contracts[name];
      assert.throws(() => fixtures.parseFixtureManifest(m, chainId), code('manifest_addresses_invalid'), `${chainId} ${name}`);
    }
    const set = fixtures.fixtureContracts(chainId);
    assert.deepEqual(Object.keys(set.addresses).sort(), ['autoExit', 'priceAnchor', 'registry', 'vaultFactoryV3', 'vaultFactoryV4', 'zapV3', 'zapV4']);
    assert.equal(Object.keys(set.deployment.contracts).length, 13);
  }
  // And the pinned production manifests are what they were (tests/v2/manifest.test.mjs, manifest-pin.test.mjs).
  for (const chainId of [4663, 8453, 42161]) assert.equal(Object.keys(manifest.v2Availability(chainId).contracts.addresses).length, 7);
});

test('a money client\'s set on a live chain still needs both zaps and factories; a v4-only set reaches no v3 component', async () => {
  // Base's set without its v3 zap is refused before any client is built (fail closed).
  const base = fixtures.fixtureContracts(8453);
  const { zapV3: _zap, ...addresses } = base.addresses;
  const { zapV3: _hash, ...codeHashes } = base.codeHashes;
  assert.throws(() => vault.v2ContractsFor(chains.v2Chain(8453), { ...base, addresses, codeHashes }), /deployment_invalid/);
  assert.deepEqual(Object.keys(vault.v2ContractsFor(chains.v2Chain(8453), base).addresses).sort(), ['autoExit', 'priceAnchor', 'registry', 'vaultFactoryV3', 'vaultFactoryV4', 'zapV3', 'zapV4']);
  // A v4-only set: asking for any v3 component's code is refused, and nothing is read.
  const set = bind(elysiumManifest());
  let reads = 0;
  const getCode = async () => { reads += 1; return '0x'; };
  for (const component of ['zapV3', 'vaultFactoryV3', 'vaultV3', 'vaultExecutorV3']) {
    await assert.rejects(deployment.verifyV2Code(getCode, set, [component]), /deployment_component_unknown/, component);
  }
  await assert.rejects(deployment.checkZapPositionManager(async () => { reads += 1; return '0x'; }, set, v4only, [3]), /deployment_component_unknown/);
  assert.equal(reads, 0);
  // Its v4 components are checked as on any chain.
  await assert.rejects(deployment.verifyV2Code(getCode, set, ['zapV4']), /deployment_missing/);
  assert.equal(reads, 1);
});
