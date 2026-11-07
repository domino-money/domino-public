/**
 * TEST-ONLY. The compiled app (.test-build) with Elysium switched on, as a build where it is live holds it (added
 * 2026-11-07, Elysium as a fourth V2 chain). A compile outside Vite reads each of the build's Elysium defines from
 * globalThis (src/lib/elysiumIdentity.ts, src/v2/elysiumFiles.ts), so `loadWith` sets them, loads the modules again from
 * scratch, and puts the cache back as it was: the rest of a test file keeps today's modules (Elysium off).
 *
 *   ELYSIUM_FORCED   what a forced test build carries (scripts/elysium-switch.mjs with DOMINO_TEST_ELYSIUM_PROFILE): live,
 *                    the synthetic profile tests/fixtures/v2-chains/elysium-99901.json, no deployment record (its
 *                    contracts are the fork-rehearsal fixture, src/v2/manifestFixtures.ts, under the test admission).
 *   withRecord(raw)  the same with a pinned deployment record (`raw`, as the file holds it) and a pin, as day 9's build
 *                    carries rugged97's, for the production admission's own checks.
 *   withFunds        ELYSIUM_FORCED and funds from Elysium (DOMINO_TEST_ELYSIUM_FUNDS_FROM=1).
 *
 * Use: `const on = loadWith(require, ELYSIUM_FORCED, () => require(`${BUILD}v2/chains.js`))`, with the test file's own
 * createRequire(import.meta.url), whose cache it works on.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const APP = new URL('../../../', import.meta.url);
export const ELYSIUM_PROFILE_PATH = 'tests/fixtures/v2-chains/elysium-99901.json';
export const ELYSIUM_FIXTURE_PATH = 'src/v2/fixtures/manifest.elysium-99901.fixture.json';
/** The synthetic profile's exact text, as the switch hands it in. */
export const ELYSIUM_PROFILE_TEXT = readFileSync(new URL(ELYSIUM_PROFILE_PATH, APP), 'utf8');
export const ELYSIUM_PROFILE = JSON.parse(ELYSIUM_PROFILE_TEXT);

export const ELYSIUM_FORCED = Object.freeze({
  __DOMINO_ELYSIUM_LIVE__: true,
  __DOMINO_ELYSIUM_PROFILE__: ELYSIUM_PROFILE_TEXT,
  __DOMINO_ELYSIUM_UNISWAP__: { positionManager: ELYSIUM_PROFILE.uniswap.v4.positionManager.toLowerCase(), permit2: ELYSIUM_PROFILE.permit2.toLowerCase() },
});
export const withFunds = Object.freeze({ ...ELYSIUM_FORCED, __DOMINO_ELYSIUM_FUNDS_FROM__: true });

/** ELYSIUM_FORCED with a deployment record's text and its pin, as a live build carries rugged97's pinned record. */
export function withRecord(raw, path = 'docs/deployments/v2-elysium-99901-2026-11-09/deployment.json') {
  const text = typeof raw === 'string' ? raw : `${JSON.stringify(raw, null, 2)}\n`;
  return Object.freeze({
    ...ELYSIUM_FORCED,
    __DOMINO_ELYSIUM_DEPLOYMENT__: text,
    __DOMINO_ELYSIUM_DEPLOYMENT_PIN__: { path, sha256: createHash('sha256').update(text).digest('hex') },
  });
}

const ours = (key) => key.includes('.test-build');

/**
 * `load()` with the build's defines set as `flags` on globalThis and the compiled modules loaded afresh, then the defines
 * and the cache restored. `require` is the calling test file's.
 */
export function loadWith(require, flags, load) {
  const saved = Object.entries(require.cache).filter(([key]) => ours(key));
  for (const [key] of saved) delete require.cache[key];
  Object.assign(globalThis, flags);
  try {
    return load();
  } finally {
    for (const name of Object.keys(flags)) delete globalThis[name];
    for (const key of Object.keys(require.cache)) if (ours(key)) delete require.cache[key];
    for (const [key, value] of saved) require.cache[key] = value;
  }
}

/**
 * The same for code that loads more modules as it runs (a lazy `import()`, compiled to a require): the defines and the
 * fresh cache stay until `run()` settles. Tests in one file run one at a time, so nothing else sees them meanwhile.
 */
export async function runWith(require, flags, run) {
  const saved = Object.entries(require.cache).filter(([key]) => ours(key));
  for (const [key] of saved) delete require.cache[key];
  Object.assign(globalThis, flags);
  try {
    return await run();
  } finally {
    for (const name of Object.keys(flags)) delete globalThis[name];
    for (const key of Object.keys(require.cache)) if (ours(key)) delete require.cache[key];
    for (const [key, value] of saved) require.cache[key] = value;
  }
}
