/**
 * The wallet-test-v2 build with Elysium forced on (added 2026-11-06, the Elysium surface), for the browser suite that
 * shows what day 9 looks like (tests/v2in-browser/elysium-surface.test.mjs) and its pictures: the synthetic v4-only
 * profile of chain 99901 in tests/fixtures/v2-chains stands in for rugged97's file. `--funds-from` also forces "funds can
 * come from Elysium" (no bridge serves it today), and (added 2026-11-09, Elysium's day 9) "funds can be brought to
 * Elysium", its stable alone, as Relay bridges it. Each writes beside the usual build (scripts/elysium-switch.mjs):
 * .wallet-test-v2-dist-elysium and .wallet-test-v2-dist-elysium-funds. Only test builds read these variables; the
 * release build ignores them.
 * Changed on purpose 2026-11-07 (day-9 rehearsal, finding F5): these builds always carry the synthetic profile, since
 * their contracts are its fork-rehearsal fixture (src/v2/manifest.ts binds that fixture to the synthetic profile's name
 * and addresses alone). Once the repository turns Elysium on, the browser suites draw live Elysium from the usual build,
 * which carries rugged97's profile and our pinned record (tests/support/elysium-profile.mjs); only funds from Elysium
 * (no bridge pins it on day 9) still comes from the `-funds` build here.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const APP = resolve(import.meta.dirname, '..');
export const ELYSIUM_FIXTURE_PROFILE = 'tests/fixtures/v2-chains/elysium-99901.json';

const funds = process.argv.includes('--funds-from');
const env = { ...process.env, DOMINO_TEST_ELYSIUM_PROFILE: ELYSIUM_FIXTURE_PROFILE, DOMINO_TEST_ELYSIUM_FUNDS_FROM: funds ? '1' : '', DOMINO_TEST_ELYSIUM_FUNDS_TO: funds ? '1' : '' };
const run = spawnSync(process.execPath, [resolve(APP, 'node_modules/vite/bin/vite.js'), 'build', '--mode', 'wallet-test-v2'], { cwd: APP, env, stdio: 'inherit' });
process.exit(run.status ?? 1);
