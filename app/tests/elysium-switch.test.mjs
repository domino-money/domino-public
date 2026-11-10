/**
 * Elysium's switch (added 2026-11-06, the Elysium surface; scripts/elysium-switch.mjs): one build-time fact, "Elysium is
 * live", and its second, "funds can come from Elysium", true only when crosschain-v1 also pins a bridge for it. Checked
 * both ways on the switch itself and through Vite on the real vite.config.ts (resolveConfig, as tests/build-guard.test.mjs
 * does: no bundle, no file written):
 *   - the repository decides for every build; today it holds none of the day-9 pieces, so every build has Elysium off;
 *   - the test override (DOMINO_TEST_ELYSIUM_PROFILE) turns it on in the test builds only, beside their usual directory;
 *     the release build (npm run release:build = vite build in production mode) and every other build ignore it;
 *   - a live build without Elysium's official mark fails, so day 9 never ships without the owner's file.
 * Changed on purpose 2026-11-07: the owner supplied Kinetiq's mark as a PNG, now public/chains/elysium.png in the
 * repository; it must be a square PNG image, and the forced test builds draw it too (the test-only placeholder is gone).
 * Changed on purpose 2026-11-07 (Elysium as a fourth V2 chain, switched on by itself): live is every day-9 piece in the
 * repository, the enabled profile, the deployment record, our pin of that record (ELYSIUM_RECORD_PIN), read-v6 and
 * position-plan naming 99901, and no longer "the app's chain list names 99901" (the list follows the switch now). Any
 * piece missing leaves Elysium off, the build green, and the switch saying which; a pin that is written but does not
 * match its record is the one hand-written piece that fails here, as the other chains' pins do.
 * Added 2026-11-07 (Elysium's pre-launch): a third stage between off and live, while Elysium is not live and
 * ELYSIUM_OPENS_ON is a day; live always wins, a forced test build included; a typo in the day fails at once, whatever
 * the stage; no environment variable changes it; and every mode writes the stage and the opening's words in as defines.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';
import { resolveConfig } from 'vite';
import { CONSTANTS } from '../../api-contracts/crosschain-v1/schema-data.mjs';
import { FIXTURE_RECORD, PROFILE_FAULTS, RECORD, RECORD_FAULTS, recordBytes } from './support/elysium-faults.mjs';
import { CONSTANTS as PLAN } from '../../api-contracts/position-plan-v1/schema-data.mjs';
import { CONSTANTS as READ_V6 } from '../../api-contracts/read-v6/schema-data.mjs';
import {
  CONTRACT_NAMES, ELYSIUM_OPENS_ON, ELYSIUM_RECORD_PIN, ELYSIUM_SLUG, ELYSIUM_V2_ID, MARK_PATH, OVERRIDE_FUNDS_FROM, OVERRIDE_FUNDS_TO, OVERRIDE_PROFILE, PIECES, V4_ONLY_CONTRACTS,
  bridgeNamed, destinationPinned, elysiumSwitch, enabledProfileIn, isTestBuild, openingOf, originPinned, planNames, profileRefusal, readV6Names, recordRefusal, recordsIn, squarePngSide,
  switchDiagnostic,
} from '../scripts/elysium-switch.mjs';

const APP = resolve(import.meta.dirname, '..');
const REPO = resolve(APP, '..');
const CONFIG = join(APP, 'vite.config.ts');
const PROFILES = join(REPO, 'api-contracts', 'v2', 'chains');
const FIXTURE = 'tests/fixtures/v2-chains/elysium-99901.json';
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixture = json(join(APP, FIXTURE));
const placeholder = json(join(APP, 'tests/fixtures/v2-chains/elysium.json'));
/** The fixture profile's stable (its rank-1 charge currency that is not native), lowercase: a forced funds build's one destination (2026-11-09). */
const STABLE = fixture.chargeCurrencies.find((currency) => currency.rank === 1 && currency.address.toLowerCase() !== `0x${'0'.repeat(40)}`).address.toLowerCase();
const testnet = json(join(APP, 'tests/fixtures/v2-chains/elysium-99801.json'));
/**
 * A nine-contract record of chain 99901 to stand in for rugged97's: the fork-rehearsal fixture (src/v2/manifestFixtures.ts)
 * as a production record has it. Changed on purpose 2026-11-07 (day-9 rehearsal, finding F6): a live build now refuses a
 * pinned record the production admission refuses, so the stand-in is the fixture made a public-chain-preparation record
 * verified at `finalized`, everything else its own (the synthetic profile's dependencies, code hashes and currencies:
 * ./support/elysium-faults.mjs RECORD).
 */
const RECORD_BYTES = recordBytes(RECORD);
const RECORD_PATH = 'docs/deployments/v2-elysium-99901-2026-11-09/deployment.json';
const RECORD_PIN = Object.freeze({ path: RECORD_PATH, sha256: sha256(RECORD_BYTES) });
/**
 * read-v6 and position-plan as they stand before day 9, whatever the repository's packages name (changed on purpose
 * 2026-11-07, review finding A: the cases below stood for "missing" with the repository's own constants, which name 99901
 * from rugged97's day-9 versions, so they would have turned live, and red, on his pull request), and as his day-9 versions
 * will have them: naming 99901 beside the three.
 */
const READ_V6_THREE = Object.freeze(READ_V6.chainIds.filter((id) => id !== ELYSIUM_V2_ID));
const PLAN_THREE = Object.freeze(Object.fromEntries(Object.entries(PLAN.chains).filter(([id]) => id !== String(ELYSIUM_V2_ID))));
const READ_V6_DAY9 = [...READ_V6_THREE, ELYSIUM_V2_ID];
const PLAN_DAY9 = { ...PLAN_THREE, [ELYSIUM_V2_ID]: { ...PLAN.chains['42161'], name: 'elysium-99901' } };
const OFFICIAL = join(APP, 'public', 'chains', 'elysium.png');
/** The owner's file, as the temporary repositories below carry it. */
const MARK = readFileSync(OFFICIAL);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="9"/></svg>';
/** A PNG's signature and IHDR chunk (CRC left zero: only the header is read), `width` by `height`. */
function pngHeader(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

const ROWS = {
  production: { testHooks: false, deployable: true, site: true },
  'preview-v2': { testHooks: false, deployable: false, site: true },
  fixtures: { testHooks: false, deployable: false, site: false },
  'wallet-test-v2': { testHooks: true, deployable: false, site: false },
};
/** The modes whose rows are test builds (vite.config.ts MODES: test hooks on, neither deployable nor the site), and the others. */
const TEST_MODES = ['wallet-test', 'consumer-test', 'v2-test', 'wallet-test-v2'];
const OTHER_MODES = ['production', 'development', 'preview-v2', 'fixtures', 'bridge-test'];
/** The compiled modules (.test-build, which scripts/test.mjs compiles before it runs this file). */
const built = createRequire(import.meta.url);
/** What the repository says today, whatever the day: every day-9 piece is there, or not. */
const REPOSITORY = elysiumSwitch({ row: ROWS.production, appRoot: APP });
/**
 * Whether the crosschain-v1 package in the repository pins a bridge for 99901 (added 2026-11-09: rugged97's #488 pins Relay
 * there). The assertions below hold in either state, so neither pull request has to edit the other's.
 */
const PINNED = originPinned(CONSTANTS.chains);
const { 99901: _elysiumChain, ...UNPINNED } = CONSTANTS.chains;
const { 99901: _elysiumDestinations, ...UNLISTED } = CONSTANTS.destinations;
const REPO_LIVE = REPOSITORY.live;

const temps = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
/**
 * A repository of its own: app/ with or without public/chains/elysium.png, api-contracts/v2/chains holding `profiles`,
 * and docs/deployments holding `records` ({ path: bytes }, paths from the root).
 */
function repository(profiles, mark = null, records = {}) {
  const root = mkdtempSync(join(tmpdir(), 'domino-elysium-'));
  temps.push(root);
  const app = join(root, 'app');
  mkdirSync(join(app, 'public', 'chains'), { recursive: true });
  mkdirSync(join(root, 'api-contracts', 'v2', 'chains'), { recursive: true });
  profiles.forEach((profile, index) => writeFileSync(join(root, 'api-contracts', 'v2', 'chains', `profile-${index}.json`), typeof profile === 'string' ? profile : JSON.stringify(profile)));
  for (const [path, bytes] of Object.entries(records)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), bytes);
  }
  if (mark !== null) writeFileSync(join(app, 'public', MARK_PATH), mark);
  return app;
}
/** Day 9 in a repository of its own: the profile, the record, its pin, read-v6 and position-plan naming 99901. */
const DAY9_RECORDS = { [RECORD_PATH]: RECORD_BYTES };
const day9 = (app, extra = {}) => elysiumSwitch({ row: ROWS.production, appRoot: app, pin: RECORD_PIN, readV6Chains: READ_V6_DAY9, planChains: PLAN_DAY9, ...extra });
const pieces = (result) => result.missing.map((entry) => entry.piece);

/** The real vite.config.ts resolved for `mode` with `env` set for this resolution only. */
async function resolved(mode, env = {}) {
  const saved = Object.fromEntries([OVERRIDE_PROFILE, OVERRIDE_FUNDS_FROM, OVERRIDE_FUNDS_TO].map((name) => [name, process.env[name]]));
  for (const name of Object.keys(saved)) delete process.env[name];
  Object.assign(process.env, env);
  try {
    return await resolveConfig({ root: APP, configFile: CONFIG, mode, logLevel: 'silent' }, 'build', mode);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
// Changed on purpose 2026-11-09 (Elysium's day 9): and whether funds can be brought to it, the third fact.
const flags = (config) => [config.define.__DOMINO_ELYSIUM_LIVE__, config.define.__DOMINO_ELYSIUM_FUNDS_FROM__, config.define.__DOMINO_ELYSIUM_FUNDS_TO__];
/** Added 2026-11-07 (Elysium's pre-launch): the stage's two defines, as the build writes them. */
const prelaunch = (config) => [config.define.__DOMINO_ELYSIUM_PRELAUNCH__, config.define.__DOMINO_ELYSIUM_OPENING__];
/** What they are for the repository's own stage. */
const REPO_PRELAUNCH = [JSON.stringify(REPOSITORY.stage === 'prelaunch'), JSON.stringify(REPOSITORY.opening)];
const NOT_PRELAUNCH = ['false', 'null'];
const NOV_9 = Object.freeze({ at: [2026, 11, 9], short: 'Nov 9', long: 'November 9' });
const files = (config) => [config.define.__DOMINO_ELYSIUM_PROFILE__, config.define.__DOMINO_ELYSIUM_DEPLOYMENT__, config.define.__DOMINO_ELYSIUM_DEPLOYMENT_PIN__];
// Changed on purpose 2026-11-09 (Elysium's day 9): the funds build forces funds to Elysium too (scripts/build-elysium-test.mjs).
const FORCED = { [OVERRIDE_PROFILE]: FIXTURE, [OVERRIDE_FUNDS_FROM]: '1', [OVERRIDE_FUNDS_TO]: '1' };

test('an enabled profile of chain 99901 is the profile piece; the placeholder, another chain or a disabled one never is', () => {
  assert.equal(ELYSIUM_V2_ID, 99901);
  assert.equal(enabledProfileIn(join(repository([placeholder, testnet, { ...fixture, enabled: false }, { ...fixture, chainId: '99901' }, '{ not json']), '..', 'api-contracts', 'v2', 'chains')), null);
  const app = repository([placeholder, fixture], MARK);
  const found = enabledProfileIn(join(app, '..', 'api-contracts', 'v2', 'chains'));
  assert.equal(found.profile.chainId, 99901);
  assert.deepEqual(JSON.parse(found.text), fixture, 'the file\'s own text, which a live build carries');
  // The fixture is v4-only, the shape Elysium launches with (6 Nov 2026: Uniswap v4 only, HYPE gas), and rugged97's:
  // HYPE priced by a hookless native HYPE/USDC v4 pool named by its id (backend/tests/v2_hype_chain.py document(dexes=(4,))).
  assert.equal(fixture.uniswap.v3, null);
  assert.equal(fixture.nativeSymbol, 'HYPE');
  assert.deepEqual(fixture.bridge.providers, []);
  assert.deepEqual(Object.keys(fixture.gasPrice.poolNativeUsd), ['dex', 'poolId', 'currency', 'stable', 'fee', 'tickSpacing']);
  assert.equal(existsSync(join(APP, 'tests/fixtures/v2-chains/elysium-99901-v4.json')), false, 'one synthetic 99901 profile, not two');
});

test('every day-9 piece there: live, carrying the profile\'s text and the pinned record\'s; funds come from it only once crosschain-v1 pins a bridge there', () => {
  assert.deepEqual([...PIECES], ['profile', 'record', 'pin', 'readV6', 'plan']);
  const app = repository([placeholder, fixture], MARK, DAY9_RECORDS);
  const live = day9(app);
  assert.equal(live.live, true);
  assert.deepEqual(live.missing, []);
  assert.equal(switchDiagnostic(live), null);
  // Changed on purpose 2026-11-09 (rugged97's #488 pins Relay for 99901): funds come from Elysium exactly when the package
  // pins a bridge there, and never without that pin.
  assert.equal(live.fundsFrom, PINNED, 'as crosschain-v1 pins a bridge for 99901 or not');
  assert.equal(day9(app, { chains: UNPINNED }).fundsFrom, false, 'no bridge pinned for 99901: no funds from it');
  assert.equal(live.forced, false);
  assert.equal(live.outDirSuffix, '');
  assert.deepEqual(JSON.parse(live.profile), fixture);
  assert.deepEqual(live.deployment, { path: RECORD_PATH, sha256: RECORD_PIN.sha256, text: RECORD_BYTES.toString('utf8') }, 'the pinned file, byte for byte');
  assert.deepEqual(live.uniswap, { positionManager: fixture.uniswap.v4.positionManager.toLowerCase(), permit2: fixture.permit2.toLowerCase() });
  const pinned = { ...CONSTANTS.chains, 99901: { name: 'Elysium', relay: { depository: `0x${'12'.repeat(20)}` } } };
  assert.equal(day9(app, { chains: pinned }).fundsFrom, true);
  // Off, the bridge's pin alone changes nothing.
  assert.equal(day9(repository([placeholder], MARK, DAY9_RECORDS), { chains: pinned }).fundsFrom, false);
});

// Added 2026-11-09 (Elysium's day 9, the owner: funds brought to Elysium from other networks as on Base): the third fact
// turns on by itself the day rugged97's profile names a bridge and crosschain-v1 pins one for 99901 and lists what a
// deposit may deliver there; any one of the three missing leaves it off, and today it is off.
test('funds are brought to Elysium only once its profile names a bridge and crosschain-v1 pins one for 99901 and lists its destinations', () => {
  const USDC = '0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65';
  const pinned = { ...CONSTANTS.chains, 99901: { name: 'Elysium', relay: { depository: `0x${'12'.repeat(20)}` } } };
  const listed = { ...CONSTANTS.destinations, 99901: [USDC] };
  const bridged = { ...fixture, bridge: { ...fixture.bridge, providers: ['relay'] } };
  const withBridge = repository([placeholder, bridged], MARK, DAY9_RECORDS);
  const all = day9(withBridge, { chains: pinned, destinations: listed });
  assert.deepEqual([all.live, all.fundsTo, all.destinations], [true, true, [USDC.toLowerCase()]]);
  const without = [
    ['no bridge in the profile', day9(repository([placeholder, fixture], MARK, DAY9_RECORDS), { chains: pinned, destinations: listed })],
    ['no pin in crosschain-v1', day9(withBridge, { chains: UNPINNED, destinations: listed })],
    ['no destinations in crosschain-v1', day9(withBridge, { chains: pinned, destinations: UNLISTED })],
    ['an empty destination list', day9(withBridge, { chains: pinned, destinations: { ...CONSTANTS.destinations, 99901: [] } })],
    ['Elysium off', day9(repository([placeholder], MARK, DAY9_RECORDS), { chains: pinned, destinations: listed })],
  ];
  for (const [why, result] of without) assert.deepEqual([result.fundsTo, result.destinations], [false, null], why);
  // The repository as it stands (changed on purpose 2026-11-09, rugged97's #488): on, with what the package lists, exactly
  // when Elysium is live, its profile names a bridge and crosschain-v1 pins one and lists destinations there.
  const repositoryProfile = REPOSITORY.profile ? JSON.parse(REPOSITORY.profile) : null;
  const listedThere = destinationPinned(CONSTANTS.destinations);
  const expected = REPOSITORY.live && bridgeNamed(repositoryProfile) && PINNED && listedThere !== null;
  assert.equal(REPOSITORY.fundsTo, expected);
  assert.deepEqual(REPOSITORY.destinations, expected ? listedThere : null);
  assert.deepEqual(destinationPinned({ 99901: [USDC, USDC.toLowerCase()] }), [USDC.toLowerCase()], 'lowercase, each once');
  assert.equal(destinationPinned({ 99901: ['HYPE'] }), null, 'only addresses');
  assert.deepEqual([bridgeNamed(fixture), bridgeNamed(bridged), bridgeNamed(null)], [false, true, false]);
});

// Added 2026-11-07 (Elysium as a fourth V2 chain): rugged97's pull request may land any part of the pieces first.
test('each piece missing on its own leaves Elysium off, the build green with no mark asked for, and the switch naming exactly that piece', () => {
  const off = (result) => [result.live, result.fundsFrom, result.profile, result.deployment, result.uniswap, result.profileFile];
  const OFF = [false, false, null, null, null, null];
  const drifted = Buffer.concat([RECORD_BYTES, Buffer.from(' ')]);
  const cases = [
    ['profile', repository([placeholder], null, DAY9_RECORDS), {}],
    ['record', repository([fixture]), {}],
    ['pin', repository([fixture], null, DAY9_RECORDS), { pin: null }],
    ['pin', repository([fixture], null, DAY9_RECORDS), { pin: { ...RECORD_PIN, sha256: 'ab'.repeat(32) } }],
    ['pin', repository([fixture], null, { [RECORD_PATH]: drifted }), {}],
    ['pin', repository([fixture], null, DAY9_RECORDS), { pin: { ...RECORD_PIN, path: 'docs/deployments/v2-elysium-99901-2026-11-10/deployment.json' } }],
    ['pin', repository([fixture], null, DAY9_RECORDS), { pin: { path: RECORD_PATH } }],
    ['readV6', repository([fixture], null, DAY9_RECORDS), { readV6Chains: READ_V6_THREE }],
    ['plan', repository([fixture], null, DAY9_RECORDS), { planChains: PLAN_THREE }],
  ];
  for (const [piece, app, extra] of cases) {
    // No mark in these repositories: a build that stays off never asks for it.
    const result = day9(app, extra);
    assert.deepEqual(off(result), OFF, piece);
    assert.deepEqual(pieces(result), [piece], piece);
    assert.match(switchDiagnostic(result), /^Elysium stays off until: .+\.$/, piece);
  }
  // Its words name the piece and what to do about it.
  assert.match(day9(repository([fixture], null, DAY9_RECORDS), { pin: null }).missing[0].detail, /docs\/deployments\/v2-elysium-99901-2026-11-09\/deployment\.json is not pinned: write its SHA-256 into scripts\/elysium-switch\.mjs ELYSIUM_RECORD_PIN/);
  assert.match(day9(repository([fixture], null, { [RECORD_PATH]: drifted }), {}).missing[0].detail, new RegExp(`SHA-256 is ${sha256(drifted)}, but ELYSIUM_RECORD_PIN says ${RECORD_PIN.sha256}`));
  assert.match(day9(repository([fixture], null, DAY9_RECORDS), { readV6Chains: READ_V6_THREE }).missing[0].detail, /read-v6 .* does not name chain 99901/);
  assert.match(day9(repository([fixture], null, DAY9_RECORDS), { planChains: PLAN_THREE }).missing[0].detail, /position-plan-v1 .* does not name chain 99901/);
  // A repository holding none of it (today's): off, and nothing printed (no pin entry while there is no record to pin).
  const today = elysiumSwitch({ row: ROWS.production, appRoot: repository([placeholder]), readV6Chains: READ_V6_THREE, planChains: PLAN_THREE });
  assert.deepEqual(pieces(today), ['profile', 'record', 'readV6', 'plan']);
  assert.equal(switchDiagnostic(today), null, 'today\'s builds print what they always did');
  // vite.config.ts hands the switch nothing of the app's own: the chain list follows the switch, never the reverse.
  const config = readFileSync(CONFIG, 'utf8');
  assert.match(config, /const elysium = elysiumSwitch\(\{ row: settings, env: process\.env, appRoot: here\('\.'\) \}\)/);
  assert.match(config, /const elysiumWaits = switchDiagnostic\(elysium\)\n\s+if \(elysiumWaits !== null\) console\.warn\(elysiumWaits\)/);
  assert.doesNotMatch(config, /import \{[^}]*V2_CHAIN_IDS[^}]*\} from/, 'the chain list is not read by the build');
  assert.match(readFileSync(join(APP, 'src/config/chainIdentity.ts'), 'utf8'), /Object\.freeze\(ELYSIUM_LIVE \? \[ROBINHOOD_ID, BASE_ID, ARBITRUM_ID, ELYSIUM_V2_ID\] : \[ROBINHOOD_ID, BASE_ID, ARBITRUM_ID\]\)/);
});

test('the record piece: only docs/deployments/v2-<slug>-99901-<date>/deployment.json counts, never a rehearsal or another chain\'s', () => {
  const app = repository([fixture], null, {
    'docs/deployments/v2-rehearsal-2026-11-08/elysium-99901-deployment.json': RECORD_BYTES,
    'docs/deployments/v2-arbitrum-42161-2026-10-04/deployment.json': RECORD_BYTES,
    'docs/deployments/v2-elysium-999010-2026-11-09/deployment.json': RECORD_BYTES,
    'docs/deployments/v2-elysium-99901-latest/deployment.json': RECORD_BYTES,
    'docs/deployments/v2-elysium-99901-2026-11-09/notes.json': RECORD_BYTES,
  });
  assert.deepEqual(recordsIn(join(app, '..')), []);
  assert.deepEqual(recordsIn(join(repository([], null, DAY9_RECORDS), '..')), [RECORD_PATH]);
  assert.deepEqual(recordsIn(REPO).filter((path) => !path.startsWith('docs/deployments/v2-')), [], 'the repository\'s, as paths from its root');
  assert.equal(readV6Names(READ_V6_DAY9), true);
  assert.equal(readV6Names(READ_V6.chainIds), READ_V6.chainIds.includes(ELYSIUM_V2_ID));
  assert.equal(planNames(PLAN_DAY9), true);
  assert.equal(planNames(PLAN.chains), Object.hasOwn(PLAN.chains, '99901'));
  for (const wrong of [undefined, null, [], '99901', { 99901: true }]) assert.equal(planNames(wrong), false);
});

// Added 2026-11-07: the one hand-written piece, held as the other chains' pins are (tests/v2/manifest-pin.test.mjs).
test('ELYSIUM_RECORD_PIN: none until day 9; once written, it names one of Elysium\'s records and its exact bytes', () => {
  if (ELYSIUM_RECORD_PIN === null) {
    assert.equal(REPOSITORY.deployment, null);
    return;
  }
  assert.ok(Object.isFrozen(ELYSIUM_RECORD_PIN));
  assert.deepEqual(Object.keys(ELYSIUM_RECORD_PIN).sort(), ['path', 'sha256']);
  assert.ok(recordsIn(REPO).includes(ELYSIUM_RECORD_PIN.path), `${ELYSIUM_RECORD_PIN.path} is one of Elysium's records`);
  const bytes = readFileSync(join(REPO, ELYSIUM_RECORD_PIN.path));
  assert.ok(!bytes.includes('\r'), 'LF endings');
  assert.equal(sha256(bytes), ELYSIUM_RECORD_PIN.sha256, `${ELYSIUM_RECORD_PIN.path} drifted from its pin`);
});

// Added 2026-11-07 (day-9 rehearsal, finding F10): a pin written wrong says how, in its own words.
test('a pin written wrong says how: uppercase hex (PowerShell\'s Get-FileHash), a ./ path, or no pin shape at all', () => {
  const wrong = (pin) => day9(repository([fixture], null, DAY9_RECORDS), { pin }).missing.map((entry) => entry.detail);
  assert.deepEqual(wrong({ ...RECORD_PIN, sha256: RECORD_PIN.sha256.toUpperCase() }), ['scripts/elysium-switch.mjs ELYSIUM_RECORD_PIN\'s sha256 must be 64 lowercase hex characters (`git show HEAD:<path> | sha256sum` in Git Bash)']);
  assert.deepEqual(wrong({ ...RECORD_PIN, path: `./${RECORD_PATH}` }), [`scripts/elysium-switch.mjs ELYSIUM_RECORD_PIN's path must start with docs/deployments/ (no ./), not ./${RECORD_PATH}`]);
  assert.deepEqual(wrong({ path: RECORD_PATH }), ['scripts/elysium-switch.mjs ELYSIUM_RECORD_PIN is not a { path, sha256 } pin of a file under docs/deployments']);
  assert.deepEqual(wrong('pin'), ['scripts/elysium-switch.mjs ELYSIUM_RECORD_PIN is not a { path, sha256 } pin of a file under docs/deployments']);
});

// Added 2026-11-07 (day-9 rehearsal, finding F11): the record's folder is named after its profile's slug, as
// scripts/v2/deploy.mjs names it, and Elysium's profile is taken only with Elysium's slug (ELYSIUM_SLUG), so the switch
// takes exactly the record tests/v2/manifest-pin.test.mjs holds; a profile with another slug fails the build (below).
test('the record piece takes the profile\'s own slug: a record under another slug is not Elysium\'s, and the switch says which folder it expects', () => {
  const other = 'docs/deployments/v2-kinetiq-99901-2026-11-09/deployment.json';
  const app = repository([fixture], MARK, { [other]: RECORD_BYTES });
  const result = day9(app, { pin: { path: other, sha256: RECORD_PIN.sha256 } });
  assert.equal(result.live, false);
  assert.deepEqual(pieces(result), ['record']);
  assert.equal(result.missing[0].detail, `docs/deployments holds no deployment record of chain 99901 under Elysium's slug: v2-elysium-99901-<date>/deployment.json is expected, not ${other}`);
  assert.deepEqual(recordsIn(join(app, '..')), [other], 'without a slug, any record of 99901');
  assert.deepEqual(recordsIn(join(app, '..'), 'elysium'), []);
  // Under its own slug, the same bytes are live.
  assert.equal(day9(repository([fixture], MARK, DAY9_RECORDS)).live, true);
  // No profile yet: still Elysium's slug alone.
  assert.deepEqual(pieces(day9(repository([placeholder], null, { [other]: RECORD_BYTES }), { pin: { path: other, sha256: RECORD_PIN.sha256 } })), ['profile', 'record']);
  assert.equal(ELYSIUM_SLUG, 'elysium');
});

// Added 2026-11-07 (day-9 rehearsal, finding F6): the third build failure. Each case below was rehearsed: built green, then
// threw invalid_chain_profile at load in every V2 chunk on all four networks (a profile), or showed Elysium everywhere with
// its contracts unavailable (a record). tests/v2/elysium-build-guard.test.mjs holds each verdict to the app's own parser.
test('a live build fails, naming why, when the app would refuse the repository\'s profile or its pinned record; a forced build is never asked', () => {
  assert.equal(profileRefusal(fixture), null, 'the synthetic profile is one the parser takes');
  assert.equal(recordRefusal(RECORD, fixture), null, 'the stand-in record is one the production admission takes');
  assert.deepEqual(Object.keys(CONTRACT_NAMES), Object.keys(FIXTURE_RECORD.contractNames), 'the 13, in the record\'s order');
  assert.deepEqual([...V4_ONLY_CONTRACTS], Object.keys(FIXTURE_RECORD.contracts), 'the nine, in the record\'s order');
  for (const [what, profile, reason] of PROFILE_FAULTS) {
    assert.match(profileRefusal(profile), reason, what);
    // The record in Elysium's own folder, so even a profile with another slug reaches the guard (and fails the build).
    const app = repository([profile], MARK, DAY9_RECORDS);
    assert.throws(() => day9(app), (error) => /^Elysium is live, but the app's chain parser \(src\/v2\/chains\.ts chainOf\) refuses .*profile-0\.json: /.test(error.message) && reason.test(error.message), what);
  }
  for (const [what, record, reason] of RECORD_FAULTS) {
    assert.match(recordRefusal(record, fixture), reason, what);
    const bytes = recordBytes(record);
    const app = repository([fixture], MARK, { [RECORD_PATH]: bytes });
    assert.throws(() => day9(app, { pin: { path: RECORD_PATH, sha256: sha256(bytes) } }), (error) => error.message.startsWith(`Elysium is live, but the production admission (src/v2/manifest.ts) refuses its pinned record ${RECORD_PATH}: `) && reason.test(error.message), what);
  }
  assert.match(recordRefusal(null, fixture), /not a JSON object/);
  // Off, nothing is asked of them: a broken profile with no record, or a broken record left unpinned, stays off quietly.
  assert.equal(day9(repository([PROFILE_FAULTS[0][1]], MARK)).live, false);
  assert.equal(day9(repository([fixture], MARK, { [RECORD_PATH]: recordBytes(FIXTURE_RECORD) }), { pin: null }).live, false);
  // A forced test build stands in with the fixture profile and no record: never asked.
  const forced = repository([placeholder], MARK);
  mkdirSync(join(forced, 'tests', 'fixtures', 'v2-chains'), { recursive: true });
  writeFileSync(join(forced, FIXTURE), JSON.stringify({ ...fixture, finality: '' }));
  assert.equal(elysiumSwitch({ row: ROWS['wallet-test-v2'], appRoot: forced, env: { [OVERRIDE_PROFILE]: FIXTURE } }).live, true);
});

// Added 2026-11-06 (review of the Elysium surface): Home's "Bring funds from" row and the docs' Bring funds page name
// Elysium once funds can come from it; that is true only where the app itself looks for funds there.
// Changed on purpose 2026-11-07 (Elysium's screens): the app now looks there by itself where funds can come from Elysium
// (ELYSIUM_FUNDS_FROM), so the modules are loaded as the repository's own build has them, with its switch's defines.
test('funds from Elysium only where the app looks for them there: its origins and its balance reads name 99901', async () => {
  const { loadWith } = await import('./v2/support/elysium-live.mjs');
  const defines = { __DOMINO_ELYSIUM_LIVE__: REPO_LIVE, __DOMINO_ELYSIUM_FUNDS_FROM__: REPOSITORY.fundsFrom, __DOMINO_ELYSIUM_PROFILE__: REPOSITORY.profile };
  const { holdings, model } = loadWith(built, defines, () => ({ holdings: built('../.test-build/app/src/finance/v2/holdings.js'), model: built('../.test-build/app/src/v2in/funds/model.js') }));
  const looks = holdings.CANDIDATE_ORIGINS.some((origin) => origin.chainId === ELYSIUM_V2_ID) && model.BALANCE_ORIGINS.includes(ELYSIUM_V2_ID);
  assert.equal(looks, REPOSITORY.fundsFrom, REPOSITORY.fundsFrom ? 'crosschain-v1 pins a bridge for 99901: Home and the docs say funds can come from Elysium, and the app looks there' : 'funds cannot come from Elysium: nothing looks for them there');
});

test('the origins listing can name Elysium only where crosschain-v1 pins Relay or Across for it', () => {
  assert.equal(originPinned(undefined), false);
  assert.equal(originPinned({}), false);
  assert.equal(originPinned({ 99901: { name: 'Elysium' } }), false, 'a name without a pinned bridge');
  assert.equal(originPinned({ 99901: { name: 'Elysium', across: { spokePool: `0x${'34'.repeat(20)}` } } }), true);
  // HyperEVM (999) is not Elysium: a pin there never counts.
  assert.equal(originPinned({ 999: CONSTANTS.chains[999] }), false);
  assert.equal(originPinned(CONSTANTS.chains), Boolean(CONSTANTS.chains[99901]?.relay || CONSTANTS.chains[99901]?.across));
});

// Changed on purpose 2026-11-07: the owner's mark is a PNG; the check is a square PNG image (signature and IHDR), not an
// SVG document.
test('a live build without Elysium\'s official mark fails, loudly; a file that is not a square PNG image fails too', () => {
  assert.throws(() => day9(repository([fixture], null, DAY9_RECORDS)), /its official mark, app\/public\/chains\/elysium\.png, is missing/);
  assert.throws(() => day9(repository([fixture], null, DAY9_RECORDS), { row: ROWS['wallet-test-v2'] }), /is missing/, 'a test build reading the repository is held to it too');
  for (const [wrong, what] of [['PNG not png', 'text'], [SVG, 'an SVG document under the PNG name'], [pngHeader(128, 96), 'a PNG that is not square'], [pngHeader(0, 0), 'a PNG of no size'], [MARK.subarray(0, 24), 'a cut-off PNG']]) {
    assert.throws(() => day9(repository([fixture], wrong, DAY9_RECORDS)), /app\/public\/chains\/elysium\.png is not a square PNG image/, what);
  }
  assert.equal(day9(repository([fixture], pngHeader(64, 64), DAY9_RECORDS)).live, true, 'any square PNG passes the check');
  // Off, nothing is asked of the file.
  assert.equal(day9(repository([placeholder], null, DAY9_RECORDS)).live, false);
  assert.equal(day9(repository([placeholder], 'PNG not png', DAY9_RECORDS)).live, false);
});

test('the owner\'s mark is in the repository: public/chains/elysium.png, a square PNG image of 128 pixels a side', () => {
  assert.equal(MARK_PATH, 'chains/elysium.png');
  assert.equal(squarePngSide(MARK), 128);
  assert.equal(squarePngSide(pngHeader(20, 20)), 20);
  for (const wrong of [Buffer.from(SVG), pngHeader(20, 21), Buffer.alloc(0), 'not bytes', null]) assert.equal(squarePngSide(wrong), 0);
  // The test-only placeholder that forced builds served while the file was missing is gone: no made-up mark anywhere.
  assert.equal(existsSync(join(APP, 'tests', 'fixtures', 'elysium', 'mark-test-placeholder.svg')), false);
});

// Changed on purpose 2026-11-07: a forced test build draws the owner's file, as day 9 will; without it, it fails as a live
// build does (the test-only placeholder is gone). It stands in for the whole of day 9 with the fixture profile alone.
test('the override: honoured by the test builds alone, with the owner\'s mark, and refused when it names anything but an enabled 99901 profile', () => {
  const app = repository([placeholder], MARK);
  // Copied in, since the override is read from app/.
  mkdirSync(join(app, 'tests', 'fixtures', 'v2-chains'), { recursive: true });
  writeFileSync(join(app, FIXTURE), JSON.stringify(fixture));
  for (const [mode, row] of Object.entries(ROWS)) {
    const asked = elysiumSwitch({ row, appRoot: app, env: { [OVERRIDE_PROFILE]: FIXTURE } });
    assert.equal(asked.live, isTestBuild(row), mode);
    assert.equal(asked.forced, isTestBuild(row), mode);
  }
  const forced = elysiumSwitch({ row: ROWS['wallet-test-v2'], appRoot: app, env: { [OVERRIDE_PROFILE]: FIXTURE } });
  // Changed on purpose 2026-11-09 (rugged97's #488): funds come from a forced build's Elysium as the package pins it.
  assert.deepEqual([forced.fundsFrom, forced.outDirSuffix], [PINNED, '-elysium']);
  assert.deepEqual(forced.missing, [], 'a forced build looks for no other piece');
  assert.deepEqual(JSON.parse(forced.profile), fixture);
  assert.equal(forced.deployment, null, 'no production record: its contracts are the fork-rehearsal fixture, under the test admission');
  const funds = elysiumSwitch({ row: ROWS['wallet-test-v2'], appRoot: app, env: FORCED });
  assert.deepEqual([funds.fundsFrom, funds.outDirSuffix], [true, '-elysium-funds']);
  // Added 2026-11-09 (Elysium's day 9): funds brought to it too, its stable alone; forced, or not at all.
  assert.deepEqual([funds.fundsTo, funds.destinations], [true, [STABLE]]);
  assert.deepEqual([forced.fundsTo, forced.destinations], [false, null]);
  const toAlone = elysiumSwitch({ row: ROWS['wallet-test-v2'], appRoot: app, env: { [OVERRIDE_PROFILE]: FIXTURE, [OVERRIDE_FUNDS_TO]: '1' } });
  assert.deepEqual([toAlone.fundsFrom, toAlone.fundsTo, toAlone.outDirSuffix], [PINNED, true, '-elysium-funds']);
  // The funds variables alone turn nothing on, in any build.
  assert.equal(elysiumSwitch({ row: ROWS['wallet-test-v2'], appRoot: app, env: { [OVERRIDE_FUNDS_FROM]: '1' } }).fundsFrom, false);
  assert.equal(elysiumSwitch({ row: ROWS['wallet-test-v2'], appRoot: app, env: { [OVERRIDE_FUNDS_TO]: '1' } }).fundsTo, false);
  for (const [mode, row] of Object.entries(ROWS)) {
    if (!isTestBuild(row)) assert.equal(elysiumSwitch({ row, appRoot: app, env: { [OVERRIDE_PROFILE]: FIXTURE, [OVERRIDE_FUNDS_TO]: '1' } }).fundsTo, false, `${mode} never honours it`);
  }
  // Without the owner's file, a forced build fails too, naming the override: nothing stands in for the mark.
  const bare = repository([placeholder]);
  mkdirSync(join(bare, 'tests', 'fixtures', 'v2-chains'), { recursive: true });
  writeFileSync(join(bare, FIXTURE), JSON.stringify(fixture));
  assert.throws(() => elysiumSwitch({ row: ROWS['wallet-test-v2'], appRoot: bare, env: { [OVERRIDE_PROFILE]: FIXTURE } }), new RegExp(`${OVERRIDE_PROFILE} forces it on with .*is missing`));
  for (const wrong of ['tests/fixtures/v2-chains/elysium-99801.json', 'tests/fixtures/v2-chains/elysium.json', 'tests/fixtures/v2-chains/none.json']) {
    assert.throws(() => elysiumSwitch({ row: ROWS['wallet-test-v2'], appRoot: APP, env: { [OVERRIDE_PROFILE]: wrong } }), /must name an enabled profile of chain 99901/, wrong);
  }
});

test('the repository decides for every build: today Elysium is off everywhere and carries none of its files (on day 9 it is on, with the owner\'s mark)', async () => {
  assert.ok(existsSync(OFFICIAL), 'app/public/chains/elysium.png is the owner\'s official file, in the repository since 7 Nov 2026');
  const expected = REPO_LIVE
    ? [JSON.stringify(REPOSITORY.profile), JSON.stringify(REPOSITORY.deployment.text), JSON.stringify({ path: REPOSITORY.deployment.path, sha256: REPOSITORY.deployment.sha256 })]
    : ['null', 'null', 'null'];
  for (const mode of [...OTHER_MODES, ...TEST_MODES]) {
    const config = await resolved(mode);
    assert.deepEqual(flags(config), [JSON.stringify(REPO_LIVE), JSON.stringify(REPO_LIVE && originPinned(CONSTANTS.chains)), JSON.stringify(REPOSITORY.fundsTo)], mode);
    assert.equal(config.define.__DOMINO_ELYSIUM_DESTINATIONS__, JSON.stringify(REPOSITORY.destinations), mode);
    assert.deepEqual(files(config), expected, `${mode}: the day-9 files exactly where Elysium is live`);
    // Added 2026-11-07 (Elysium's pre-launch): the stage and the opening's words, the repository's own in every mode.
    assert.deepEqual(prelaunch(config), REPO_PRELAUNCH, `${mode}: the repository's stage, ${REPOSITORY.stage}`);
    assert.doesNotMatch(config.build.outDir, /elysium/, `${mode} writes where it always did`);
    assert.equal(config.plugins.some((plugin) => /elysium/i.test(plugin.name)), false, `${mode}: the mark is public/'s file, never a plugin's`);
  }
});

// Added 2026-11-07: the diagnostic the task names, a skipped test with the exact missing piece until day 9 is complete.
test('day 9 in the repository: every piece is there and Elysium is live', (t) => {
  if (!REPO_LIVE) return t.skip(`Elysium is off; still to come: ${REPOSITORY.missing.map((entry) => `${entry.piece} (${entry.detail})`).join('; ')}`);
  assert.deepEqual(REPOSITORY.missing, []);
  assert.equal(REPOSITORY.deployment.path, ELYSIUM_RECORD_PIN.path);
  assert.equal(JSON.parse(REPOSITORY.profile).chainId, ELYSIUM_V2_ID);
  assert.equal(JSON.parse(REPOSITORY.deployment.text).chain.chainId, ELYSIUM_V2_ID);
  // Added 2026-11-07 (review finding P5): the app takes Elysium as the one network with Uniswap v4 alone (its nine-contract
  // deployment, and New position's leads by its id: src/v2in/journey/PoolAdvanced.tsx), as its profile says.
  assert.equal(JSON.parse(REPOSITORY.profile).uniswap.v3, null, 'Elysium\'s profile names no Uniswap v3');
});

// Added 2026-11-07 (Elysium's pre-launch, the owner's order: Elysium on the site before its network opens).
const TODAY = () => repository([placeholder]);
const notLive = (extra) => elysiumSwitch({ row: ROWS.production, appRoot: TODAY(), readV6Chains: READ_V6_THREE, planChains: PLAN_THREE, ...extra });

test('pre-launch: while Elysium is not live and ELYSIUM_OPENS_ON is a day, the stage is prelaunch, with the day and its English words', () => {
  assert.equal(ELYSIUM_OPENS_ON, '2026-11-09', 'Kinetiq\'s announced day, one hand-written line');
  const today = notLive({ opensOn: '2026-11-09' });
  assert.deepEqual([today.live, today.fundsFrom, today.stage], [false, false, 'prelaunch']);
  assert.deepEqual(today.opening, NOV_9);
  assert.deepEqual([today.profile, today.deployment, today.uniswap], [null, null, null], 'nothing of chain 99901 is carried');
  assert.equal(switchDiagnostic(today), null, 'today\'s builds print what they always did');
  assert.deepEqual(notLive({}).opening, openingOf(ELYSIUM_OPENS_ON), 'the default is the hand line');
  // Some pieces there but not all: still not live, so still pre-launch, a test build reading the repository included.
  for (const extra of [{ pin: null }, { readV6Chains: READ_V6_THREE }, { planChains: PLAN_THREE }]) {
    const partial = day9(repository([fixture], null, DAY9_RECORDS), { ...extra, opensOn: '2026-11-09' });
    assert.deepEqual([partial.live, partial.stage, partial.opening], [false, 'prelaunch', NOV_9], JSON.stringify(Object.keys(extra)));
  }
  assert.equal(elysiumSwitch({ row: ROWS['wallet-test-v2'], appRoot: TODAY(), readV6Chains: READ_V6_THREE, planChains: PLAN_THREE, opensOn: '2026-11-09' }).stage, 'prelaunch');
  // Off: no day written.
  const off = notLive({ opensOn: null });
  assert.deepEqual([off.live, off.stage, off.opening], [false, 'off', null]);
  // A day that has passed is no error: the visitor's own date decides the words (src/lib/elysiumOpening.ts).
  assert.deepEqual([notLive({ opensOn: '2026-11-01' }).stage, notLive({ opensOn: '2026-11-01' }).opening], ['prelaunch', { at: [2026, 11, 1], short: 'Nov 1', long: 'November 1' }]);
  // The words: month then day, the site's en-US, no year, no weekday.
  for (const [day, short, long] of [['2027-01-05', 'Jan 5', 'January 5'], ['2026-05-31', 'May 31', 'May 31'], ['2026-09-10', 'Sep 10', 'September 10'], ['2028-02-29', 'Feb 29', 'February 29'], ['2026-12-25', 'Dec 25', 'December 25']]) {
    const words = openingOf(day);
    assert.deepEqual([words.short, words.long], [short, long], day);
    assert.match(words.short, /^[A-Z][a-z]{2} \d{1,2}$/);
    assert.match(words.long, /^[A-Z][a-z]+ \d{1,2}$/);
  }
  assert.equal(openingOf(null), null);
});

test('live always wins: every day-9 piece there, or a forced test build, is live with no pre-launch piece, whatever ELYSIUM_OPENS_ON says', () => {
  const app = repository([placeholder, fixture], MARK, DAY9_RECORDS);
  for (const opensOn of ['2026-11-09', '2026-11-01', '2030-01-01', null]) {
    const live = day9(app, { opensOn });
    assert.deepEqual([live.live, live.stage, live.opening], [true, 'live', null], String(opensOn));
  }
  const forcedApp = repository([placeholder], MARK);
  mkdirSync(join(forcedApp, 'tests', 'fixtures', 'v2-chains'), { recursive: true });
  writeFileSync(join(forcedApp, FIXTURE), JSON.stringify(fixture));
  for (const env of [{ [OVERRIDE_PROFILE]: FIXTURE }, { [OVERRIDE_PROFILE]: FIXTURE, [OVERRIDE_FUNDS_FROM]: '1' }]) {
    const forced = elysiumSwitch({ row: ROWS['wallet-test-v2'], appRoot: forcedApp, env, opensOn: '2026-11-09' });
    assert.deepEqual([forced.forced, forced.live, forced.stage, forced.opening], [true, true, 'live', null]);
  }
});

test('ELYSIUM_OPENS_ON: anything but null or a day that exists fails at once, whatever the stage, naming the line', () => {
  const live = repository([placeholder, fixture], MARK, DAY9_RECORDS);
  const WORDS = /scripts\/elysium-switch\.mjs ELYSIUM_OPENS_ON must be a day, YYYY-MM-DD, or null: /;
  for (const wrong of ['2026-11-31', '2026-02-29', '2026-11-9', '9 Nov 2026', 20261109, '', '2026-13-01', '2026-00-10', '2026-11-09T00:00', ' 2026-11-09', false, {}]) {
    assert.throws(() => notLive({ opensOn: wrong }), WORDS, `${JSON.stringify(wrong)}, before live`);
    assert.throws(() => day9(live, { opensOn: wrong }), WORDS, `${JSON.stringify(wrong)}, live: a typo fails now, not on the day`);
    assert.throws(() => openingOf(wrong), WORDS, JSON.stringify(wrong));
  }
  assert.deepEqual(openingOf('2028-02-29').at, [2028, 2, 29], 'a leap day exists');
});

test('no environment variable changes the stage: the opening day is one reviewed line in the repository', async () => {
  const stage = ELYSIUM_OPENS_ON === null ? 'off' : 'prelaunch';
  const ENVS = [{ DOMINO_TEST_ELYSIUM_OPENS_ON: 'null' }, { DOMINO_TEST_ELYSIUM_OPENS_ON: '2026-12-01' }, { DOMINO_ELYSIUM_OPENS_ON: 'null' }, { DOMINO_ELYSIUM_PRELAUNCH: '0' }, { ELYSIUM_OPENS_ON: '' }];
  for (const env of ENVS) {
    for (const [mode, row] of Object.entries(ROWS)) {
      const result = elysiumSwitch({ row, env, appRoot: TODAY(), readV6Chains: READ_V6_THREE, planChains: PLAN_THREE });
      assert.deepEqual([result.stage, result.opening], [stage, openingOf(ELYSIUM_OPENS_ON)], `${mode} ${JSON.stringify(env)}`);
    }
  }
  // Through Vite, for the release build and a test build: the repository's stage, whatever the environment says.
  for (const mode of ['production', 'wallet-test-v2']) {
    const names = Object.keys(Object.assign({}, ...ENVS));
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, ...ENVS);
    try {
      assert.deepEqual(prelaunch(await resolved(mode)), REPO_PRELAUNCH, mode);
    } finally {
      for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  // The switch reads no environment of its own but the test overrides (three since 2026-11-09).
  const source = readFileSync(join(APP, 'scripts/elysium-switch.mjs'), 'utf8');
  assert.deepEqual([...new Set([...source.matchAll(/env\[([A-Z_]+)\]/g)].map((match) => match[1]))].sort(), ['OVERRIDE_FUNDS_FROM', 'OVERRIDE_FUNDS_TO', 'OVERRIDE_PROFILE']);
  assert.doesNotMatch(source, /process\.env/);
});

test('the repository\'s stage today: pre-launch with Kinetiq\'s day until every day-9 piece is in, then live (and none of the pre-launch pieces)', () => {
  if (REPO_LIVE) {
    assert.deepEqual([REPOSITORY.stage, REPOSITORY.opening], ['live', null]);
    return;
  }
  assert.deepEqual([REPOSITORY.stage, ELYSIUM_OPENS_ON], ['prelaunch', '2026-11-09']);
  assert.deepEqual(REPOSITORY.opening, NOV_9);
});

test('the release build ignores the override: npm run release:build is a production build, which reads the repository alone', async () => {
  const scripts = json(join(APP, 'package.json')).scripts;
  assert.equal(scripts['release:build'], 'npm run build && node scripts/release.mjs record');
  assert.equal(scripts.build, 'tsc --noEmit && vite build', 'vite build with no --mode is the production mode');
  for (const mode of OTHER_MODES) {
    const config = await resolved(mode, FORCED);
    assert.deepEqual(flags(config), [JSON.stringify(REPO_LIVE), JSON.stringify(REPO_LIVE && originPinned(CONSTANTS.chains)), JSON.stringify(REPOSITORY.fundsTo)], `${mode} ignores ${OVERRIDE_PROFILE}`);
    assert.equal(config.define.__DOMINO_ELYSIUM_PROFILE__, JSON.stringify(REPOSITORY.profile), `${mode} carries the repository's profile, never the fixture`);
    assert.deepEqual(prelaunch(config), REPO_PRELAUNCH, `${mode}: the repository's stage, never the forced build's`);
    assert.doesNotMatch(config.build.outDir, /elysium/, mode);
    assert.equal(config.plugins.some((plugin) => /elysium/i.test(plugin.name)), false, `${mode}: the mark is public/'s file, never a plugin's`);
  }
  const production = await resolved('production', FORCED);
  assert.equal(production.define.__DOMINO_ELYSIUM_UNISWAP__, JSON.stringify(REPOSITORY.uniswap));
});

test('the test builds honour the override, each writing beside its usual directory, with the fixture profile and no record', async () => {
  const text = readFileSync(join(APP, FIXTURE), 'utf8');
  for (const mode of TEST_MODES) {
    const usual = (await resolved(mode)).build.outDir;
    const live = await resolved(mode, { [OVERRIDE_PROFILE]: FIXTURE });
    // Changed on purpose 2026-11-09 (rugged97's #488): funds from Elysium as the package pins it; brought to it, never with
    // the fixture profile, which names no bridge.
    assert.deepEqual(flags(live), ['true', String(PINNED), 'false'], mode);
    assert.equal(live.define.__DOMINO_ELYSIUM_DESTINATIONS__, 'null', mode);
    // Added 2026-11-07 (Elysium's pre-launch): a forced build is live, and live always wins: no pre-launch piece in it.
    assert.deepEqual(prelaunch(live), NOT_PRELAUNCH, `${mode}: forced on, never in pre-launch`);
    assert.equal(live.build.outDir, `${usual}-elysium`, mode);
    assert.deepEqual(files(live), [JSON.stringify(text), 'null', 'null'], mode);
    assert.equal(live.define.__DOMINO_ELYSIUM_UNISWAP__, JSON.stringify({ positionManager: fixture.uniswap.v4.positionManager.toLowerCase(), permit2: fixture.permit2.toLowerCase() }));
    // Changed on purpose 2026-11-07 (Elysium's screens): a forced build's one Elysium plugin is day 9's rehearsed read-v6 and
    // plan packages (vite.config.ts elysiumRehearsal); its mark is still public/'s file, never a stand-in's.
    assert.deepEqual(live.plugins.filter((plugin) => /elysium/i.test(plugin.name)).map((plugin) => plugin.name), ['domino:elysium-rehearsal'], `${mode}: a forced build draws public/'s file too, never a stand-in`);
    const funds = await resolved(mode, FORCED);
    assert.deepEqual(flags(funds), ['true', 'true', 'true'], mode);
    assert.equal(funds.define.__DOMINO_ELYSIUM_DESTINATIONS__, JSON.stringify([STABLE]), `${mode}: the fixture's stable alone, as Relay bridges Elysium's USDC`);
    assert.equal(funds.build.outDir, `${usual}-elysium-funds`, mode);
  }
});

// Added 2026-11-07 (Elysium's screens): the forced test builds rehearse day 9's read-v6 and position-plan packages
// (scripts/elysium-rehearsal.mjs, served by vite.config.ts elysiumRehearsal in those builds alone): every chain-id enum
// that names Base and Arbitrum One takes 99901, an answer's one-per-chain list takes one more, read-v6 prices HYPE at its
// native pool and position-plan has a 99901 row from the profile. The packages themselves are never changed.
// Changed on purpose 2026-11-07 (day-9 rehearsal, finding F1): split on each package. Once rugged97's package names 99901
// (his day-9 version, landed), the rehearsal hands it back exactly as it is, whatever his rows hold (the real profile's
// addresses never match the synthetic fixture's, and his read-v6 row carries `feed` and `heartbeatSeconds` null), so his
// merge turns nothing red here; before that, the rehearsed rows are held to the fixture as before.
test('day 9 rehearsed for the forced builds: the packages\' data with 99901 beside the others, the packages untouched', async () => {
  const { rehearsePlan, rehearseReadV6 } = await import('../scripts/elysium-rehearsal.mjs');
  const readV6 = await import('../../api-contracts/read-v6/schema-data.mjs');
  const plan = await import('../../api-contracts/position-plan-v1/schema-data.mjs');
  const before = JSON.stringify([readV6.SCHEMAS, readV6.CONSTANTS, plan.SCHEMAS, plan.CONSTANTS]);
  const day9 = rehearseReadV6(readV6, fixture);
  if (readV6Names(readV6.CONSTANTS.chainIds)) {
    assert.deepEqual(day9, { SCHEMAS: readV6.SCHEMAS, ERRORS: readV6.ERRORS, CONSTANTS: readV6.CONSTANTS }, 'day 9: his package as it is');
  } else {
    assert.deepEqual(day9.CONSTANTS.chainIds, [4663, 8453, 42161, ELYSIUM_V2_ID]);
    assert.deepEqual(day9.SCHEMAS['chain-pools'].request.properties.chainId.enum, [4663, 8453, 42161, ELYSIUM_V2_ID]);
    assert.deepEqual(day9.SCHEMAS['chain-tokens'].request.properties.chainId.enum, [8453, 42161, ELYSIUM_V2_ID], 'the other networks\' enum too');
    assert.deepEqual(day9.SCHEMAS['chain-balances'].request.$defs.BalanceTokenRef.properties.chainId.enum, [1, 10, 4663, 8453, 42161, ELYSIUM_V2_ID]);
    assert.deepEqual([day9.SCHEMAS.portfolio.response.properties.chains.minItems, day9.SCHEMAS.portfolio.response.properties.chains.maxItems], [4, 4]);
    const usdc = fixture.chargeCurrencies.find((currency) => currency.rank === 1).address.toLowerCase();
    assert.deepEqual(day9.CONSTANTS.priceProfiles[ELYSIUM_V2_ID], {
      stable: usdc, wrapped: fixture.wrappedNative.address.toLowerCase(), feed: null, heartbeatSeconds: null,
      nativePool: { dex: 4, currency0: '0x0000000000000000000000000000000000000000', currency1: usdc, fee: 500, tickSpacing: 10, hooks: '0x0000000000000000000000000000000000000000' },
    }, 'the producer\'s shape for a chain priced at its native pool (backend/v2_chain_reads.py price_profile)');
  }
  const planned = rehearsePlan(plan, fixture);
  if (planNames(plan.CONSTANTS.chains)) {
    assert.deepEqual(planned, { SCHEMAS: plan.SCHEMAS, ERRORS: plan.ERRORS, CONSTANTS: plan.CONSTANTS }, 'day 9: his package as it is');
  } else {
    assert.deepEqual(planned.SCHEMAS.plan.request.properties.chainId.enum, [4663, 8453, 42161, ELYSIUM_V2_ID]);
    assert.deepEqual(planned.CONSTANTS.chains[ELYSIUM_V2_ID], {
      chargeCurrencies: fixture.chargeCurrencies.map((currency) => ({ rank: currency.rank, token: currency.address.toLowerCase() })),
      l1DataFeeSource: 'nitro_node_interface', name: 'elysium-99901', permit2: fixture.permit2.toLowerCase(), stack: 'arbitrum-nitro',
      universalRouter: fixture.uniswap.universalRouter.address.toLowerCase(), wrappedNative: fixture.wrappedNative.address.toLowerCase(),
    });
  }
  assert.equal(JSON.stringify([readV6.SCHEMAS, readV6.CONSTANTS, plan.SCHEMAS, plan.CONSTANTS]), before, 'the packages as they are');
  assert.equal(readV6Names(day9.CONSTANTS.chainIds), true);
  assert.equal(planNames(planned.CONSTANTS.chains), true);
  // A day-9 package is never widened: an enum it leaves without 99901 (here chain-tokens') stays without it.
  const named = { SCHEMAS: { 'chain-tokens': { request: { properties: { chainId: { enum: [8453, 42161] } } } } }, ERRORS: {}, CONSTANTS: { chainIds: [4663, 8453, 42161, ELYSIUM_V2_ID], priceProfiles: {} } };
  assert.deepEqual(rehearseReadV6(named, fixture), named, 'his package as it is, chain-tokens\' enum included');
  const planRow = { SCHEMAS: { plan: { request: { properties: { chainId: { enum: [4663, 8453, 42161] } } } } }, ERRORS: {}, CONSTANTS: { chains: { [ELYSIUM_V2_ID]: { name: 'elysium-99901' } } } };
  assert.deepEqual(rehearsePlan(planRow, fixture), planRow);
});

// Added 2026-11-09 (Elysium's day 9, the owner: funds brought to Elysium from other networks as on Base): the forced funds
// build also rehearses crosschain-v1 as a version that brings funds to 99901 has it: Relay pinned there and the profile's
// stable its one destination, checked by the package's own runtime; the package itself untouched, and handed back as it
// is once it pins a bridge for 99901 and lists its destinations.
test('funds to Elysium rehearsed for the forced funds build: crosschain-v1 takes a deposit of its stable there, never of HYPE', async () => {
  const { moduleSource, rehearseCrosschain } = await import('../scripts/elysium-rehearsal.mjs');
  const data = await import('../../api-contracts/crosschain-v1/schema-data.mjs');
  const before = JSON.stringify([data.SCHEMAS, data.CONSTANTS]);
  const rehearsed = rehearseCrosschain(data, fixture);
  assert.equal(JSON.stringify([data.SCHEMAS, data.CONSTANTS]), before, 'the package as it is');
  if (PINNED && destinationPinned(data.CONSTANTS.destinations) !== null) {
    // Added 2026-11-09 (rugged97's #488): the package pins Relay and lists Elysium's destinations itself, so the forced
    // build bundles it as it is, and its own runtime takes a deposit of what it lists there (USDC), never of HYPE.
    assert.deepEqual(rehearsed, { SCHEMAS: data.SCHEMAS, ERRORS: data.ERRORS, CONSTANTS: data.CONSTANTS }, 'his package as it is');
    const runtime = await import('../../api-contracts/crosschain-v1/runtime.mjs');
    const quote = JSON.parse(readFileSync(join(REPO, 'api-contracts/crosschain-v1/fixtures/requests/quote.json'), 'utf8'));
    const [listed] = destinationPinned(data.CONSTANTS.destinations);
    assert.equal(runtime.validateRequest('quote', { ...quote, destinationChainId: ELYSIUM_V2_ID, destinationToken: listed }), true, 'its listed token on Elysium');
    assert.equal(runtime.validateRequest('quote', { ...quote, destinationChainId: ELYSIUM_V2_ID, destinationToken: `0x${'0'.repeat(40)}` }), false, 'never HYPE');
    return;
  }
  assert.deepEqual(rehearsed.CONSTANTS.destinations[ELYSIUM_V2_ID], [STABLE]);
  assert.equal(originPinned(rehearsed.CONSTANTS.chains), true);
  assert.deepEqual(destinationPinned(rehearsed.CONSTANTS.destinations), [STABLE]);
  // Its own runtime over the rehearsed data, in a scratch copy of the package (closed-schema.mjs re-exported in place).
  const dir = mkdtempSync(join(tmpdir(), 'domino-crosschain-day9-'));
  try {
    mkdirSync(join(dir, 'crosschain-v1'));
    mkdirSync(join(dir, 'shared'));
    writeFileSync(join(dir, 'shared', 'closed-schema.mjs'), `export * from ${JSON.stringify(pathToFileURL(join(REPO, 'api-contracts/shared/closed-schema.mjs')).href)};\n`);
    writeFileSync(join(dir, 'crosschain-v1', 'runtime.mjs'), readFileSync(join(REPO, 'api-contracts/crosschain-v1/runtime.mjs'), 'utf8'));
    writeFileSync(join(dir, 'crosschain-v1', 'schema-data.mjs'), moduleSource(rehearsed));
    const day = await import(pathToFileURL(join(dir, 'crosschain-v1', 'runtime.mjs')).href);
    const today = await import('../../api-contracts/crosschain-v1/runtime.mjs');
    const quote = JSON.parse(readFileSync(join(REPO, 'api-contracts/crosschain-v1/fixtures/requests/quote.json'), 'utf8'));
    const toElysium = { ...quote, destinationChainId: ELYSIUM_V2_ID, destinationToken: STABLE };
    assert.equal(today.validateRequest('quote', quote), true, 'the fixture quote, as the package has it');
    assert.equal(today.validateRequest('quote', toElysium), false, 'today\'s package refuses a deposit to 99901');
    assert.equal(day.validateRequest('quote', quote), true, 'the three as before');
    assert.equal(day.validateRequest('quote', toElysium), true, 'its stable on Elysium');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const pinnedPackage = { ...data, CONSTANTS: { ...data.CONSTANTS, chains: { ...data.CONSTANTS.chains, [ELYSIUM_V2_ID]: { name: 'Elysium', relay: { depository: `0x${'12'.repeat(20)}` } } }, destinations: { ...data.CONSTANTS.destinations, [ELYSIUM_V2_ID]: [STABLE] } } };
  assert.deepEqual(rehearseCrosschain(pinnedPackage, fixture), { SCHEMAS: pinnedPackage.SCHEMAS, ERRORS: pinnedPackage.ERRORS, CONSTANTS: pinnedPackage.CONSTANTS }, 'his package as it is');
});
