/**
 * The V2 manifest pins, checked against the bytes the build imports (spec F7 rev2 §7.3 point 1), in the pattern of
 * tests/contract-pin.test.mjs: every pinned manifest file hashes to its SHA-256, is its own canonical JSON (one value per
 * key, as the backend's parse_manifest demands) within the backend's size bound, parses for its own chain under the
 * production admission and passes the CREATE3 prediction; and so does every fixture file, under the fork-rehearsal
 * admission. The deployable map and its pins name the same chains, each map entry is the very file its pin names, and
 * every deployed chain shows the same Domino addresses (CREATE3, spec §1.3).
 *
 * Line endings matter: a checkout that rewrites a manifest to CRLF changes its digest and fails here. That is the
 * correct outcome, not a flake.
 *
 * Changed on purpose (data) 2026-10-02 (Domino V2 rev2 §7): the #302 format; the fixtures are #302's fork-rehearsal
 * manifests, byte for byte.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { keccak256, stringToHex } from 'viem';
import { elysiumSwitch } from '../../scripts/elysium-switch.mjs';
import { loadWith } from './support/elysium-live.mjs';

const require = createRequire(import.meta.url);
const manifest = require('../../.test-build/app/src/v2/manifest.js');
const fixtures = require('../../.test-build/app/src/v2/manifestFixtures.js');
const deployment = require('../../.test-build/app/src/finance/v2/deployment.js');
const chains = require('../../.test-build/app/src/v2/chains.js');

const REPO = resolve(import.meta.dirname, '../../..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** git's blob id of a file's bytes, to name where a fixture came from. */
const gitBlob = (bytes) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
const CHAINS = [4663, 8453, 42161];
const SLUGS = { 4663: 'robinhood', 8453: 'base', 42161: 'arbitrum' };

/**
 * Changed on purpose 2026-11-06 (review of the v4-only build, F3): two records agree on every contract both hold, and each
 * holds exactly its own versions' (13 with Uniswap v3 and v4, nine with v4 alone: src/v2/manifest.ts componentsFor), so a
 * chain with v4 alone (Elysium, docs/ELYSIUM_DAY9.md) fits beside the three without editing these checks.
 */
function sameWhereShared(a, b, what) {
  for (const key of Object.keys(a).filter((name) => Object.hasOwn(b, name))) assert.deepEqual(a[key], b[key], `${what}: ${key}`);
}
const ownComponents = (raw) => [...manifest.componentsFor(manifest.manifestDexes(raw))].sort();

/** What the backend's parse_manifest and the pin need of a file's bytes: LF, the bound, and one value per key. */
function wellFormedFile(bytes, path) {
  assert.ok(!bytes.includes('\r'), `${path} has LF endings`);
  assert.ok(bytes.length <= manifest.MAX_MANIFEST_BYTES, `${path} is within the backend's ${manifest.MAX_MANIFEST_BYTES} bytes`);
  const text = bytes.toString('utf8');
  // deploy.mjs writeJson's own output: a duplicate key, a float or any hand edit would not survive this round trip.
  assert.equal(`${JSON.stringify(JSON.parse(text), null, 2)}\n`, text, `${path} is its own canonical JSON (no duplicate key)`);
  return JSON.parse(text);
}

test('every deployable manifest is pinned, its file hashes to the pin, it is the file the map imports, and it passes production admission', () => {
  const deployed = Object.keys(manifest.V2_DEPLOYMENTS).map(Number).sort();
  assert.deepEqual(Object.keys(manifest.V2_MANIFEST_PINS).map(Number).sort(), deployed, 'the map and its pins name the same chains');
  for (const chainId of deployed) {
    const pin = manifest.V2_MANIFEST_PINS[chainId];
    assert.match(pin.path, new RegExp(`^docs/deployments/v2-${SLUGS[chainId]}-${chainId}-\\d{4}-\\d{2}-\\d{2}/deployment\\.json$`), pin.path);
    assert.match(pin.sha256, /^[0-9a-f]{64}$/);
    const bytes = readFileSync(join(REPO, pin.path));
    assert.equal(sha256(bytes), pin.sha256, `${pin.path} drifted from its pin`);
    assert.deepEqual(manifest.V2_DEPLOYMENTS[chainId], wellFormedFile(bytes, pin.path), 'the map holds the pinned file');
    const contracts = manifest.parseV2Manifest(manifest.V2_DEPLOYMENTS[chainId], chainId);
    assert.equal(contracts.fixture, false);
    assert.equal(contracts.deployment.admission, 'production');
    deployment.checkV2Prediction(contracts.deployment);
    deployment.admitV2Contracts(chains.v2Chain(chainId), contracts);
    assert.equal(manifest.v2Availability(chainId).available, true);
  }
  const records = deployed.map((chainId) => manifest.parseV2Manifest(manifest.V2_DEPLOYMENTS[chainId], chainId).deployment.contracts);
  for (const [index, chainId] of deployed.entries()) assert.deepEqual(Object.keys(records[index]).sort(), ownComponents(manifest.V2_DEPLOYMENTS[chainId]), `${chainId}: its versions' contracts`);
  for (const record of records.slice(1)) sameWhereShared(record, records[0], 'every deployed chain shows the same Domino addresses');
});

test('every fixture file hashes to its pin, is #302\'s own file byte for byte, and the module holds the file\'s content', () => {
  assert.deepEqual(Object.keys(fixtures.FIXTURE_PINS).map(Number).sort(), CHAINS.slice().sort());
  // The git blobs of docs/deployments/v2-rehearsal-2026-10-02/<slug>-<chainId>-deployment.json on main (597bcb7b, #302
  // merged; Changed on purpose (data) 2026-10-03: the merged rehearsal, with the owner's real roles).
  const BLOBS = { 4663: 'caaa7a131e2cc0d33b4e4ca179bcbf6da9ca9690', 8453: 'fcf341afac596b675d418219cd72c99334cf12c9', 42161: 'c04f55d37ce8327fc84b510af49c919784898559' };
  for (const chainId of CHAINS) {
    const pin = fixtures.FIXTURE_PINS[chainId];
    assert.equal(pin.path, `app/src/v2/fixtures/manifest.${SLUGS[chainId]}-${chainId}.fixture.json`);
    const bytes = readFileSync(join(REPO, pin.path));
    assert.equal(sha256(bytes), pin.sha256, `${pin.path} drifted from its pin`);
    assert.equal(gitBlob(bytes), BLOBS[chainId], `${pin.path} is #302's rehearsal manifest`);
    const raw = wellFormedFile(bytes, pin.path);
    assert.deepEqual(fixtures.FIXTURE_MANIFESTS[chainId], raw);
    const contracts = fixtures.parseFixtureManifest(raw, chainId);
    assert.equal(contracts.chainId, chainId);
    deployment.checkV2Prediction(contracts.deployment);
    deployment.admitV2Contracts(chains.v2Chain(chainId), contracts);
  }
});

test('the fixtures keep CREATE3\'s property: the same 13 addresses and salts on every chain, from the owner\'s deployer: production\'s own addresses', () => {
  const raws = CHAINS.map((chainId) => fixtures.FIXTURE_MANIFESTS[chainId]);
  for (const raw of raws) assert.deepEqual(Object.keys(raw.contracts).sort(), ownComponents(raw));
  for (const raw of raws.slice(1)) {
    sameWhereShared(raw.contracts, raws[0].contracts, 'contracts');
    assert.deepEqual([raw.createx.address, raw.createx.runtimeCodeHash], [raws[0].createx.address, raws[0].createx.runtimeCodeHash]);
    sameWhereShared(raw.createx.salts, raws[0].createx.salts, 'salts');
    sameWhereShared(raw.createx.guardedSalts, raws[0].createx.guardedSalts, 'guardedSalts');
    assert.deepEqual(raw.roles, raws[0].roles);
  }
  const [robinhood, base, arbitrum] = CHAINS.map((chainId) => fixtures.fixtureContracts(chainId));
  assert.deepEqual(base.addresses, robinhood.addresses);
  assert.deepEqual(arbitrum.addresses, robinhood.addresses);
  // Constructors bind each chain's dependencies and EIP-712 domain: most code hashes differ by chain (the registry's,
  // the factories' and the v4 steps' do not: nothing chain-specific is immutable in them).
  assert.notEqual(base.codeHashes.zapV3, robinhood.codeHashes.zapV3);
  assert.notEqual(arbitrum.codeHashes.autoExit, robinhood.codeHashes.autoExit);
  assert.equal(arbitrum.codeHashes.registry, robinhood.codeHashes.registry);
  // Changed on purpose (data) 2026-10-03 (#302 merged): the rehearsal carries the owner's real deployer (docs/v2/DEPLOYMENT.md),
  // so its 13 addresses are the very ones the production deployment will have (spec §7.2's table).
  assert.equal(raws[0].roles.deployer, '0x706627e3e75b0603c4b6f9a1ebbfc635da712747');
  const production = deployment.predictV2Deployment('0x706627E3E75b0603c4B6f9a1eBBfc635dA712747');
  const lower = (values) => Object.values(values).map((value) => String(value).toLowerCase()).sort();
  assert.deepEqual(lower(raws[0].contracts), lower(production.contracts));
});

test('every fixture salt is deployer ‖ 0x00 ‖ bytes11(keccak256("domino.v2.<component>")) (F0 "Deterministic deployment")', () => {
  for (const chainId of CHAINS) {
    const raw = fixtures.FIXTURE_MANIFESTS[chainId];
    assert.deepEqual(Object.keys(raw.createx.salts), [...manifest.deployOrderFor(manifest.manifestDexes(raw))]);
    for (const [component, salt] of Object.entries(raw.createx.salts)) {
      const tail = keccak256(stringToHex(`domino.v2.${component}`)).slice(2, 24);
      assert.equal(salt, `${raw.roles.deployer}00${tail}`, component);
    }
  }
});

// Added 2026-11-07 (Elysium as a fourth V2 chain; docs/ELYSIUM_DAY9.md section 2, step 9): the checks above, on
// rugged97's real record, once the repository turns Elysium on (scripts/elysium-switch.mjs). The compiled modules are
// loaded with the very defines the release build writes (its profile, its pinned record's text and pin), so the map
// holds the pinned file, it passes the production admission for 99901, the CREATE3 prediction and the money clients'
// admission, holds its nine contracts, and shows the same Domino addresses as the other three where both hold one.
// Until then it is skipped, naming what is still to come.
test('Elysium\'s pinned record, once day 9 is in the repository: the file the pin names, admitted for production on 99901, the same addresses', (t) => {
  const repository = elysiumSwitch({ row: { testHooks: false, deployable: true, site: true }, appRoot: resolve(REPO, 'app') });
  if (!repository.live) return t.skip(`Elysium is off; still to come: ${repository.missing.map((entry) => entry.piece).join(', ')}`);
  const flags = {
    __DOMINO_ELYSIUM_LIVE__: true,
    __DOMINO_ELYSIUM_PROFILE__: repository.profile,
    __DOMINO_ELYSIUM_DEPLOYMENT__: repository.deployment.text,
    __DOMINO_ELYSIUM_DEPLOYMENT_PIN__: { path: repository.deployment.path, sha256: repository.deployment.sha256 },
  };
  const on = loadWith(require, flags, () => ({
    manifest: require('../../.test-build/app/src/v2/manifest.js'),
    deployment: require('../../.test-build/app/src/finance/v2/deployment.js'),
    chains: require('../../.test-build/app/src/v2/chains.js'),
  }));
  const pin = on.manifest.V2_MANIFEST_PINS[99901];
  assert.match(pin.path, /^docs\/deployments\/v2-elysium-99901-\d{4}-\d{2}-\d{2}\/deployment\.json$/, pin.path);
  const bytes = readFileSync(join(REPO, pin.path));
  assert.equal(sha256(bytes), pin.sha256, `${pin.path} drifted from its pin`);
  assert.deepEqual(on.manifest.V2_DEPLOYMENTS[99901], wellFormedFile(bytes, pin.path), 'the map holds the pinned file');
  const contracts = on.manifest.parseV2Manifest(on.manifest.V2_DEPLOYMENTS[99901], 99901);
  assert.deepEqual([contracts.fixture, contracts.deployment.admission], [false, 'production']);
  on.deployment.checkV2Prediction(contracts.deployment);
  on.deployment.admitV2Contracts(on.chains.v2Chain(99901), contracts);
  assert.equal(on.manifest.v2Availability(99901).available, true);
  assert.deepEqual(Object.keys(contracts.deployment.contracts).sort(), ownComponents(on.manifest.V2_DEPLOYMENTS[99901]));
  assert.equal(Object.keys(contracts.deployment.contracts).length, 9, 'Uniswap v4 alone: nine contracts');
  for (const chainId of CHAINS) {
    sameWhereShared(contracts.deployment.contracts, on.manifest.parseV2Manifest(on.manifest.V2_DEPLOYMENTS[chainId], chainId).deployment.contracts, `99901 and ${chainId}: the same Domino addresses`);
  }
});
