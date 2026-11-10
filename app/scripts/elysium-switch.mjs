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
 *   fundsTo     (added 2026-11-09, Elysium's day 9, the owner: funds brought to Elysium from other networks as on Base)
 *               live, Elysium's profile names a bridge (`bridge.providers` not empty), crosschain-v1 pins Relay or Across
 *               for chain 99901 (CONSTANTS.chains, as `fundsFrom` reads it) AND lists what a deposit may deliver there
 *               (CONSTANTS.destinations["99901"], a list of token addresses): its runtime refuses a deposit to any chain
 *               or token it does not list, so this is exactly "a deposit can bring funds to Elysium". Those tokens are
 *               the build's own too (`destinations`, src/v2/crosschain/present.ts destinationChoices), since Relay
 *               bridges Elysium's USDC there and not its native HYPE. On 9 Nov 2026 the profile names no bridge
 *               (`providers: []`) and crosschain-v1 has no 99901, though Relay lists 99901 (elysium, USDC
 *               0xb47c4c8f73f009cc0c0d3f92b388d13e293f0b65 bridged, HYPE not): false.
 *
 * A missing piece never fails a build: rugged97's pull request may land any part of them first (a profile without a
 * record, a record without our pin, read-v6 without 99901...) and Elysium simply stays off, every build and test as they
 * were, with `missing` naming what is still to come (vite.config.ts prints it once anything of day 9 is there). Only four
 * things fail a build: a live build without Elysium's official mark (below), an override that names anything but an
 * enabled 99901 profile, (changed on purpose 2026-11-07, day-9 rehearsal, finding F6) a live build of the repository
 * whose profile the app's chain parser refuses or whose pinned record the production admission refuses (profileRefusal,
 * recordRefusal): either would build green, then break Elysium, or every V2 screen, at load, and (added 2026-11-07,
 * Elysium's pre-launch) an ELYSIUM_OPENS_ON that is neither null nor a day.
 *
 * What a live build carries, besides the two facts (vite.config.ts defines, as JSON text, so a build where Elysium is off
 * carries none of it): the profile's text (`profile`, src/v2/elysiumFiles.ts ELYSIUM_PROFILE: the fourth chain of
 * src/v2/chains.ts and its binding in src/v2/manifest.ts), and the pinned record's text with its pin (`deployment`:
 * src/v2/manifest.ts V2_DEPLOYMENTS and V2_MANIFEST_PINS, parsed there under the production admission like the others').
 *
 * The test override (the only environment variable a build reads for Elysium): `DOMINO_TEST_ELYSIUM_PROFILE`, a path
 * (from app/) to a fixture profile of chain 99901, and with it `DOMINO_TEST_ELYSIUM_FUNDS_FROM=1` and (added 2026-11-09)
 * `DOMINO_TEST_ELYSIUM_FUNDS_TO=1`, the latter delivering the fixture profile's stable alone, as Relay would. Honoured ONLY by the
 * test builds (a MODES row with test hooks that is neither deployable nor the site); every other build, the release build
 * above all, ignores both and reads the repository alone (tests/elysium-switch.test.mjs). A forced build stands in for the
 * whole of day 9 with the fixture profile alone: no production record (its contracts are the fork-rehearsal fixture of
 * src/v2/manifestFixtures.ts, under the test admission), and the services as they answer. It writes to a directory of its
 * own (`<outDir>-elysium`, or `<outDir>-elysium-funds` with funds from or to Elysium), so the suites' usual builds are never
 * replaced by it.
 *
 * Elysium's official mark (public/chains/elysium.png) is the owner's file (7 Nov 2026: Kinetiq's mark, 128 x 128 PNG,
 * white inside the circle and transparent outside). A live build, forced or not, fails without it or with anything but a
 * square PNG image there (its signature and its IHDR), so nothing made up is ever drawn.
 *
 * Added 2026-11-07 (Elysium's pre-launch, the owner's order: Elysium on the site before its network opens): a third
 * state between off and live. `stage` is 'live' when live; otherwise 'prelaunch' while ELYSIUM_OPENS_ON (below) is a
 * day; otherwise 'off'. vite.config.ts writes it in as `__DOMINO_ELYSIUM_PRELAUNCH__` with the opening day and its two
 * English forms, `__DOMINO_ELYSIUM_OPENING__` (src/lib/elysiumIdentity.ts ELYSIUM_PRELAUNCH, ELYSIUM_OPENING). A
 * pre-launch build draws two things, Home's "Open positions on" row with Elysium's mark and when it opens, and the docs'
 * Elysium section, and nothing of chain 99901: no read, no choice, no figure. Live always wins: once every piece above is
 * in, the build is live and carries none of the pre-launch pieces. No environment variable changes the stage.
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
 * write, with the committed blob's hash in lowercase hex (`git show HEAD:<path> | sha256sum` in Git Bash; changed on
 * purpose 2026-11-07, day-9 rehearsal: never the working file's, which a CRLF checkout changes, nor Get-FileHash's
 * uppercase),
 *   export const ELYSIUM_RECORD_PIN = Object.freeze({ path: 'docs/deployments/v2-elysium-99901-<date>/deployment.json', sha256: '<64 hex>' });
 * Never computed by the build: a record that is not pinned leaves Elysium off.
 */
export const ELYSIUM_RECORD_PIN = Object.freeze({ path: 'docs/deployments/v2-elysium-99901-2026-11-09/deployment.json', sha256: 'd3d4f694d316f53d169cccbb4063a76ef19b2015cde2b3369fa9ce4a99e0c76d' });

/** Elysium's slug (src/v2/elysium.ts ELYSIUM.slug): its profile's, and its deployment record's folder's. */
export const ELYSIUM_SLUG = 'elysium';

/**
 * Elysium's pre-launch (added 2026-11-07, the owner's order: Elysium on the site before its network opens): the day
 * Kinetiq announced for Elysium's opening, 'YYYY-MM-DD', or null for no pre-launch. While Elysium is not live and this
 * is a day, the build is in pre-launch: Home's "Open positions on" row with Elysium's mark and when it opens, and the
 * docs' Elysium section, never a choice, a read or a figure. Live always wins: once every day-9 piece is here, the
 * build is live and none of the pre-launch pieces is in it. Never compared with the build's own clock: the visitor's
 * own date decides the words (src/lib/elysiumOpening.ts), so a build made after the day is still true.
 */
export const ELYSIUM_OPENS_ON = '2026-11-09';

/** The only environment variables read for Elysium, and only by the test builds. */
export const OVERRIDE_PROFILE = 'DOMINO_TEST_ELYSIUM_PROFILE';
export const OVERRIDE_FUNDS_FROM = 'DOMINO_TEST_ELYSIUM_FUNDS_FROM';
/** Added 2026-11-09 (Elysium's day 9): forces "funds can be brought to Elysium" in a forced test build alone. */
export const OVERRIDE_FUNDS_TO = 'DOMINO_TEST_ELYSIUM_FUNDS_TO';
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
 * other chains' records never match. Changed on purpose 2026-11-07 (day-9 rehearsal, finding F11): with `slug`, only that
 * slug's folders count. The switch asks for Elysium's own slug (ELYSIUM_SLUG: scripts/v2/deploy.mjs names a record's
 * folder after its profile's slug, and the app's chain parser takes Elysium's profile only with this one), so the record
 * the switch takes is the one tests/v2/manifest-pin.test.mjs holds (`v2-elysium-99901-<date>`).
 */
export function recordsIn(repoRoot, slug = null) {
  const dir = join(repoRoot, 'docs', 'deployments');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RECORD_DIRECTORY.test(entry.name) && (slug === null || entry.name.startsWith(`v2-${slug}-${ELYSIUM_V2_ID}-`)) && existsSync(join(dir, entry.name, 'deployment.json')))
    .map((entry) => `docs/deployments/${entry.name}/deployment.json`)
    .sort();
}

/**
 * Why a pin is not a pin, or null: a path under docs/deployments (from the repository's root, no `./`) and a lowercase
 * SHA-256. Changed on purpose 2026-11-07 (day-9 rehearsal, finding F10): each reason said apart, since PowerShell's
 * Get-FileHash prints UPPERCASE hex and a `./` path read as "not a pin" with no word of why.
 */
function pinFault(pin) {
  if (!plain(pin) || typeof pin.path !== 'string' || typeof pin.sha256 !== 'string') return 'scripts/elysium-switch.mjs ELYSIUM_RECORD_PIN is not a { path, sha256 } pin of a file under docs/deployments';
  if (!pin.path.startsWith('docs/deployments/')) return `scripts/elysium-switch.mjs ELYSIUM_RECORD_PIN's path must start with docs/deployments/ (no ./), not ${pin.path}`;
  if (!SHA256.test(pin.sha256)) return 'scripts/elysium-switch.mjs ELYSIUM_RECORD_PIN\'s sha256 must be 64 lowercase hex characters (`git show HEAD:<path> | sha256sum` in Git Bash)';
  return null;
}

/**
 * The pinned record (`pin`) among `records` (recordsIn), as { record: { path, sha256, text } }, or { reason } there is
 * none to use: no pin, a pin naming another file, bytes that differ from the pin, or bytes that are not JSON.
 */
export function pinnedRecord(repoRoot, records, pin) {
  if (pin === null || pin === undefined) return { reason: `${records.join(', ')} is not pinned: write its SHA-256 into scripts/elysium-switch.mjs ELYSIUM_RECORD_PIN (docs/ELYSIUM_DAY9.md)` };
  const fault = pinFault(pin);
  if (fault !== null) return { reason: fault };
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

/**
 * What crosschain-v1's destinations (CONSTANTS.destinations) let a deposit deliver on chain 99901: its token addresses,
 * lowercase, in the package's order, or null when it lists none (added 2026-11-09, Elysium's day 9), as its runtime reads
 * them (`offered(chain, token)`: the token in the chain's list).
 */
export const destinationPinned = (destinations) => {
  const list = plain(destinations) ? destinations[String(ELYSIUM_V2_ID)] : undefined;
  if (!Array.isArray(list) || list.length === 0 || !list.every((token) => typeof token === 'string' && /^0x[0-9a-fA-F]{40}$/.test(token))) return null;
  return [...new Set(list.map((token) => token.toLowerCase()))];
};

/** A profile's rank-1 charge currency that is not its native one (its stable), lowercase: a forced build's one destination. */
const stableOf = (profile) => String(profile.chargeCurrencies.find((currency) => currency.rank === 1 && String(currency.address).toLowerCase() !== `0x${'0'.repeat(40)}`).address).toLowerCase();

/** Whether a profile names a bridge for its chain (`bridge.providers` not empty), as Base's and Arbitrum One's do. */
export const bridgeNamed = (profile) => plain(profile) && plain(profile.bridge) && Array.isArray(profile.bridge.providers) && profile.bridge.providers.length > 0;

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const isAddress = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
/** JSON with every object's keys sorted, as src/v2/manifest.ts `canonical` compares a record's parts. */
const canonical = (value) => JSON.stringify(value, (_key, entry) => (plain(entry) ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry));
/** The contracts a deployment with Uniswap v4 alone records (src/v2/manifest.ts componentsFor([4])): nine. */
export const V4_ONLY_CONTRACTS = Object.freeze(['registry', 'priceAnchor', 'autoExit', 'vaultSwap', 'vault.v4', 'vaultFactory.v4', 'zap.v4.steps', 'zap.v4', 'vaultExecutor.v4']);
/** A record's `contractNames`, always the 13 (src/v2/manifest.ts CONTRACT_NAMES; tests/v2/elysium-build-guard.test.mjs holds the two equal). */
export const CONTRACT_NAMES = Object.freeze({
  registry: 'DominoRegistry', priceAnchor: 'DominoPriceAnchor', autoExit: 'DominoAutoExit', vaultSwap: 'DominoV2VaultSwapModule',
  'vault.v3': 'DominoV2VaultV3', 'vault.v4': 'DominoV2VaultV4', 'vaultFactory.v3': 'DominoV2VaultFactory', 'vaultFactory.v4': 'DominoV2VaultFactory',
  'zap.v4.steps': 'DominoZapV4Steps', 'zap.v3': 'DominoZapV3', 'zap.v4': 'DominoZapV4', 'vaultExecutor.v3': 'DominoV2VaultExecutorV3', 'vaultExecutor.v4': 'DominoV2VaultExecutorV4',
});
/**
 * The code hash the profile's verification list records at `address` (by address, exactly once), or null; `lowercase`:
 * only a lowercase one, as the manifest's binding reads it (src/v2/manifest.ts bindingOf), where the chain parser takes
 * either case.
 */
function verifiedCodehash(profile, address, lowercase = false) {
  const at = String(address).toLowerCase();
  const list = Array.isArray(profile.verification?.contracts) ? profile.verification.contracts : [];
  const found = list.filter((entry) => plain(entry) && typeof entry.address === 'string' && entry.address.toLowerCase() === at);
  return found.length === 1 && typeof found[0].codehash === 'string' && (lowercase ? /^0x[0-9a-f]{64}$/ : /^0x[0-9a-fA-F]{64}$/).test(found[0].codehash) ? found[0].codehash : null;
}

/**
 * Why the app's chain parser would refuse Elysium's enabled profile, or null (added 2026-11-07, day-9 rehearsal, finding
 * F6): src/v2/chains.ts chainOf with Elysium's row of V2_CHAIN_FACTS (src/v2/elysium.ts: slug elysium, HYPE, WHYPE, v4
 * alone), said in the profile's own words. tests/v2/elysium-build-guard.test.mjs holds it to the parser itself, case by case.
 */
export function profileRefusal(profile) {
  if (!plain(profile)) return 'it is not an object';
  if (profile.slug !== 'elysium') return `its slug is ${JSON.stringify(profile.slug)}, not "elysium"`;
  if (profile.nativeSymbol !== 'HYPE') return `its nativeSymbol is ${JSON.stringify(profile.nativeSymbol)}, not "HYPE"`;
  if (profile.stack !== 'arbitrum-nitro' && profile.stack !== 'op-stack') return `its stack is ${JSON.stringify(profile.stack)}, not arbitrum-nitro or op-stack`;
  const uniswap = profile.uniswap;
  if (!plain(uniswap) || !Object.hasOwn(uniswap, 'v3') || uniswap.v3 !== null) return 'uniswap.v3 must be there and null (Uniswap v4 alone)';
  if (!plain(uniswap.v4) || !['poolManager', 'positionManager', 'stateView'].every((name) => isAddress(uniswap.v4[name]))) return 'uniswap.v4 needs its poolManager, positionManager and stateView addresses';
  if (!plain(uniswap.universalRouter) || uniswap.universalRouter.version !== '2.1.2' || !isAddress(uniswap.universalRouter.address)) return 'uniswap.universalRouter must be version 2.1.2 at an address';
  if (!isAddress(profile.permit2) || !isAddress(profile.multicall3)) return 'permit2 and multicall3 must be addresses';
  const wrapped = profile.wrappedNative;
  if (!plain(wrapped) || wrapped.symbol !== 'WHYPE' || wrapped.decimals !== 18 || !isAddress(wrapped.address)) return 'wrappedNative must be WHYPE, 18 decimals, at an address';
  const currencies = Array.isArray(profile.chargeCurrencies) ? profile.chargeCurrencies : [];
  if (!currencies.every((currency) => plain(currency) && isAddress(currency.address))) return 'every charge currency needs an address';
  const at = (currency) => currency.address.toLowerCase();
  const stables = currencies.filter((currency) => currency.rank === 1);
  const second = currencies.filter((currency) => currency.rank === 2);
  const native = second.filter((currency) => currency.native === true && at(currency) === ZERO_ADDRESS && currency.symbol === 'HYPE' && currency.decimals === 18);
  const token = second.filter((currency) => currency.native !== true && at(currency) === wrapped.address.toLowerCase() && currency.symbol === 'WHYPE' && currency.decimals === 18);
  if (currencies.length !== 3 || stables.length !== 1 || stables[0].native === true || at(stables[0]) === ZERO_ADDRESS || second.length !== 2 || native.length !== 1 || token.length !== 1) {
    return 'chargeCurrencies must be exactly three: one rank-1 stable (not the native currency), HYPE at address 0 and WHYPE, both rank 2 with 18 decimals';
  }
  if (typeof profile.finality !== 'string' || profile.finality.trim() === '') return 'its finality text is missing';
  const feed = profile.gasPrice?.chainlinkEthUsd != null, pool = profile.gasPrice?.poolNativeUsd != null;
  if (feed === pool) return 'gasPrice must name exactly one of chainlinkEthUsd and poolNativeUsd';
  if (profile.stack === 'op-stack') {
    const oracles = (Array.isArray(profile.verification?.contracts) ? profile.verification.contracts : []).filter((entry) => plain(entry) && entry.name === 'opGasPriceOracle');
    if (oracles.length !== 1 || String(oracles[0].address).toLowerCase() !== '0x420000000000000000000000000000000000000f') return 'an op-stack profile names its opGasPriceOracle once, at 0x420000000000000000000000000000000000000F';
  }
  for (const name of ['positionManager', 'stateView']) {
    if (verifiedCodehash(profile, uniswap.v4[name]) === null) return `its verification list records no code hash for uniswap.v4.${name}`;
  }
  return null;
}

/** The dependencies a record of a v4-only chain names, from its profile (src/v2/manifest.ts bindingOf), lowercase. */
const dependenciesOf = (profile) => ({
  v4PoolManager: String(profile.uniswap?.v4?.poolManager).toLowerCase(),
  v4PositionManager: String(profile.uniswap?.v4?.positionManager).toLowerCase(),
  v4StateView: String(profile.uniswap?.v4?.stateView).toLowerCase(),
  v4Quoter: String(profile.uniswap?.v4?.quoter).toLowerCase(),
  universalRouter: String(profile.uniswap?.universalRouter?.address).toLowerCase(),
  permit2: String(profile.permit2).toLowerCase(),
  wrappedNative: String(profile.wrappedNative?.address).toLowerCase(),
});

/**
 * Why the production admission would refuse Elysium's pinned record (`record`, parsed) bound to its profile, or null
 * (added 2026-11-07, day-9 rehearsal, finding F6): src/v2/manifest.ts `bound` with the production admission, on a chain
 * with Uniswap v4 alone. The record's own shape (checkV2Manifest) is held by tests/v2/manifest-pin.test.mjs "Elysium's
 * pinned record"; tests/v2/elysium-build-guard.test.mjs holds this to the admission itself, case by case.
 */
export function recordRefusal(record, profile) {
  if (!plain(record)) return 'it is not a JSON object';
  const chain = record.chain;
  if (!plain(chain) || chain.chainId !== ELYSIUM_V2_ID) return `its chain.chainId is not ${ELYSIUM_V2_ID}`;
  if (chain.name !== profile.name) return `its chain.name ${JSON.stringify(chain.name)} differs from the profile's name ${JSON.stringify(profile.name)}`;
  if (chain.nativeCurrency !== 'HYPE') return `its chain.nativeCurrency is ${JSON.stringify(chain.nativeCurrency)}, not "HYPE"`;
  if (record.status !== 'verified') return `its status is ${JSON.stringify(record.status)}, not "verified"`;
  if (record.environment !== 'public-chain-preparation') return `its environment is ${JSON.stringify(record.environment)}, not "public-chain-preparation"`;
  if (!plain(record.verification) || record.verification.blockTag !== 'finalized') return 'it is not verified at "finalized" (verification.blockTag)';
  if (!plain(record.build) || record.build.workingTreeSourceChanges !== false) return 'its build.workingTreeSourceChanges is not false';
  if (!plain(record.contracts) || canonical(Object.keys(record.contracts).sort()) !== canonical([...V4_ONLY_CONTRACTS].sort())) return `its contracts are not exactly the nine of Uniswap v4 alone (${V4_ONLY_CONTRACTS.join(', ')})`;
  if (canonical(record.contractNames) !== canonical(CONTRACT_NAMES)) return 'its contractNames are not the 13';
  const dependencies = dependenciesOf(profile);
  if (canonical(record.dependencies) !== canonical(dependencies)) return 'its dependencies differ from the profile\'s (Uniswap v4, Universal Router, Permit2, WHYPE; lowercase)';
  for (const [name, address] of Object.entries(dependencies)) {
    if (!plain(record.runtimeCodeHashes) || record.runtimeCodeHashes[name] !== verifiedCodehash(profile, address, true)) return `its runtimeCodeHashes.${name} differs from the code hash the profile's verification list records there`;
  }
  const currencies = Array.isArray(profile.chargeCurrencies) ? profile.chargeCurrencies.map((currency) => ({ token: String(currency.address).toLowerCase(), rank: currency.rank })) : [];
  if (canonical(record.chargeCurrencies) !== canonical(currencies)) return 'its chargeCurrencies differ from the profile\'s (in its order, lowercase)';
  return null;
}

/** The months in the site's English (en-US: month, then day), for the opening's words; the page itself ships no table. */
const MONTHS = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The opening day `opensOn` (ELYSIUM_OPENS_ON) as the build writes it in: { at: [year, month, day] (month from 1),
 * short: 'Nov 9', long: 'November 9' }, or null for null. Throws on anything else, a day that does not exist included
 * (2026-11-31, 2026-02-29): it must survive Date.UTC unchanged. A day that has passed is no error: the visitor's own date
 * decides the words (src/lib/elysiumOpening.ts).
 */
export function openingOf(opensOn) {
  if (opensOn === null) return null;
  const match = typeof opensOn === 'string' ? DAY.exec(opensOn) : null;
  const [year, month, day] = match ? match.slice(1).map(Number) : [];
  const date = match ? new Date(Date.UTC(year, month - 1, day)) : null;
  if (!date || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`scripts/elysium-switch.mjs ELYSIUM_OPENS_ON must be a day, YYYY-MM-DD, or null: ${JSON.stringify(opensOn)}`);
  }
  const name = MONTHS[month - 1];
  return Object.freeze({ at: Object.freeze([year, month, day]), short: `${name.slice(0, 3)} ${day}`, long: `${name} ${day}` });
}

/** A test build: the suites' builds only (test hooks on, neither deployable nor the published site). */
export const isTestBuild = (row) => row.testHooks === true && row.deployable === false && row.site === false;

/**
 * The switch for one build. `row`: the mode's MODES row. `env`: the build's environment. `appRoot`: app/. The rest are
 * the repository's own unless a test hands in its own: `pin` (ELYSIUM_RECORD_PIN), `readV6Chains` (read-v6's
 * CONSTANTS.chainIds), `planChains` (position-plan-v1's CONSTANTS.chains), `chains` (crosschain-v1's CONSTANTS.chains),
 * `destinations` (crosschain-v1's CONSTANTS.destinations) and `opensOn` (ELYSIUM_OPENS_ON).
 * Returns { live, fundsFrom, fundsTo, destinations, forced, outDirSuffix, profileFile, profile, deployment, uniswap, missing, stage, opening }:
 *   - `destinations` (added 2026-11-09): where `fundsTo`, the tokens a deposit may deliver on Elysium (lowercase); else null;
 *   - `outDirSuffix`: what a forced build adds to its mode's directory ('' otherwise);
 *   - `profile`: the enabled profile's text, and `deployment` the pinned record ({ path, sha256, text }), each null while
 *     Elysium is off (`deployment` in a forced build too: its contracts are the fixture's);
 *   - `uniswap`: the profile's Uniswap v4 PositionManager and its Permit2 (lowercase, or null), which the docs list
 *     (src/lib/docs/elysium.ts), null while Elysium is off;
 *   - `missing`: the pieces still to come, each { piece, detail }, in PIECES' order: empty when live, and in a forced build,
 *     which looks for none. No record means no `pin` entry: there is nothing to pin yet;
 *   - `stage` (added 2026-11-07, Elysium's pre-launch): 'live' when live, else 'prelaunch' when `opensOn` is a day, else
 *     'off'; `opening` (openingOf) only in pre-launch, null otherwise, a forced test build's included (it is live).
 * Throws when Elysium is live (forced or not) and its official mark is missing or is not a square PNG image, when an
 * override names anything but an enabled 99901 profile, when the repository turns it live with a profile or a pinned
 * record the app would refuse (profileRefusal, recordRefusal; never in a forced build), and when `opensOn` is neither
 * null nor a day, whatever the stage, so a typo fails at once and not on the day.
 */
export function elysiumSwitch({ row, env = {}, appRoot, pin = ELYSIUM_RECORD_PIN, readV6Chains = READ_V6.chainIds, planChains = POSITION_PLAN.chains, chains = CROSSCHAIN.chains, destinations = CROSSCHAIN.destinations, opensOn = ELYSIUM_OPENS_ON }) {
  const opening = openingOf(opensOn);
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
    const records = recordsIn(repoRoot, ELYSIUM_SLUG);
    if (records.length === 0) {
      const elsewhere = recordsIn(repoRoot);
      missing.push({
        piece: 'record',
        detail: elsewhere.length === 0
          ? `docs/deployments holds no deployment record of chain ${ELYSIUM_V2_ID} (v2-${ELYSIUM_SLUG}-${ELYSIUM_V2_ID}-<date>/deployment.json)`
          : `docs/deployments holds no deployment record of chain ${ELYSIUM_V2_ID} under Elysium's slug: v2-${ELYSIUM_SLUG}-${ELYSIUM_V2_ID}-<date>/deployment.json is expected, not ${elsewhere.join(', ')}`,
      });
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
  // Added 2026-11-09 (Elysium's day 9, the owner: funds brought to Elysium from other networks as on Base): forced, the
  // fixture profile's stable alone (what Relay bridges there); else what the package lists, once the profile names a
  // bridge and the package pins one for 99901.
  const toForced = forced && env[OVERRIDE_FUNDS_TO] === '1';
  const delivered = !live ? null : toForced ? [stableOf(found.profile)] : bridgeNamed(found.profile) && originPinned(chains) ? destinationPinned(destinations) : null;
  const fundsTo = delivered !== null;
  const official = join(appRoot, 'public', MARK_PATH);
  if (live && !existsSync(official)) {
    const why = forced ? `${OVERRIDE_PROFILE} forces it on with ${found.file}` : `${found.file} is an enabled profile of chain ${ELYSIUM_V2_ID}, its record ${deployment.path} is pinned, and read-v6 and position-plan name it`;
    throw new Error(`Elysium is live (${why}), but its official mark, app/public/${MARK_PATH}, is missing. Add the owner's file before building (docs/ELYSIUM_DAY9.md).`);
  }
  if (live && squarePngSide(readFileSync(official)) === 0) {
    throw new Error(`app/public/${MARK_PATH} is not a square PNG image.`);
  }
  // Changed on purpose 2026-11-07 (day-9 rehearsal, finding F6): the third thing that fails a build. A live build of the
  // repository whose profile the app's chain parser refuses, or whose pinned record the production admission refuses,
  // used to build green and then throw at load in every V2 chunk (the profile) or show Elysium everywhere with its
  // contracts unavailable (the record). A forced test build has neither (the fixture profile, no record): never asked.
  if (live && !forced) {
    const profileFault = profileRefusal(found.profile);
    if (profileFault !== null) throw new Error(`Elysium is live, but the app's chain parser (src/v2/chains.ts chainOf) refuses ${found.file}: ${profileFault}. Nothing is built: fix the profile with rugged97 (docs/ELYSIUM_DAY9.md).`);
    let record;
    try {
      record = JSON.parse(deployment.text);
    } catch {
      record = null;
    }
    const recordFault = recordRefusal(record, found.profile);
    if (recordFault !== null) throw new Error(`Elysium is live, but the production admission (src/v2/manifest.ts) refuses its pinned record ${deployment.path}: ${recordFault}. Nothing is built: fix the record with rugged97 and pin it again (docs/ELYSIUM_DAY9.md, step 2).`);
  }
  const uniswap = live ? { positionManager: lowerAddress(found.profile.uniswap?.v4?.positionManager), permit2: lowerAddress(found.profile.permit2) } : null;
  const outDirSuffix = forced ? (fundsForced || toForced ? '-elysium-funds' : '-elysium') : '';
  const stage = live ? 'live' : opening !== null ? 'prelaunch' : 'off';
  return {
    live,
    fundsFrom,
    fundsTo,
    destinations: delivered,
    forced,
    outDirSuffix,
    profileFile: live ? found.file : null,
    profile: live ? found.text : null,
    deployment: live ? deployment : null,
    uniswap,
    missing,
    stage,
    opening: stage === 'prelaunch' ? opening : null,
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
