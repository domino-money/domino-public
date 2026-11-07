/**
 * Elysium's switch (added 2026-11-06, the Elysium surface): the one build-time fact "Elysium is live", which vite.config.ts
 * writes into every build as `__DOMINO_ELYSIUM_LIVE__` (read by src/lib/elysiumIdentity.ts ELYSIUM_LIVE), with its second
 * fact, `__DOMINO_ELYSIUM_FUNDS_FROM__`: funds can come from Elysium.
 *
 * Changed on purpose 2026-11-07 (Elysium as a fourth V2 chain, switched on by itself): live is no longer "the profile and
 * the app's chain list naming 99901". The chain list now FOLLOWS the switch (src/config/chainIdentity.ts V2_CHAIN_IDS
 * names 99901 exactly when ELYSIUM_LIVE is true), so the switch reads only what rugged97's day-9 pull request and one
 * reviewed line of ours put in the repository, each piece by directory or by package, never a file by name:
 *
 *   live        every piece below is there (`missing` is empty):
 *     profile   api-contracts/v2/chains/ holds an ENABLED profile of chain 99901 (rugged97's elysium-99901.json, which
 *               replaces today's disabled placeholder). Either layout builds (tests/v2/chain-layouts.test.mjs).
 *     record    docs/deployments/ holds Elysium's deployment record, `v2-<slug>-99901-<date>/deployment.json`.
 *     pin       that record's SHA-256 is pinned by hand, here (ELYSIUM_RECORD_PIN below): the same deliberate human check
 *               as src/v2/manifest.ts V2_MANIFEST_PINS for the other three chains. A record that is not pinned, or whose
 *               bytes differ from its pin, leaves Elysium off: it is never trusted by hashing it at build time. The
 *               pinned bytes are what the build carries (`deployment`), so the app's map holds exactly the file pinned.
 *     readV6    the read-v6 package the app bundles names 99901 (api-contracts/read-v6 CONSTANTS.chainIds): its runtime
 *               refuses any portfolio answer whose chain list differs from its own (runtime.mjs:160), so the app cannot
 *               read Elysium before it does.
 *     plan      the position-plan-v1 package names 99901 (CONSTANTS.chains): its runtime checks a plan against its
 *               chain's row, so Create position cannot plan there before it does.
 *   fundsFrom   live, and the crosschain-v1 contract the app reads the origins listing with pins Relay or Across for chain
 *               99901 (api-contracts/crosschain-v1 CONSTANTS.chains): its runtime refuses any listing that names a chain
 *               it does not pin, so this is exactly "the origins listing can name Elysium as an origin". On 6 Nov 2026
 *               neither bridge serves 99901 (Relay lists 999 HyperEVM, Across has no 99901): false.
 *
 * A missing piece never fails a build: rugged97's pull request may land any part of them first (a profile without a
 * record, a record without our pin, read-v6 without 99901...) and Elysium simply stays off, every build and test as they
 * were, with `missing` naming what is still to come (vite.config.ts prints it once anything of day 9 is there). Only two
 * things fail a build: a live build without Elysium's official mark (below), and an override that names anything but an
 * enabled 99901 profile.
 *
 * What a live build carries, besides the two facts (vite.config.ts defines, as JSON text, so a build where Elysium is off
 * carries none of it): the profile's text (`profile`, src/v2/elysiumFiles.ts ELYSIUM_PROFILE: the fourth chain of
 * src/v2/chains.ts and its binding in src/v2/manifest.ts), and the pinned record's text with its pin (`deployment`:
 * src/v2/manifest.ts V2_DEPLOYMENTS and V2_MANIFEST_PINS, parsed there under the production admission like the others').
 *
 * The test override (the only environment variable a build reads for Elysium): `DOMINO_TEST_ELYSIUM_PROFILE`, a path
 * (from app/) to a fixture profile of chain 99901, and with it `DOMINO_TEST_ELYSIUM_FUNDS_FROM=1`. Honoured ONLY by the
 * test builds (a MODES row with test hooks that is neither deployable nor the site); every other build, the release build
 * above all, ignores both and reads the repository alone (tests/elysium-switch.test.mjs). A forced build stands in for the
 * whole of day 9 with the fixture profile alone: no production record (its contracts are the fork-rehearsal fixture of
 * src/v2/manifestFixtures.ts, under the test admission), and the services as they answer. It writes to a directory of its
 * own (`<outDir>-elysium`, or `<outDir>-elysium-funds` with funds from Elysium), so the suites' usual builds are never
 * replaced by it.
 *
 * Elysium's official mark (public/chains/elysium.png) is the owner's file (7 Nov 2026: Kinetiq's mark, 128 x 128 PNG,
 * white inside the circle and transparent outside). A live build, forced or not, fails without it or with anything but a
 * square PNG image there (its signature and its IHDR), so nothing made up is ever drawn.
 *
 * Pure node: its imports are rugged97's package data, read in place. vite.config.ts and the tests both load it.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { CONSTANTS as CROSSCHAIN } from '../../api-contracts/crosschain-v1/schema-data.mjs';
import { CONSTANTS as POSITION_PLAN } from '../../api-contracts/position-plan-v1/schema-data.mjs';
import { CONSTANTS as READ_V6 } from '../../api-contracts/read-v6/schema-data.mjs';

/** Elysium mainnet's chain id (rugged97's #459, scripts/v2/deploy.mjs ENABLED_CHAINS). */
export const ELYSIUM_V2_ID = 99901;

/**
 * Elysium's deployment record, pinned: its path from the repository's root and the SHA-256 of its exact bytes (LF line
 * endings), exactly as src/v2/manifest.ts V2_MANIFEST_PINS pins the other three chains' records, or null while there is
 * none to pin. THE DAY-9 LINE (docs/ELYSIUM_DAY9.md, "Monday checklist"): once rugged97's record is merged, review it and
 * write, with `sha256sum` of the committed file,
 *   export const ELYSIUM_RECORD_PIN = Object.freeze({ path: 'docs/deployments/v2-elysium-99901-<date>/deployment.json', sha256: '<64 hex>' });
 * Never computed by the build: a record that is not pinned leaves Elysium off.
 */
export const ELYSIUM_RECORD_PIN = null;

/** The only environment variables read for Elysium, and only by the test builds. */
export const OVERRIDE_PROFILE = 'DOMINO_TEST_ELYSIUM_PROFILE';
export const OVERRIDE_FUNDS_FROM = 'DOMINO_TEST_ELYSIUM_FUNDS_FROM';
/** Where the official mark is served from (src/lib/elysiumIdentity.ts ELYSIUM_MARK), under public/. */
export const MARK_PATH = 'chains/elysium.png';
/** The pieces live needs, in the order `missing` names them. */
export const PIECES = Object.freeze(['profile', 'record', 'pin', 'readV6', 'plan']);
/** A PNG file's eight-byte signature. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A deployment record's directory under docs/deployments, as scripts/v2/deploy.mjs names it: v2-<slug>-<chainId>-<date>. */
const RECORD_DIRECTORY = new RegExp(`^v2-[a-z0-9]+(?:-[a-z0-9]+)*-${ELYSIUM_V2_ID}-\\d{4}-\\d{2}-\\d{2}$`);
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Whether `bytes` is a square PNG image, as tests/v2/chain-identity.test.mjs reads the owner's file: the PNG signature,
 * then the IHDR chunk first (length 13, its type, then width and height, big-endian), with a width equal to its height
 * and not zero. Returns its side in pixels, or 0.
 */
export function squarePngSide(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 0;
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR') return 0;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  return width > 0 && width === height ? width : 0;
}

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const lowerAddress = (value) => (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Whether a parsed profile is an enabled profile of chain 99901 (deploy.mjs: `enabled === true`, a positive chain id). */
export const isEnabledElysium = (profile) => plain(profile) && profile.chainId === ELYSIUM_V2_ID && profile.enabled === true;

/**
 * The enabled 99901 profile in `dir` (api-contracts/v2/chains), as { file, text, profile }, or null. A file that is not
 * JSON is passed over here: the chain list's own reader (src/v2/chains.ts) is what refuses a broken profile.
 */
export function enabledProfileIn(dir) {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.json')).sort()) {
    const text = readFileSync(join(dir, name), 'utf8');
    let profile;
    try {
      profile = JSON.parse(text);
    } catch {
      continue;
    }
    if (isEnabledElysium(profile)) return { file: join(dir, name), text, profile };
  }
  return null;
}

/**
 * Elysium's deployment records under `repoRoot`/docs/deployments: every `v2-<slug>-99901-<date>/deployment.json`, as
 * paths from the repository's root with forward slashes, in order. Rehearsal directories (v2-rehearsal-<date>) and the
 * other chains' records never match.
 */
export function recordsIn(repoRoot) {
  const dir = join(repoRoot, 'docs', 'deployments');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RECORD_DIRECTORY.test(entry.name) && existsSync(join(dir, entry.name, 'deployment.json')))
    .map((entry) => `docs/deployments/${entry.name}/deployment.json`)
    .sort();
}

/** Whether a pin is a pin: a path under docs/deployments and a lowercase SHA-256. */
const wellFormedPin = (pin) => plain(pin) && typeof pin.path === 'string' && pin.path.startsWith('docs/deployments/') && typeof pin.sha256 === 'string' && SHA256.test(pin.sha256);

/**
 * The pinned record (`pin`) among `records` (recordsIn), as { record: { path, sha256, text } }, or { reason } there is
 * none to use: no pin, a pin naming another file, bytes that differ from the pin, or bytes that are not JSON.
 */
export function pinnedRecord(repoRoot, records, pin) {
  if (pin === null || pin === undefined) return { reason: `${records.join(', ')} is not pinned: write its SHA-256 into scripts/elysium-switch.mjs ELYSIUM_RECORD_PIN (docs/ELYSIUM_DAY9.md)` };
  if (!wellFormedPin(pin)) return { reason: 'scripts/elysium-switch.mjs ELYSIUM_RECORD_PIN is not a { path, sha256 } pin of a file under docs/deployments' };
  if (!records.includes(pin.path)) return { reason: `ELYSIUM_RECORD_PIN names ${pin.path}, which is not one of Elysium's records (${records.join(', ') || 'none'})` };
  const bytes = readFileSync(join(repoRoot, pin.path));
  const actual = sha256(bytes);
  if (actual !== pin.sha256) return { reason: `${pin.path}'s SHA-256 is ${actual}, but ELYSIUM_RECORD_PIN says ${pin.sha256}` };
  const text = bytes.toString('utf8');
  try {
    JSON.parse(text);
  } catch {
    return { reason: `${pin.path} is not JSON` };
  }
  return { record: Object.freeze({ path: pin.path, sha256: pin.sha256, text }) };
}

/** Whether read-v6's package names chain 99901 among its chains (CONSTANTS.chainIds). */
export const readV6Names = (chainIds) => Array.isArray(chainIds) && chainIds.includes(ELYSIUM_V2_ID);
/** Whether position-plan-v1's package has a row for chain 99901 (CONSTANTS.chains). */
export const planNames = (chains) => plain(chains) && plain(chains[String(ELYSIUM_V2_ID)]);

/**
 * Whether crosschain-v1's pinned chains (CONSTANTS.chains) pin Relay or Across for chain 99901, as its runtime reads a
 * pin (`pinned(provider, chain)`: the provider's entry in the chain's row).
 */
export const originPinned = (chains) => {
  const row = plain(chains) ? chains[String(ELYSIUM_V2_ID)] : undefined;
  return plain(row) && (Boolean(row.relay) || Boolean(row.across));
};

/** A test build: the suites' builds only (test hooks on, neither deployable nor the published site). */
export const isTestBuild = (row) => row.testHooks === true && row.deployable === false && row.site === false;

/**
 * The switch for one build. `row`: the mode's MODES row. `env`: the build's environment. `appRoot`: app/. The rest are
 * the repository's own unless a test hands in its own: `pin` (ELYSIUM_RECORD_PIN), `readV6Chains` (read-v6's
 * CONSTANTS.chainIds), `planChains` (position-plan-v1's CONSTANTS.chains) and `chains` (crosschain-v1's CONSTANTS.chains).
 * Returns { live, fundsFrom, forced, outDirSuffix, profileFile, profile, deployment, uniswap, missing }:
 *   - `outDirSuffix`: what a forced build adds to its mode's directory ('' otherwise);
 *   - `profile`: the enabled profile's text, and `deployment` the pinned record ({ path, sha256, text }), each null while
 *     Elysium is off (`deployment` in a forced build too: its contracts are the fixture's);
 *   - `uniswap`: the profile's Uniswap v4 PositionManager and its Permit2 (lowercase, or null), which the docs list
 *     (src/lib/docs/elysium.ts), null while Elysium is off;
 *   - `missing`: the pieces still to come, each { piece, detail }, in PIECES' order: empty when live, and in a forced build,
 *     which looks for none. No record means no `pin` entry: there is nothing to pin yet.
 * Throws when Elysium is live (forced or not) and its official mark is missing or is not a square PNG image, and when an
 * override names anything but an enabled 99901 profile.
 */
export function elysiumSwitch({ row, env = {}, appRoot, pin = ELYSIUM_RECORD_PIN, readV6Chains = READ_V6.chainIds, planChains = POSITION_PLAN.chains, chains = CROSSCHAIN.chains }) {
  const asked = typeof env[OVERRIDE_PROFILE] === 'string' && env[OVERRIDE_PROFILE] !== '' ? env[OVERRIDE_PROFILE] : null;
  const forced = asked !== null && isTestBuild(row);
  const repoRoot = resolve(appRoot, '..');
  const missing = [];
  let found;
  let deployment = null;
  if (forced) {
    const file = isAbsolute(asked) ? asked : resolve(appRoot, asked);
    const text = existsSync(file) ? readFileSync(file, 'utf8') : 'null';
    const profile = JSON.parse(text);
    if (!isEnabledElysium(profile)) throw new Error(`${OVERRIDE_PROFILE} must name an enabled profile of chain ${ELYSIUM_V2_ID}: ${file}`);
    found = { file, text, profile };
  } else {
    found = enabledProfileIn(join(repoRoot, 'api-contracts', 'v2', 'chains'));
    if (found === null) missing.push({ piece: 'profile', detail: `api-contracts/v2/chains holds no enabled profile of chain ${ELYSIUM_V2_ID}` });
    const records = recordsIn(repoRoot);
    if (records.length === 0) {
      missing.push({ piece: 'record', detail: `docs/deployments holds no deployment record of chain ${ELYSIUM_V2_ID} (v2-<slug>-${ELYSIUM_V2_ID}-<date>/deployment.json)` });
    } else {
      const pinned = pinnedRecord(repoRoot, records, pin);
      if (pinned.record) deployment = pinned.record;
      else missing.push({ piece: 'pin', detail: pinned.reason });
    }
    if (!readV6Names(readV6Chains)) missing.push({ piece: 'readV6', detail: `read-v6 (api-contracts/read-v6 CONSTANTS.chainIds) does not name chain ${ELYSIUM_V2_ID}` });
    if (!planNames(planChains)) missing.push({ piece: 'plan', detail: `position-plan-v1 (api-contracts/position-plan-v1 CONSTANTS.chains) does not name chain ${ELYSIUM_V2_ID}` });
  }
  const live = found !== null && missing.length === 0;
  const fundsForced = forced && env[OVERRIDE_FUNDS_FROM] === '1';
  const fundsFrom = live && (fundsForced || originPinned(chains));
  const official = join(appRoot, 'public', MARK_PATH);
  if (live && !existsSync(official)) {
    const why = forced ? `${OVERRIDE_PROFILE} forces it on with ${found.file}` : `${found.file} is an enabled profile of chain ${ELYSIUM_V2_ID}, its record ${deployment.path} is pinned, and read-v6 and position-plan name it`;
    throw new Error(`Elysium is live (${why}), but its official mark, app/public/${MARK_PATH}, is missing. Add the owner's file before building (docs/ELYSIUM_DAY9.md).`);
  }
  if (live && squarePngSide(readFileSync(official)) === 0) {
    throw new Error(`app/public/${MARK_PATH} is not a square PNG image.`);
  }
  const uniswap = live ? { positionManager: lowerAddress(found.profile.uniswap?.v4?.positionManager), permit2: lowerAddress(found.profile.permit2) } : null;
  const outDirSuffix = forced ? (fundsForced ? '-elysium-funds' : '-elysium') : '';
  return {
    live,
    fundsFrom,
    forced,
    outDirSuffix,
    profileFile: live ? found.file : null,
    profile: live ? found.text : null,
    deployment: live ? deployment : null,
    uniswap,
    missing,
  };
}

/**
 * One line for a build's log, or null: what Elysium still waits for, once anything of day 9 is in the repository (a
 * profile, a record, read-v6 or position-plan naming 99901) and Elysium is still off. Null when it is live, and today,
 * when nothing of it is there, so today's builds print what they always did.
 */
export function switchDiagnostic(result) {
  const lacks = (piece) => result.missing.some((entry) => entry.piece === piece);
  if (result.live || ['profile', 'record', 'readV6', 'plan'].every(lacks)) return null;
  return `Elysium stays off until: ${result.missing.map((entry) => entry.detail).join('; ')}.`;
}
