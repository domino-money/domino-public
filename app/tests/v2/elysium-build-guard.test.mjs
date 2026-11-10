/**
 * The build's guard on Elysium's day-9 files, held to the app itself (added 2026-11-07, day-9 rehearsal, finding F6). A
 * live build of the repository fails when the app would refuse its enabled profile or its pinned record
 * (scripts/elysium-switch.mjs profileRefusal, recordRefusal), since either used to build green and break at load. The
 * guard is plain node, so it says the parser's rules again in its own words; here, case by case
 * (tests/support/elysium-faults.mjs), the compiled app is loaded with the very defines a live build writes and each
 * verdict must be the app's: the guard refuses exactly what src/v2/chains.ts chainOf refuses (at load), and exactly what
 * the production admission refuses (src/v2/manifest.ts parseV2Manifest, then finance/v2/deployment.ts
 * checkV2Prediction and admitV2Contracts, as tests/v2/manifest-pin.test.mjs "Elysium's pinned record" reads a record).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { CONTRACT_NAMES, V4_ONLY_CONTRACTS, profileRefusal, recordRefusal } from '../../scripts/elysium-switch.mjs';
import { PROFILE, PROFILE_FAULTS, RECORD, RECORD_FAULTS, recordBytes } from '../support/elysium-faults.mjs';
import { ELYSIUM_FORCED, loadWith, withRecord } from './support/elysium-live.mjs';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const PROFILE_TEXT = `${JSON.stringify(PROFILE, null, 2)}\n`;

/** What the app does with `profile` as a live build's: null where its chain list loads, else its error. */
function appOnProfile(profile) {
  try {
    loadWith(require, { ...ELYSIUM_FORCED, __DOMINO_ELYSIUM_PROFILE__: `${JSON.stringify(profile, null, 2)}\n` }, () => require(`${BUILD}v2/chains.js`));
    return null;
  } catch (error) {
    return error;
  }
}

/** What the app does with `record` pinned beside PROFILE: null where it is admitted for production on 99901, else its error. */
function appOnRecord(record) {
  try {
    const flags = { ...withRecord(recordBytes(record).toString('utf8')), __DOMINO_ELYSIUM_PROFILE__: PROFILE_TEXT };
    const on = loadWith(require, flags, () => ({
      manifest: require(`${BUILD}v2/manifest.js`),
      deployment: require(`${BUILD}finance/v2/deployment.js`),
      chains: require(`${BUILD}v2/chains.js`),
    }));
    const contracts = on.manifest.parseV2Manifest(on.manifest.V2_DEPLOYMENTS[99901], 99901);
    on.deployment.checkV2Prediction(contracts.deployment);
    on.deployment.admitV2Contracts(on.chains.v2Chain(99901), contracts);
    return null;
  } catch (error) {
    return error;
  }
}

test('the guard\'s constants are the app\'s: the 13 contract names, and the nine contracts of Uniswap v4 alone', () => {
  const manifest = require(`${BUILD}v2/manifest.js`);
  assert.deepEqual({ ...CONTRACT_NAMES }, { ...manifest.CONTRACT_NAMES });
  assert.deepEqual([...V4_ONLY_CONTRACTS], [...manifest.componentsFor([4])]);
});

test('a profile: the guard refuses exactly what the app\'s chain parser refuses at load', () => {
  assert.equal(profileRefusal(PROFILE), null);
  assert.equal(appOnProfile(PROFILE), null, 'the synthetic profile loads');
  for (const [what, profile, reason] of PROFILE_FAULTS) {
    assert.match(profileRefusal(profile) ?? 'taken', reason, what);
    const error = appOnProfile(profile);
    assert.ok(error !== null && /invalid_chain_profile/.test(error.message), `${what}: the app refuses it too (${error?.message ?? 'it loaded'})`);
  }
});

test('a pinned record: the guard refuses exactly what the production admission refuses', () => {
  assert.equal(recordRefusal(RECORD, PROFILE), null);
  assert.equal(appOnRecord(RECORD), null, 'the stand-in record is admitted for production on 99901');
  for (const [what, record, reason] of RECORD_FAULTS) {
    assert.match(recordRefusal(record, PROFILE) ?? 'taken', reason, what);
    const error = appOnRecord(record);
    assert.ok(error !== null && /^manifest_/.test(error.code ?? error.message), `${what}: the app refuses it too (${error?.code ?? error?.message ?? 'admitted'})`);
  }
});
