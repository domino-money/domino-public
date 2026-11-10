/**
 * Elysium as a fourth V2 chain, its core (added 2026-11-07; docs/ELYSIUM_DAY9.md sections 1 to 3): the chain list, the
 * profile, the deployment's binding, the services' tables, the gates, the explorers, the wallet's and the session's
 * networks, all following the build's one switch (scripts/elysium-switch.mjs, src/lib/elysiumIdentity.ts ELYSIUM_LIVE).
 *
 *   - Off (today, and the release build): every list, table and service is the three chains', exactly as before; no
 *     99901 row, no 99901 code path (the release bundle itself: tests/session.bundle.test.mjs).
 *   - Forced on with the fixtures (./support/elysium-live.mjs, as the forced test builds carry them: the synthetic v4-only
 *     profile, no production record): 99901 is served last, HYPE native, v4 alone; it binds its nine-contract
 *     fork-rehearsal record under the test admission, and refuses the three live chains' shape (13 contracts); it is in
 *     V2_CHAIN_IDS, isV2ChainId, the session's networks, the wallet's switching and every per-chain table; S2 stays off
 *     there. A pinned record is still parsed under the production admission, so a rehearsal record is refused.
 *   - The services answer for Elysium as they do for the others: a read-v6 capabilities answer that names 99901, or does
 *     not, keeps the reads on; a portfolio answer that names a chain the app does not serve has that chain left out.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { ELYSIUM_FIXTURE_PATH, ELYSIUM_FORCED, ELYSIUM_PROFILE, loadWith, runWith, withRecord } from './support/elysium-live.mjs';
import { v4OnlyManifest } from './support/v4-only.mjs';
import { CONTRACT_VERSION as READ_V6_VERSION } from '../../../api-contracts/read-v6/runtime.mjs';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const ID = 99901;
const THREE = [4663, 8453, 42161];
const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const FIXTURE_BYTES = readFileSync(new URL(`../../${ELYSIUM_FIXTURE_PATH}`, import.meta.url));
const fixture = JSON.parse(FIXTURE_BYTES);
const arbitrumFixture = json('../../src/v2/fixtures/manifest.arbitrum-42161.fixture.json');
const NINE = ['registry', 'priceAnchor', 'autoExit', 'vaultSwap', 'vault.v4', 'vaultFactory.v4', 'zap.v4.steps', 'zap.v4', 'vaultExecutor.v4'];
const code = (expected) => (error) => { assert.equal(error.code ?? error.message, expected, `${error.code ?? error.message} (${error.detail ?? ''})`); return true; };

/** The modules this file looks at, loaded with `flags` (none: today's, Elysium off). */
const modules = () => ({
  identity: require(`${BUILD}config/chainIdentity.js`),
  chains: require(`${BUILD}v2/chains.js`),
  manifest: require(`${BUILD}v2/manifest.js`),
  fixtures: require(`${BUILD}v2/manifestFixtures.js`),
  deployment: require(`${BUILD}finance/v2/deployment.js`),
  capabilities: require(`${BUILD}v2/capabilities.js`),
  gate: require(`${BUILD}v2/gate.js`),
  types: require(`${BUILD}v2/types.js`),
  explorers: require(`${BUILD}v2/explorers.js`),
  present: require(`${BUILD}v2/crosschain/present.js`),
  routes: require(`${BUILD}v2/routes.js`),
  v6: require(`${BUILD}v2/read/v6.js`),
  route: require(`${BUILD}v2in/route.js`),
  files: require(`${BUILD}v2/elysiumFiles.js`),
});
const OFF = modules();
const ON = loadWith(require, ELYSIUM_FORCED, modules);
const ON_V2 = loadWith(require, { ...ELYSIUM_FORCED, __DOMINO_V2__: true }, () => require(`${BUILD}session/machine.js`));
const OFF_V2 = loadWith(require, { __DOMINO_V2__: true }, () => require(`${BUILD}session/machine.js`));

// ---------------------------------------------------------------------------
// Off: today's build and the release build
// ---------------------------------------------------------------------------

test('off: the three chains, every list and table as before, and nothing of Elysium served', () => {
  const { identity, chains, manifest, fixtures, capabilities, gate, files } = OFF;
  assert.deepEqual([...identity.V2_CHAIN_IDS], THREE);
  assert.deepEqual(chains.V2_CHAINS.map((chain) => chain.chainId), THREE);
  assert.deepEqual(Object.keys(chains.V2_CHAIN_FACTS).map(Number), THREE);
  assert.equal(chains.isV2ChainId(ID), false);
  assert.throws(() => chains.v2Chain(ID), /chain_not_supported/);
  assert.equal(chains.chainHasDex(ID, 4), false);
  assert.deepEqual([...manifest.ENABLED_CHAINS], THREE);
  assert.deepEqual(Object.keys(manifest.V2_DEPLOYMENTS).map(Number), THREE);
  assert.deepEqual(Object.keys(manifest.V2_MANIFEST_PINS).map(Number), THREE);
  assert.deepEqual(Object.keys(fixtures.FIXTURE_MANIFESTS).map(Number), THREE);
  assert.deepEqual(Object.keys(fixtures.FIXTURE_PINS).map(Number), THREE);
  for (const service of ['s1', 's2', 'vault', 'autoExit']) assert.deepEqual(Object.keys(capabilities.V2_BACKEND_CAPABILITIES[service]).map(Number), THREE, service);
  assert.deepEqual([...gate.S1_PLAN_CHAINS], THREE);
  assert.deepEqual([files.ELYSIUM_PROFILE, files.ELYSIUM_DEPLOYMENT, files.ELYSIUM_DEPLOYMENT_PIN], [null, null, null]);
  // Its fixture is not a set of a chain the app serves.
  assert.throws(() => fixtures.parseFixtureManifest(fixture, ID), code('manifest_chain_unsupported'));
  assert.deepEqual(OFF.route.parseV2PositionParam('elysium-v4-5'), null);
  assert.throws(() => OFF.route.v2PositionHref({ chainId: ID, dex: 4, tokenId: 5n }), /invalid_position_ref/);
  assert.equal(OFF_V2.keptChains().includes(ID), false, 'the session is not kept on Elysium');
  assert.ok(THREE.every((chainId) => OFF_V2.keptChains().includes(chainId)));
});

test('off, defines that are not "live" carry nothing: a profile or a record without the switch is never read', () => {
  const half = loadWith(require, { __DOMINO_ELYSIUM_PROFILE__: ELYSIUM_FORCED.__DOMINO_ELYSIUM_PROFILE__, ...withRecord(fixture), __DOMINO_ELYSIUM_LIVE__: false }, modules);
  assert.deepEqual([half.files.ELYSIUM_PROFILE, half.files.ELYSIUM_DEPLOYMENT, half.files.ELYSIUM_DEPLOYMENT_PIN], [null, null, null]);
  assert.deepEqual(half.chains.V2_CHAINS.map((chain) => chain.chainId), THREE);
  assert.deepEqual(Object.keys(half.manifest.V2_DEPLOYMENTS).map(Number), THREE);
  // A record without its pin is never carried either.
  const unpinned = loadWith(require, { ...ELYSIUM_FORCED, __DOMINO_ELYSIUM_DEPLOYMENT__: `${JSON.stringify(fixture, null, 2)}\n` }, modules);
  assert.deepEqual([unpinned.files.ELYSIUM_DEPLOYMENT, unpinned.files.ELYSIUM_DEPLOYMENT_PIN], [null, null]);
  assert.deepEqual(Object.keys(unpinned.manifest.V2_DEPLOYMENTS).map(Number), THREE);
});

// ---------------------------------------------------------------------------
// On: the chain list and the profile
// ---------------------------------------------------------------------------

test('on: Elysium is the fourth chain, last, from its profile and its facts: HYPE native, Uniswap v4 alone, about 12 minutes to finalized', () => {
  const { identity, chains, files } = ON;
  assert.deepEqual([...identity.V2_CHAIN_IDS], [...THREE, ID]);
  assert.deepEqual(chains.V2_CHAINS.map((chain) => chain.chainId), [...THREE, ID]);
  assert.equal(chains.isV2ChainId(ID), true);
  assert.deepEqual(files.ELYSIUM_PROFILE, ELYSIUM_PROFILE);
  const elysium = chains.v2Chain(ID);
  assert.deepEqual([elysium.hex, elysium.slug, elysium.name, elysium.nativeSymbol, elysium.wrappedNative.symbol, elysium.nativeUsd], ['0x1863d', 'elysium', 'Elysium', 'HYPE', 'WHYPE', 'pool']);
  assert.deepEqual([...elysium.dexes], [4]);
  assert.equal(elysium.uniswap.v3, null);
  assert.equal(elysium.uniswap.v4.positionManager, ELYSIUM_PROFILE.uniswap.v4.positionManager.toLowerCase());
  assert.deepEqual([elysium.stack, elysium.ordering, elysium.l1FeeInReceipt, elysium.l1FeeOracle, elysium.finality.aboutMinutes], ['arbitrum-nitro', 'arrival', false, null, 12]);
  assert.deepEqual(elysium.bridgeProviders, []);
  assert.deepEqual(elysium.chargeCurrencies.map((c) => [c.rank, c.symbol, c.native]), [[1, 'USDC', false], [2, 'HYPE', true], [2, 'WHYPE', false]]);
  assert.deepEqual([chains.chainHasDex(ID, 4), chains.chainHasDex(ID, 3)], [true, false]);
  assert.equal(chains.nativeSymbolOf(ID), 'HYPE');
  assert.deepEqual({ ...chains.V2_CHAIN_FACTS[ID] }, { slug: 'elysium', name: 'Elysium', nativeSymbol: 'HYPE', wrappedSymbol: 'WHYPE', finalityMinutes: 12, dexes: [4] });
  // The three chains are what they were.
  assert.deepEqual(chains.V2_CHAINS.slice(0, 3), OFF.chains.V2_CHAINS);
  assert.deepEqual(THREE.map((chainId) => chains.V2_CHAIN_FACTS[chainId]), THREE.map((chainId) => OFF.chains.V2_CHAIN_FACTS[chainId]));
});

test('on: a broken Elysium profile is refused as any listed chain\'s is, never served half-read', () => {
  for (const [edit, why] of [
    [(p) => { p.uniswap.v3 = ON.chains.v2Chain(42161).uniswap.v3; }, /elysium uniswap versions/],
    [(p) => { p.nativeSymbol = 'ETH'; }, /elysium native/],
    [(p) => { p.enabled = false; }, /elysium is incomplete/],
  ]) {
    const profile = structuredClone(ELYSIUM_PROFILE);
    edit(profile);
    assert.throws(() => loadWith(require, { ...ELYSIUM_FORCED, __DOMINO_ELYSIUM_PROFILE__: JSON.stringify(profile) }, () => require(`${BUILD}v2/chains.js`)), why);
  }
});

// ---------------------------------------------------------------------------
// On: the deployment
// ---------------------------------------------------------------------------

test('on: the 99901 fork-rehearsal fixture is pinned, is Arbitrum One\'s rehearsal moved to the profile with v4 alone, and binds its nine contracts under the test admission', () => {
  const { manifest, fixtures, deployment, chains } = ON;
  assert.deepEqual([...manifest.ENABLED_CHAINS], [...THREE, ID], 'as scripts/v2/deploy.mjs ENABLED_CHAINS');
  const pin = fixtures.FIXTURE_PINS[ID];
  assert.equal(pin.path, `app/${ELYSIUM_FIXTURE_PATH}`);
  assert.equal(sha256(FIXTURE_BYTES), pin.sha256, `${pin.path} drifted from its pin`);
  assert.ok(!FIXTURE_BYTES.includes('\r'));
  assert.equal(`${JSON.stringify(fixture, null, 2)}\n`, FIXTURE_BYTES.toString('utf8'), 'its own canonical JSON');
  assert.deepEqual(fixture, v4OnlyManifest(arbitrumFixture, ELYSIUM_PROFILE, ID), 'tests/v2/support/v4-only.mjs v4OnlyManifest, as the v4-only tests derive it');
  assert.deepEqual(fixtures.FIXTURE_MANIFESTS[ID], fixture);
  assert.deepEqual(Object.keys(fixture.contracts), NINE);
  assert.deepEqual(Object.keys(fixture.contractNames), Object.keys(manifest.CONTRACT_NAMES), 'contractNames still the 13');
  const contracts = fixtures.fixtureContracts(ID);
  assert.deepEqual([contracts.chainId, contracts.fixture, contracts.deployment.admission], [ID, true, 'fork-rehearsal']);
  assert.deepEqual(Object.keys(contracts.addresses).sort(), ['autoExit', 'priceAnchor', 'registry', 'vaultFactoryV4', 'zapV4']);
  deployment.checkV2Prediction(contracts.deployment);
  deployment.admitV2Contracts(chains.v2Chain(ID), contracts);
  // CREATE3: the same addresses as the other chains' rehearsals, where both hold the contract.
  const arbitrum = fixtures.fixtureContracts(42161);
  for (const name of Object.keys(contracts.addresses)) assert.equal(contracts.addresses[name], arbitrum.addresses[name], name);
  // The three chains' fixtures bind as before.
  for (const chainId of THREE) assert.deepEqual(fixtures.fixtureContracts(chainId), OFF.fixtures.fixtureContracts(chainId), String(chainId));
});

test('on: the three live chains\' shape is refused on Elysium, and Elysium\'s on the three', () => {
  const { fixtures } = ON;
  // Thirteen contracts on the v4-only chain: Arbitrum One's rehearsal moved to 99901 with its v3 left in.
  const thirteen = structuredClone(arbitrumFixture);
  thirteen.chain = { ...fixture.chain };
  assert.throws(() => fixtures.parseFixtureManifest(thirteen, ID), code('manifest_dependency_mismatch'));
  // Elysium's record asked for each of the three: another chain's.
  for (const chainId of THREE) assert.throws(() => fixtures.parseFixtureManifest(fixture, chainId), code('manifest_chain_mismatch'), String(chainId));
  // Against another profile (rugged97's real one, on the day) the synthetic fixture binds nothing.
  const other = structuredClone(ELYSIUM_PROFILE);
  other.name = 'Elysium';
  const real = loadWith(require, { ...ELYSIUM_FORCED, __DOMINO_ELYSIUM_PROFILE__: JSON.stringify(other) }, () => require(`${BUILD}v2/manifestFixtures.js`));
  assert.throws(() => real.fixtureContracts(ID), code('manifest_chain_mismatch'));
});

test('on: without a record Elysium says "Not available on Elysium yet"; a pinned record joins the map and is parsed under the production admission, so a rehearsal one is refused', () => {
  const answer = ON.manifest.v2Availability(ID);
  assert.deepEqual([answer.available, answer.reason, answer.copy], [false, 'not_deployed', 'Not available on Elysium yet']);
  assert.equal(ON.capabilities.serviceAvailability('s1', ID).reason, 'build_off', 'this compile carries no V2 (src/v2/flag.ts)');
  const pinned = loadWith(require, withRecord(fixture), modules);
  assert.deepEqual(Object.keys(pinned.manifest.V2_DEPLOYMENTS).map(Number), [...THREE, ID]);
  assert.deepEqual(Object.keys(pinned.manifest.V2_MANIFEST_PINS).map(Number), [...THREE, ID]);
  assert.deepEqual(pinned.manifest.V2_DEPLOYMENTS[ID], fixture, 'the pinned text, parsed');
  assert.equal(pinned.manifest.V2_MANIFEST_PINS[ID].path, 'docs/deployments/v2-elysium-99901-2026-11-09/deployment.json');
  const refused = pinned.manifest.v2Availability(ID);
  assert.deepEqual([refused.available, refused.reason], [false, 'manifest_not_admitted'], 'a fork rehearsal is never a production deployment');
  // The production admission's own rules hold for it: a record admitted as production must be verified at `finalized`
  // from committed sources, by real roles; the rehearsal is none of these.
  assert.throws(() => pinned.manifest.parseV2Manifest(fixture, ID), code('manifest_not_admitted'));
  for (const chainId of THREE) assert.equal(pinned.manifest.v2Availability(chainId).available, true, `${chainId} stays available`);
});

test('on, day 9 rehearsed: a production record with v4 alone (Arbitrum One\'s, moved to the profile) is admitted on 99901, and Elysium\'s V2 is available, at the same CREATE3 addresses', () => {
  const production = v4OnlyManifest(json('../../../docs/deployments/v2-arbitrum-42161-2026-10-04/deployment.json'), ELYSIUM_PROFILE, ID);
  const day9 = loadWith(require, withRecord(production), modules);
  const contracts = day9.manifest.parseV2Manifest(day9.manifest.V2_DEPLOYMENTS[ID], ID);
  assert.deepEqual([contracts.chainId, contracts.fixture, contracts.deployment.admission], [ID, false, 'production']);
  day9.deployment.checkV2Prediction(contracts.deployment);
  day9.deployment.admitV2Contracts(day9.chains.v2Chain(ID), contracts);
  assert.deepEqual(Object.keys(contracts.deployment.contracts), NINE);
  const answer = day9.manifest.v2Availability(ID);
  assert.equal(answer.available, true);
  const arbitrum = day9.manifest.v2Availability(42161).contracts;
  assert.deepEqual(Object.keys(answer.contracts.addresses).sort(), ['autoExit', 'priceAnchor', 'registry', 'vaultFactoryV4', 'zapV4']);
  for (const name of Object.keys(answer.contracts.addresses)) assert.equal(answer.contracts.addresses[name], arbitrum.addresses[name], name);
  // Its services open as the others' do: from their routes' own word, never from the table (this compile has no V2).
  assert.equal(day9.capabilities.serviceAvailability('vault', ID).reason, 'build_off');
  // The same record with its v3 left in is refused there, under the production admission too.
  const thirteen = structuredClone(json('../../../docs/deployments/v2-arbitrum-42161-2026-10-04/deployment.json'));
  thirteen.chain = { ...production.chain };
  const refused = loadWith(require, withRecord(thirteen), modules).manifest.v2Availability(ID);
  assert.deepEqual([refused.available, refused.reason], [false, 'manifest_dependency_mismatch']);
});

// ---------------------------------------------------------------------------
// On: the services, the gates, the explorers
// ---------------------------------------------------------------------------

test('on: every service\'s table has Elysium\'s row, off; S1 plans there once its route is on; S2 brings no funds there', () => {
  const { capabilities, gate, types, present } = ON;
  for (const service of ['s1', 's2', 'vault', 'autoExit']) {
    assert.deepEqual(Object.keys(capabilities.V2_BACKEND_CAPABILITIES[service]).map(Number), [...THREE, ID], service);
    assert.equal(capabilities.V2_BACKEND_CAPABILITIES[service][ID], false, service);
  }
  assert.deepEqual(capabilities.chainsFor('s1').map(({ chain }) => chain.chainId), [...THREE, ID]);
  assert.deepEqual([...gate.S1_PLAN_CHAINS], [...THREE, ID]);
  assert.deepEqual([...types.S2_DESTINATION_CHAIN_IDS], THREE);
  assert.deepEqual([types.isS2Destination(ID), ...THREE.map(types.isS2Destination)], [false, true, true, true]);
  assert.deepEqual(present.destinationChoices().map((choice) => choice.chainId), THREE, 'no deposit to Elysium');
  assert.deepEqual(present.destinationChoices(), OFF.present.destinationChoices());
});

test('on: S2\'s gate is off on Elysium wherever every other gate is open, and the preview carries Elysium\'s own fixture', async () => {
  const flags = { ...ELYSIUM_FORCED, __DOMINO_V2__: true, __DOMINO_TEST_HOOKS__: true, __DOMINO_V2_FIXTURE_SETS__: true, window: { __dominoV2Test: { originOpen: true } } };
  await runWith(require, flags, async () => {
    const gate = require(`${BUILD}v2/gate.js`);
    const routes = () => Promise.resolve({ state: () => Promise.resolve({ on: true, routes: ['origins', 'quote', 'status', 'plan', 'portfolio'] }) });
    assert.deepEqual(await gate.s2Gate(ID, routes, 'https://example.test'), { mode: 'off' });
    assert.equal((await gate.s2Gate(8453, routes, 'https://example.test')).mode, 'live', 'Base keeps its deposits');
    const s1 = await gate.v2Gate('s1', ID, 'https://example.test');
    assert.deepEqual([s1.mode, s1.chainId, s1.contracts.fixture, s1.lockedCopy], ['preview', ID, true, 'This opens as soon as Domino\'s service is live on Elysium.']);
  });
  // Against rugged97's real profile the synthetic fixture binds nothing: the preview falls back to Elysium's own pinned
  // set (none here), so the gate is off, never another chain's set.
  const real = structuredClone(ELYSIUM_PROFILE);
  real.name = 'Elysium';
  await runWith(require, { ...flags, __DOMINO_ELYSIUM_PROFILE__: JSON.stringify(real) }, async () => {
    const gate = require(`${BUILD}v2/gate.js`);
    assert.deepEqual(await gate.v2Gate('s1', ID, 'https://example.test'), { mode: 'off' });
    assert.equal((await gate.v2Gate('s1', 8453, 'https://example.test')).mode, 'preview', 'Base keeps its fixture preview');
  });
});

// Changed on purpose 2026-11-09 (Elysium's day 9, checklist step 5): Kinetiq's explorer is published, so Elysium's rows
// link it, as the three link theirs; until that day they said "none yet" and no link was drawn.
test('on: Elysium\'s explorer rows link Kinetiq\'s explorer, a transaction and a contract, lower case; the three keep theirs', () => {
  const { explorers } = ON;
  const hash = `0x${'AB'.repeat(32)}`;
  assert.equal(explorers.v2TxUrl(ID, hash), `https://elysium.kinetiq.xyz/tx/0x${'ab'.repeat(32)}`);
  assert.equal(explorers.v2ContractUrl(ID, `0x${'CD'.repeat(20)}`), `https://elysium.kinetiq.xyz/address/0x${'cd'.repeat(20)}`);
  assert.equal(explorers.v2TxUrl(ID, '0x1234'), null, 'a malformed hash links nothing');
  for (const chainId of THREE) assert.equal(explorers.v2TxUrl(chainId, hash), OFF.explorers.v2TxUrl(chainId, hash));
  const source = readFileSync(new URL('../../src/lib/elysiumIdentity.ts', import.meta.url), 'utf8');
  assert.match(source, /export const ELYSIUM_EXPLORER: string \| null = 'https:\/\/elysium\.kinetiq\.xyz'/, 'its host, no trailing slash (a day-9 line)');
});

// ---------------------------------------------------------------------------
// On: the wallet's and the session's networks, a position's route
// ---------------------------------------------------------------------------

test('on: the session is kept on Elysium and the wallet switches to it, from the one list; a position there has its own route', () => {
  assert.ok(ON_V2.keptChains().includes(ID));
  assert.deepEqual(ON_V2.keptChains().filter((id) => id !== ID), OFF_V2.keptChains(), 'the rest as before');
  // The wallet's switching and WalletConnect's session take the chain list (src/wallet/port.ts, walletConnectProvider.ts).
  const port = readFileSync(new URL('../../src/wallet/port.ts', import.meta.url), 'utf8');
  assert.match(port, /import \{ V2_CHAIN_IDS \} from '\.\.\/config\/chainIdentity'/);
  assert.match(port, /if \(!V2_CHAIN_IDS\.includes\(chainId\)\) return 'error'/);
  const walletConnect = readFileSync(new URL('../../src/wallet/walletConnectProvider.ts', import.meta.url), 'utf8');
  assert.match(walletConnect, /const CHAINS = ELYSIUM_LIVE \? \[`eip155:\$\{ROBINHOOD\}`, 'eip155:1', 'eip155:8453', 'eip155:42161', `eip155:\$\{ELYSIUM_V2_ID\}`\] : \[`eip155:\$\{ROBINHOOD\}`, 'eip155:1', 'eip155:8453', 'eip155:42161'\]/);
  // `#/positions/elysium-v4-<tokenId>`, both ways; the three keep theirs.
  assert.equal(ON.route.v2PositionHref({ chainId: ID, dex: 4, tokenId: 5n }), '/positions/elysium-v4-5');
  assert.deepEqual({ ...ON.route.parseV2PositionParam('elysium-v4-5') }, { chainId: ID, dex: 4, tokenId: 5n });
  for (const param of ['robinhood-v4-7', 'base-v3-1', 'arbitrum-v4-2']) assert.deepEqual(ON.route.parseV2PositionParam(param), OFF.route.parseV2PositionParam(param), param);
});

// ---------------------------------------------------------------------------
// The services' own answers (docs/ELYSIUM_DAY9.md, "Order")
// ---------------------------------------------------------------------------

// Changed on purpose 2026-11-07 (day-9 rehearsal, finding F8): the package's own version, never a literal, so a day-9
// version move needs only docs/ELYSIUM_DAY9.md step 3.
const V6 = READ_V6_VERSION;
const v6Reply = (chainIds) => ({
  kind: 'reply',
  reply: { status: 200, opaqueRedirect: false, contentType: 'application/json', contractHeader: V6, requestIdHeader: null, retryAfterHeader: null,
    body: { kind: 'text', text: JSON.stringify({ contractVersion: V6, dataMode: 'live_read_only', chainIds, enabledReads: ['portfolio', 'activity'], walletAuthentication: false, privateAccounts: false, ownerTransactions: false, automation: false }) } },
});

test('read-v6\'s capabilities may name Elysium or not, in either build: the reads stay on; the three must still all be there, in order', () => {
  for (const { routes } of [OFF, ON]) {
    for (const chainIds of [[4663, 8453, 42161], [4663, 8453, 42161, ID], [ID, 4663, 8453, 42161]]) {
      assert.deepEqual(routes.routeStateOf('readV6', v6Reply(chainIds)), { on: true, routes: ['portfolio', 'activity'] }, chainIds.join());
    }
    for (const chainIds of [[4663, 8453, ID], [8453, 4663, 42161, ID], [4663, 8453, 42161, ID, ID], [4663, 8453, 42161, '99901'], [4663, 8453, 42161, 0], [4663, 8453, 42161, 1.5], [], 'all']) {
      assert.deepEqual(routes.routeStateOf('readV6', v6Reply(chainIds)), { on: false, reason: 'invalid' }, JSON.stringify(chainIds));
    }
  }
});

/** read-v6's validators as rugged97's day-9 package would answer, which names Elysium (every answer passes here). */
const DAY9_RUNTIME = { CONTRACT_VERSION: V6, ERROR_STATUS_BY_CODE: {}, validateRequest: () => true, validateResponse: () => true, validateExchange: () => true, validateError: () => true };
const WALLET = `0x${'12'.repeat(20)}`;
const status = (chainId, state) => ({ chainId, status: state });
const portfolio = (chains) => ({
  wallet: WALLET, coverage: chains.every((chain) => chain.status === 'current') ? 'complete' : 'partial', chains,
  tokens: chains.map(({ chainId }) => ({ chainId })), vaults: chains.map(({ chainId }) => ({ chainId })), positions: chains.map(({ chainId }) => ({ chainId })),
  mandates: chains.map(({ chainId }) => ({ chainId })), credits: chains.map(({ chainId }) => ({ chainId })),
});
const transport = (body) => ({ kind: 'fixture', post: () => Promise.resolve({ status: 200, body }) });

test('a portfolio or activity answer that names a chain the app does not serve has it left out, its coverage then the served chains\' own; served, it is kept', async () => {
  const four = portfolio([status(4663, 'current'), status(8453, 'current'), status(42161, 'current'), status(ID, 'unavailable')]);
  const off = await OFF.v6.readPortfolio(transport(four), DAY9_RUNTIME, WALLET);
  assert.equal(off.kind, 'ok');
  for (const key of ['chains', 'tokens', 'vaults', 'positions', 'mandates', 'credits']) assert.deepEqual(off.body[key].map((entry) => entry.chainId), THREE, key);
  assert.equal(off.body.coverage, 'complete', 'Elysium, unavailable and not served, no longer makes it partial');
  assert.equal(OFF.v6.coverageNote(off.body.chains), null, 'no sentence about a network this build does not name');
  const on = await ON.v6.readPortfolio(transport(four), DAY9_RUNTIME, WALLET);
  assert.deepEqual(on.body, four, 'served, the answer is the service\'s own');
  assert.equal(ON.v6.coverageNote(on.body.chains), 'Showing Robinhood Chain, Base and Arbitrum One. Elysium is unavailable right now.');
  // Activity's items too.
  const activity = { wallet: WALLET, coverage: 'partial', chains: [status(4663, 'current'), status(ID, 'stale')], tokens: [], items: [{ chainId: 4663 }, { chainId: ID }], nextCursor: null };
  const read = await OFF.v6.readActivity(transport(activity), DAY9_RUNTIME, WALLET);
  assert.deepEqual([read.body.items.map((item) => item.chainId), read.body.coverage], [[4663], 'complete']);
  // An answer of the three is returned as it is, the very object: today's answers pass untouched.
  const three = portfolio([status(4663, 'current'), status(8453, 'stale'), status(42161, 'current')]);
  assert.equal((await OFF.v6.readPortfolio(transport(three), DAY9_RUNTIME, WALLET)).body, three);
  assert.equal((await ON.v6.readPortfolio(transport(three), DAY9_RUNTIME, WALLET)).body, three);
});
