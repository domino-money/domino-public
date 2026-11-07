/**
 * Domino V2's deployment manifests (spec F7 rev2 §7.2, §7.3), in PR #302's format, checked as the backend loader on
 * main checks them (backend/v2_manifest.py `checked_manifest` and `checked_deployment`, rule for rule): the deployable
 * map holds the three verified manifests of 2026-10-04 (#327); every rule refuses its mutation of a passing
 * fixture; the fixtures (#302's own fork-rehearsal manifests) pass the v2-test admission and FAIL the production one;
 * the admission matrix by environment, status, admission and build flag; the deploy guard catches the fixtures while
 * the parser's own source carries no marker.
 *
 * Changed on purpose (data) 2026-10-02 (Domino V2 rev2 §7): rewritten for the #302 format.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { findForbidden } from '../../scripts/deploy-markers.mjs';

const require = createRequire(import.meta.url);
const MANIFEST = '../../.test-build/app/src/v2/manifest.js';
const FIXTURES = '../../.test-build/app/src/v2/manifestFixtures.js';
const FLAG = '../../.test-build/app/src/v2/flag.js';
const manifest = require(MANIFEST);
const fixtures = require(FIXTURES);
const deployment = require('../../.test-build/app/src/finance/v2/deployment.js');
const types = require('../../.test-build/app/src/v2/types.js');
const chains = require('../../.test-build/app/src/v2/chains.js');

const CHAINS = [4663, 8453, 42161];
const FILES = { 4663: 'manifest.robinhood-4663.fixture.json', 8453: 'manifest.base-8453.fixture.json', 42161: 'manifest.arbitrum-42161.fixture.json' };
const fixtureText = (chainId) => readFileSync(new URL(`../../src/v2/fixtures/${FILES[chainId]}`, import.meta.url), 'utf8');
/** A fresh, editable copy of a chain's fixture manifest, from the file itself. */
const fixture = (chainId = 4663) => JSON.parse(fixtureText(chainId));
/** #302's own local-test manifest (scripts/v2/deploy-fixtures/deployment.fixture.json, chain 31337), a second real artifact. */
const local302 = () => JSON.parse(readFileSync(new URL('./support/manifest-302-local-test.json', import.meta.url), 'utf8'));

/** Roles that are no key of the public test mnemonic, no placeholder, no component. */
const REAL_ROLES = {
  governance: '0x0000000000000000000000000000000000100001',
  guardian: '0x0000000000000000000000000000000000100002',
  operator: '0x0000000000000000000000000000000000100003',
  publisher: '0x0000000000000000000000000000000000100004',
};
/** The same content shaped as a production deployment: public chain, `finalized`, roles off the public mnemonic. */
const asProduction = (raw) => {
  const m = structuredClone(raw);
  m.environment = 'public-chain-preparation';
  m.verification.blockTag = 'finalized';
  Object.assign(m.roles, REAL_ROLES);
  return m;
};
/** The same content as a prepared (not yet executed) manifest. */
const asPrepared = (raw) => ({ ...structuredClone(raw), status: 'prepared', deploymentReceipts: {}, verification: null });

const code = (expected) => (error) => {
  assert.equal(error.code, expected, `${error.code} (${error.detail})`);
  assert.equal(error.message, expected);
  assert.ok(manifest.MANIFEST_ERRORS.includes(error.code) || deployment.DEPLOYMENT_ERRORS.includes(error.code));
  return true;
};
/** The backend's whole checked_manifest: the rules without a hash function, then the CREATE3 prediction and the tree. */
const fullCheck = (raw) => deployment.checkV2Prediction(manifest.manifestFacts(manifest.checkV2Manifest(raw), 'local-test'));
/**
 * What a money client gets from a fixture manifest: parsed under the fork-rehearsal admission (src/v2/manifest.ts),
 * then admitted (finance/v2/deployment.ts admitV2Contracts, which runs the CREATE3 prediction and the source tree).
 */
const admitted = (raw, chainId) => {
  const contracts = fixtures.parseFixtureManifest(raw, chainId);
  deployment.admitV2Contracts(chains.v2Chain(chainId), contracts);
  return contracts;
};
/**
 * Asserts the fixture of `chainId`, edited by `edit`, is refused with `expected` by checked_manifest and before a money
 * client takes it; and the same edit of the production-shaped copy is refused by checked_manifest too.
 */
const refused = (edit, expected, chainId = 4663) => {
  const raw = fixture(chainId);
  edit(raw);
  assert.throws(() => fullCheck(raw), code(expected), 'checked_manifest');
  assert.throws(() => admitted(raw, chainId), code(expected), 'as a fixture, before a money client');
  const production = asProduction(fixture(chainId));
  edit(production);
  assert.throws(() => fullCheck(production), code(expected), 'checked_manifest, production-shaped');
};
/** Asserts the fixture of `chainId`, edited by `edit`, still passes checked_manifest, the fork-rehearsal admission and admitV2Contracts. */
const passes = (edit, chainId = 4663) => {
  const raw = fixture(chainId);
  edit(raw);
  fullCheck(raw);
  return admitted(raw, chainId);
};

// ---------------------------------------------------------------------------
// The map, the constants
// ---------------------------------------------------------------------------

test('the deployable map holds the three verified manifests (#327): V2 is available on each chain, at production\'s own addresses', () => {
  // Changed on purpose 2026-10-04 (V2 deployed on Robinhood, Base and Arbitrum, #327): the map was empty and every chain
  // said "Not available on {chain} yet"; tests/v2/manifest-pin.test.mjs checks each file against its pin.
  assert.deepEqual(Object.keys(manifest.V2_DEPLOYMENTS), ['4663', '8453', '42161']);
  assert.deepEqual(Object.keys(manifest.V2_MANIFEST_PINS), ['4663', '8453', '42161']);
  assert.ok(Object.isFrozen(manifest.V2_DEPLOYMENTS) && Object.isFrozen(manifest.V2_MANIFEST_PINS));
  const production = deployment.predictV2Deployment('0x706627E3E75b0603c4B6f9a1eBBfc635dA712747');
  const lower = (values) => Object.values(values).map((value) => String(value).toLowerCase()).sort();
  const copies = {};
  for (const chainId of CHAINS) {
    const answer = manifest.v2Availability(chainId);
    assert.equal(answer.available, true);
    assert.equal(answer.contracts.fixture, false);
    assert.equal(answer.contracts.chainId, chainId);
    assert.equal(answer.contracts.deployment.admission, 'production');
    assert.deepEqual(lower(answer.contracts.deployment.contracts), lower(production.contracts), 'the CREATE3 addresses of the owner\'s deployer');
    copies[chainId] = manifest.notAvailableCopy(chains.v2Chain(chainId));
  }
  // The words a chain shows when its manifest fails a check.
  assert.deepEqual(copies, { 4663: 'Not available on Robinhood Chain yet', 8453: 'Not available on Base yet', 42161: 'Not available on Arbitrum One yet' });
  assert.throws(() => manifest.v2Availability(1), /chain_not_supported/);
});

test('the constants are the backend\'s (backend/v2_manifest.py on main) and #302\'s, value for value', () => {
  assert.equal(manifest.MANIFEST_KIND, 'domino-v2-deployment');
  assert.equal(manifest.MANIFEST_SCHEMA_VERSION, 1);
  assert.equal(manifest.MAX_MANIFEST_BYTES, 262144);
  assert.equal(manifest.CREATE_X, '0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed');
  assert.equal(manifest.CREATE_X_CODE_HASH, '0xbd8a7ea8cfca7b4e5f5041d7d4b17bc317c5ce42cfbc42066a00cf26b43eb53f');
  assert.equal(manifest.CREATE3_PROXY_INITCODE_HASH, '0x21c35dbe1b344a2488cf3321d6ce542f8e9f305544ff09e4993a62319a497c1f');
  assert.deepEqual({ ...manifest.CONTRACT_NAMES }, {
    registry: 'DominoRegistry', priceAnchor: 'DominoPriceAnchor', autoExit: 'DominoAutoExit',
    vaultSwap: 'DominoV2VaultSwapModule', 'vault.v3': 'DominoV2VaultV3', 'vault.v4': 'DominoV2VaultV4',
    'vaultFactory.v3': 'DominoV2VaultFactory', 'vaultFactory.v4': 'DominoV2VaultFactory',
    'zap.v4.steps': 'DominoZapV4Steps', 'zap.v3': 'DominoZapV3', 'zap.v4': 'DominoZapV4',
    'vaultExecutor.v3': 'DominoV2VaultExecutorV3', 'vaultExecutor.v4': 'DominoV2VaultExecutorV4',
  });
  assert.deepEqual([...manifest.MANIFEST_CONTRACTS], Object.keys(manifest.CONTRACT_NAMES));
  assert.deepEqual([...manifest.DEPLOY_ORDER], ['registry', 'priceAnchor', 'autoExit', 'vaultSwap', 'vault.v3', 'vault.v4', 'vaultFactory.v3', 'vaultFactory.v4', 'zap.v4.steps', 'zap.v3', 'zap.v4']);
  assert.deepEqual([...manifest.ROLE_NAMES], ['deployer', 'governance', 'guardian', 'feeRecipient', 'operator', 'publisher']);
  assert.deepEqual(JSON.stringify(manifest.MANIFEST_POLICIES), JSON.stringify({
    assistedSwapFeeBps: 65, bridgeAppFeeBps: 35, simpleCompoundFeeBps: 200, dominoCompoundFeeBps: 400,
    autoExitFeeBps: 20, automationFeeBasis: 'consumed_original_earned_fees_once_not_principal',
    additionalAutomationSwapFeeBps: 0, timelockSeconds: 86400, minTwapSeconds: 60,
    autoExitMaxObservationAgeSeconds: 300, autoExitMinTwapSeconds: 600, minimumUniversalRouterVersion: 212,
    hookedPoolsAllowed: false,
  }));
  // Spec §7.3 point 5: the fees are the app's constants, the windows the app's.
  assert.equal(manifest.MANIFEST_POLICIES.assistedSwapFeeBps, types.V2_FEES.assistedSwapBps);
  assert.equal(manifest.MANIFEST_POLICIES.bridgeAppFeeBps, types.V2_FEES.bridgeAppBps);
  assert.equal(manifest.MANIFEST_POLICIES.simpleCompoundFeeBps, types.V2_FEES.automationSimpleBps);
  assert.equal(manifest.MANIFEST_POLICIES.dominoCompoundFeeBps, types.V2_FEES.automationDominoBps);
  assert.equal(manifest.MANIFEST_POLICIES.autoExitFeeBps, types.V2_FEES.autoExitBps);
  assert.equal(manifest.MANIFEST_POLICIES.autoExitMaxObservationAgeSeconds, types.V2_WINDOWS.v4ObservationMaxSeconds);
  assert.equal(manifest.MANIFEST_POLICIES.autoExitMinTwapSeconds, types.V2_WINDOWS.v3TwapMinSeconds);
  assert.deepEqual([...manifest.MANIFEST_DEPENDENCIES], ['v3Factory', 'v3PositionManager', 'v3Quoter', 'v3SwapRouter', 'v4PoolManager', 'v4PositionManager', 'v4StateView', 'v4Quoter', 'universalRouter', 'permit2', 'wrappedNative']);
  assert.deepEqual([...manifest.ENVIRONMENTS], ['public-chain-preparation', 'local-test', 'fork-rehearsal']);
  assert.deepEqual([...manifest.ENABLED_CHAINS], [4663, 8453, 42161]);
  assert.deepEqual([...manifest.ADMISSIONS], ['production', 'fork-rehearsal', 'local-test']);
  assert.deepEqual({ ...manifest.BUILD_PROFILE }, { version: '0.8.26+commit.8a97fa7a', optimizerRuns: 200, viaIR: true, evmVersion: 'cancun', bytecodeHash: 'none' });
  assert.deepEqual([...manifest.TOP_LEVEL], ['schemaVersion', 'kind', 'status', 'environment', 'chain', 'sourceCommit', 'releaseTag', 'contractNames', 'contracts', 'dependencies', 'roles', 'policies', 'chargeCurrencies', 'runtimeCodeHashes', 'createx', 'build', 'deploymentReceipts', 'verification']);
  assert.deepEqual([...manifest.PUBLIC_TEST_ACCOUNTS].sort(), [
    '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc', '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
    '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65', '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc',
    '0x976ea74026e726554db657fa54763abd0c3a0aa9', '0x14dc79964da2c08b23698b3d3cc7ca32193d9955',
    '0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f', '0xa0ee7a142d267c1f36714e4a8f75612f20a79720'].sort());
  // The app's names for the seven components it calls (spec §7.2), and the six more the code check reaches.
  assert.deepEqual({ ...manifest.APP_COMPONENTS }, { registry: 'registry', priceAnchor: 'priceAnchor', autoExit: 'autoExit', zapV3: 'zap.v3', zapV4: 'zap.v4', vaultFactoryV3: 'vaultFactory.v3', vaultFactoryV4: 'vaultFactory.v4' });
  assert.deepEqual(Object.values(manifest.CODE_COMPONENTS).sort(), [...manifest.MANIFEST_CONTRACTS].sort());
});

test('canonical() is deploy.mjs\'s: keys sorted by UTF-16 code unit at every level, arrays kept in order', () => {
  assert.equal(manifest.canonical({ b: 1, a: [{ d: 2, c: 3 }], 'zap.v3': true, Z: null }), '{"Z":null,"a":[{"c":3,"d":2}],"b":1,"zap.v3":true}');
  // By UTF-16 code unit, as the backend sorts: U+1F600 is the pair 0xD83D 0xDE00, which sorts before U+FF5E (0xD83D < 0xFF5E),
  // although its code point is higher.
  assert.equal(manifest.canonical({ '～': 1, '\u{1F600}': 2 }), '{"\u{1F600}":2,"～":1}');
});

// ---------------------------------------------------------------------------
// The fixtures: #302's fork rehearsal; v2-test admission yes, production no
// ---------------------------------------------------------------------------

test('each fixture passes checked_manifest and the fork-rehearsal admission for its own chain: seven components, fixture: true', () => {
  for (const chainId of CHAINS) {
    const raw = fixture(chainId);
    fullCheck(raw);
    const contracts = fixtures.fixtureContracts(chainId);
    deployment.admitV2Contracts(chains.v2Chain(chainId), contracts);
    assert.deepEqual(admitted(raw, chainId), contracts);
    assert.equal(contracts.chainId, chainId);
    assert.equal(contracts.fixture, true);
    assert.deepEqual(Object.keys(contracts.addresses).sort(), ['autoExit', 'priceAnchor', 'registry', 'vaultFactoryV3', 'vaultFactoryV4', 'zapV3', 'zapV4']);
    assert.deepEqual(Object.keys(contracts.codeHashes).sort(), Object.keys(contracts.addresses).sort());
    for (const [name, key] of Object.entries(manifest.APP_COMPONENTS)) {
      assert.equal(contracts.addresses[name], raw.contracts[key]);
      assert.equal(contracts.codeHashes[name], raw.runtimeCodeHashes[key]);
      assert.match(contracts.addresses[name], /^0x[0-9a-f]{40}$/);
    }
    const facts = contracts.deployment;
    assert.equal(facts.environment, 'fork-rehearsal');
    assert.equal(facts.admission, 'fork-rehearsal');
    assert.equal(facts.deployer, raw.roles.deployer);
    assert.deepEqual({ ...facts.contracts }, raw.contracts);
    assert.deepEqual(Object.keys(facts.codeHashes), [...manifest.MANIFEST_CONTRACTS]);
    assert.deepEqual({ ...facts.salts }, raw.createx.salts);
    assert.deepEqual({ ...facts.guardedSalts }, raw.createx.guardedSalts);
    assert.ok(Object.isFrozen(contracts) && Object.isFrozen(contracts.addresses) && Object.isFrozen(contracts.codeHashes) && Object.isFrozen(facts) && Object.isFrozen(facts.contracts));
  }
});

test('each fixture FAILS the production admission (the pinned map\'s, in every build), and the local-test one', () => {
  for (const chainId of CHAINS) {
    assert.throws(() => manifest.parseV2Manifest(fixture(chainId), chainId), code('manifest_not_admitted'));
    assert.throws(() => manifest.parseV2FixtureManifest(fixture(chainId), chainId, 'local-test'), code('manifest_not_admitted'));
    const off = manifest.availabilityOf(chainId, fixture(chainId));
    assert.equal(off.available, false);
    assert.equal(off.reason, 'manifest_not_admitted');
  }
  // Each of the four things that keep it out, alone: the environment, the block tag, a public test key, a working tree.
  const production = asProduction(fixture(8453));
  assert.equal(manifest.parseV2Manifest(production, 8453).fixture, false, 'shaped as a production deployment, it would pass');
  for (const edit of [
    (m) => { m.environment = 'fork-rehearsal'; },
    (m) => { m.verification.blockTag = 'latest'; },
    (m) => { m.verification.blockTag = 'safe'; },
    (m) => { m.roles.operator = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'; },
    (m) => { m.build.workingTreeSourceChanges = true; },
  ]) {
    const m = asProduction(fixture(8453));
    edit(m);
    assert.throws(() => manifest.parseV2Manifest(m, 8453), code('manifest_not_admitted'));
  }
});

test('no role of a production manifest is one of the ten public test accounts, whichever role it is', () => {
  const roles = ['governance', 'guardian', 'feeRecipient', 'operator', 'publisher'];
  for (const [index, account] of manifest.PUBLIC_TEST_ACCOUNTS.entries()) {
    const m = asProduction(fixture(4663));
    m.roles[roles[index % roles.length]] = account;
    if (m.roles.operator === m.roles.publisher) continue;
    assert.throws(() => manifest.parseV2Manifest(m, 4663), code('manifest_not_admitted'), account);
    // The same roles pass the test admissions: a rehearsal may use them.
    m.environment = 'fork-rehearsal';
    assert.equal(fixtures.parseFixtureManifest(m, 4663).fixture, true);
  }
});

test('the admission matrix: environment × status × admission, as checked_deployment answers', () => {
  const variants = {
    'public-chain-preparation': (m) => { Object.assign(m, asProduction(m)); },
    'fork-rehearsal': () => {},
    'local-test': (m) => { m.environment = 'local-test'; },
  };
  for (const [environment, shape] of Object.entries(variants)) {
    for (const status of ['verified', 'prepared']) {
      for (const admission of ['production', 'fork-rehearsal', 'local-test']) {
        let m = fixture(42161);
        shape(m);
        if (status === 'prepared') m = asPrepared(m);
        assert.equal(m.environment, environment);
        manifest.checkV2Manifest(m);
        const run = () => (admission === 'production' ? manifest.parseV2Manifest(m, 42161) : manifest.parseV2FixtureManifest(m, 42161, admission));
        const admitted = status === 'verified' && (admission === 'production' ? environment === 'public-chain-preparation' : environment === admission);
        if (admitted) {
          const contracts = run();
          assert.equal(contracts.fixture, admission !== 'production', `${environment} ${status} ${admission}`);
          assert.equal(contracts.deployment.admission, admission);
        } else {
          assert.throws(run, code(status === 'prepared' ? 'manifest_not_executed' : 'manifest_not_admitted'), `${environment} ${status} ${admission}`);
        }
      }
    }
  }
  assert.throws(() => manifest.parseV2FixtureManifest(fixture(), 4663, 'production'), code('manifest_admission_invalid'));
  assert.throws(() => manifest.parseV2FixtureManifest(fixture(), 4663, 'mainnet'), code('manifest_admission_invalid'));
});

test('the gate: only the v2-test build (and the node test build) takes a test admission; a deployable build refuses before reading', () => {
  const fresh = () => {
    for (const path of [MANIFEST, FIXTURES, FLAG]) delete require.cache[require.resolve(path)];
    return { manifest: require(MANIFEST), fixtures: require(FIXTURES) };
  };
  const withFlags = (flags, run) => {
    Object.assign(globalThis, flags);
    try {
      return run(fresh());
    } finally {
      for (const key of Object.keys(flags)) delete globalThis[key];
      fresh();
    }
  };
  // Deployable (production, development): refused before the manifest is read, whatever it holds, V2 on or off.
  for (const v2 of [false, true]) {
    withFlags({ __DOMINO_DEPLOYABLE__: true, __DOMINO_V2__: v2 }, (built) => {
      for (const chainId of CHAINS) {
        assert.throws(() => built.fixtures.fixtureContracts(chainId), code('manifest_fixture_refused'));
        assert.throws(() => built.manifest.parseV2FixtureManifest(null, chainId, 'local-test'), code('manifest_fixture_refused'), 'before reading');
        assert.throws(() => built.manifest.parseV2Manifest(fixture(chainId), chainId), code('manifest_not_admitted'));
        // A production manifest still parses there. Changed on purpose 2026-10-04 (#327): the deployable map holds the
        // verified manifests, so V2 is available on every chain in a deployable build too (whether a feature opens is the
        // build flag's and each backend capability's to say).
        assert.equal(built.manifest.parseV2Manifest(asProduction(fixture(chainId)), chainId).fixture, false);
        assert.equal(built.manifest.v2Availability(chainId).available, true);
      }
    });
  }
  // Another test build without V2 (fixtures, bridge-test, wallet-test, consumer-test): refused too.
  withFlags({ __DOMINO_DEPLOYABLE__: false, __DOMINO_V2__: false }, (built) => {
    assert.throws(() => built.fixtures.fixtureContracts(4663), code('manifest_fixture_refused'));
  });
  // v2-test: taken.
  withFlags({ __DOMINO_DEPLOYABLE__: false, __DOMINO_V2__: true }, (built) => {
    assert.equal(built.fixtures.fixtureContracts(4663).fixture, true);
  });
  // The node test build (no Vite define): taken.
  assert.equal(fresh().fixtures.fixtureContracts(8453).fixture, true);
});

// ---------------------------------------------------------------------------
// checked_manifest, rule by rule: a passing fixture, then each rule's mutation
// ---------------------------------------------------------------------------

/** Every nested object with exact keys, and how to reach it. */
const LEVELS = {
  manifest: (m) => m,
  chain: (m) => m.chain,
  contractNames: (m) => m.contractNames,
  contracts: (m) => m.contracts,
  dependencies: (m) => m.dependencies,
  roles: (m) => m.roles,
  policies: (m) => m.policies,
  'chargeCurrencies[0]': (m) => m.chargeCurrencies[0],
  runtimeCodeHashes: (m) => m.runtimeCodeHashes,
  createx: (m) => m.createx,
  'createx.salts': (m) => m.createx.salts,
  'createx.guardedSalts': (m) => m.createx.guardedSalts,
  build: (m) => m.build,
  deploymentReceipts: (m) => m.deploymentReceipts,
  'deploymentReceipts.registry': (m) => m.deploymentReceipts.registry,
  verification: (m) => m.verification,
};
const LEVEL_CODES = {
  manifest: 'manifest_fields_invalid', chain: 'manifest_chain_invalid', contractNames: 'manifest_contracts_or_policy_changed',
  contracts: 'manifest_addresses_invalid', dependencies: 'manifest_dependencies_invalid', roles: 'manifest_roles_invalid',
  policies: 'manifest_contracts_or_policy_changed', 'chargeCurrencies[0]': 'manifest_currencies_invalid',
  runtimeCodeHashes: 'manifest_codehash_keys_invalid', createx: 'manifest_createx_invalid', 'createx.salts': 'manifest_createx_changed',
  'createx.guardedSalts': 'manifest_createx_changed', build: 'manifest_build_invalid', deploymentReceipts: 'manifest_receipts_incomplete',
  'deploymentReceipts.registry': 'manifest_receipt_invalid', verification: 'manifest_verification_invalid',
};

test('exact keys at every level: one key more, or one fewer, is refused', () => {
  for (const [level, reach] of Object.entries(LEVELS)) {
    refused((m) => { reach(m).extra = 1; }, LEVEL_CODES[level]);
    refused((m) => { const target = reach(m); delete target[Object.keys(target)[0]]; }, level === 'manifest' ? 'manifest_fields_invalid' : LEVEL_CODES[level]);
  }
  refused((m) => { m.chain = [m.chain]; }, 'manifest_chain_invalid');
  assert.throws(() => manifest.checkV2Manifest(null), code('manifest_fields_invalid'));
  assert.throws(() => manifest.checkV2Manifest([]), code('manifest_fields_invalid'));
  assert.throws(() => manifest.checkV2Manifest('{}'), code('manifest_fields_invalid'));
});

test('identity: schemaVersion 1, kind domino-v2-deployment, status prepared or verified', () => {
  for (const bad of [2, '1', true, 1.5]) refused((m) => { m.schemaVersion = bad; }, 'manifest_identity_invalid');
  for (const bad of ['domino-v2-deployment-fixture', 'domino-v1-deployment', '']) refused((m) => { m.kind = bad; }, 'manifest_identity_invalid');
  for (const bad of ['deployed', 'VERIFIED', null]) refused((m) => { m.status = bad; }, 'manifest_identity_invalid');
});

test('chain: a positive integer id, a name and a native currency; any chain id only for local-test', () => {
  for (const bad of ['4663', 0, -1, 1.5, null, 2 ** 53]) refused((m) => { m.chain.chainId = bad; }, 'manifest_chain_invalid');
  refused((m) => { m.chain.name = ''; }, 'manifest_chain_invalid');
  refused((m) => { m.chain.nativeCurrency = ''; }, 'manifest_chain_invalid');
  refused((m) => { m.chain.nativeCurrency = 1; }, 'manifest_chain_invalid');
  for (const bad of ['production', 'local', null]) refused((m) => { m.environment = bad; }, 'manifest_environment_invalid');
  for (const bad of [1, 31337, 10]) refused((m) => { m.chain.chainId = bad; }, 'manifest_chain_not_enabled');
  // local-test: any chain id is a well-formed manifest (it binds to no V2 chain profile then).
  const anvil = fixture();
  anvil.environment = 'local-test';
  anvil.chain.chainId = 31337;
  fullCheck(anvil);
  assert.throws(() => manifest.parseV2FixtureManifest(anvil, 4663, 'local-test'), code('manifest_chain_mismatch'));
  assert.throws(() => manifest.parseV2FixtureManifest(anvil, 31337, 'local-test'), code('manifest_chain_unsupported'));
});

test('source: a 40-hex commit and a release tag of the pattern', () => {
  for (const bad of ['85EE2420BEDDB9843BD37C3FCB378F5942C069A4', '85ee242', `${'a'.repeat(40)}\n`, 42]) refused((m) => { m.sourceCommit = bad; }, 'manifest_source_invalid');
  for (const bad of ['', '-v2', '.v2', 'v2 candidate', 'v2/candidate', `v${'1'.repeat(101)}`, 7]) refused((m) => { m.releaseTag = bad; }, 'manifest_source_invalid');
  passes((m) => { m.releaseTag = `v${'1'.repeat(100)}`; });
  passes((m) => { m.releaseTag = 'V2_candidate-2026.10.02'; });
});

test('contractNames: exactly the 13 names; policies: exactly the 13 values, one bps or one second off is refused', () => {
  refused((m) => { m.contractNames['zap.v3'] = 'DominoZapV3Mock'; }, 'manifest_contracts_or_policy_changed');
  for (const [key, value] of Object.entries(manifest.MANIFEST_POLICIES)) {
    const others = typeof value === 'number' ? [value + 1, value - 1, String(value), null] : typeof value === 'boolean' ? [!value, String(value), 0] : [`${value}_v2`, 1];
    for (const other of others) refused((m) => { m.policies[key] = other; }, 'manifest_contracts_or_policy_changed');
  }
});

test('roles: six lowercase addresses, no placeholder (below 2^16, one repeated digit), operator ≠ publisher, none a component or CreateX', () => {
  for (const bad of ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8', '0x1234', 42, null]) refused((m) => { m.roles.operator = bad; }, 'manifest_roles_invalid');
  const placeholders = ['0x000000000000000000000000000000000000dead', '0x000000000000000000000000000000000000beef', '0x000000000000000000000000000000000000cafe',
    '0x000000000000000000000000000000000000ffff', `0x${'0'.repeat(40)}`, `0x${'1'.repeat(40)}`, `0x${'f'.repeat(40)}`];
  for (const role of ['governance', 'guardian', 'feeRecipient', 'publisher']) {
    for (const bad of placeholders) refused((m) => { m.roles[role] = bad; }, 'manifest_role_placeholder');
  }
  passes((m) => { m.roles.guardian = '0x0000000000000000000000000000000000010000'; });
  refused((m) => { m.roles.publisher = m.roles.operator; }, 'manifest_operator_publisher_conflict');
  for (const component of ['registry', 'zap.v4', 'vaultExecutor.v3']) refused((m) => { m.roles.feeRecipient = m.contracts[component]; }, 'manifest_role_component_conflict');
  refused((m) => { m.roles.governance = manifest.CREATE_X; }, 'manifest_role_component_conflict');
});

test('contracts: the 13, lowercase and distinct; each one the CREATE3 prediction for roles.deployer (finance/v2/deployment.ts)', () => {
  refused((m) => { m.contracts['zap.v3'] = m.contracts['zap.v3'].toUpperCase().replace('0X', '0x'); }, 'manifest_addresses_invalid');
  refused((m) => { m.contracts['zap.v4'] = m.contracts['zap.v3']; }, 'manifest_addresses_invalid');
  refused((m) => { m.contracts.autoExit = `0x${'0'.repeat(40)}`; }, 'manifest_addresses_invalid');
  // Well formed but not the prediction: only the keccak half can tell.
  for (const component of ['registry', 'priceAnchor', 'zap.v3', 'vaultExecutor.v4']) {
    const m = fixture();
    m.contracts[component] = '0x00000000000000000000000000000000000c0de1';
    manifest.checkV2Manifest(m);
    assert.throws(() => fullCheck(m), code('deployment_addresses_changed'), component);
  }
  // Another deployer, its salts' prefix rewritten so the pure rules pass: the addresses are not its prediction.
  const other = fixture();
  const deployer = '0x00000000000000000000000000000000000c0de2';
  for (const key of Object.keys(other.createx.salts)) other.createx.salts[key] = `${deployer}00${other.createx.salts[key].slice(44)}`;
  other.roles.deployer = deployer;
  manifest.checkV2Manifest(other);
  assert.throws(() => fullCheck(other), code('deployment_addresses_changed'));
  // Two executors swapped.
  refused((m) => { [m.contracts['vaultExecutor.v3'], m.contracts['vaultExecutor.v4']] = [m.contracts['vaultExecutor.v4'], m.contracts['vaultExecutor.v3']]; }, 'deployment_addresses_changed');
});

test('createx: the canonical address and code hash, and per component the raw and guarded salts the prediction gives', () => {
  refused((m) => { m.createx.address = '0x4e59b44847b379578588920ca78fbf26c0b4956c'; }, 'manifest_createx_changed');
  refused((m) => { m.createx.runtimeCodeHash = `0x${'1'.repeat(64)}`; }, 'manifest_createx_changed');
  refused((m) => { delete m.createx.salts.autoExit; }, 'manifest_createx_changed');
  refused((m) => { m.createx.salts['vaultExecutor.v3'] = m.createx.salts['vault.v3']; }, 'manifest_createx_changed');
  // A raw salt with the chain byte on, or another deployer's prefix.
  refused((m) => { const s = m.createx.salts.registry; m.createx.salts.registry = `${s.slice(0, 42)}01${s.slice(44)}`; }, 'manifest_createx_changed');
  refused((m) => { const s = m.createx.salts.registry; m.createx.salts.registry = `0x00000000000000000000000000000000000c0de3${s.slice(42)}`; }, 'manifest_createx_changed');
  refused((m) => { m.createx.guardedSalts.zap = '0x12'; }, 'manifest_createx_changed');
  // Well formed but not the prediction.
  refused((m) => { const s = m.createx.salts['zap.v4']; m.createx.salts['zap.v4'] = `${s.slice(0, 64)}ff`; }, 'deployment_salts_changed');
  refused((m) => { m.createx.guardedSalts.priceAnchor = m.createx.guardedSalts.registry; }, 'deployment_salts_changed');
});

test('dependencies: the eleven, nonzero; runtime code hashes for the 13 and the 11, nonzero', () => {
  refused((m) => { m.dependencies.permit2 = `0x${'0'.repeat(40)}`; }, 'manifest_dependency_address_invalid');
  refused((m) => { m.dependencies.v4Quoter = '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94'; }, 'manifest_dependency_address_invalid');
  refused((m) => { m.dependencies.multicall3 = '0xca11bde05977b3631167028862be2a173976ca11'; delete m.dependencies.v3Quoter; }, 'manifest_dependencies_invalid');
  refused((m) => { delete m.runtimeCodeHashes['vaultExecutor.v4']; }, 'manifest_codehash_keys_invalid');
  refused((m) => { delete m.runtimeCodeHashes.wrappedNative; }, 'manifest_codehash_keys_invalid');
  refused((m) => { m.runtimeCodeHashes.multicall3 = m.runtimeCodeHashes.permit2; }, 'manifest_codehash_keys_invalid');
  for (const bad of [`0x${'0'.repeat(64)}`, '0x12', m0x(), 7]) refused((m) => { m.runtimeCodeHashes['zap.v4'] = bad; }, 'manifest_codehash_invalid');
  refused((m) => { m.runtimeCodeHashes.permit2 = `0x${'0'.repeat(64)}`; }, 'manifest_codehash_invalid');
});
function m0x() { return `0x${'A'.repeat(64)}`; }

test('charge currencies: two or more, distinct tokens (address zero is ETH), ranks 1..255', () => {
  refused((m) => { m.chargeCurrencies = m.chargeCurrencies.slice(0, 1); }, 'manifest_currencies_invalid');
  refused((m) => { m.chargeCurrencies = {}; }, 'manifest_currencies_invalid');
  refused((m) => { m.chargeCurrencies[2].token = m.chargeCurrencies[0].token; }, 'manifest_currencies_invalid');
  for (const bad of [0, 256, 1.5, '1', null]) refused((m) => { m.chargeCurrencies[0].rank = bad; }, 'manifest_currencies_invalid');
  refused((m) => { m.chargeCurrencies[0].token = m.chargeCurrencies[0].token.toUpperCase().replace('0X', '0x'); }, 'manifest_currencies_invalid');
  assert.equal(fixture().chargeCurrencies[1].token, `0x${'0'.repeat(40)}`, 'the fixture lists ETH as address zero');
});

test('build: the fixed compiler profile, source paths under src/v2/ or deploy-fixtures/, and the source tree\'s SHA-256', () => {
  for (const [key, bad] of [['version', '0.8.27+commit.40a35a09'], ['optimizerRuns', 201], ['optimizerRuns', '200'], ['viaIR', 'true'], ['viaIR', 1], ['evmVersion', 'paris'], ['bytecodeHash', 'ipfs']]) {
    refused((m) => { m.build[key] = bad; }, 'manifest_build_invalid');
  }
  refused((m) => { m.build.chainProfileSha256 = m.build.chainProfileSha256.toUpperCase(); }, 'manifest_build_invalid');
  refused((m) => { m.build.workingTreeSourceChanges = 'false'; }, 'manifest_build_invalid');
  refused((m) => { m.build.sourceHashes = {}; }, 'manifest_build_invalid');
  const one = (path, value = 'a'.repeat(64)) => (m) => { m.build.sourceHashes[path] = value; };
  for (const path of ['contracts/src/v2/X.sol', 'src/v1/X.sol', 'src/v2/../v1/X.sol', 'deploy-fixtures/../../etc', 'src/v2/\uD800.sol']) refused(one(path), 'manifest_build_invalid');
  refused(one('src/v2/X.sol', 'A'.repeat(64)), 'manifest_build_invalid');
  refused((m) => { m.build.sourceTreeSha256 = 'not-a-hash'; }, 'manifest_build_invalid');
  // Well formed, but the tree's hash no longer covers the sources: only the SHA-256 half can tell.
  refused(one('src/v2/Extra.sol'), 'deployment_source_tree_changed');
  refused((m) => { m.build.sourceTreeSha256 = 'f'.repeat(64); }, 'deployment_source_tree_changed');
  // #302's local manifest adds a deploy-fixtures/ source, which the rule admits.
  assert.ok(Object.keys(local302().build.sourceHashes).includes('deploy-fixtures/DependencyFixture.sol'));
  fullCheck(local302());
});

test('receipts: one distinct receipt per deployed component, in a block after the genesis, no zero hash, one hash per block', () => {
  refused((m) => { delete m.deploymentReceipts['zap.v4']; }, 'manifest_receipts_incomplete');
  refused((m) => { m.deploymentReceipts['vaultExecutor.v3'] = m.deploymentReceipts['vault.v3']; }, 'manifest_receipts_incomplete');
  refused((m) => { m.deploymentReceipts = []; }, 'manifest_receipts_incomplete');
  for (const [key, bad] of [['blockNumber', 0], ['blockNumber', '78299506'], ['blockNumber', -1], ['blockNumber', 1.5], ['transactionHash', `0x${'0'.repeat(64)}`], ['blockHash', `0x${'0'.repeat(64)}`],
    ['transactionHash', '0x12'], ['gasUsed', 1932821], ['gasUsed', '01'], ['gasUsed', '-1'], ['effectiveGasPrice', '1e3'], ['effectiveGasPrice', '']]) {
    refused((m) => { m.deploymentReceipts.registry[key] = bad; }, 'manifest_receipt_invalid');
  }
  // Two receipts in one block must agree on its hash; one transaction cannot be two receipts.
  refused((m) => { m.deploymentReceipts.priceAnchor.blockNumber = m.deploymentReceipts.registry.blockNumber; }, 'manifest_receipt_invalid');
  passes((m) => { Object.assign(m.deploymentReceipts.priceAnchor, { blockNumber: m.deploymentReceipts.registry.blockNumber, blockHash: m.deploymentReceipts.registry.blockHash }); });
  refused((m) => { m.deploymentReceipts.autoExit.transactionHash = m.deploymentReceipts.registry.transactionHash; }, 'manifest_receipt_invalid');
  passes((m) => { m.deploymentReceipts.registry.gasUsed = '0'; });
});

test('verification: anchored at or after every receipt, agreeing with a receipt in its block, exact markers, a time with a zone', () => {
  refused((m) => { m.verification = null; }, 'manifest_verification_invalid');
  refused((m) => { m.verification.codeHashes = 'observed'; }, 'manifest_verification_invalid');
  refused((m) => { m.verification.wiring = 'unchecked'; }, 'manifest_verification_invalid');
  refused((m) => { m.verification.blockTag = 7; }, 'manifest_verification_invalid');
  refused((m) => { m.verification.blockNumber -= 1; }, 'manifest_verification_invalid');
  // The same block as the last receipt, with another hash.
  refused((m) => { m.verification.blockHash = `0x${'1'.repeat(64)}`; }, 'manifest_verification_invalid');
  refused((m) => { m.verification.blockNumber += 1; m.verification.blockHash = `0x${'0'.repeat(64)}`; }, 'manifest_verification_invalid');
  passes((m) => { m.verification.blockNumber += 10; m.verification.blockHash = `0x${'1'.repeat(64)}`; });
  for (const bad of ['2026-10-02T14:24:32.125', '2026-10-02', '2026-10-02T14:24', '2026-13-02T14:24:32Z', '2026-02-30T14:24:32Z', '2026-10-02T24:00:00Z', 'yesterday', 1759415072, null]) {
    refused((m) => { m.verification.checkedAt = bad; }, 'manifest_verification_invalid');
  }
  for (const good of ['2026-10-02T14:24:32Z', '2026-10-02T14:24:32.125Z', '2026-10-02T11:24:32-03:00', '2026-10-02 14:24:32+00:00', '2026-10-02T14:24Z', '2024-02-29T00:00:00+0530']) {
    passes((m) => { m.verification.checkedAt = good; });
  }
});

test('prepared: no receipts and no verification; it is well formed but never admitted (not executed)', () => {
  const prepared = asPrepared(fixture());
  fullCheck(prepared);
  for (const admission of ['fork-rehearsal', 'local-test']) assert.throws(() => manifest.parseV2FixtureManifest(prepared, 4663, admission), code('manifest_not_executed'));
  assert.throws(() => manifest.parseV2Manifest(asPrepared(asProduction(fixture())), 4663), code('manifest_not_executed'));
  assert.throws(() => manifest.checkV2Manifest({ ...prepared, deploymentReceipts: fixture().deploymentReceipts }), code('manifest_prepared_has_receipts'));
  assert.throws(() => manifest.checkV2Manifest({ ...prepared, verification: fixture().verification }), code('manifest_prepared_has_receipts'));
  assert.throws(() => manifest.checkV2Manifest({ ...prepared, deploymentReceipts: null }), code('manifest_receipts_incomplete'));
});

// ---------------------------------------------------------------------------
// checked_deployment: bound to the app's chain profile
// ---------------------------------------------------------------------------

test('chain: the manifest names the chain it is asked for, and outside local-test the profile\'s name and native symbol', () => {
  for (const chainId of CHAINS) {
    for (const other of CHAINS.filter((id) => id !== chainId)) {
      assert.throws(() => fixtures.parseFixtureManifest(fixture(chainId), other), code('manifest_chain_mismatch'));
      assert.throws(() => manifest.parseV2Manifest(asProduction(fixture(chainId)), other), code('manifest_chain_mismatch'));
    }
  }
  for (const edit of [(m) => { m.chain.name = 'Base Mainnet'; }, (m) => { m.chain.nativeCurrency = 'WETH'; }]) {
    const m = fixture(8453);
    edit(m);
    fullCheck(m);
    assert.throws(() => fixtures.parseFixtureManifest(m, 8453), code('manifest_chain_mismatch'));
    m.environment = 'local-test';
    assert.equal(manifest.parseV2FixtureManifest(m, 8453, 'local-test').chainId, 8453, 'a local test may name its fork as it likes');
  }
  assert.throws(() => fixtures.parseFixtureManifest(fixture(8453), 1), code('manifest_chain_unsupported'));
  assert.throws(() => manifest.parseV2Manifest(asProduction(fixture(8453)), 99801), code('manifest_chain_unsupported'));
});

test('dependencies: each of the eleven is the chain profile\'s own; outside local-test their verified code hashes and the charge currencies too', () => {
  const robinhood = fixture(4663);
  const base = fixture(8453);
  for (const key of manifest.MANIFEST_DEPENDENCIES) {
    if (robinhood.dependencies[key] === base.dependencies[key]) continue; // Permit2: the same everywhere
    const m = fixture(4663);
    m.dependencies[key] = base.dependencies[key];
    fullCheck(m);
    assert.throws(() => fixtures.parseFixtureManifest(m, 4663), code('manifest_dependency_mismatch'), key);
    m.environment = 'local-test';
    assert.throws(() => manifest.parseV2FixtureManifest(m, 4663, 'local-test'), code('manifest_dependency_mismatch'), `${key}, local-test too`);
  }
  assert.equal(robinhood.dependencies.permit2, base.dependencies.permit2);
  // A dependency's code hash, and the charge currencies (their order too), outside local-test only.
  for (const edit of [
    (m) => { m.runtimeCodeHashes.v3Quoter = m.runtimeCodeHashes.v3Factory; },
    (m) => { m.runtimeCodeHashes.permit2 = `0x${'1'.repeat(64)}`; },
    (m) => { m.chargeCurrencies.reverse(); },
    (m) => { m.chargeCurrencies[0].rank = 3; },
    (m) => { m.chargeCurrencies.pop(); },
  ]) {
    const m = fixture(4663);
    edit(m);
    fullCheck(m);
    assert.throws(() => fixtures.parseFixtureManifest(m, 4663), code('manifest_dependency_mismatch'));
    m.environment = 'local-test';
    assert.equal(manifest.parseV2FixtureManifest(m, 4663, 'local-test').chainId, 4663);
  }
  // The fixtures were built against the real profiles: their dependencies are the profiles' own.
  for (const chainId of CHAINS) assert.equal(fixtures.parseFixtureManifest(fixture(chainId), chainId).chainId, chainId);
});

test('#302\'s own local-test manifest (chain 31337, deployer Anvil #0) passes checked_manifest; it binds to no V2 chain', () => {
  const m = local302();
  assert.equal(m.environment, 'local-test');
  assert.equal(m.chain.chainId, 31337);
  fullCheck(m);
  assert.throws(() => manifest.parseV2FixtureManifest(m, 31337, 'local-test'), code('manifest_chain_unsupported'));
  assert.throws(() => manifest.parseV2FixtureManifest(m, 8453, 'local-test'), code('manifest_chain_mismatch'));
  m.chain.chainId = 8453;
  // Base's addresses, synthetic code at them: the binding refuses the dependencies' code only outside local-test.
  assert.equal(manifest.parseV2FixtureManifest(m, 8453, 'local-test').fixture, true);
  m.environment = 'fork-rehearsal';
  assert.throws(() => manifest.parseV2FixtureManifest(m, 8453, 'fork-rehearsal'), code('manifest_chain_mismatch'));
});

// ---------------------------------------------------------------------------
// What never ships
// ---------------------------------------------------------------------------

// Changed on purpose (data) 2026-10-03 (#302 merged): the rehearsal manifests carry the owner's real roles and production's
// own addresses, so the guard catches each file by its rehearsal facts (verification block, first receipt), and an
// address is never a marker: the production bundle will carry the very same ones.
test('the deploy guard catches each fixture file by its rehearsal facts, and not the parser, a production address (the fixtures\' own) or a public test account', () => {
  for (const chainId of CHAINS) {
    const hits = findForbidden(fixtureText(chainId));
    assert.ok(hits.some((hit) => hit.marker === 'V2 fixture manifest'), FILES[chainId]);
  }
  // A bundle that carries the module inlines its three files, each caught above.
  const fixturesSource = readFileSync(new URL('../../src/v2/manifestFixtures.ts', import.meta.url), 'utf8');
  const inlined = [...fixturesSource.matchAll(/^import \w+ from '\.\/fixtures\/(manifest\.[a-z]+-\d+\.fixture\.json)'$/gm)].map((match) => match[1]).sort();
  // Changed on purpose 2026-11-07 (Elysium as a fourth V2 chain): and Elysium's, Arbitrum One's rehearsal moved to the
  // synthetic v4-only profile, so the same rehearsal facts mark it.
  assert.deepEqual(inlined, ['manifest.arbitrum-42161.fixture.json', 'manifest.base-8453.fixture.json', 'manifest.elysium-99901.fixture.json', 'manifest.robinhood-4663.fixture.json'], 'manifestFixtures.ts can never ship');
  const elysium = readFileSync(new URL('../../src/v2/fixtures/manifest.elysium-99901.fixture.json', import.meta.url), 'utf8');
  assert.ok(findForbidden(elysium).some((hit) => hit.marker === 'V2 fixture manifest'), 'manifest.elysium-99901.fixture.json');
  const raw = fixture();
  for (const address of [raw.roles.deployer, ...Object.values(raw.contracts)]) assert.deepEqual(findForbidden(JSON.stringify(address)), [], `${address} is production's own`);
  assert.equal(fixtures.fixtureContracts(8453).fixture, true, 'what a fixture parses into says so, and never sends');
  const source = readFileSync(new URL('../../src/v2/manifest.ts', import.meta.url), 'utf8');
  assert.deepEqual(findForbidden(source), [], 'manifest.ts carries no build marker');
  const production = deployment.predictV2Deployment('0x706627E3E75b0603c4B6f9a1eBBfc635dA712747');
  for (const text of ['domino-v2-deployment', '0x706627e3e75b0603c4b6f9a1ebbfc635da712747', ...Object.values(production.contracts), ...manifest.PUBLIC_TEST_ACCOUNTS, manifest.CREATE_X, 'DominoZapV4']) {
    assert.deepEqual(findForbidden(text), [], text);
  }
});

test('manifest.ts names no fixture deployer or address, no URL, and imports nothing of the wallet or viem', () => {
  const source = readFileSync(new URL('../../src/v2/manifest.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /0149af4613aa457765d23a38d62685a9623aef35|fixtures\/manifest|deployment-fixture|f1c7f1c7/i);
  assert.doesNotMatch(source, /https?:\/\//, 'no URL of any kind');
  const imports = [...source.matchAll(/^import[^;]*?from '([^']+)'/gm)].map((match) => match[1]);
  // Changed on purpose 2026-10-04 (#327): the three verified deployment manifests, by relative path from git.
  // Changed on purpose 2026-11-07 (Elysium as a fourth V2 chain): Elysium's literals and the files its build hands in
  // (./elysiumFiles.ts: its profile and its pinned record, read by the switch, never imported by path).
  assert.deepEqual(imports, [
    '../../../api-contracts/v2/chains/robinhood-4663.json', '../../../api-contracts/v2/chains/base-8453.json', '../../../api-contracts/v2/chains/arbitrum-42161.json',
    '../../../docs/deployments/v2-robinhood-4663-2026-10-04/deployment.json', '../../../docs/deployments/v2-base-8453-2026-10-04/deployment.json', '../../../docs/deployments/v2-arbitrum-42161-2026-10-04/deployment.json',
    '../lib/elysiumIdentity', './chains', './elysiumFiles', './flag', './types',
  ]);
  assert.match(source, /^declare const __DOMINO_DEPLOYABLE__: boolean \| undefined$/m, 'declared module-scoped, as finance/pin.ts does');
  assert.equal(fixtures.FIXTURE_ADMISSION, 'fork-rehearsal');
  for (const chainId of CHAINS) assert.equal(fixture(chainId).environment, 'fork-rehearsal');
});
