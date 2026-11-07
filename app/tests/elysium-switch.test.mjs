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
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';
import { resolveConfig } from 'vite';
import { CONSTANTS } from '../../api-contracts/crosschain-v1/schema-data.mjs';
import { CONSTANTS as PLAN } from '../../api-contracts/position-plan-v1/schema-data.mjs';
import { CONSTANTS as READ_V6 } from '../../api-contracts/read-v6/schema-data.mjs';
import {
  ELYSIUM_RECORD_PIN, ELYSIUM_V2_ID, MARK_PATH, OVERRIDE_FUNDS_FROM, OVERRIDE_PROFILE, PIECES, elysiumSwitch, enabledProfileIn, isTestBuild,
  originPinned, planNames, readV6Names, recordsIn, squarePngSide, switchDiagnostic,
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
const testnet = json(join(APP, 'tests/fixtures/v2-chains/elysium-99801.json'));
/** A nine-contract record of chain 99901 to stand in for rugged97's: the fork-rehearsal fixture (src/v2/manifestFixtures.ts). */
const RECORD_BYTES = readFileSync(join(APP, 'src/v2/fixtures/manifest.elysium-99901.fixture.json'));
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
  const saved = Object.fromEntries([OVERRIDE_PROFILE, OVERRIDE_FUNDS_FROM].map((name) => [name, process.env[name]]));
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
const flags = (config) => [config.define.__DOMINO_ELYSIUM_LIVE__, config.define.__DOMINO_ELYSIUM_FUNDS_FROM__];
const files = (config) => [config.define.__DOMINO_ELYSIUM_PROFILE__, config.define.__DOMINO_ELYSIUM_DEPLOYMENT__, config.define.__DOMINO_ELYSIUM_DEPLOYMENT_PIN__];
const FORCED = { [OVERRIDE_PROFILE]: FIXTURE, [OVERRIDE_FUNDS_FROM]: '1' };

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
  assert.equal(live.fundsFrom, false, 'crosschain-v1 pins no bridge for 99901 today');
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
  assert.deepEqual([forced.fundsFrom, forced.outDirSuffix], [false, '-elysium']);
  assert.deepEqual(forced.missing, [], 'a forced build looks for no other piece');
  assert.deepEqual(JSON.parse(forced.profile), fixture);
  assert.equal(forced.deployment, null, 'no production record: its contracts are the fork-rehearsal fixture, under the test admission');
  const funds = elysiumSwitch({ row: ROWS['wallet-test-v2'], appRoot: app, env: FORCED });
  assert.deepEqual([funds.fundsFrom, funds.outDirSuffix], [true, '-elysium-funds']);
  // The funds variable alone turns nothing on, in any build.
  assert.equal(elysiumSwitch({ row: ROWS['wallet-test-v2'], appRoot: app, env: { [OVERRIDE_FUNDS_FROM]: '1' } }).fundsFrom, false);
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
    assert.deepEqual(flags(config), [JSON.stringify(REPO_LIVE), JSON.stringify(REPO_LIVE && originPinned(CONSTANTS.chains))], mode);
    assert.deepEqual(files(config), expected, `${mode}: the day-9 files exactly where Elysium is live`);
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

test('the release build ignores the override: npm run release:build is a production build, which reads the repository alone', async () => {
  const scripts = json(join(APP, 'package.json')).scripts;
  assert.equal(scripts['release:build'], 'npm run build && node scripts/release.mjs record');
  assert.equal(scripts.build, 'tsc --noEmit && vite build', 'vite build with no --mode is the production mode');
  for (const mode of OTHER_MODES) {
    const config = await resolved(mode, FORCED);
    assert.deepEqual(flags(config), [JSON.stringify(REPO_LIVE), JSON.stringify(REPO_LIVE && originPinned(CONSTANTS.chains))], `${mode} ignores ${OVERRIDE_PROFILE}`);
    assert.equal(config.define.__DOMINO_ELYSIUM_PROFILE__, JSON.stringify(REPOSITORY.profile), `${mode} carries the repository's profile, never the fixture`);
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
    assert.deepEqual(flags(live), ['true', 'false'], mode);
    assert.equal(live.build.outDir, `${usual}-elysium`, mode);
    assert.deepEqual(files(live), [JSON.stringify(text), 'null', 'null'], mode);
    assert.equal(live.define.__DOMINO_ELYSIUM_UNISWAP__, JSON.stringify({ positionManager: fixture.uniswap.v4.positionManager.toLowerCase(), permit2: fixture.permit2.toLowerCase() }));
    // Changed on purpose 2026-11-07 (Elysium's screens): a forced build's one Elysium plugin is day 9's rehearsed read-v6 and
    // plan packages (vite.config.ts elysiumRehearsal); its mark is still public/'s file, never a stand-in's.
    assert.deepEqual(live.plugins.filter((plugin) => /elysium/i.test(plugin.name)).map((plugin) => plugin.name), ['domino:elysium-rehearsal'], `${mode}: a forced build draws public/'s file too, never a stand-in`);
    const funds = await resolved(mode, FORCED);
    assert.deepEqual(flags(funds), ['true', 'true'], mode);
    assert.equal(funds.build.outDir, `${usual}-elysium-funds`, mode);
  }
});

// Added 2026-11-07 (Elysium's screens): the forced test builds rehearse day 9's read-v6 and position-plan packages
// (scripts/elysium-rehearsal.mjs, served by vite.config.ts elysiumRehearsal in those builds alone): every chain-id enum
// that names Base and Arbitrum One takes 99901, an answer's one-per-chain list takes one more, read-v6 prices HYPE at its
// native pool and position-plan has a 99901 row from the profile. The packages themselves are never changed.
test('day 9 rehearsed for the forced builds: the packages\' data with 99901 beside the others, the packages untouched', async () => {
  const { rehearsePlan, rehearseReadV6 } = await import('../scripts/elysium-rehearsal.mjs');
  const readV6 = await import('../../api-contracts/read-v6/schema-data.mjs');
  const plan = await import('../../api-contracts/position-plan-v1/schema-data.mjs');
  const before = JSON.stringify([readV6.SCHEMAS, readV6.CONSTANTS, plan.SCHEMAS, plan.CONSTANTS]);
  const day9 = rehearseReadV6(readV6, fixture);
  assert.deepEqual(day9.CONSTANTS.chainIds, [4663, 8453, 42161, ELYSIUM_V2_ID]);
  assert.deepEqual(day9.SCHEMAS['chain-pools'].request.properties.chainId.enum, [4663, 8453, 42161, ELYSIUM_V2_ID]);
  assert.deepEqual(day9.SCHEMAS['chain-tokens'].request.properties.chainId.enum, [8453, 42161, ELYSIUM_V2_ID], 'the other networks\' enum too');
  assert.deepEqual(day9.SCHEMAS['chain-balances'].request.$defs.BalanceTokenRef.properties.chainId.enum, [1, 10, 4663, 8453, 42161, ELYSIUM_V2_ID]);
  assert.deepEqual([day9.SCHEMAS.portfolio.response.properties.chains.minItems, day9.SCHEMAS.portfolio.response.properties.chains.maxItems], [4, 4]);
  const usdc = fixture.chargeCurrencies.find((currency) => currency.rank === 1).address.toLowerCase();
  assert.deepEqual(day9.CONSTANTS.priceProfiles[ELYSIUM_V2_ID], {
    stable: usdc, wrapped: fixture.wrappedNative.address.toLowerCase(),
    nativePool: { dex: 4, currency0: '0x0000000000000000000000000000000000000000', currency1: usdc, fee: 500, tickSpacing: 10, hooks: '0x0000000000000000000000000000000000000000' },
  });
  const planned = rehearsePlan(plan, fixture);
  assert.deepEqual(planned.SCHEMAS.plan.request.properties.chainId.enum, [4663, 8453, 42161, ELYSIUM_V2_ID]);
  assert.deepEqual(planned.CONSTANTS.chains[ELYSIUM_V2_ID], {
    chargeCurrencies: fixture.chargeCurrencies.map((currency) => ({ rank: currency.rank, token: currency.address.toLowerCase() })),
    l1DataFeeSource: 'nitro_node_interface', name: 'elysium-99901', permit2: fixture.permit2.toLowerCase(), stack: 'arbitrum-nitro',
    universalRouter: fixture.uniswap.universalRouter.address.toLowerCase(), wrappedNative: fixture.wrappedNative.address.toLowerCase(),
  });
  assert.equal(JSON.stringify([readV6.SCHEMAS, readV6.CONSTANTS, plan.SCHEMAS, plan.CONSTANTS]), before, 'the packages as they are');
  assert.equal(readV6Names(day9.CONSTANTS.chainIds), true);
  assert.equal(planNames(planned.CONSTANTS.chains), true);
});
